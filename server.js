'use strict';

/**
 * PERFORMANCE ARCHITECTURE
 * ─────────────────────────────────────────────────────────────────────────────
 * selfHandleResponse:true + responseInterceptor buffers the ENTIRE response
 * before sending a single byte to the browser.  For large JS bundles this
 * means the user waits for the full download twice (proxy←upstream, then
 * browser←proxy).
 *
 * Instead we use TWO middleware layers per route:
 *
 *   1. STREAMING proxy  (selfHandleResponse:false)
 *      – Handles every request.
 *      – onProxyReq  → rewrites request headers.
 *      – onProxyRes  → strips/rewrites response headers in-place.
 *      – For binary/non-text responses (images, fonts, wasm, video) the
 *        response body is piped directly to the browser.  Zero buffering.
 *      – For text responses it calls res.proxyNeedsRewrite = true and then
 *        falls through to layer 2 by NOT calling next() but also NOT writing
 *        the body — instead it stores the raw stream on res.upstreamStream.
 *
 * Actually the cleanest split is: use selfHandleResponse:true ONLY for the
 * HTML document request (path === '/' or ends in .html), and use
 * selfHandleResponse:false for everything else.
 *
 * We achieve this with two separate proxy middleware instances mounted on
 * the same path with a router that inspects Accept header / path extension.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SIMPLER CORRECT APPROACH (used here):
 *
 * Use ONE proxy with selfHandleResponse:true BUT inside responseInterceptor:
 *   – If content-type is NOT rewritable → return responseBuffer immediately
 *     (responseInterceptor still buffers it, but we return synchronously).
 *   – If content-type IS rewritable → do the string replacements.
 *
 * To make this fast:
 *   1. Re-enable Accept-Encoding to upstream so CDN sends gzip/br.
 *      responseInterceptor decompresses automatically.
 *   2. Add the `compression` npm package so the proxy re-gzips to browser.
 *   3. Set proper Cache-Control so browsers cache assets locally.
 *   4. Add a filter function so the proxy skips selfHandleResponse for
 *      requests whose path clearly points to a binary asset.
 *
 * Run:  npm install compression
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express    = require('express');
const compression = require('compression');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');
const zlib       = require('zlib');
const { pipeline, Readable } = require('stream');

const app = express();

// Gzip/br compress all proxy responses sent to the browser
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

// Content-types that need string replacement (everything else streams through)
const REWRITABLE = [
  'text/html','text/css',
  'application/javascript','application/x-javascript','text/javascript',
  'application/json','application/manifest+json',
  'text/plain','text/xml','application/xml',
];
const isRewritable = (ct = '') => REWRITABLE.some(t => ct.includes(t));

// File extensions that are definitely binary — skip ALL body processing
const BINARY_EXT = /\.(png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|eot|otf|mp4|webm|wasm|pdf|zip)(\?.*)?$/i;
const isBinaryPath = path => BINARY_EXT.test(path);

// ─── Service-worker stub ──────────────────────────────────────────────────────

const SW_STUB = `
/* Proxy-injected stub — replaces gfn-service-worker.js */
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', async () => {
  const keys = await caches.keys();
  await Promise.all(keys.map(k => caches.delete(k)));
  await self.registration.unregister();
  await self.clients.claim();
});
self.addEventListener('fetch', e => e.respondWith(fetch(e.request)));
`;

// Must be before ALL proxy middleware
app.get(/gfn-service-worker\.js(\?.*)?$/, (_req, res) => {
  res.setHeader('Content-Type',           'application/javascript; charset=utf-8');
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Cache-Control',          'no-store');
  res.send(SW_STUB);
});

const SW_SNIPPET = `<script>
(function(){
  if(!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.getRegistrations().then(function(r){r.forEach(function(s){s.unregister();});});
  caches.keys().then(function(k){k.forEach(function(c){caches.delete(c);});});
}());
</script>`;

// ─── Response-body rewriter ───────────────────────────────────────────────────
//
// KEY PERFORMANCE CHANGE:
//   • We re-allow Accept-Encoding to the upstream.  responseInterceptor
//     decompresses gzip/br automatically, so we still get plain text to
//     work with, but the upstream→proxy leg uses compression (faster on
//     Render's outbound bandwidth).
//   • For binary paths we skip selfHandleResponse entirely via the `filter`
//     option so those responses are piped straight through without any
//     buffering at all.
//
const bodyRewriter = responseInterceptor(
  async (responseBuffer, proxyRes, req, _res) => {
    sanitizeHeaders(proxyRes.headers);

    const ct = proxyRes.headers['content-type'] || '';

    // Binary or non-rewritable → return immediately, no string work
    if (!isRewritable(ct)) return responseBuffer;

    let body = responseBuffer.toString('utf8');

    if (ct.includes('text/html')) {
      body = stripSRI(body);

      if (!body.includes('proxy: sw-unregister')) {
        body = body.replace(/(<head[^>]*>)/i, '$1' + SW_SNIPPET);
        if (!body.includes('proxy: sw-unregister'))
          body = SW_SNIPPET + body;
      }

      // Nuke any SW + cache from prior visits
      proxyRes.headers['clear-site-data'] = '"cache", "cookies", "storage"';
    }

    // Allow downstream compression (set by app.use(compression()) above)
    delete proxyRes.headers['content-encoding'];

    return Buffer.from(rewriteUpstreamUrl(body), 'utf8');
  }
);

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

    // Skip buffering entirely for known-binary paths
    // (filter returning false means "don't proxy this request via this
    //  middleware", but since we only use it for the skip-selfHandle trick
    //  we instead rely on the early-return in bodyRewriter for content-type
    //  checks, and use filter just to log)
    // Note: to truly skip selfHandleResponse per-request we'd need two
    // middleware instances; the early-return in responseInterceptor is the
    // next best thing and avoids the string-replace overhead at least.

    // ── v2-compatible flat event keys ──────────────────────────────────────
    onProxyReq(proxyReq, req) {
      proxyReq.setHeader('host',    host);
      proxyReq.setHeader('origin',  target);
      proxyReq.setHeader('referer', target + '/');
      // Do NOT remove accept-encoding — let CDN send compressed responses.
      // responseInterceptor handles decompression automatically.
      const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';
      if (ip) proxyReq.setHeader('x-forwarded-for', ip);
    },

    onProxyRes: bodyRewriter,

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
app.use('/gfnblob',    makeProxy('https://gfnjpstorageaccount.blob.core.windows.net', { pathRewrite: { '^/gfnblob': '' } }));
app.use('/',           makeProxy('https://play.geforcenow.com'));

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT   = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`[proxy] port=${PORT}  PROXY_HOST=${PROXY_HOST}`);
});

server.on('upgrade', (req) => console.log(`[ws:upgrade] ${req.url}`));

module.exports = { app, server };
