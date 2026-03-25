'use strict';

/**
 * STREAMING PROXY ARCHITECTURE
 * ─────────────────────────────────────────────────────────────────────────────
 * Previous versions used responseInterceptor which buffers the ENTIRE response
 * before sending byte 1 to the browser. A 3MB JS bundle = browser waits for
 * the full upstream download before anything renders.
 *
 * This version uses a custom onProxyRes with selfHandleResponse:true and
 * splits into three pipelines based on content-type:
 *
 *   BINARY  (images/fonts/wasm/video)
 *     proxyRes ──────────────────────────────────────► res
 *     Zero buffering. First byte arrives at browser immediately.
 *
 *   TEXT/JS/CSS/JSON
 *     proxyRes ──► decompress ──► RewriteTransform ──► res
 *     Streaming domain rewrite. First byte arrives after one chunk (~64KB).
 *     Handles chunk-boundary splits with an overlap buffer.
 *
 *   HTML  (small, needs SRI stripping + SW snippet injection)
 *     proxyRes ──► decompress ──► buffer ──► stripSRI+inject ──► res
 *     Buffered but HTML is ~50KB so this is fast.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express    = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const zlib       = require('zlib');
const { Transform } = require('stream');

// NOTE: compression() middleware removed — it re-gzips every body we already
// decompressed from the CDN, wasting CPU and adding latency on large bundles.
// If you need outbound gzip, add it selectively per-route.

const app = express();

// ─── Config ──────────────────────────────────────────────────────────────────

const PROXY_HOST = (process.env.PROXY_HOST || 'http://localhost:3000').replace(/\/$/, '');

const DOMAIN_MAP = {
  'https://play.geforcenow.com':                        PROXY_HOST,
  'https://login.nvidia.com':                           `${PROXY_HOST}/auth`,
  'https://www.nvidia.com':                             `${PROXY_HOST}/nvidia`,
  'https://assets.nvidiagrid.net':                      `${PROXY_HOST}/nvidiagrid`,
  'https://gfnjpstorageaccount.blob.core.windows.net':  `${PROXY_HOST}/gfnblob`,
};

// ─── Precompiled domain rewrite ───────────────────────────────────────────────
//
// KEY PERF FIX: Previously rewriteUpstreamUrl did N separate split().join()
// passes (one per domain), allocating a new string each time. A single compiled
// RegExp rewrites all domains in ONE pass through the string, and the replace
// callback only fires on actual matches.

const DOMAIN_ENTRIES = Object.entries(DOMAIN_MAP);

const DOMAIN_REGEX = new RegExp(
  DOMAIN_ENTRIES
    .map(([up]) => up.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|'),
  'g'
);

function rewriteUpstreamUrl(str) {
  // Short-circuit: if no upstream domain appears in the string, skip replace()
  // entirely. Most chunks in large JS bundles won't contain any domain.
  if (!str.includes('nvidia') && !str.includes('geforcenow') && !str.includes('gfnjpstorageaccount')) {
    return str;
  }
  return str.replace(DOMAIN_REGEX, match => DOMAIN_MAP[match]);
}

// Longest upstream URL length — used for chunk-boundary overlap buffer
const MAX_DOMAIN_LEN = Math.max(...DOMAIN_ENTRIES.map(([k]) => k.length));

// ─── Precompiled content-type checks ─────────────────────────────────────────
//
// Previously isRewritable / isHTML scanned an array on every request.
// A compiled regex is a single C-level call.

const REWRITABLE_RE = /text\/html|text\/css|text\/plain|text\/xml|application\/(javascript|x-javascript|json|manifest\+json|xml)/i;
const HTML_RE       = /text\/html/i;

const isRewritable = (ct = '') => REWRITABLE_RE.test(ct);
const isHTML       = (ct = '') => HTML_RE.test(ct);

// ─── Header sanitization ──────────────────────────────────────────────────────
//
// Use a Set for O(1) membership checks instead of forEach on an array.

const DROP_HEADERS = new Set([
  'x-frame-options','content-security-policy','content-security-policy-report-only',
  'cross-origin-opener-policy','cross-origin-embedder-policy',
  'cross-origin-resource-policy','strict-transport-security',
  'x-content-type-options','x-xss-protection','report-to','nel',
]);

function sanitizeHeaders(headers) {
  for (const h of DROP_HEADERS) delete headers[h];

  if (headers['location'])
    headers['location'] = rewriteUpstreamUrl(headers['location']);

  if (headers['set-cookie'])
    headers['set-cookie'] = headers['set-cookie'].map(c =>
      c.replace(/;\s*Domain=[^;]*/gi, '')
       .replace(/;\s*SameSite=\w+/gi,  '; SameSite=Lax')
       .replace(/;\s*Secure/gi, process.env.NODE_ENV === 'production' ? '; Secure' : '')
    );
}

