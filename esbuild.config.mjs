import * as esbuild from 'esbuild';
const demo = process.argv.includes('--demo');
const options = {
  loader: { '.aff': 'text', '.dic': 'text' },
  entryPoints: [demo ? 'src/demo.ts' : 'src/main.ts'], bundle: true,
  outfile: demo ? 'demo/app.js' : 'main.js',
  format: demo ? 'iife' : 'cjs', target: 'es2022',
  external: demo ? [] : ['obsidian', 'electron', '@codemirror/state', '@codemirror/view'],
  sourcemap: demo ? 'inline' : false, logLevel: 'info',
  banner: {js: '/* Inkstone — Pencil-first handwriting for Obsidian. */'},
};
if (process.argv.includes('--watch')) {
  const ctx = await esbuild.context(options); await ctx.watch();
} else { await esbuild.build(options); }
