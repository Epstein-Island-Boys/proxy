'use strict';

/**
 * High-performance GeForce Now streaming proxy
 *
 * Architecture:
 *   HTTP  → raw http/https with keepAlive agents  (no http-proxy-middleware)
 *   HTML  → streaming Transform (SRI strip + SW inject + domain rewrite, no buffer)
 *   JS/CSS→ streaming Transform (domain rewrite, overlap buffer)
 *   Binary→ straight pipe, zero copy
 *   Cache → in-memory LRU (256 MB) for immutable static assets
 *   WS    → raw TLS splice, no middleware
 *
 * Why the old version showed a blank tab:
 *   1. clear-site-data header nuked all browser caches on every HTML response,
 *      forcing a full cold-load every time (no cached JS, CSS, fonts, images)
 *   2. HTML was fully buffered before byte 1 reached the browser
 *   3. No keepAlive: every asset paid a full TLS handshake (~150-250 ms)
 *   4. compression() re-gzipped content we had just decompressed (wasted CPU)
 *   5. http-proxy-middleware added unnecessary event-emitter chain overhead
 */

const http    = require('http');
const https   = require('https');
const tls     = require('tls');
const zlib    = require('zlib');
const { Transform, pipeline } = require('stream');

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT       = Number(process.env.PORT || 3000);
const PROXY_HOST = (process.env.PROXY_HOST || `http://localhost:${PORT}`).replace(/\/$/, '');

// Route table: evaluated in order, first prefix match wins
const ROUTES = [
  { prefix: '/auth',       target: 'https://login.nvidia.com'                            },
  { prefix: '/nvidia',     target: 'https://www.nvidia.com'                              },
  { prefix: '/nvidiagrid', target: 'https://assets.nvidiagrid.net'                       },
  { prefix: '/gfnblob',    target: 'https://gfnjpstorageaccount.blob.core.windows.net'   },
  { prefix: '/',           target: 'https://play.geforcenow.com'                         },
];

const DOMAIN_MAP = {
  'https://play.geforcenow.com':                       PROXY_HOST,
  'https://login.nvidia.com':                          `${PROXY_HOST}/auth`,
  'https://www.nvidia.com':                            `${PROXY_HOST}/nvidia`,
  'https://assets.nvidiagrid.net':                     `${PROXY_HOST}/nvidiagrid`,
  'https://gfnjpstorageaccount.blob.core.windows.net': `${PROXY_HOST}/gfnblob`,
};

// ─── keepAlive upstream agents ────────────────────────────────────────────────
// Reuse TLS sessions across requests. Without this every single asset (JS, CSS,
// font, image) pays a full TLS handshake (~150-250 ms). With it the connection
// is already warm and data starts flowing in microseconds.

const HTTPS_AGENT = new https.Agent({
  keepAlive:      true,
  maxSockets:     256,   // concurrent upstream sockets
  maxFreeSockets: 64,    // idle sockets kept warm between requests
  timeout:        30_000,
  scheduling:     'lifo', // reuse most-recently-idle socket (warm TLS state)
});

// ─── Domain rewrite (one compiled regex, one pass) ───────────────────────────

