import http from 'node:http';
import { readFile } from 'node:fs/promises';
const routes = { '/': ['demo/index.html', 'text/html'], '/app.js': ['demo/app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'] };
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const asset = /^\/ocr\/([a-zA-Z0-9_.-]+)$/.exec(pathname);
  const route = asset ? [`assets/ocr/${asset[1]}`, asset[1].endsWith('.js') ? 'text/javascript' : asset[1].endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream'] : routes[pathname];
  if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (!route) { res.writeHead(404); res.end('Not found'); return; }
  try { const data = await readFile(route[0]); res.writeHead(200, { 'Content-Type': route[1], 'Cache-Control': 'no-store' }); res.end(data); }
  catch { res.writeHead(500); res.end('Build the demo first.'); }
});
const port = Number(process.env.INKSTONE_PORT || 5173);
server.listen(port, '127.0.0.1', () => console.log(`Inkstone preview: http://127.0.0.1:${port}`));
