const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const HttpsProxyAgent = require('https-proxy-agent');

const app = express();

// === YOUR RESIDENTIAL PROXY GOES HERE (set in Render Environment Variables) ===
const PROXY_URL = process.env.PROXY_URL;

if (!PROXY_URL) {
  console.warn('⚠️ PROXY_URL is not set! TikTok will probably show the sad robot error.');
}

const agent = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : null;

app.use('/', createProxyMiddleware({
  target: 'https://www.tiktok.com',
  changeOrigin: true,
  followRedirects: true,
  agent: agent,
  secure: true,

  onProxyReq: (proxyReq, req) => {
    const headersToForward = [
      'user-agent', 'accept', 'accept-language', 'accept-encoding',
      'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-dest', 'referer', 'cookie'
    ];

    headersToForward.forEach(header => {
      if (req.headers[header]) {
        proxyReq.setHeader(header, req.headers[header]);
      }
    });

    // Modern headers TikTok expects
    proxyReq.setHeader('sec-ch-ua', '"Chromium";v="134", "Not:A-Brand";v="99", "Google Chrome";v="134"');
    proxyReq.setHeader('sec-ch-ua-mobile', '?0');
    proxyReq.setHeader('sec-ch-ua-platform', '"Windows"');
  },

  onProxyRes: (proxyRes) => {
    delete proxyRes.headers['x-frame-options'];
    delete proxyRes.headers['content-security-policy'];
    delete proxyRes.headers['strict-transport-security'];
    delete proxyRes.headers['x-content-security-policy'];
  },

  onError: (err, req, res) => {
    console.error('Proxy Error:', err.message);
    res.status(502).send('Proxy error — please refresh the page.');
  }
}));

app.get('/health', (req, res) => res.send('TikTok proxy is running ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Proxy running on port ${PORT}`);
});
