const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const HttpsProxyAgent = require('https-proxy-agent');

const app = express();

// === PUT YOUR RESIDENTIAL PROXY HERE ===
const proxyUrl = 'http://username:password@residential-proxy-host:port'; 
// Example providers: Smartproxy, Bright Data, Oxylabs, IPRoyal, Webshare residential, NodeMaven, etc.
// For best results use a **sticky session** or **US mobile/ISP** proxy.

const agent = new HttpsProxyAgent(proxyUrl);

app.use('/', createProxyMiddleware({
  target: 'https://www.tiktok.com',
  changeOrigin: true,
  followRedirects: true,
  agent: agent,                    // ← This routes ALL requests through the residential proxy
  secure: true,

  onProxyReq: (proxyReq, req) => {
    // Forward real browser headers from the visitor
    ['user-agent', 'accept', 'accept-language', 'accept-encoding',
     'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-dest', 'referer'].forEach(header => {
      if (req.headers[header]) {
        proxyReq.setHeader(header, req.headers[header]);
      }
    });

    // Modern Chrome-like headers (TikTok checks these)
    proxyReq.setHeader('sec-ch-ua', '"Chromium";v="134", "Not:A-Brand";v="99", "Google Chrome";v="134"');
    proxyReq.setHeader('sec-ch-ua-mobile', '?0');
    proxyReq.setHeader('sec-ch-ua-platform', '"Windows"');
  },

  onProxyRes: (proxyRes) => {
    // Allow embedding / remove protections
    delete proxyRes.headers['x-frame-options'];
    delete proxyRes.headers['content-security-policy'];
    delete proxyRes.headers['strict-transport-security'];
  },

  onError: (err, req, res) => {
    console.error('Proxy Error:', err.message);
    res.status(502).send('Proxy error - try refreshing');
  }
}));

app.get('/health', (req, res) => res.send('TikTok proxy OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