const DOMAIN_ENTRIES = Object.entries(DOMAIN_MAP);
const DOMAIN_RE      = new RegExp(
  DOMAIN_ENTRIES.map(([k]) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'g'
);
const MAX_DOMAIN_LEN = Math.max(...DOMAIN_ENTRIES.map(([k]) => k.length));
// Fast-path skip: if none of these tokens are present, no domain can appear
const DOMAIN_HINTS   = ['nvidia', 'geforcenow', 'gfnjpstorageaccount'];

function rewriteDomains(str) {
  if (!DOMAIN_HINTS.some(h => str.includes(h))) return str;
  return str.replace(DOMAIN_RE, m => DOMAIN_MAP[m]);
}

// ─── Content-type helpers ─────────────────────────────────────────────────────

const REWRITABLE_RE   = /\b(?:text|javascript|json|xml|manifest)\b/i;
const HTML_RE         = /text\/html/i;
const STATIC_EXT_RE   = /\.(?:js|mjs|css|woff2?|ttf|otf|eot|png|jpe?g|gif|webp|svg|ico|wasm|map)(?:[?#]|$)/i;
const IMMUTABLE_CC_RE = /\bimmutable\b|max-age=([1-9]\d{4,})/; // max-age >= 10 000 s

// ─── In-memory LRU cache (256 MB) ────────────────────────────────────────────
// Serves immutable static assets (JS bundles, fonts, images) from RAM,
// eliminating upstream round-trips on repeat visits.

class LRU {
  constructor(maxBytes) {
    this.max  = maxBytes;
    this.used = 0;
    this.map  = new Map(); // Map preserves insertion order → LRU eviction
  }

  get(key) {
    if (!this.map.has(key)) return null;
    const v = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, v); // promote to tail (most-recently-used)
    return v;
  }

  set(key, entry) {
    const bytes = entry.body.length;
    if (bytes > this.max >>> 2) return; // skip items > 25 % of total budget
    while (this.used + bytes > this.max && this.map.size > 0) {
      const [k, v] = this.map.entries().next().value;
      this.map.delete(k);
      this.used -= v.body.length;
    }
    if (this.map.has(key)) this.used -= this.map.get(key).body.length;
    this.map.set(key, entry);
    this.used += bytes;
  }
}

const CACHE = new LRU(256 << 20); // 256 MB

// ─── Header handling ──────────────────────────────────────────────────────────

const DROP_HEADERS = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'strict-transport-security',
  'x-content-type-options',
  'x-xss-protection',
  'report-to',
  'nel',
  // KEY FIX: never forward clear-site-data.
  // This header instructs the browser to wipe all caches, cookies, and storage
  // before the page even renders. Every load became a cold start: no cached JS,
  // no cached fonts, no cached images — everything re-downloaded from scratch.
  'clear-site-data',
]);

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'proxy-connection',
]);

function sanitizeResHeaders(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const kl = k.toLowerCase();
    if (DROP_HEADERS.has(kl) || HOP_BY_HOP.has(kl)) continue;
    out[kl] = kl === 'location' ? rewriteDomains(String(v)) : v;
  }
  if (out['set-cookie']) {
    out['set-cookie'] = [].concat(out['set-cookie']).map(c =>
      c.replace(/;\s*Domain=[^;]*/gi, '')
       .replace(/;\s*SameSite=\w+/gi,  '; SameSite=Lax')
       .replace(/;\s*Secure/gi, process.env.NODE_ENV === 'production' ? '; Secure' : '')
    );
  }
  return out;
}

// ─── Decompressor ────────────────────────────────────────────────────────────

function makeDecompressor(enc) {
  switch ((enc || '').toLowerCase()) {
    case 'gzip':    return zlib.createGunzip();
    case 'deflate': return zlib.createInflate();
    case 'br':      return zlib.createBrotliDecompress();
    default:        return null;
  }
}

// ─── Streaming transforms ─────────────────────────────────────────────────────
//
// Overlap buffer: must be >= the longest possible pattern that could straddle
// a chunk boundary. integrity="sha512-<88-char-base64>" is ~115 chars.
// MAX_DOMAIN_LEN is ~55. 512 bytes covers both with room to spare.

const OVERLAP = Math.max(MAX_DOMAIN_LEN, 512);

const SRI_RES = [
  /(?<![a-zA-Z0-9_-])integrity\s*=\s*"[^"]*"/gi,
  /(?<![a-zA-Z0-9_-])integrity\s*=\s*'[^']*'/gi,
  /(?<![a-zA-Z0-9_-])crossorigin\s*=\s*"[^"]*"/gi,
  /(?<![a-zA-Z0-9_-])crossorigin\s*=\s*'[^']*'/gi,
];
function stripSRI(s) {
  for (const r of SRI_RES) s = s.replace(r, '');
  return s;
}

// Minified so it adds minimal bytes to every HTML page
const SW_SNIPPET =
  `<script>/* proxy */(function(){` +
  `if(!('serviceWorker' in navigator))return;` +
  `navigator.serviceWorker.getRegistrations()` +
  `.then(function(r){r.forEach(function(sw){sw.unregister();});});` +
  `caches.keys().then(function(k){k.forEach(function(c){caches.delete(c);});});` +
  `}());</script>`;

/**
 * makeHTMLStream()
 *
 * Processes HTML chunk by chunk — the browser receives the first bytes of the
 * page as soon as the first chunk arrives from upstream, instead of waiting
 * for the entire page to be downloaded and buffered.
 *
 * On a slow connection or a large SPA bootstrap page this is the difference
 * between first paint in ~100 ms vs several seconds of blank tab.
 *
 * Per chunk (in a single pass):
 *   1. Strip integrity/crossorigin attributes (SRI)
 *   2. Inject SW unregister snippet after <head> (once)
 *   3. Rewrite upstream domain URLs to local proxy paths
 */
