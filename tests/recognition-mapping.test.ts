import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapRecognitionWords } from '../src/recognition';
import { inkSignature } from '../src/ink-signature';
import { PAGE_WIDTH, type Stroke } from '../src/model';
const blocks = (words: { text: string; bbox: { x0: number; y0: number; x1: number; y1: number } }[]) => [{ paragraphs: [{ lines: [{ words }] }] }];
test('recognition word locations recover the native page crop offset', () => {
  assert.deepEqual(mapRecognitionWords(blocks([{ text: 'algebra', bbox: { x0: 12, y0: 9, x1: 102, y1: 41 } }]), 420, 610),
    [{ text: 'algebra', x: 432, y: 619, width: 90, height: 32 }]);
  assert.deepEqual(mapRecognitionWords(null, 0, 0), []);
});
test('OCR boxes are bounded to page and invalid or empty word boxes are omitted', () => {
  const words = blocks([
    { text: 'edge', bbox: { x0: 5, y0: 1, x1: 45, y1: 12 } },
    { text: ' ', bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } },
    { text: 'invalid', bbox: { x0: NaN, y0: 0, x1: 10, y1: 10 } },
    { text: 'reversed', bbox: { x0: 10, y0: 0, x1: 5, y1: 10 } },
    { text: 'outside', bbox: { x0: 50, y0: 0, x1: 80, y1: 10 } },
  ]);
  assert.deepEqual(mapRecognitionWords(words, PAGE_WIDTH - 20, 0), [{ text: 'edge', x: PAGE_WIDTH - 15, y: 1, width: 15, height: 11 }]);
});
test('ink snapshot signature survives a round trip and changes with stroke edits', () => {
  const strokes: Stroke[] = [{ id: 'a', tool: 'pen', color: '#000000', width: 3, points: [{ x: 20, y: 25, pressure: .5, time: 0 }] }];
  const original = inkSignature(strokes);
  assert.equal(original, inkSignature(JSON.parse(JSON.stringify(strokes))));
  for (const field of ['x', 'y', 'pressure', 'time'] as const) {
    const changed = structuredClone(strokes); changed[0].points[0][field] += .1;
    assert.notEqual(original, inkSignature(changed));
  }
  const changed = structuredClone(strokes); changed[0].width++;
  assert.notEqual(original, inkSignature(changed));
  assert.notEqual(original, inkSignature([]));
});

import { LocalRecognizer } from '../src/recognition';
import { createPage } from '../src/model';
import { type createWorker, type Worker } from 'tesseract.js';

// The engine contract is exercised without downloading assets or relying on OCR
// accuracy; the browser smoke test separately runs the real bundled engine.
function fakeCanvasDocument() {
  return { createElement: () => ({ width: 0, height: 0, getContext: () => ({
    fillRect() {}, translate() {}, beginPath() {}, arc() {}, fill() {}, moveTo() {}, lineTo() {}, stroke() {},
  }) }) } as unknown as Document;
}
function inkPage() {
  const page = createPage();
  page.strokes = [{ id: 'pen', tool: 'pen', color: '#000000', width: 3, points: [{ x: 80, y: 80, pressure: .5, time: 0 }] }];
  return page;
}
function fakeWorker(overrides: Partial<Worker> = {}) {
  return { setParameters: async () => ({}), recognize: async () => ({ data: { text: 'HELLO', blocks: null } }), terminate: async () => ({}), ...overrides } as Worker;
}

test('OCR startup errors settle, sanitize asset URLs, and allow a fresh attempt', async () => {
  const original = globalThis.document; globalThis.document = fakeCanvasDocument();
  let attempts = 0, terminated = 0;
  const factory: typeof createWorker = async (_lang, _oem, options) => {
    assert.equal(options?.workerPath, 'app://local/plugin/assets/ocr/worker.min.js');
    assert.equal(options?.langPath, 'app://local/plugin/assets/ocr');
    if (++attempts === 1) {
      // Tesseract 6 invokes the callback but leaves createWorker unresolved.
      queueMicrotask(() => options?.errorHandler?.(new Error('model unavailable')));
      return new Promise(() => {});
    }
    return fakeWorker({ terminate: async () => { terminated++; return {} as never; } });
  };
  const recognizer = new LocalRecognizer('app://local/plugin/assets/ocr?cache=123', factory, 1000);
  try {
    await assert.rejects(recognizer.recognize(inkPage()), /model unavailable/);
    assert.equal((await recognizer.recognize(inkPage())).text, 'HELLO');
    assert.equal(attempts, 2);
  } finally { await recognizer.destroy(); globalThis.document = original; }
  assert.equal(terminated, 1);
});

