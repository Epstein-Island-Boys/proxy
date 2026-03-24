'use strict';

const express = require('express');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');

const app = express();

// ─── Config ────────────────────────────────────────────────────────────────────
// Set PROXY_HOST to your full public URL, e.g. https://prokc.onrender.com
const PROXY_HOST = (process.env.PROXY_HOST || 'http://localhost:3000').replace(/\/$/, '');

// Every upstream domain the GFN frontend may reference, mapped to the
// path prefix on THIS proxy that handles it.
const DOMAIN_MAP = {
  'https://play.geforcenow.com':                        PROXY_HOST,
  'https://login.nvidia.com':                           `${PROXY_HOST}/auth`,
  'https://www.nvidia.com':                             `${PROXY_HOST}/nvidia`,
  'https://assets.nvidiagrid.net':                      `${PROXY_HOST}/nvidiagrid`,
  'https://gfnjpstorageaccount.blob.core.windows.net':  `${PROXY_HOST}/gfnblob`,
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

function rewriteUpstreamUrl(str) {
  for (const [upstream, local] of Object.entries(DOMAIN_MAP)) {
    str = str.split(upstream).join(local);
  }
  return str;
}

function sanitizeResponseHeaders(headers) {
  [
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
  ].forEach(h => delete headers[h]);

  if (headers['location']) {
    headers['location'] = rewriteUpstreamUrl(headers['location']);
  }

  if (headers['set-cookie']) {
    headers['set-cookie'] = headers['set-cookie'].map(c =>
      c
        .replace(/;\s*Domain=[^;]*/gi, '')
        .replace(/;\s*SameSite=\w+/gi, '; SameSite=Lax')
        .replace(/;\s*Secure/gi, process.env.NODE_ENV === 'production' ? '; Secure' : '')
    );
  }
}

/**
 * Strip SRI integrity attributes from HTML.
 *
 * WHY THE PREVIOUS REGEX FAILED:
 * The old pattern used \s+ (requires whitespace BEFORE the attribute name).
 * In minified HTML the attribute can follow immediately after the previous
 * attribute value with no space, or be separated only by a newline that the
 * minifier absorbed.  We now use a negative lookbehind for word chars so we
 * match the attribute regardless of what precedes it.
 */
function stripSRI(html) {
  // integrity="sha384-..." or integrity='sha384-...'
  html = html.replace(/(?<![a-zA-Z0-9_-])integrity\s*=\s*"[^"]*"/gi, '');
  html = html.replace(/(?<![a-zA-Z0-9_-])integrity\s*=\s*'[^']*'/gi, '');
  // crossorigin="..." or crossorigin='...'
  html = html.replace(/(?<![a-zA-Z0-9_-])crossorigin\s*=\s*"[^"]*"/gi, '');
  html = html.replace(/(?<![a-zA-Z0-9_-])crossorigin\s*=\s*'[^']*'/gi, '');
  return html;
}

const REWRITABLE = [
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

function isRewritable(ct = '') {
  return REWRITABLE.some(t => ct.includes(t));
}

// ─── Service-worker neutralisation ─────────────────────────────────────────────
//
// ROOT CAUSE OF THE PERSISTENT SRI ERROR:
//   GFN registers gfn-service-worker.js with scope /.  Once installed the SW
//   intercepts ALL requests inside prokc.onrender.com — including the HTML
//   document — and serves stale cached versions that STILL contain the original
//   integrity="sha384-..." attributes.  Our proxy body-rewriter runs on the
//   response from the upstream, but if the SW short-circuits the request before
//   it ever reaches the network, the browser receives the unmodified cached
//   response and the integrity check fails again.
//
// THREE-LAYER FIX:
//   1. Replace the actual service-worker JS file with a stub that immediately
//      unregisters itself and clears all caches (handled below as an Express
//      route that runs BEFORE any proxy middleware).
//   2. Inject an inline <script> into every HTML response that unregisters any
//      already-running SW at page-load time (belt and suspenders).
//   3. Send Clear-Site-Data on every HTML response to nuke SW + caches from
//      any previous visit.
// ────────────────────────────────────────────────────────────────────────────────

const SW_STUB = `
/* Injected by proxy — replaces the real GFN service worker */
self.addEventListener('install', () => {
  console.log('[proxy-sw] install — skipping waiting');
  self.skipWaiting();
});
self.addEventListener('activate', async () => {
  console.log('[proxy-sw] activate — unregistering and clearing caches');
  // Delete every cache entry the real SW may have written
  const cacheKeys = await caches.keys();
  await Promise.all(cacheKeys.map(k => caches.delete(k)));
  // Unregister ourselves so we don't interfere further
  await self.registration.unregister();
  await self.clients.claim();
});
// Pass every fetch straight through — no caching at all
self.addEventListener('fetch', e => e.respondWith(fetch(e.request)));
`;

// Must be registered BEFORE the proxy middleware so Express handles it directly
app.get(/gfn-service-worker\.js(\?.*)?$/, (req, res) => {
  console.log('[sw-intercept]', req.path);
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.send(SW_STUB);
});

// Inline script injected into every proxied HTML page
const SW_UNREGISTER_SNIPPET = `<script>
/* proxy: unregister any previously installed service workers */
(function () {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.getRegistrations().then(function (regs) {
    regs.forEach(function (r) {
      console.log('[proxy] unregistering SW:', r.scope);
      r.unregister();
    });
  });
  caches.keys().then(function (keys) {
    keys.forEach(function (k) {
      console.log('[proxy] deleting cache:', k);
      caches.delete(k);
    });
  });
}());
</script>`;

// ─── Response body rewriter ─────────────────────────────────────────────────────
function buildBodyRewriter() {
  return responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
    // Sanitize headers on EVERY response regardless of content-type
    sanitizeResponseHeaders(proxyRes.headers);

    const ct = proxyRes.headers['content-type'] || '';
    if (!isRewritable(ct)) return responseBuffer;

    let body = responseBuffer.toString('utf8');

    if (ct.includes('text/html')) {
      // Layer 1: strip SRI hashes — must happen BEFORE domain rewrite so the
      //          regex targets the original attribute text unmodified
      body = stripSRI(body);

      // Layer 2: inject unregister script as early as possible in the document
      body = body.replace(/(<head[^>]*>)/i, '$1' + SW_UNREGISTER_SNIPPET);
      // Fallback if no <head> tag
      if (!body.includes(SW_UNREGISTER_SNIPPET)) {
        body = SW_UNREGISTER_SNIPPET + body;
      }

      // Layer 3: tell the browser to nuke SW registrations + caches from
      //          any previous visit (header must be set before body is sent)
      proxyRes.headers['clear-site-data'] = '"cache", "cookies", "storage"';
    }

    // Rewrite all upstream domain references to our proxy URLs
    body = rewriteUpstreamUrl(body);

    return Buffer.from(body, 'utf8');
  });
}

