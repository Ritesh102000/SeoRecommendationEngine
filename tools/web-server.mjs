import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import handler from '../api/audit.js';

const host = '127.0.0.1';
const port = Number(process.env.PORT || 8777);
const publicDir = join(process.cwd(), 'public');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${host}:${port}`);
    if (url.pathname === '/api/audit') {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 100_000) throw new Error('Request is too large.');
      }
      req.body = raw ? JSON.parse(raw) : {};
      res.status = (code) => {
        res.statusCode = code;
        return res;
      };
      res.json = (body) => {
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(body));
      };
      return handler(req, res);
    }

    const routes = { '/': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css' };
    const file = routes[url.pathname];
    if (!file) {
      res.writeHead(404).end('Not found');
      return;
    }
    const body = await readFile(join(publicDir, file));
    res.setHeader('content-type', mime[extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: error.message || 'Local server error.' }));
  }
});

server.listen(port, host, () => {
  console.log(`SEO Lens running at http://${host}:${port}`);
});
