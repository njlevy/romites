/**
 * dev-server.js — Tiny static file server with a POST endpoint
 * to save avatar-positions.json from the editor.
 *
 * Usage: node dev-server.js [port]
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PREFERRED_PORT = parseInt(process.argv[2], 10) || 8080;
const PORT_CANDIDATES = [PREFERRED_PORT, PREFERRED_PORT + 1, PREFERRED_PORT + 2, PREFERRED_PORT + 3, PREFERRED_PORT + 4];
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2',
};

// Simple in-memory cache for proxied images (avoids re-fetching)
const proxyCache = new Map();

function proxyFetch(targetUrl) {
  return new Promise((resolve, reject) => {
    // Check cache first
    if (proxyCache.has(targetUrl)) {
      return resolve(proxyCache.get(targetUrl));
    }

    const doRequest = (reqUrl, redirects) => {
      if (redirects > 5) return reject(new Error('Too many redirects'));
      const mod = reqUrl.startsWith('https') ? https : http;
      mod.get(reqUrl, (resp) => {
        if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
          return doRequest(resp.headers.location, redirects + 1);
        }
        if (resp.statusCode !== 200) {
          return reject(new Error(`HTTP ${resp.statusCode}`));
        }
        const chunks = [];
        resp.on('data', c => chunks.push(c));
        resp.on('end', () => {
          const buf = Buffer.concat(chunks);
          const ct = resp.headers['content-type'] || 'image/jpeg';
          const result = { buf, ct };
          proxyCache.set(targetUrl, result);
          // Evict after 5 minutes
          setTimeout(() => proxyCache.delete(targetUrl), 5 * 60 * 1000);
          resolve(result);
        });
        resp.on('error', reject);
      }).on('error', reject);
    };
    doRequest(targetUrl, 0);
  });
}

const server = http.createServer((req, res) => {
  // --- GET /img-proxy?url=... → proxy image from Google ---
  if (req.method === 'GET' && req.url.startsWith('/img-proxy?')) {
    const parsed = url.parse(req.url, true);
    const targetUrl = parsed.query.url;
    if (!targetUrl || (!targetUrl.includes('google') && !targetUrl.includes('lh3'))) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad request — only Google URLs allowed');
      return;
    }
    proxyFetch(targetUrl)
      .then(({ buf, ct }) => {
        res.writeHead(200, {
          'Content-Type': ct,
          'Cache-Control': 'public, max-age=300',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(buf);
      })
      .catch((err) => {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Proxy error: ' + err.message);
      });
    return;
  }

  // --- POST /save-positions → write avatar-positions.json ---
  if (req.method === 'POST' && req.url === '/save-positions') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        // Validate it's proper JSON
        const data = JSON.parse(body);
        const pretty = JSON.stringify(data, null, 2);
        const dest = path.join(ROOT, 'js', 'avatar-positions.json');
        fs.writeFileSync(dest, pretty + '\n', 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        console.log(`[save] Wrote ${dest} (${Object.keys(data).length} artists)`);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // --- Static file serving ---
  const urlPath = req.url.split('?')[0];
  let filePath = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
  const ext = path.extname(filePath).toLowerCase();

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
    res.end(data);
  });
});

function tryListen(ports) {
  const port = ports[0];
  server.listen(port, () => {
    console.log(`PORT=${port}`);
    console.log(`Dev server running at http://localhost:${port}`);
    console.log(`Editor mode: http://localhost:${port}/?editor=1`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && ports.length > 1) {
      console.log(`Port ${port} in use, trying ${ports[1]}...`);
      server.removeAllListeners('error');
      tryListen(ports.slice(1));
    } else {
      console.error(`Could not start server: ${err.message}`);
      process.exit(1);
    }
  });
}

tryListen(PORT_CANDIDATES);