// ─── SRI stripping ────────────────────────────────────────────────────────────
//
// Precompile SRI/crossorigin regexes once instead of inline.

const SRI_RE_DQ   = /(?<![a-zA-Z0-9_-])integrity\s*=\s*"[^"]*"/gi;
const SRI_RE_SQ   = /(?<![a-zA-Z0-9_-])integrity\s*=\s*'[^']*'/gi;
const CORS_RE_DQ  = /(?<![a-zA-Z0-9_-])crossorigin\s*=\s*"[^"]*"/gi;
const CORS_RE_SQ  = /(?<![a-zA-Z0-9_-])crossorigin\s*=\s*'[^']*'/gi;

function stripSRI(html) {
  return html
    .replace(SRI_RE_DQ,  '')
    .replace(SRI_RE_SQ,  '')
    .replace(CORS_RE_DQ, '')
    .replace(CORS_RE_SQ, '');
}

// ─── Streaming domain-rewrite Transform ───────────────────────────────────────
//
// Rewrites domain strings on-the-fly as chunks flow through.
// Maintains an overlap buffer of MAX_DOMAIN_LEN chars between chunks so a
// domain name that straddles a chunk boundary is still rewritten correctly.

function createRewriteStream() {
  let leftover = '';

  return new Transform({
    transform(chunk, _enc, cb) {
      const str    = leftover + chunk.toString('utf8');
      leftover     = str.slice(-MAX_DOMAIN_LEN);  // hold back tail for next chunk
      const safe   = str.slice(0, str.length - MAX_DOMAIN_LEN);
      const result = rewriteUpstreamUrl(safe);
      // Avoid unnecessary Buffer allocation when nothing changed
      cb(null, result === safe ? Buffer.from(safe, 'utf8') : Buffer.from(result, 'utf8'));
    },
    flush(cb) {
      if (!leftover) return cb();
      cb(null, Buffer.from(rewriteUpstreamUrl(leftover), 'utf8'));
    },
  });
}

// ─── Decompressor factory ─────────────────────────────────────────────────────

function createDecompressor(encoding) {
  switch ((encoding || '').toLowerCase()) {
    case 'gzip':    return zlib.createGunzip();
    case 'br':      return zlib.createBrotliDecompress();
    case 'deflate': return zlib.createInflate();
    default:        return null;
  }
}

// ─── Core response handler ────────────────────────────────────────────────────

