const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();

app.use('/', createProxyMiddleware({
  target: 'https://www.tiktok.com',
  changeOrigin: true,
  followRedirects: true,        // already good
  secure: true,

  // --- Critical: Forward ALL important headers from the real client ---
  onProxyReq: (proxyReq, req, res) => {
    // Forward the original User-Agent (don't hardcode a generic one)
    if (req.headers['user-agent']) {
      proxyReq.setHeader('user-agent', req.headers['user-agent']);
    }

    // TikTok heavily checks these
    if (req.headers['accept']) {
      proxyReq.setHeader('accept', req.headers['accept']);
    }
    if (req.headers['accept-language']) {
      proxyReq.setHeader('accept-language', req.headers['accept-language']);
    }
    if (req.headers['accept-encoding']) {
      proxyReq.setHeader('accept-encoding', req.headers['accept-encoding']);
    }
    if (req.headers['referer']) {
      proxyReq.setHeader('referer', req.headers['referer']);
    }
    if (req.headers['sec-fetch-mode']) {
      proxyReq.setHeader('sec-fetch-mode', req.headers['sec-fetch-mode']);
    }
    if (req.headers['sec-fetch-site']) {
      proxyReq.setHeader('sec-fetch-site', req.headers['sec-fetch-site']);
    }
    if (req.headers['sec-fetch-dest']) {
      proxyReq.setHeader('sec-fetch-dest', req.headers['sec-fetch-dest']);
    }

    // Optional but helpful: spoof a more complete modern browser profile
    // proxyReq.setHeader('sec-ch-ua', '"Chromium";v="134", "Not:A-Brand";v="99", "Google Chrome";v="134"');
    // proxyReq.setHeader('sec-ch-ua-mobile', '?0');
    // proxyReq.setHeader('sec-ch-ua-platform', '"Windows"');
  },

  // Remove anti-embedding / CSP protections so your iframe/proxy page works
  onProxyRes: (proxyRes, req, res) => {
    delete proxyRes.headers['x-frame-options'];
    delete proxyRes.headers['content-security-policy'];
    delete proxyRes.headers['x-content-security-policy'];
    delete proxyRes.headers['strict-transport-security']; // sometimes helps
    delete proxyRes.headers['x-xss-protection'];

    // TikTok sometimes sets these; clearing them can reduce issues
    delete proxyRes.headers['set-cookie']; // be careful – this may break login/session if needed
  },

  // Log errors for debugging
  onError: (err, req, res) => {
    console.error('Proxy error:', err);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Proxy error: ' + err.message);
  }
}));

// Optional: Add a simple health check
app.get('/health', (req, res) => res.send('Proxy running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`TikTok proxy running on http://localhost:${PORT}`);
});
