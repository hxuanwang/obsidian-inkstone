import { createHash } from 'node:crypto';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'assets/ocr');
const modelURL = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz';
const modelSHA256 = '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91';
const hash = data => createHash('sha256').update(data).digest('hex');
await mkdir(output, { recursive: true });
const files = [
  ['tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['tesseract.js/LICENSE.md', 'TESSERACT-JS-LICENSE.md'],
  ['tesseract.js-core/LICENSE', 'TESSERACT-CORE-LICENSE'],
  ...['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-lstm.wasm', 'tesseract-core-simd-lstm.wasm'].map(name => [`tesseract.js-core/${name}`, name]),
];
for (const [source, target] of files) await copyFile(path.join(root, 'node_modules', source), path.join(output, target));
let model = await readFile(path.join(output, 'eng.traineddata.gz')).catch(() => null);
if (!model || hash(model) !== modelSHA256) {
  console.log('Downloading the pinned English OCR model (build time only)…');
  const response = await fetch(modelURL, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`OCR model download failed: HTTP ${response.status}`);
  model = Buffer.from(await response.arrayBuffer());
  if (hash(model) !== modelSHA256) throw new Error('OCR model checksum mismatch; refusing to package unverified model.');
  await writeFile(path.join(output, 'eng.traineddata.gz'), model);
}
const hashes = {};
for (const name of [...files.map(([, target]) => target), 'eng.traineddata.gz']) hashes[name] = hash(await readFile(path.join(output, name)));
await writeFile(path.join(output, 'checksums.json'), JSON.stringify({ modelURL, sha256: hashes }, null, 2) + '\n');
await writeFile(path.join(output, 'NOTICE.txt'), 'Local OCR assets for Inkstone\n\nTesseract.js 6.0.1 and Tesseract.js-core 6.x: Apache License 2.0, included.\nEnglish model: @tesseract.js-data/eng 1.0.0, 4.0.0_best_int, Apache License 2.0.\nSource: https://github.com/naptha/tessdata\n\nThe .wasm.js engines contain embedded WASM. Both SIMD and non-SIMD engines\nare included for mobile compatibility. No remote OCR service is used.\nEnglish OCR accuracy varies substantially for handwriting; review transcripts.\n');
console.log(`Prepared ${Object.keys(hashes).length} verified OCR assets in assets/ocr.`);
