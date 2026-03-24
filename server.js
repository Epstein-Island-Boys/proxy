'use strict';

const express = require('express');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');
const zlib = require('zlib');

const app = express();

// ─── Domain map ────────────────────────────────────────────────────────────────
// Keys   = real upstream domains (no trailing slash)
// Values = the path prefix on YOUR proxy that maps to them
//
// When rewriting response bodies we replace every occurrence of a key
// with the corresponding proxy URL so the browser never navigates
// directly to an upstream domain.
// ────────────────────────────────────────────────────────────────────────────────
const PROXY_HOST = process.env.PROXY_HOST || 'http://localhost:3000'; // e.g. https://your-app.onrender.com

const DOMAIN_MAP = {
  'https://play.geforcenow.com':  PROXY_HOST,
  'https://login.nvidia.com':     `${PROXY_HOST}/auth`,
  'https://www.nvidia.com':       `${PROXY_HOST}/nvidia`,
  'https://assets.nvidiagrid.net': `${PROXY_HOST}/nvidiagrid`,
  'https://gfnjpstorageaccount.blob.core.windows.net': `${PROXY_HOST}/gfnblob`,
};

// ─── Shared header-rewrite helpers ─────────────────────────────────────────────

/**
 * Strip headers that prevent the proxied page from being used normally
 * inside a different origin context.
 */
function sanitizeResponseHeaders(proxyRes) {
  const drop = [
    'x-frame-options',
    'content-security-policy',
    'content-security-policy-report-only',
    'cross-origin-opener-policy',
    'cross-origin-embedder-policy',
    'cross-origin-resource-policy',
    'strict-transport-security',
    'x-content-type-options',
    'x-xss-protection',
  ];
  drop.forEach(h => delete proxyRes.headers[h]);

  // Rewrite Location headers so redirects stay on the proxy
  const loc = proxyRes.headers['location'];
  if (loc) {
    proxyRes.headers['location'] = rewriteUpstreamUrl(loc);
  }

  // Allow cookies set by the upstream to work on our domain
  if (proxyRes.headers['set-cookie']) {
    proxyRes.headers['set-cookie'] = proxyRes.headers['set-cookie'].map(cookie =>
      cookie
        .replace(/;\s*Domain=[^;]*/gi, '')   // strip Domain= attribute entirely
        .replace(/;\s*SameSite=None/gi, '')  // remove SameSite=None (causes issues without Secure in dev)
        .replace(/;\s*Secure/gi, process.env.NODE_ENV === 'production' ? '; Secure' : '')
    );
  }
}

/**
 * Replace every upstream URL in a string with its proxy equivalent.
 */
function rewriteUpstreamUrl(str) {
  for (const [upstream, proxy] of Object.entries(DOMAIN_MAP)) {
    // Use a global replace so all occurrences in a body/header are caught
    str = str.split(upstream).join(proxy);
  }
  return str;
}

// ─── Response-body rewriter ─────────────────────────────────────────────────────
//
// responseInterceptor handles decompression/recompression automatically
// BUT it requires `selfHandleResponse: true` on the proxy config.
//
// We only decode + rewrite text-based content types to avoid corrupting
// binary assets (images, wasm, etc.).
// ────────────────────────────────────────────────────────────────────────────────
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

function isRewritable(contentType = '') {
  return REWRITABLE_TYPES.some(t => contentType.includes(t));
}

/**
 * Build a responseInterceptor that:
 *   1. Strips security headers
 *   2. Rewrites upstream domain strings inside text responses
 */
