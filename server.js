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
 *
 * npm install compression   ← required
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express    = require('express');
const compression = require('compression');
const { createProxyMiddleware } = require('http-proxy-middleware');
const zlib       = require('zlib');
const { Transform } = require('stream');

const app = express();
app.use(compression());

// ─── Config ──────────────────────────────────────────────────────────────────

const PROXY_HOST = (process.env.PROXY_HOST || 'http://localhost:3000').replace(/\/$/, '');

const DOMAIN_MAP = {
  'https://play.geforcenow.com':                        PROXY_HOST,
  'https://login.nvidia.com':                           `${PROXY_HOST}/auth`,
  'https://www.nvidia.com':                             `${PROXY_HOST}/nvidia`,
  'https://assets.nvidiagrid.net':                      `${PROXY_HOST}/nvidiagrid`,
  'https://gfnjpstorageaccount.blob.core.windows.net':  `${PROXY_HOST}/gfnblob`,
};

// Longest upstream URL length — used for chunk-boundary overlap buffer
const MAX_DOMAIN_LEN = Math.max(...Object.keys(DOMAIN_MAP).map(k => k.length));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function rewriteUpstreamUrl(str) {
  for (const [up, local] of Object.entries(DOMAIN_MAP))
    str = str.split(up).join(local);
  return str;
}

function sanitizeHeaders(headers) {
  [
    'x-frame-options','content-security-policy','content-security-policy-report-only',
    'cross-origin-opener-policy','cross-origin-embedder-policy',
    'cross-origin-resource-policy','strict-transport-security',
    'x-content-type-options','x-xss-protection','report-to','nel',
  ].forEach(h => delete headers[h]);

  if (headers['location'])
    headers['location'] = rewriteUpstreamUrl(headers['location']);

  if (headers['set-cookie'])
    headers['set-cookie'] = headers['set-cookie'].map(c =>
      c.replace(/;\s*Domain=[^;]*/gi, '')
       .replace(/;\s*SameSite=\w+/gi,  '; SameSite=Lax')
       .replace(/;\s*Secure/gi, process.env.NODE_ENV === 'production' ? '; Secure' : '')
    );
}

function stripSRI(html) {
  html = html.replace(/(?<![a-zA-Z0-9_-])integrity\s*=\s*"[^"]*"/gi,   '');
  html = html.replace(/(?<![a-zA-Z0-9_-])integrity\s*=\s*'[^']*'/gi,   '');
  html = html.replace(/(?<![a-zA-Z0-9_-])crossorigin\s*=\s*"[^"]*"/gi, '');
  html = html.replace(/(?<![a-zA-Z0-9_-])crossorigin\s*=\s*'[^']*'/gi, '');
  return html;
}

const REWRITABLE = [
  'text/html','text/css',
  'application/javascript','application/x-javascript','text/javascript',
  'application/json','application/manifest+json',
  'text/plain','text/xml','application/xml',
];
const isRewritable = (ct = '') => REWRITABLE.some(t => ct.includes(t));
const isHTML       = (ct = '') => ct.includes('text/html');

// ─── Streaming domain-rewrite Transform ───────────────────────────────────────
//
// Rewrites domain strings on-the-fly as chunks flow through.
// Maintains an overlap buffer of MAX_DOMAIN_LEN chars between chunks so a
// domain name that straddles a chunk boundary is still rewritten correctly.
//
function createRewriteStream() {
  let leftover = '';

  return new Transform({
    transform(chunk, _enc, cb) {
      const str  = leftover + chunk.toString('utf8');
      leftover   = str.slice(-MAX_DOMAIN_LEN);   // hold back tail for next chunk
      const safe = str.slice(0, str.length - MAX_DOMAIN_LEN);
      cb(null, Buffer.from(rewriteUpstreamUrl(safe), 'utf8'));
    },
    flush(cb) {
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
//
// Called from onProxyRes.  With selfHandleResponse:true the library does NOT
// pipe proxyRes → res; we are fully responsible for sending the response.
//
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

  // For text responses we decompress ourselves, so tell the browser the body
  // will be plain (compression() middleware will re-gzip it if accepted)
  delete proxyRes.headers['content-encoding'];
  delete proxyRes.headers['content-length'];   // length will change after rewrite

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

      // Inject SW unregister snippet immediately after <head>
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

// Must be registered before ANY proxy middleware
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
    selfHandleResponse:  true,           // we pipe the response manually above
    cookieDomainRewrite: { '*': '' },
    cookiePathRewrite:   { '*': '/' },
    ...(pathRewrite ? { pathRewrite } : {}),

    onProxyReq(proxyReq, req) {
      proxyReq.setHeader('host',    host);
      proxyReq.setHeader('origin',  target);
      proxyReq.setHeader('referer', target + '/');
      // Keep accept-encoding — CDN sends compressed, we decompress ourselves
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
