const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();

/**
 * Helper to rewrite redirects so user stays inside proxy
 */
function rewriteLocationHeader(proxyRes, req) {
  const location = proxyRes.headers['location'];
  if (!location) return;

  // Rewrite NVIDIA login → /auth
  if (location.includes('login.nvidia.com')) {
    proxyRes.headers['location'] = location.replace(
      'https://login.nvidia.com',
      '/auth'
    );
  }

  // Rewrite GeForce NOW → /
  if (location.includes('play.geforcenow.com')) {
    proxyRes.headers['location'] = location.replace(
      'https://play.geforcenow.com',
      '/'
    );
  }
}

/**
 * MAIN SITE PROXY
 */
app.use('/', createProxyMiddleware({
  target: 'https://play.geforcenow.com',
  changeOrigin: true,
  ws: true, // important for streaming/websockets
  followRedirects: true,

  cookieDomainRewrite: {
    '*': ''
  },
  cookiePathRewrite: {
    '*': '/'
  },

  onProxyRes: (proxyRes, req, res) => {
    // Remove frame blocking (may still not work, but worth trying)
    delete proxyRes.headers['x-frame-options'];
    delete proxyRes.headers['content-security-policy'];

    rewriteLocationHeader(proxyRes, req);
  }
}));

/**
 * LOGIN PROXY (VERY IMPORTANT)
 */
app.use('/auth', createProxyMiddleware({
  target: 'https://login.nvidia.com',
  changeOrigin: true,
  ws: true,
  followRedirects: true,

  pathRewrite: {
    '^/auth': ''
  },

  cookieDomainRewrite: {
    '*': ''
  },
  cookiePathRewrite: {
    '*': '/'
  },

  onProxyRes: (proxyRes, req, res) => {
    delete proxyRes.headers['x-frame-options'];
    delete proxyRes.headers['content-security-policy'];

    rewriteLocationHeader(proxyRes, req);
  }
}));

app.listen(3000, () => {
  console.log('Running on http://localhost:3000');
});