// ─── Request header rewriter ────────────────────────────────────────────────────
function buildReqHandler(upstreamOrigin) {
  const { host } = new URL(upstreamOrigin);
  return (proxyReq, req) => {
    proxyReq.setHeader('host',    host);
    proxyReq.setHeader('origin',  upstreamOrigin);
    proxyReq.setHeader('referer', upstreamOrigin + '/');
    // Force uncompressed responses so the body rewriter always sees plain text
    proxyReq.removeHeader('accept-encoding');
    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';
    if (ip) proxyReq.setHeader('x-forwarded-for', ip);
  };
}

// ─── Proxy factory ──────────────────────────────────────────────────────────────
const bodyRewriter = buildBodyRewriter(); // one shared instance is fine

function makeProxy(target, { pathRewrite } = {}) {
  return createProxyMiddleware({
    target,
    changeOrigin:       true,
    ws:                 true,
    followRedirects:    false,
    selfHandleResponse: true,   // required by responseInterceptor
    cookieDomainRewrite: { '*': '' },
    cookiePathRewrite:   { '*': '/' },
    ...(pathRewrite ? { pathRewrite } : {}),
    on: {
      proxyReq: buildReqHandler(target),
      proxyRes: bodyRewriter,
      error(err, req, res) {
        console.error(`[proxy:error] ${req.method} ${req.url}`, err.message);
        if (res && !res.headersSent) res.status(502).send(`Proxy error: ${err.message}`);
      },
    },
  });
}

// ─── Routes — specific paths BEFORE the catch-all ──────────────────────────────
app.use('/auth',       makeProxy('https://login.nvidia.com',     { pathRewrite: { '^/auth': '' } }));
app.use('/nvidia',     makeProxy('https://www.nvidia.com',       { pathRewrite: { '^/nvidia': '' } }));
app.use('/nvidiagrid', makeProxy('https://assets.nvidiagrid.net',{ pathRewrite: { '^/nvidiagrid': '' } }));
app.use('/gfnblob',    makeProxy('https://gfnjpstorageaccount.blob.core.windows.net', { pathRewrite: { '^/gfnblob': '' } }));
app.use('/',           makeProxy('https://play.geforcenow.com'));

// ─── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`[proxy] listening on :${PORT}`);
  console.log(`[proxy] PROXY_HOST = ${PROXY_HOST}`);
});

server.on('upgrade', (req, socket, head) => {
  console.log(`[ws:upgrade] ${req.url}`);
});

module.exports = { app, server };
