'use strict';

/**
 * IMPORTANT — http-proxy-middleware API version compatibility:
 *
 *   v2.x  →  onProxyReq / onProxyRes / onError  (flat keys on the config object)
 *   v3.x  →  on: { proxyReq, proxyRes, error }  (nested under `on`)
 *
 * The previous version used v3 syntax.  If your installed version is v2 the
 * entire `on` block is silently ignored — no header stripping, no body
 * rewriting, no SRI removal.  This file uses v2-style flat keys so it works
 * regardless of which version you have installed.
 *
 * To check: `npm list http-proxy-middleware`
 * To pin v2: `npm install http-proxy-middleware@^2.0.6`
 */

const express = require('express');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');

const app = express();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PROXY_HOST = (process.env.PROXY_HOST || 'http://localhost:3000').replace(/\/$/, '');

// All upstream domains the GFN frontend may reference → mapped to proxy paths.
// Add more here as you discover them in DevTools Network tab.
const DOMAIN_MAP = {
  'https://play.geforcenow.com':                        PROXY_HOST,
  'https://login.nvidia.com':                           `${PROXY_HOST}/auth`,
  'https://www.nvidia.com':                             `${PROXY_HOST}/nvidia`,
  'https://assets.nvidiagrid.net':                      `${PROXY_HOST}/nvidiagrid`,
  'https://gfnjpstorageaccount.blob.core.windows.net':  `${PROXY_HOST}/gfnblob`,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rewriteUpstreamUrl(str) {
  for (const [upstream, local] of Object.entries(DOMAIN_MAP)) {
    str = str.split(upstream).join(local);
  }
  return str;
}

/**
 * Mutates the headers object in-place — removes every security / isolation
 * header that would break the proxied page under a different origin.
 */
function sanitizeHeaders(headers) {
  const DROP = [
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
  ];
  DROP.forEach(h => delete headers[h]);

  if (headers['location']) {
    headers['location'] = rewriteUpstreamUrl(headers['location']);
  }

  if (headers['set-cookie']) {
    headers['set-cookie'] = headers['set-cookie'].map(c =>
      c
        .replace(/;\s*Domain=[^;]*/gi, '')
        .replace(/;\s*SameSite=\w+/gi, '; SameSite=Lax')
        .replace(/;\s*Secure/gi,
          process.env.NODE_ENV === 'production' ? '; Secure' : '')
    );
  }
}

/**
 * Strip SRI integrity and crossorigin attributes from HTML.
 *
 * Uses a negative lookbehind so it matches even when there is no whitespace
 * immediately before the attribute name (minified / newline-separated HTML).
 */
function stripSRI(html) {
  html = html.replace(/(?<![a-zA-Z0-9_-])integrity\s*=\s*"[^"]*"/gi,  '');
  html = html.replace(/(?<![a-zA-Z0-9_-])integrity\s*=\s*'[^']*'/gi,  '');
  html = html.replace(/(?<![a-zA-Z0-9_-])crossorigin\s*=\s*"[^"]*"/gi,'');
  html = html.replace(/(?<![a-zA-Z0-9_-])crossorigin\s*=\s*'[^']*'/gi,'');
  return html;
}

const REWRITABLE_TYPES = [
  'text/html',
  'text/css',
  'application/javascript',
  'application/x-javascript',
  'text/javascript',
  'application/json',
  'text/plain',
  'application/manifest+json',
  'application/xml',
  'text/xml',
];
const isRewritable = (ct = '') => REWRITABLE_TYPES.some(t => ct.includes(t));

// ---------------------------------------------------------------------------
// Service-worker neutralisation
//
// GFN's SW registers with scope / and intercepts ALL requests once installed,
// serving stale cached HTML that still has the original integrity= attributes.
// Fix: replace the SW file with a stub that immediately unregisters & clears
// caches.  This route must be registered BEFORE any proxy middleware.
// ---------------------------------------------------------------------------

const SW_STUB = `
/* Proxy-injected stub — replaces gfn-service-worker.js */
self.addEventListener('install', () => { console.log('[stub-sw] install'); self.skipWaiting(); });
self.addEventListener('activate', async () => {
  console.log('[stub-sw] activate — clearing caches and unregistering');
  const keys = await caches.keys();
  await Promise.all(keys.map(k => caches.delete(k)));
  await self.registration.unregister();
  await self.clients.claim();
});
self.addEventListener('fetch', e => e.respondWith(fetch(e.request)));
`;

app.get(/gfn-service-worker\.js(\?.*)?$/, (_req, res) => {
  res.setHeader('Content-Type',          'application/javascript; charset=utf-8');
  res.setHeader('Service-Worker-Allowed','/')
  res.setHeader('Cache-Control',         'no-store, no-cache, must-revalidate');
  res.send(SW_STUB);
});

// Snippet injected into every HTML response body
const SW_UNREGISTER_SNIPPET = `<script>
/* proxy: unregister any previously-installed service workers on this origin */
(function(){
  if(!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.getRegistrations().then(function(regs){
    regs.forEach(function(r){ console.log('[proxy] unregistering SW',r.scope); r.unregister(); });
  });
  caches.keys().then(function(keys){
    keys.forEach(function(k){ console.log('[proxy] deleting cache',k); caches.delete(k); });
  });
}());
</script>`;

// ---------------------------------------------------------------------------
// Body rewriter  (responseInterceptor requires selfHandleResponse:true)
// ---------------------------------------------------------------------------
const bodyRewriter = responseInterceptor(
  async (responseBuffer, proxyRes, _req, _res) => {
    // Always sanitize headers — even for binary responses
    sanitizeHeaders(proxyRes.headers);

    const ct = proxyRes.headers['content-type'] || '';
    if (!isRewritable(ct)) return responseBuffer; // binary asset — pass through

    let body = responseBuffer.toString('utf8');

    if (ct.includes('text/html')) {
      body = stripSRI(body);

      // Inject unregister snippet immediately after <head>
      if (!body.includes('proxy: unregister')) {
        body = body.replace(/(<head[^>]*>)/i, '$1' + SW_UNREGISTER_SNIPPET);
        if (!body.includes('proxy: unregister')) {
          body = SW_UNREGISTER_SNIPPET + body; // no <head> tag fallback
        }
      }

      // Tell browser to nuke SW registrations + caches from prior visits
      proxyRes.headers['clear-site-data'] = '"cache", "cookies", "storage"';
    }

    return Buffer.from(rewriteUpstreamUrl(body), 'utf8');
  }
);

// ---------------------------------------------------------------------------
// Request header rewriter
// ---------------------------------------------------------------------------
function makeReqHandler(upstreamOrigin) {
  const { host } = new URL(upstreamOrigin);
  return (proxyReq, req) => {
    proxyReq.setHeader('host',    host);
    proxyReq.setHeader('origin',  upstreamOrigin);
    proxyReq.setHeader('referer', upstreamOrigin + '/');
    proxyReq.removeHeader('accept-encoding'); // force plaintext responses
    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';
    if (ip) proxyReq.setHeader('x-forwarded-for', ip);
  };
}

// ---------------------------------------------------------------------------
// Proxy factory — uses FLAT v2-style keys (onProxyReq / onProxyRes / onError)
// so it works whether http-proxy-middleware v2 OR v3 is installed.
// ---------------------------------------------------------------------------
function makeProxy(target, { pathRewrite } = {}) {
  return createProxyMiddleware({
    target,
    changeOrigin:        true,
    ws:                  true,
    followRedirects:     false,
    selfHandleResponse:  true,        // required by responseInterceptor
    cookieDomainRewrite: { '*': '' },
    cookiePathRewrite:   { '*': '/' },
    ...(pathRewrite ? { pathRewrite } : {}),

    // ── v2-style flat event keys ──────────────────────────────────────────
    onProxyReq:  makeReqHandler(target),
    onProxyRes:  bodyRewriter,
    onError(err, req, res) {
      console.error(`[proxy:error] ${req.method} ${req.url}`, err.message);
      if (res && !res.headersSent) res.status(502).send('Proxy error: ' + err.message);
    },
  });
}

// ---------------------------------------------------------------------------
// Routes — specific paths before the catch-all
// ---------------------------------------------------------------------------
app.use('/auth',       makeProxy('https://login.nvidia.com',
                         { pathRewrite: { '^/auth': '' } }));
app.use('/nvidia',     makeProxy('https://www.nvidia.com',
                         { pathRewrite: { '^/nvidia': '' } }));
app.use('/nvidiagrid', makeProxy('https://assets.nvidiagrid.net',
                         { pathRewrite: { '^/nvidiagrid': '' } }));
app.use('/gfnblob',    makeProxy('https://gfnjpstorageaccount.blob.core.windows.net',
                         { pathRewrite: { '^/gfnblob': '' } }));
app.use('/',           makeProxy('https://play.geforcenow.com'));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`[proxy] port=${PORT}  PROXY_HOST=${PROXY_HOST}`);
});

server.on('upgrade', (req, _socket, _head) => {
  console.log(`[ws:upgrade] ${req.url}`);
});

module.exports = { app, server };