function makeHTMLStream() {
  let tail     = '';
  let injected = false;

  return new Transform({
    transform(chunk, _enc, cb) {
      let s    = tail + chunk.toString('utf8');
      tail     = s.slice(-OVERLAP);
      let safe = s.slice(0, s.length - OVERLAP);
      if (!safe) return cb();

      safe = stripSRI(safe);

      if (!injected) {
        safe = safe.replace(/(<head[^>]*>)/i, (_, tag) => {
          injected = true;
          return tag + SW_SNIPPET;
        });
      }

      cb(null, Buffer.from(rewriteDomains(safe), 'utf8'));
    },

    flush(cb) {
      if (!tail) return cb();
      let s = stripSRI(tail);
      if (!injected) s = SW_SNIPPET + s; // <head> never appeared, prepend
      cb(null, Buffer.from(rewriteDomains(s), 'utf8'));
    },
  });
}

/**
 * makeRewriteStream()
 * Streaming domain rewrite for JS / CSS / JSON.
 */
function makeRewriteStream() {
  let tail = '';

  return new Transform({
    transform(chunk, _enc, cb) {
      const s    = tail + chunk.toString('utf8');
      tail       = s.slice(-OVERLAP);
      const safe = s.slice(0, s.length - OVERLAP);
      if (!safe) return cb();
      const out = rewriteDomains(safe);
      cb(null, out === safe ? Buffer.from(safe) : Buffer.from(out, 'utf8'));
    },

    flush(cb) {
      if (!tail) return cb();
      const out = rewriteDomains(tail);
      cb(null, out === tail ? Buffer.from(tail) : Buffer.from(out, 'utf8'));
    },
  });
}

// ─── Route resolution ─────────────────────────────────────────────────────────

function resolveRoute(reqUrl) {
  for (const r of ROUTES) {
    const p = r.prefix;
    if (p === '/' || reqUrl === p || reqUrl.startsWith(p + '/') || reqUrl.startsWith(p + '?')) {
      const strippedPath = p === '/' ? reqUrl : (reqUrl.slice(p.length) || '/');
      return { target: r.target, path: strippedPath };
    }
  }
  return { target: ROUTES[ROUTES.length - 1].target, path: reqUrl };
}

// ─── HTTP request handler ─────────────────────────────────────────────────────

function handleRequest(req, res) {
  if (res.socket) res.socket.setNoDelay(true); // disable Nagle — flush immediately

  // Service-worker stub file
  if (/gfn-service-worker\.js/.test(req.url)) {
    res.writeHead(200, {
      'content-type':           'application/javascript; charset=utf-8',
      'service-worker-allowed': '/',
      'cache-control':          'no-store',
    });
    return res.end(SW_STUB_FILE);
  }

  const { target, path } = resolveRoute(req.url);
  const upUrl    = new URL(path, target);
  const cacheKey = upUrl.href;

  // Cache lookup (GET only)
  if (req.method === 'GET') {
    const hit = CACHE.get(cacheKey);
    if (hit) {
      res.writeHead(200, hit.headers);
      res.end(hit.body);
      return;
    }
  }

  // Build upstream headers
  const upHeaders = { origin: target, referer: target + '/' };
  for (const [k, v] of Object.entries(req.headers)) {
    const kl = k.toLowerCase();
    if (!HOP_BY_HOP.has(kl)) upHeaders[kl] = v;
  }
  upHeaders['host']            = upUrl.hostname;
  upHeaders['accept-encoding'] = 'gzip, deflate'; // skip brotli, slower to decompress

  const upReq = https.request(
    {
      hostname: upUrl.hostname,
      port:     upUrl.port || 443,
      path:     upUrl.pathname + upUrl.search,
      method:   req.method,
      headers:  upHeaders,
      agent:    HTTPS_AGENT,
    },
    upRes => {
      const headers  = sanitizeResHeaders(upRes.headers);
      const status   = upRes.statusCode;
      const ct       = headers['content-type'] || '';
      const encoding = upRes.headers['content-encoding'];

      // ── Binary ─────────────────────────────────────────────────────────
      if (!REWRITABLE_RE.test(ct)) {
        const shouldCache =
          req.method === 'GET' &&
          status === 200 &&
          STATIC_EXT_RE.test(req.url) &&
          IMMUTABLE_CC_RE.test(headers['cache-control'] || '');

        if (shouldCache) {
          // Decompress so we store raw bytes (client may not support gzip)
          const decomp = makeDecompressor(encoding);
          const src    = decomp ? upRes.pipe(decomp) : upRes;
          const chunks = [];
          src.on('data', c => chunks.push(c));
          src.on('end', () => {
            const body = Buffer.concat(chunks);
            const ch   = { ...headers };
            delete ch['content-encoding'];
            ch['content-length'] = String(body.length);
            CACHE.set(cacheKey, { headers: ch, body });
            res.writeHead(status, ch);
            res.end(body);
          });
          src.on('error', () => { if (!res.writableEnded) res.end(); });
          return;
        }

        // Non-cacheable binary: pipe with encoding headers intact (zero work)
        res.writeHead(status, headers);
        pipeline(upRes, res, _err => {});
        return;
      }

      // Text responses: decompress, strip encoding headers (length will change)
      delete headers['content-encoding'];
      delete headers['content-length'];

      const decomp = makeDecompressor(encoding);

      // ── HTML ───────────────────────────────────────────────────────────
      if (HTML_RE.test(ct)) {
        res.writeHead(status, headers);
        const src = decomp ? upRes.pipe(decomp) : upRes;
        pipeline(src, makeHTMLStream(), res, err => {
          if (err) console.error('[proxy] html stream:', err.message);
        });
        return;
      }

      // ── JS / CSS / JSON ────────────────────────────────────────────────
      res.writeHead(status, headers);
      const src = decomp ? upRes.pipe(decomp) : upRes;
      pipeline(src, makeRewriteStream(), res, err => {
        if (err) console.error('[proxy] text stream:', err.message);
      });
    }
  );

  upReq.on('error', err => {
    console.error('[proxy] upstream error:', req.method, req.url, err.message);
    if (!res.headersSent) res.writeHead(502);
    if (!res.writableEnded) res.end('Proxy error: ' + err.message);
  });

  pipeline(req, upReq, err => {
    if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      console.error('[proxy] req body pipe:', err.message);
    }
  });
}

