const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();

/**
 * Rewrite redirects so everything stays inside proxy
 */
function rewriteLocation(proxyRes) {
  const loc = proxyRes.headers['location'];
  if (!loc) return;

  proxyRes.headers['location'] = loc
    .replace('https://play.geforcenow.com', '/')
    .replace('https://login.nvidia.com', '/auth');
}

/**
 * Common proxy config
 */
function createConfig(target) {
  return {
    target,
    changeOrigin: true,
    ws: true,
    followRedirects: true,

    headers: {
      origin: target,
      referer: target
    },

    cookieDomainRewrite: { '*': '' },
    cookiePathRewrite: { '*': '/' },

    selfHandleResponse: false, // IMPORTANT: let browser handle JS

    onProxyReq: (proxyReq, req, res) => {
      // Force correct origin headers
      proxyReq.setHeader('origin', target);
      proxyReq.setHeader('referer', target);
    },

    onProxyRes: (proxyRes, req, res) => {
      // Remove frame blockers (not always enough)
      delete proxyRes.headers['x-frame-options'];
      delete proxyRes.headers['content-security-policy'];

      rewriteLocation(proxyRes);
    }
  };
}

/**
 * Main site
 */
app.use('/', createProxyMiddleware(createConfig('https://play.geforcenow.com')));

/**
 * Login domain
 */
app.use('/auth', createProxyMiddleware({
  ...createConfig('https://login.nvidia.com'),
  pathRewrite: { '^/auth': '' }
}));

app.listen(3000, () => {
  console.log('Running on http://localhost:3000');
});
