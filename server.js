const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();

const TARGET = 'https://play.geforcenow.com';

/**
 * MAIN PROXY
 */
app.use('/', createProxyMiddleware({
  target: TARGET,
  changeOrigin: true,
  ws: true,
  followRedirects: true,

  cookieDomainRewrite: { '*': '' },
  cookiePathRewrite: { '*': '/' },

  onProxyReq: (proxyReq, req, res) => {
    // 🔥 THIS IS THE KEY FIX
    proxyReq.setHeader('host', 'play.geforcenow.com');
    proxyReq.setHeader('origin', TARGET);
    proxyReq.setHeader('referer', TARGET);
  },

  onProxyRes: (proxyRes, req, res) => {
    delete proxyRes.headers['x-frame-options'];
    delete proxyRes.headers['content-security-policy'];

    // Rewrite redirects ONLY (not everything)
    const loc = proxyRes.headers['location'];
    if (loc) {
      proxyRes.headers['location'] = loc
        .replace('https://play.geforcenow.com', '/')
        .replace('https://login.nvidia.com', '/auth');
    }
  }
}));

/**
 * LOGIN PROXY
 */
app.use('/auth', createProxyMiddleware({
  target: 'https://login.nvidia.com',
  changeOrigin: true,
  ws: true,
  followRedirects: true,

  pathRewrite: {
    '^/auth': ''
  },

  cookieDomainRewrite: { '*': '' },
  cookiePathRewrite: { '*': '/' },

  onProxyReq: (proxyReq) => {
    proxyReq.setHeader('host', 'login.nvidia.com');
    proxyReq.setHeader('origin', 'https://login.nvidia.com');
    proxyReq.setHeader('referer', 'https://login.nvidia.com/');
  }
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Running on port ${PORT}`);
});