function buildBodyRewriter(upstreamHost) {
  return responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
    // Always sanitize headers regardless of content type
    sanitizeResponseHeaders(proxyRes);

    const contentType = proxyRes.headers['content-type'] || '';
    if (!isRewritable(contentType)) {
      return responseBuffer; // binary — pass through untouched
    }

    let body = responseBuffer.toString('utf8');

    // ── Strip Subresource Integrity (SRI) attributes ──────────────────────────
    // The proxy rewrites domain strings inside JS/CSS, which changes the file
    // bytes and breaks any sha256/sha384/sha512 integrity hash baked into the
    // HTML. The browser then blocks the script entirely → black screen.
    // We must remove integrity + crossorigin attributes from <script> and <link>
    // tags so the browser skips hash validation.
    if (contentType.includes('text/html')) {
      // Remove integrity="..." and integrity='...'
      body = body.replace(/\s+integrity=(["'])sha\d+-[A-Za-z0-9+/=]+\1/g, '');
      // crossorigin="anonymous" is only meaningful alongside integrity; strip it
      // too so the browser doesn't send a CORS preflight for no reason.
      body = body.replace(/\s+crossorigin=(["'])[^"']*\1/g, '');
    }

    const rewritten = rewriteUpstreamUrl(body);
    return Buffer.from(rewritten, 'utf8');
  });
}

// ─── Shared proxyReq handler factory ───────────────────────────────────────────
function buildProxyReqHandler(upstreamOrigin) {
  const url = new URL(upstreamOrigin);
  return (proxyReq, req, res) => {
    // Force correct host/origin/referer so CDN & S3 bucket policies accept us
    proxyReq.setHeader('host',    url.host);
    proxyReq.setHeader('origin',  upstreamOrigin);
    proxyReq.setHeader('referer', upstreamOrigin + '/');

    // Remove compression so we always receive plaintext response bodies.
    // responseInterceptor CAN handle gzip/br, but stripping it is safer and
    // avoids partial-decode edge cases on streamed responses.
    proxyReq.removeHeader('accept-encoding');

    // Forward real client IP if running behind a load balancer
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    proxyReq.setHeader('x-forwarded-for', clientIp);
  };
}

// ─── Proxy factory ──────────────────────────────────────────────────────────────
function makeProxy(target, { pathRewrite } = {}) {
  return createProxyMiddleware({
    target,
    changeOrigin:      true,
    ws:                true,        // proxy WebSocket upgrades
    followRedirects:   false,       // handle Location rewrites ourselves
    selfHandleResponse: true,       // required for responseInterceptor
    cookieDomainRewrite: { '*': '' },
    cookiePathRewrite:   { '*': '/' },
    ...(pathRewrite ? { pathRewrite } : {}),
    on: {
      proxyReq: buildProxyReqHandler(target),
      proxyRes: buildBodyRewriter(target),
      error: (err, req, res) => {
        console.error(`[proxy error] ${req.method} ${req.url} →`, err.message);
        if (!res.headersSent) {
          res.status(502).send('Proxy error: ' + err.message);
        }
      },
    },
  });
}

// ─── Routes ────────────────────────────────────────────────────────────────────
//
// ORDER MATTERS — more-specific paths must come before '/'.
// ────────────────────────────────────────────────────────────────────────────────

// NVIDIA login / auth
app.use('/auth', makeProxy('https://login.nvidia.com', {
  pathRewrite: { '^/auth': '' },
}));

// NVIDIA main site (privacy policy links, etc.)
app.use('/nvidia', makeProxy('https://www.nvidia.com', {
  pathRewrite: { '^/nvidia': '' },
}));

// NVIDIA Grid / CDN assets (loaded by the GFN frontend)
app.use('/nvidiagrid', makeProxy('https://assets.nvidiagrid.net', {
  pathRewrite: { '^/nvidiagrid': '' },
}));

// Azure blob storage assets sometimes referenced by GFN
app.use('/gfnblob', makeProxy('https://gfnjpstorageaccount.blob.core.windows.net', {
  pathRewrite: { '^/gfnblob': '' },
}));

// Main GeForce NOW app — catch-all, must be last
app.use('/', makeProxy('https://play.geforcenow.com'));

// ─── Server startup ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
  console.log(`Proxying to: https://play.geforcenow.com`);
  console.log(`PROXY_HOST resolved to: ${PROXY_HOST}`);
});

// Forward WebSocket upgrade events to the GFN proxy.
// http-proxy-middleware registers its own upgrade handler when ws:true,
// but we need to make sure the http.Server hands upgrades through.
server.on('upgrade', (req, socket, head) => {
  // The proxy middleware attached to '/' will handle this automatically
  // via http-proxy-middleware's internal ws handler.
  // No manual forwarding needed — this listener is just a safety log.
  console.log(`[ws upgrade] ${req.url}`);
});

module.exports = { app, server };
