app.use('/', createProxyMiddleware({
  target: 'https://www.tiktok.com', // or any site
  changeOrigin: true,
  followRedirects: true,
  headers: {
    'User-Agent': 'Mozilla/5.0',
  },
  onProxyReq: (proxyReq, req) => {
    // forward real headers
    if (req.headers['user-agent']) {
      proxyReq.setHeader('user-agent', req.headers['user-agent']);
    }
  },
  onProxyRes: (proxyRes) => {
    delete proxyRes.headers['x-frame-options'];
    delete proxyRes.headers['content-security-policy'];
  }
}));
