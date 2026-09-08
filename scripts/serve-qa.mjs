/** Explicit browser test server; does not read or modify preview localStorage. */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = await build({
  loader: { '.aff': 'text', '.dic': 'text' },
  absWorkingDir: root, entryPoints: ['tests/browser-fixture.ts'], bundle: true,
  format: 'iife', target: 'es2022', write: false, logLevel: 'info',
});
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Inkstone browser QA</title><link rel="stylesheet" href="/styles.css"><style>
html,body{margin:0;height:100%;overflow:hidden;background:#eeefeb}body{display:flex;flex-direction:column}#app{flex:1;min-height:0}#qa-tools{font:12px/1.4 system-ui;padding:6px 14px;background:#263b32;color:white;flex-shrink:0}#qa-status{display:block;max-height:70px;overflow:auto;white-space:pre-wrap;word-break:break-all}#qa-export{width:100%;height:60px;box-sizing:border-box}
</style></head><body><details id="qa-tools"><summary>Test tooling · synthetic HELLO fixture · no stored data</summary><output id="qa-status" aria-label="Last persisted document"></output><p id="qa-export-status">No SVG export yet</p><textarea id="qa-export" aria-label="Exported SVG" readonly></textarea></details><main id="app"></main><script src="/app.js"></script></body></html>`;
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  let data, type;
  try {
    if (pathname === '/') { data = html; type = 'text/html'; }
    else if (pathname === '/app.js') { data = bundle.outputFiles[0].contents; type = 'text/javascript'; }
    else if (pathname === '/styles.css') { data = await readFile(new URL('../styles.css', import.meta.url)); type = 'text/css'; }
    else {
      const asset = /^\/ocr\/([a-zA-Z0-9_.-]+)$/.exec(pathname);
      if (!asset) { res.writeHead(404); res.end('Not found'); return; }
      data = await readFile(new URL(`../assets/ocr/${asset[1]}`, import.meta.url));
      type = asset[1].endsWith('.js') ? 'text/javascript' : asset[1].endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(data);
  } catch { res.writeHead(404); res.end('QA asset unavailable; run npm run prepare:ocr.'); }
});
server.listen(Number(process.env.INKSTONE_QA_PORT ?? 5175), '127.0.0.1', () => console.log(`Inkstone QA fixture: http://127.0.0.1:${process.env.INKSTONE_QA_PORT ?? 5175}`));