test('an unresponsive OCR worker times out and is released', async () => {
  const original = globalThis.document; globalThis.document = fakeCanvasDocument();
  let terminated = 0;
  const factory: typeof createWorker = async () => fakeWorker({
    recognize: () => new Promise(() => {}),
    terminate: async () => { terminated++; return {} as never; },
  });
  const recognizer = new LocalRecognizer('/ocr', factory, 15);
  try { await assert.rejects(recognizer.recognize(inkPage()), /timed out/); }
  finally { await recognizer.destroy(); globalThis.document = original; }
  assert.equal(terminated, 1);
});

test('destroy cancels startup immediately and terminates a worker that arrives late', async () => {
  const original = globalThis.document; globalThis.document = fakeCanvasDocument();
  let resolveWorker!: (worker: Worker) => void, terminated = 0;
  const factory: typeof createWorker = () => new Promise(resolve => { resolveWorker = resolve; });
  const recognizer = new LocalRecognizer('/ocr', factory, 1000);
  try {
    const job = recognizer.recognize(inkPage());
    const rejected = assert.rejects(job, /cancelled/);
    await new Promise(resolve => setImmediate(resolve));
    await recognizer.destroy(); await rejected;
    resolveWorker(fakeWorker({ terminate: async () => { terminated++; return {} as never; } }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(terminated, 1);
    await assert.rejects(recognizer.recognize(inkPage()), /closed/);
  } finally { await recognizer.destroy(); globalThis.document = original; }
});

test('OCR stays cold for empty ink and serializes exact submitted snapshots', async () => {
  const original = globalThis.document;
  const submittedX: number[] = [];
  globalThis.document = fakeCanvasDocument();
  const createCanvas = globalThis.document.createElement;
  globalThis.document.createElement = (() => {
    const canvas = createCanvas('canvas') as HTMLCanvasElement;
    const context = canvas.getContext('2d')!;
    context.arc = (x: number) => { submittedX.push(x); };
    canvas.getContext = (() => context) as unknown as typeof canvas.getContext;
    return canvas;
  }) as typeof document.createElement;
  let starts = 0, calls = 0, finishFirst!: () => void;
  const factory: typeof createWorker = async () => {
    starts++;
    return fakeWorker({ recognize: (() => {
      calls++;
      return calls === 1 ? new Promise(resolve => { finishFirst = () => resolve({ data: { text: 'FIRST', blocks: null } } as never); }) : Promise.resolve({ data: { text: 'SECOND', blocks: null } });
    }) as Worker['recognize'] });
  };
  const recognizer = new LocalRecognizer('/ocr', factory, 1000);
  try {
    assert.equal(starts, 0);
    await recognizer.recognize(createPage());
    assert.equal(starts, 0, 'Opening an empty note must not start an OCR worker');
    const first = recognizer.recognize(inkPage());
    await new Promise(resolve => setImmediate(resolve));
    const secondPage = inkPage(); secondPage.strokes[0].points[0].x = 150;
    const signature = inkSignature(secondPage.strokes);
    const second = recognizer.recognize(secondPage);
    secondPage.strokes[0].points[0].x = 500;
    assert.equal(calls, 1, 'Only one page may be recognized at a time');
    finishFirst();
    await first;
    assert.equal((await second).inkSignature, signature);
    assert.deepEqual(submittedX, [80, 150], 'Queued pages retain ink from submission time');
    assert.equal(starts, 1, 'Consecutive OCR jobs reuse one worker');
  } finally { await recognizer.destroy(); globalThis.document = original; }
});