// ─── WebSocket / Upgrade handler ──────────────────────────────────────────────
//
// GeForce Now streams the game over WebSocket. Rather than routing through
// middleware (which buffers frames and adds event-emitter overhead), we open a
// raw TLS socket to the upstream host and splice the two streams together.
// The browser and upstream talk directly through our process with zero parsing.

function handleUpgrade(req, clientSocket, head) {
  clientSocket.setNoDelay(true);

  const { target, path } = resolveRoute(req.url);
  const upUrl  = new URL(path, target);
  const upPort = Number(upUrl.port) || 443;

  const upSocket = tls.connect(
    { host: upUrl.hostname, port: upPort, servername: upUrl.hostname },
    () => {
      const fwdHeaders = Object.entries(req.headers)
        .filter(([k]) => !HOP_BY_HOP.has(k.toLowerCase()) && k.toLowerCase() !== 'host')
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n');

      upSocket.write(
        `GET ${upUrl.pathname}${upUrl.search} HTTP/1.1\r\n` +
        `host: ${upUrl.hostname}\r\n` +
        `origin: ${target}\r\n` +
        (fwdHeaders ? fwdHeaders + '\r\n' : '') +
        'connection: Upgrade\r\n' +
        'upgrade: websocket\r\n' +
        '\r\n'
      );

      if (head && head.length) upSocket.write(head);

      // Bidirectional splice — no parsing, no buffering
      upSocket.pipe(clientSocket);
      clientSocket.pipe(upSocket);
    }
  );

  const cleanup = () => { upSocket.destroy(); clientSocket.destroy(); };
  upSocket.on('error', err => { console.error('[ws]', err.message); cleanup(); });
  clientSocket.on('error', cleanup);
  clientSocket.on('close', () => upSocket.destroy());
  upSocket.on('close', () => clientSocket.destroy());
}

// ─── Service-worker file ──────────────────────────────────────────────────────

const SW_STUB_FILE = [
  `self.addEventListener('install', () => self.skipWaiting());`,
  `self.addEventListener('activate', async () => {`,
  `  await Promise.all((await caches.keys()).map(k => caches.delete(k)));`,
  `  await self.registration.unregister();`,
  `  await self.clients.claim();`,
  `});`,
  `self.addEventListener('fetch', e => e.respondWith(fetch(e.request)));`,
].join('\n');

// ─── Start ────────────────────────────────────────────────────────────────────

const server = http.createServer(handleRequest);
server.on('upgrade', handleUpgrade);

// Keep game sessions alive — don't time out long-lived connections
server.keepAliveTimeout = 120_000;
server.headersTimeout   = 125_000;

server.listen(PORT, () => {
  console.log(`[proxy] port=${PORT}  PROXY_HOST=${PROXY_HOST}`);
});

module.exports = { server };
