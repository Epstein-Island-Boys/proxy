const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();

// Homepage with input box
app.get('/', (req, res) => {
  res.send(`
    <h2>Simple Proxy</h2>
    <form method="GET" action="/proxy">
      <input type="text" name="url" placeholder="https://example.com" style="width:300px" required />
      <button type="submit">Go</button>
    </form>
  `);
});

// Proxy route
app.use('/proxy', (req, res, next) => {
  let target = req.query.url;

  if (!target) {
    return res.send('No URL provided');
  }

  // Add https:// if missing
  if (!target.startsWith('http')) {
    target = 'https://' + target;
  }

  return createProxyMiddleware({
    target: target,
    changeOrigin: true,
    followRedirects: true,
    pathRewrite: {
      '^/proxy': '',
    },
    onProxyRes: function (proxyRes) {
      delete proxyRes.headers['x-frame-options'];
      delete proxyRes.headers['content-security-policy'];
    }
  })(req, res, next);
});

app.listen(3000, () => {
  console.log('Running on http://localhost:3000');
});
