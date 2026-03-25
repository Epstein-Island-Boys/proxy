'use strict';

/**
 * High-performance GeForce Now streaming proxy
 *
 * Architecture:
 *   HTTP  → raw https with keepAlive agents (no http-proxy-middleware)
 *   HTML  → streaming Transform (SRI strip + SW inject + domain rewrite, no buffer)
 *   JS/CSS→ streaming Transform (domain rewrite, overlap buffer)
 *   Binary→ straight pipe, zero copy; immutable assets cached in 256 MB LRU
 *   WS    → raw TLS splice via data events (no pipe deadlocks)
 *
 * Fixes vs previous version:
 *   [LOADING HANG #1] 304 / 204 / 1xx / HEAD have no body — old code sent them
 *     into the decompress+rewrite pipeline which waited forever for data
 *   [LOADING HANG #2] WebSocket bidirectional pipe() creates backpressure
 *     deadlocks under load — replaced with data-event splice
 *   [LOADING HANG #3] No upstream timeout — one hung API call during the JS
 *     startup sequence stalls the entire loading screen indefinitely
 *   [LOADING HANG #4] pipeline(req, upReq) + upReq.on('error') both fired on
 *     failure, causing double-response / destroyed-socket writes
 *   [BLANK TAB]  clear-site-data on every HTML response wiped all browser
 *     caches, making every load a full cold start
 *   [BLANK TAB]  HTML fully buffered — now streamed chunk-by-chunk
 *   [LATENCY]    No keepAlive — each asset paid a full TLS handshake
 */

const http    = require('http');
const https   = require('https');
const tls     = require('tls');
const zlib    = require('zlib');
const { Transform, pipeline } = require('stream');

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT       = Number(process.env.PORT || 3000);
const PROXY_HOST = (process.env.PROXY_HOST || `http://localhost:${PORT}`).replace(/\/$/, '');

// Evaluated in order — first prefix match wins
const ROUTES = [
  { prefix: '/auth',       target: 'https://login.nvidia.com'                          },
  { prefix: '/nvidia',     target: 'https://www.nvidia.com'                            },
  { prefix: '/nvidiagrid', target: 'https://assets.nvidiagrid.net'                     },
  { prefix: '/gfnblob',   target: 'https://gfnjpstorageaccount.blob.core.windows.net' },
  { prefix: '/',           target: 'https://play.geforcenow.com'                       },
];

const DOMAIN_MAP = {
  'https://play.geforcenow.com':                       PROXY_HOST,
  'https://login.nvidia.com':                          `${PROXY_HOST}/auth`,
  'https://www.nvidia.com':                            `${PROXY_HOST}/nvidia`,
  'https://assets.nvidiagrid.net':                     `${PROXY_HOST}/nvidiagrid`,
  'https://gfnjpstorageaccount.blob.core.windows.net': `${PROXY_HOST}/gfnblob`,
};

const UPSTREAM_TIMEOUT_MS = 20_000; // abort hung upstream requests after 20 s

// ─── keepAlive upstream agent ─────────────────────────────────────────────────

const HTTPS_AGENT = new https.Agent({
  keepAlive:      true,
  maxSockets:     256,
  maxFreeSockets: 64,
  timeout:        30_000,
  scheduling:     'lifo',
});

// ─── Domain rewrite ───────────────────────────────────────────────────────────

