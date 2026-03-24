const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();

/**
 * Rewrite redirects so user stays inside proxy
 */
function rewriteLocation(proxyRes) {
  const loc = proxyRes.headers['location'];
  if (!loc) return;

  proxyRes.headers['location'] = loc
    .replace('https://play.geforcenow.com', '/')
    .replace('https://login.nvidia.com', '/auth');
}

/**
 * Shared proxy config
 */
function createConfig(target) {
  return {
    target: target,
    changeOrigin: true,
    ws: true,
    followRedirects: true,

    headers: {
      origin: target,
      referer: target
    },

    cookieDomainRewrite: {
      '*': ''
    },
    cookiePathRewrite: {
      '*': '/'
    },

    onProxyReq: (proxyReq, req, res) => {
      proxyReq.setHeader('origin', target);
      proxyReq.setHeader('referer', target);
    },

    onProxyRes: (proxyRes, req, res) => {
      // Remove frame protections (may or may not work)
      delete proxyRes.headers['x-frame-options'];
      delete proxyRes.headers['content-security-policy'];

      rewriteLocation(proxyRes);
    }
  };
}

/**
 * MAIN SITE
 */
app.use(
  '/',
  createProxyMiddleware(createConfig('https://play.geforcenow.com'))
);

/**
 * LOGIN ROUTE
 */
app.use(
  '/auth',
  createProxyMiddleware({
    ...createConfig('https://login.nvidia.com'),
    pathRewrite: {
      '^/auth': ''
    }
  })
);

app.listen(3000, () => {
  console.log('Running on http://localhost:3000');
});