function handleProxyResponse(proxyRes, req, res) {
  sanitizeHeaders(proxyRes.headers);

  const ct       = proxyRes.headers['content-type'] || '';
  const encoding = proxyRes.headers['content-encoding'];

  // ── 1. BINARY — stream straight through, no touching ─────────────────────
  if (!isRewritable(ct)) {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
    proxyRes.on('error', () => res.end());
    return;
  }

  // For text responses we decompress ourselves
  delete proxyRes.headers['content-encoding'];
  delete proxyRes.headers['content-length'];

  // ── 2. HTML — buffer (small), strip SRI, inject SW snippet ───────────────
  if (isHTML(ct)) {
    proxyRes.headers['clear-site-data'] = '"cache", "cookies", "storage"';
    res.writeHead(proxyRes.statusCode, proxyRes.headers);

    const decompressor = createDecompressor(encoding);
    const source = decompressor ? proxyRes.pipe(decompressor) : proxyRes;

    const chunks = [];
    source.on('data', c => chunks.push(c));
    source.on('end', () => {
      let body = Buffer.concat(chunks).toString('utf8');
      body = stripSRI(body);

      const snippet = `<script>
/* proxy */
(function(){
  if(!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.getRegistrations().then(function(r){r.forEach(function(s){s.unregister();});});
  caches.keys().then(function(k){k.forEach(function(c){caches.delete(c);});});
}());
</script>`;
      if (!body.includes('/* proxy */')) {
        const patched = body.replace(/(<head[^>]*>)/i, '$1' + snippet);
        body = patched.includes('/* proxy */') ? patched : snippet + body;
      }

      body = rewriteUpstreamUrl(body);
      res.end(Buffer.from(body, 'utf8'));
    });
    source.on('error', err => {
      console.error('[proxy] html decompress error:', err.message);
      if (!res.writableEnded) res.end();
    });
    return;
  }

  // ── 3. JS / CSS / JSON — streaming rewrite, first byte ASAP ─────────────
  res.writeHead(proxyRes.statusCode, proxyRes.headers);

  const decompressor  = createDecompressor(encoding);
  const rewriteStream = createRewriteStream();
  const source        = decompressor ? proxyRes.pipe(decompressor) : proxyRes;

  source.pipe(rewriteStream).pipe(res);

  source.on('error', err => {
    console.error('[proxy] js/css decompress error:', err.message);
    if (!res.writableEnded) res.end();
  });
  rewriteStream.on('error', err => {
    console.error('[proxy] rewrite stream error:', err.message);
    if (!res.writableEnded) res.end();
  });
}

// ─── Service-worker stub ──────────────────────────────────────────────────────

const SW_STUB = `
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', async () => {
  const keys = await caches.keys();
  await Promise.all(keys.map(k => caches.delete(k)));
  await self.registration.unregister();
  await self.clients.claim();
});
self.addEventListener('fetch', e => e.respondWith(fetch(e.request)));
`;

app.get(/gfn-service-worker\.js(\?.*)?$/, (_req, res) => {
  res.setHeader('Content-Type',           'application/javascript; charset=utf-8');
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Cache-Control',          'no-store');
  res.send(SW_STUB);
});

// ─── Proxy factory ────────────────────────────────────────────────────────────

function makeProxy(target, { pathRewrite } = {}) {
  const { host } = new URL(target);

  return createProxyMiddleware({
    target,
    changeOrigin:        true,
    ws:                  true,
    followRedirects:     false,
    selfHandleResponse:  true,
    cookieDomainRewrite: { '*': '' },
    cookiePathRewrite:   { '*': '/' },
    ...(pathRewrite ? { pathRewrite } : {}),

    onProxyReq(proxyReq, req) {
      proxyReq.setHeader('host',    host);
      proxyReq.setHeader('origin',  target);
      proxyReq.setHeader('referer', target + '/');
      const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';
      if (ip) proxyReq.setHeader('x-forwarded-for', ip);
    },

    onProxyRes: handleProxyResponse,

    onError(err, req, res) {
      console.error(`[proxy:error] ${req.method} ${req.url}`, err.message);
      if (res && !res.headersSent) res.status(502).send('Proxy error: ' + err.message);
    },
  });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use('/auth',       makeProxy('https://login.nvidia.com',     { pathRewrite: { '^/auth': '' } }));
app.use('/nvidia',     makeProxy('https://www.nvidia.com',       { pathRewrite: { '^/nvidia': '' } }));
app.use('/nvidiagrid', makeProxy('https://assets.nvidiagrid.net',{ pathRewrite: { '^/nvidiagrid': '' } }));
app.use('/gfnblob',    makeProxy('https://gfnjpstorageaccount.blob.core.windows.net',
                         { pathRewrite: { '^/gfnblob': '' } }));
app.use('/',           makeProxy('https://play.geforcenow.com'));

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT   = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`[proxy] port=${PORT}  PROXY_HOST=${PROXY_HOST}`);
});

server.on('upgrade', req => console.log(`[ws:upgrade] ${req.url}`));

module.exports = { app, server };