const DOMAIN_ENTRIES = Object.entries(DOMAIN_MAP);
const DOMAIN_RE      = new RegExp(
  DOMAIN_ENTRIES.map(([k]) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'g'
);
const MAX_DOMAIN_LEN = Math.max(...DOMAIN_ENTRIES.map(([k]) => k.length));
const DOMAIN_HINTS   = ['nvidia', 'geforcenow', 'gfnjpstorageaccount'];

function rewriteDomains(str) {
  if (!DOMAIN_HINTS.some(h => str.includes(h))) return str;
  return str.replace(DOMAIN_RE, m => DOMAIN_MAP[m]);
}

// ─── Content-type helpers ─────────────────────────────────────────────────────

const REWRITABLE_RE   = /\b(?:text|javascript|json|xml|manifest)\b/i;
const HTML_RE         = /text\/html/i;
const STATIC_EXT_RE   = /\.(?:js|mjs|css|woff2?|ttf|otf|eot|png|jpe?g|gif|webp|svg|ico|wasm|map)(?:[?#]|$)/i;
const IMMUTABLE_CC_RE = /\bimmutable\b|max-age=([1-9]\d{4,})/;

// HTTP status codes / methods that must never have a response body
function isBodyless(status, method) {
  return method === 'HEAD' ||
    status === 204 || status === 304 ||
    (status >= 100 && status < 200);
}

// ─── LRU cache (256 MB) ───────────────────────────────────────────────────────

class LRU {
  constructor(maxBytes) {
    this.max = maxBytes; this.used = 0; this.map = new Map();
  }
  get(k) {
    if (!this.map.has(k)) return null;
    const v = this.map.get(k); this.map.delete(k); this.map.set(k, v); return v;
  }
  set(k, v) {
    const b = v.body.length;
    if (b > this.max >>> 2) return;
    while (this.used + b > this.max && this.map.size > 0) {
      const [ek, ev] = this.map.entries().next().value;
      this.map.delete(ek); this.used -= ev.body.length;
    }
    if (this.map.has(k)) this.used -= this.map.get(k).body.length;
    this.map.set(k, v); this.used += b;
  }
}

const CACHE = new LRU(256 << 20);

// ─── Headers ──────────────────────────────────────────────────────────────────

const DROP_HEADERS = new Set([
  'x-frame-options', 'content-security-policy', 'content-security-policy-report-only',
  'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy',
  'strict-transport-security', 'x-content-type-options', 'x-xss-protection',
  'report-to', 'nel',
  // Forwarding this header tells the browser to wipe all caches/cookies/storage
  // before rendering — every load becomes a cold start.
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

// Large enough to cover the longest SRI attribute (~115 chars) and longest
// upstream domain (~55 chars) that could straddle a chunk boundary.
const OVERLAP = Math.max(MAX_DOMAIN_LEN, 512);

const SRI_RES = [
  /(?<![a-zA-Z0-9_-])integrity\s*=\s*"[^"]*"/gi,
  /(?<![a-zA-Z0-9_-])integrity\s*=\s*'[^']*'/gi,
  /(?<![a-zA-Z0-9_-])crossorigin\s*=\s*"[^"]*"/gi,
  /(?<![a-zA-Z0-9_-])crossorigin\s*=\s*'[^']*'/gi,
];
function stripSRI(s) { for (const r of SRI_RES) s = s.replace(r, ''); return s; }

const SW_SNIPPET =
  `<script>/* proxy */(function(){` +
  `if(!('serviceWorker' in navigator))return;` +
  `navigator.serviceWorker.getRegistrations()` +
  `.then(function(r){r.forEach(function(sw){sw.unregister();});});` +
  `caches.keys().then(function(k){k.forEach(function(c){caches.delete(c);});});` +
  `}());</script>`;

function makeHTMLStream() {
  let tail = '', injected = false;
  return new Transform({
    transform(chunk, _enc, cb) {
      let s = tail + chunk.toString('utf8');
      tail  = s.slice(-OVERLAP);
      let safe = s.slice(0, s.length - OVERLAP);
      if (!safe) return cb();
      safe = stripSRI(safe);
      if (!injected) {
        safe = safe.replace(/(<head[^>]*>)/i, (_, tag) => { injected = true; return tag + SW_SNIPPET; });
      }
      cb(null, Buffer.from(rewriteDomains(safe), 'utf8'));
    },
    flush(cb) {
      if (!tail) return cb();
      let s = stripSRI(tail);
      if (!injected) s = SW_SNIPPET + s;
      cb(null, Buffer.from(rewriteDomains(s), 'utf8'));
    },
  });
}

function makeRewriteStream() {
  let tail = '';
  return new Transform({
    transform(chunk, _enc, cb) {
      const s = tail + chunk.toString('utf8');
      tail    = s.slice(-OVERLAP);
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
      return { target: r.target, path: p === '/' ? reqUrl : (reqUrl.slice(p.length) || '/') };
    }
  }
  return { target: ROUTES[ROUTES.length - 1].target, path: reqUrl };
}

// ─── HTTP request handler ─────────────────────────────────────────────────────

function handleRequest(req, res) {
  if (res.socket) res.socket.setNoDelay(true);

  // Service-worker stub
  if (/gfn-service-worker\.js/.test(req.url)) {
    res.writeHead(200, {
      'content-type': 'application/javascript; charset=utf-8',
      'service-worker-allowed': '/',
      'cache-control': 'no-store',
    });
    return res.end(SW_STUB_FILE);
  }

  const { target, path } = resolveRoute(req.url);
  const upUrl    = new URL(path, target);
  const cacheKey = upUrl.href;

  if (req.method === 'GET') {
    const hit = CACHE.get(cacheKey);
    if (hit) { res.writeHead(200, hit.headers); res.end(hit.body); return; }
  }

  // Build upstream headers — forward everything except hop-by-hop
  const upHeaders = { origin: target, referer: target + '/' };
  for (const [k, v] of Object.entries(req.headers)) {
    const kl = k.toLowerCase();
    if (!HOP_BY_HOP.has(kl)) upHeaders[kl] = v;
  }
  upHeaders['host'] = upUrl.hostname;

  let responded = false;
  function safeError(msg) {
    if (responded) return;
    responded = true;
    console.error('[proxy]', req.method, req.url, msg);
    try {
      if (!res.headersSent) res.writeHead(502);
      if (!res.writableEnded) res.end('Proxy error: ' + msg);
    } catch (_) {}
  }

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
      responded = true;
      const headers = sanitizeResHeaders(upRes.headers);
      const status  = upRes.statusCode;
      const ct      = headers['content-type'] || '';
      const enc     = upRes.headers['content-encoding'];

      // ── Bodyless responses (304, 204, 1xx, HEAD) ───────────────────────
      // CRITICAL FIX: these statuses have no body. Sending them into a
      // decompress/rewrite pipeline causes it to wait forever for data
      // that never arrives, hanging the browser's request indefinitely.
      if (isBodyless(status, req.method)) {
        // 304 must preserve the exact headers that tell the browser its
        // cached copy is still valid — do not strip content-encoding here
        res.writeHead(status, headers);
        res.end();
        upRes.resume(); // drain so the socket can be reused
        return;
      }

      // ── Binary (images, fonts, wasm, video) ────────────────────────────
      if (!REWRITABLE_RE.test(ct)) {
        const shouldCache =
          req.method === 'GET' && status === 200 &&
          STATIC_EXT_RE.test(req.url) &&
          IMMUTABLE_CC_RE.test(headers['cache-control'] || '');

        if (shouldCache) {
          const decomp  = makeDecompressor(enc);
          const src     = decomp ? upRes.pipe(decomp) : upRes;
          const chunks  = [];
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

        res.writeHead(status, headers);
        pipeline(upRes, res, _err => {});
        return;
      }

      // Text: decompress ourselves, remove encoding headers
      delete headers['content-encoding'];
      delete headers['content-length'];

      const decomp = makeDecompressor(enc);

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

  // Timeout: if upstream doesn't respond within N seconds, unblock the browser.
  // Without this, one stalled API call during GFN's startup sequence causes
  // the loading screen to hang until the browser's own timeout fires (~2 min).
  upReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
    upReq.destroy(new Error(`upstream timeout after ${UPSTREAM_TIMEOUT_MS}ms`));
  });

  upReq.on('error', err => safeError(err.message));

  // Pipe request body using events instead of pipeline() to avoid a conflict
  // where both pipeline's internal error handler and upReq.on('error') would
  // attempt to handle the same failure and write to an already-closed response.
  req.on('data',  chunk => { if (!upReq.destroyed) upReq.write(chunk); });
  req.on('end',   ()    => { if (!upReq.destroyed) upReq.end(); });
  req.on('error', err   => { console.error('[proxy] client req error:', err.message); upReq.destroy(); });
}

// ─── WebSocket / Upgrade handler ──────────────────────────────────────────────
//
// GFN uses WebSocket for game session signalling. We open a raw TLS socket to
// upstream and splice the byte streams together.
//
// WHY data events instead of pipe():
//   Bidirectional pipe() — upSocket.pipe(clientSocket) + clientSocket.pipe(upSocket)
//   — can deadlock under backpressure. If both sides fill their write buffers
//   simultaneously and neither drains, both pipes stall. With data events we
//   write directly and ignore backpressure (acceptable for a proxy that just
//   needs to forward WebSocket frames without buffering them).

function handleUpgrade(req, clientSocket, head) {
  clientSocket.setNoDelay(true);

  const { target, path } = resolveRoute(req.url);
  const upUrl  = new URL(path, target);
  const upPort = Number(upUrl.port) || 443;

  const upSocket = tls.connect(
    { host: upUrl.hostname, port: upPort, servername: upUrl.hostname },
    () => {
      upSocket.setNoDelay(true);

      // Replay the HTTP Upgrade handshake to upstream
      const fwdLines = Object.entries(req.headers)
        .filter(([k]) => {
          const kl = k.toLowerCase();
          return !HOP_BY_HOP.has(kl) && kl !== 'host';
        })
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n');

      upSocket.write(
        `GET ${upUrl.pathname}${upUrl.search} HTTP/1.1\r\n` +
        `host: ${upUrl.hostname}\r\n` +
        `origin: ${target}\r\n` +
        (fwdLines ? fwdLines + '\r\n' : '') +
        'connection: Upgrade\r\n' +
        'upgrade: websocket\r\n' +
        '\r\n'
      );

      if (head && head.length) upSocket.write(head);

      // Bidirectional splice via data events — no pipe(), no deadlocks
      upSocket.on('data', chunk => { if (!clientSocket.destroyed) clientSocket.write(chunk); });
      clientSocket.on('data', chunk => { if (!upSocket.destroyed) upSocket.write(chunk); });
    }
  );

  const cleanup = () => {
    if (!upSocket.destroyed)    upSocket.destroy();
    if (!clientSocket.destroyed) clientSocket.destroy();
  };

  upSocket.on('end',   () => { if (!clientSocket.destroyed) clientSocket.end(); });
  clientSocket.on('end', () => { if (!upSocket.destroyed) upSocket.end(); });
  upSocket.on('error',   err => { console.error('[ws] upstream:', err.message); cleanup(); });
  clientSocket.on('error', () => cleanup());
  upSocket.on('close',   () => { if (!clientSocket.destroyed) clientSocket.destroy(); });
  clientSocket.on('close', () => { if (!upSocket.destroyed) upSocket.destroy(); });
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
server.keepAliveTimeout = 120_000;
server.headersTimeout   = 125_000;

server.listen(PORT, () => {
  console.log(`[proxy] port=${PORT}  PROXY_HOST=${PROXY_HOST}`);
});

module.exports = { server };
