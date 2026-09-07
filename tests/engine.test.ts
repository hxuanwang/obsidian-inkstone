import test from 'node:test';
import assert from 'node:assert/strict';
import { createPage as createDocument, type InkPage as InkDocument } from '../src/model';
import { InkEngine, pointSegmentDistance } from '../src/ink-engine';

const note = (): InkDocument => ({
  id: 'page-test', title: 'Test', text: '', transcript: '', paper: 'dots', strokes: [{ id: 'stroke-1', tool: 'pen', color: '#123456', width: 3,
    points: [{ x: 12, y: 35, pressure: 0.5, time: 20 }, { x: 14, y: 38, pressure: 0.7, time: 21 }] }],
});

test('eraser distance covers dots, segment interiors, and endpoints', () => {
  assert.equal(pointSegmentDistance({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 }), 5);
  assert.equal(pointSegmentDistance({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 3);
  assert.equal(pointSegmentDistance({ x: 13, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 5);
});

// These doubles exercise pointer routing and rendering work; they do not simulate GPU latency.
class CanvasContext {
  arcs = 0;
  composites = 0;
  constructor(readonly canvas: Canvas) {}
  setTransform() {} clearRect() {} save() {} restore() {} beginPath() {} rect() {} clip() {}
  setLineDash() {} strokeRect() {} moveTo() {} lineTo() {} closePath() {} fill() {} fillRect() {} stroke() {}
  arc() { this.arcs++; }
  drawImage() { this.composites++; }
}
class Canvas {
  width = 0; height = 0;
  style: Record<string, string> = {};
  context = new CanvasContext(this);
  getContext() { return this.context; }
  setAttribute() {} remove() {}
}
class Layer {
  style: Record<string, string> = {};
  className = '';
  children: Layer[] = [];
  setAttribute() {} remove() {}
  append(child: Layer) { this.children.push(child); }
  replaceChildren() { this.children = []; }
}
class Host extends EventTarget {
  canvases: Canvas[] = [];
  width = 1024; height = 900;
  layers: Layer[] = [];
  style: Record<string, string> = {};
  classList = { add() {} };
  append(element: Canvas | Layer) { if (element instanceof Canvas) this.canvases.push(element); else this.layers.push(element); }
  setPointerCapture() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: this.width, height: this.height }; }
}

function withEngine(run: (state: {
  engine: InkEngine; host: Host; changes: InkDocument[]; viewportChanges: () => number; pulls: number[]; advances: () => number;
  pointer: (type: string, x: number, y: number, values?: Record<string, unknown>) => void;
  event: (x: number, y: number, values?: Record<string, unknown>) => Event;
  flush: () => void; getZoom: () => number; resize: (width: number, height: number) => void;
}) => void, document: InkDocument = createDocument()): void {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const install = (name: string, value: unknown) => {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  let sequence = 0;
  const frames = new Map<number, FrameRequestCallback>();
  install('document', { createElement: (tag: string) => tag === 'canvas' ? new Canvas() : new Layer() });
  install('window', { devicePixelRatio: 2 });
  let onResize = () => {};
  install('ResizeObserver', class { constructor(callback: () => void) { onResize = callback; } observe() {} disconnect() {} });
  install('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  install('cancelAnimationFrame', (id: number) => frames.delete(id));
  const host = new Host();
  const changes: InkDocument[] = [];
  const pulls: number[] = []; let advances = 0;
  let zoom = 1; let viewportChanges = 0; let timestamp = 0;
  const engine = new InkEngine(host as unknown as HTMLElement, { document, onChange: value => changes.push(value),
    onViewportChange: value => { zoom = value; viewportChanges++; }, onPagePull: value => pulls.push(value), onPageAdvance: () => advances++ });
  const event = (x: number, y: number, values: Record<string, unknown> = {}) => {
    const result = new Event('pointermove', { cancelable: true });
    const properties = { pointerId: 1, pointerType: 'pen', button: 0, pressure: 0.5,
      clientX: (1024 - 1400 * zoom) / 2 + x * zoom, clientY: 100 + y * zoom, timeStamp: ++timestamp, ...values };
    for (const [key, value] of Object.entries(properties)) Object.defineProperty(result, key, { value, configurable: true });
    return result;
  };
  const pointer = (type: string, x: number, y: number, values: Record<string, unknown> = {}) => {
    const sample = event(x, y, values);
    Object.defineProperty(sample, 'type', { value: type });
    host.dispatchEvent(sample);
  };
  const flush = () => { for (const [id, callback] of frames) { frames.delete(id); callback(0); } };
  try { flush(); run({ engine, host, changes, pulls, advances: () => advances, viewportChanges: () => viewportChanges, pointer, event, flush, getZoom: () => zoom, resize: (width, height) => { host.width = width; host.height = height; onResize(); } }); }
  finally {
    engine.destroy();
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

test('ink starts immediately and live samples/commit never replay historical ink', () => {
  withEngine(({ engine, host, pointer, changes }) => {
    const historicalArcs = host.canvases[0].context.arcs;
    pointer('pointerdown', 300, 300);
    assert.equal(host.canvases[1].context.arcs, 1, 'pointerdown paints a dot synchronously');
    pointer('pointermove', 310, 320);
    pointer('pointerup', 320, 330);
    assert.equal(host.canvases[0].context.arcs, historicalArcs, 'base history was never replayed');
    assert.equal(host.canvases[0].context.composites, 1, 'commit composites the existing live layer');
    assert.equal(changes.length, 1);
    assert.equal(engine.getDocument().strokes.length, 2);
    assert.equal(engine.getDocument().strokes[1].points.length, 3);
  }, note());
});

test('Pencil takes precedence over a finger already on the page and ignores palms', () => {
  withEngine(({ engine, pointer, viewportChanges }) => {
    pointer('pointerdown', 300, 300, { pointerId: 2, pointerType: 'touch' });
    pointer('pointerdown', 300, 300);
    const count = viewportChanges();
    pointer('pointermove', 600, 600, { pointerId: 2, pointerType: 'touch' });
    pointer('pointerdown', 700, 700, { pointerId: 3, pointerType: 'touch' });
    pointer('pointermove', 800, 800, { pointerId: 3, pointerType: 'touch' });
    pointer('pointermove', 310, 320);
    pointer('pointerup', 310, 320);
    assert.equal(viewportChanges(), count, 'palm contacts must not transform the viewport');
    const points = engine.getDocument().strokes[0].points;
    assert.ok(Math.abs(points[0].x - 300) < 1e-6);
    assert.ok(Math.abs(points[1].x - 310) < 1e-6);
  });
});

test('coalesced input preserves real samples and unavailable WebKit input falls back', () => {
  withEngine(({ engine, pointer, event }) => {
    pointer('pointerdown', 300, 300);
    const samples = [event(310, 310), event(320, 320)];
    pointer('pointermove', 320, 320, { getCoalescedEvents: () => samples });
    pointer('pointermove', 330, 330, { getCoalescedEvents: () => { throw new Error('unsupported'); } });
    pointer('pointerup', 330, 330);
    const points = engine.getDocument().strokes[0].points;
    assert.equal(points.length, 4);
    assert.deepEqual(points.map(point => Math.round(point.x)), [300, 310, 320, 330]);
  });
});

test('eraser catches a crossing between sparse events and undo/redo restores the transaction', () => {
  withEngine(({ engine, pointer, changes, flush }) => {
    pointer('pointerdown', 200, 300);
    pointer('pointerup', 600, 300);
    engine.setTool('eraser');
    pointer('pointerdown', 400, 200);
    pointer('pointermove', 400, 400);
    pointer('pointerup', 400, 400);
    flush();
    assert.equal(engine.getDocument().strokes.length, 0);
    assert.equal(changes.length, 2, 'one save per ink/eraser gesture');
    engine.undo(); assert.equal(engine.getDocument().strokes.length, 1);
    assert.equal(engine.canRedo(), true);
    engine.redo(); assert.equal(engine.getDocument().strokes.length, 0);
    engine.undo();
    engine.setTool('pen');
    pointer('pointerdown', 700, 700); pointer('pointerup', 700, 700);
    assert.equal(engine.canRedo(), false, 'new ink discards the old redo branch');
  });
});


test('lasso moves pressure-preserving ink, duplicates and deletes with undo', () => {
  withEngine(({ engine, pointer }) => {
    pointer('pointerdown', 200, 300, { pressure: 0.3 }); pointer('pointerup', 400, 300, { pressure: 0.8 });
    const original = engine.getDocument().strokes[0];
    engine.setTool('lasso');
    pointer('pointerdown', 180, 280); pointer('pointermove', 420, 280); pointer('pointermove', 420, 320);
    pointer('pointermove', 180, 320); pointer('pointerup', 180, 280);
    pointer('pointerdown', 300, 300); pointer('pointerup', 350, 350);
    let moved = engine.getDocument().strokes[0];
    assert.ok(Math.abs(moved.points[0].x - original.points[0].x - 50) < 1e-6);
    assert.deepEqual(moved.points.map(p => p.pressure), original.points.map(p => p.pressure));
    engine.duplicateSelection(); assert.equal(engine.getDocument().strokes.length, 2);
    engine.deleteSelection(); assert.equal(engine.getDocument().strokes.length, 1);
    engine.undo(); assert.equal(engine.getDocument().strokes.length, 2);
    engine.undo(); assert.equal(engine.getDocument().strokes.length, 1);
    engine.undo(); assert.deepEqual(engine.getDocument().strokes[0], original);
  });
});

test('cancelled lasso drag restores ink without adding an undo transaction', () => {
  withEngine(({ engine, pointer, changes }) => {
    pointer('pointerdown', 200, 300); pointer('pointerup', 400, 300);
    const original = engine.getDocument();
    engine.setTool('lasso');
    pointer('pointerdown', 180, 280); pointer('pointermove', 420, 280); pointer('pointermove', 420, 320);
    pointer('pointermove', 180, 320); pointer('pointerup', 180, 280);
    pointer('pointerdown', 300, 300); pointer('pointermove', 350, 350); pointer('pointercancel', 350, 350);
    assert.equal(engine.getDocument(), original);
    assert.equal(changes.length, 1);
  });
});

test('shape tool regularizes a line as one undoable ink stroke', () => {
  withEngine(({ engine, pointer }) => {
    engine.setTool('shape');
    pointer('pointerdown', 200, 300); pointer('pointermove', 300, 302); pointer('pointerup', 400, 300);
    assert.equal(engine.getDocument().strokes[0].points.length, 2);
    assert.equal(engine.getDocument().strokes[0].tool, 'pen');
    engine.undo(); assert.equal(engine.getDocument().strokes.length, 0);
    engine.redo(); assert.equal(engine.getDocument().strokes.length, 1);
    assert.ok(engine.exportSvg().includes('<circle'));
  });
});

test('shape tool fits a tilted oval on release, with one save and reversible history', () => {
  withEngine(({ engine, pointer, changes }) => {
    engine.setTool('shape');
    const samples = Array.from({ length: 65 }, (_, i) => {
      const angle = i*Math.PI*2/64;
      const x = 100*Math.cos(angle), y = 40*Math.sin(angle);
      return { x: 350+x*Math.cos(0.7)-y*Math.sin(0.7), y: 400+x*Math.sin(0.7)+y*Math.cos(0.7) };
    });
    pointer('pointerdown', samples[0].x, samples[0].y);
    for (const p of samples.slice(1, -1)) pointer('pointermove', p.x, p.y);
    assert.equal(changes.length, 0, 'no save or recognition while the pen is moving');
    pointer('pointerup', samples.at(-1)!.x, samples.at(-1)!.y);
    const shape = engine.getDocument().strokes[0];
    assert.equal(shape.points.length, 97);
    assert.equal(changes.length, 1);
    engine.undo(); assert.equal(engine.getDocument().strokes.length, 0);
    engine.redo(); assert.deepEqual(engine.getDocument().strokes[0], shape);
  });
});

test('Pencil lasso ignores palm movement and cancellation never recognizes shapes', () => {
  withEngine(({ engine, pointer, viewportChanges }) => {
    engine.setTool('lasso');
    pointer('pointerdown', 200, 300);
    const initial = viewportChanges();
    pointer('pointerdown', 400, 500, { pointerId: 2, pointerType: 'touch' });
    pointer('pointermove', 800, 900, { pointerId: 2, pointerType: 'touch' });
    assert.equal(viewportChanges(), initial);
    pointer('pointercancel', 200, 300);
    engine.setTool('shape');
    pointer('pointerdown', 200, 300); pointer('pointermove', 300, 302); pointer('pointermove', 400, 300);
    pointer('pointercancel', 400, 300);
    assert.equal(engine.getDocument().strokes[0].points.length, 3);
  });
});


test('writing view fills the width and follows sidebar resizing until manually zoomed', () => {
  withEngine(({ engine, getZoom, resize }) => {
    const writingZoom = getZoom();
    assert.ok(1400 * writingZoom > 900, 'initial page should fill the writing area');
    engine.fit();
    assert.ok(getZoom() < writingZoom, 'whole-page overview remains available');
    engine.fitWidth();
    assert.equal(getZoom(), writingZoom);
    resize(720, 900);
    assert.ok(1400 * getZoom() > 650 && 1400 * getZoom() < 720, 'sidebar reduces fitted width');
    engine.zoomBy(1.25);
    const manualZoom = getZoom();
    resize(1024, 900);
    assert.equal(getZoom(), manualZoom, 'resizing preserves a manually selected scale');
    engine.fitWidth();
    assert.equal(getZoom(), writingZoom);
  });
});


test('search highlights remain transient, track zoom, and clear on page changes', () => {
  withEngine(({ engine, host, changes, flush }) => {
    const before = engine.getDocument();
    const svg = engine.exportSvg();
    const arcs = host.canvases[0].context.arcs;
    engine.setSearchHighlights([{ x: 100, y: 1400, width: 160, height: 40 }], 0);
    flush();
    const overlay = host.layers[0];
    assert.equal(overlay.children.length, 1);
    assert.match(overlay.children[0].className, /is-active/);
    assert.equal(host.canvases[0].context.arcs, arcs, 'updating results does not repaint historical ink');
    const transform = overlay.style.transform;
    engine.focusSearchHighlight(0);
    assert.notEqual(overlay.style.transform, transform, 'focus moves an offscreen match into view');
    const focused = overlay.style.transform;
    engine.zoomBy(1.2);
    assert.notEqual(overlay.style.transform, focused, 'overlay follows zoom immediately');
    assert.equal(engine.getDocument(), before);
    assert.equal(engine.canUndo(), false);
    assert.equal(changes.length, 0);
    assert.equal(engine.exportSvg(), svg, 'search marks never enter exported artwork');
    engine.setDocument(createDocument());
    assert.equal(overlay.children.length, 0);
  }, note());
});

test('highlight input is bounded and malformed rectangles cannot affect the viewport', () => {
  withEngine(({ engine, host, viewportChanges }) => {
    engine.setSearchHighlights([
      { x: Number.NaN, y: 10, width: 20, height: 20 },
      { x: 10, y: 10, width: -20, height: 20 },
      { x: 1500, y: 10, width: 20, height: 20 },
    ]);
    assert.equal(host.layers[0].children.length, 0);
    const count = viewportChanges();
    engine.focusSearchHighlight(-1);
    engine.focusSearchHighlight(Number.NaN);
    assert.equal(viewportChanges(), count);
    engine.setSearchHighlights([
      { x: NaN, y: 10, width: 20, height: 20 },
      { x: 10, y: 1400, width: 20, height: 20 },
    ]);
    engine.focusSearchHighlight(1);
    assert.match(host.layers[0].children[0].className, /is-active/, 'focus retains original indices after rejecting invalid boxes');
    engine.setSearchHighlights(Array.from({ length: 1200 }, () => ({ x: 10, y: 10, width: 20, height: 20 })));
    assert.equal(host.layers[0].children.length, 1000);
    engine.setSearchHighlights([]);
    assert.equal(host.layers[0].children.length, 0);
  });
});


const viewport = (host: Host) => {
  const values = host.layers[0].style.transform.match(/translate\(([-.\d]+)px, ([-.\d]+)px\) scale\(([-.\d]+)\)/)!;
  return { x: Number(values[1]), y: Number(values[2]), zoom: Number(values[3]) };
};
const wheelTo = (host: Host, deltaY: number, deltaX = 0) => {
  const event = new Event('wheel', { cancelable: true });
  Object.assign(event, { deltaY, deltaX, clientX: 500, clientY: 500 }); host.dispatchEvent(event);
};
const contact = (y: number, pointerType = 'touch', pointerId = 2, x = 500) => ({ clientX: x, clientY: y, pointerType, pointerId });

test('wheel panning stops at page edges and overview stays centered', () => {
  withEngine(({ engine, host, advances, pulls }) => {
    wheelTo(host, 100000, 100000);
    let view = viewport(host);
    assert.equal(view.x, 32);
    assert.ok(Math.abs(view.y + 1900 * view.zoom - 872) < 1e-6);
    wheelTo(host, -100000, -100000);
    assert.equal(viewport(host).y, 100);
    engine.fit(); const fitted = viewport(host);
    wheelTo(host, 100000, 100000);
    assert.deepEqual(viewport(host), fitted);
    assert.equal(advances(), 0); assert.deepEqual(pulls, []);
  });
});

test('zoom, search focus and resize keep the writing surface within page bounds', () => {
  withEngine(({ engine, host, resize }) => {
    engine.zoomBy(3);
    wheelTo(host, 100000, 100000);
    let view = viewport(host);
    assert.ok(Math.abs(view.x + 1400 * view.zoom - 996) < 1e-6);
    engine.setSearchHighlights([{ x: 0, y: 0, width: 10, height: 10 }, { x: 1390, y: 1890, width: 10, height: 10 }]);
    engine.focusSearchHighlight(0);
    assert.equal(viewport(host).x, 28); assert.equal(viewport(host).y, 100);
    engine.focusSearchHighlight(1);
    view = viewport(host);
    assert.ok(Math.abs(view.y + 1900 * view.zoom - 872) < 1e-6);
    resize(600, 500);
    view = viewport(host);
    assert.ok(view.x >= 600 - 28 - 1400 * view.zoom && view.x <= 28);
    assert.ok(view.y >= 500 - 28 - 1900 * view.zoom && view.y <= 140);
    engine.zoomBy(0.01); const overview = viewport(host);
    wheelTo(host, -100000, 100000);
    assert.deepEqual(viewport(host), overview);
  });
});

test('bottom pull previews continuously, reverses, and advances only on armed release', () => {
  withEngine(({ host, pointer, pulls, advances, changes }) => {
    wheelTo(host, 100000); const bottom = viewport(host);
    pointer('pointerdown', 0, 0, contact(500));
    pointer('pointermove', 0, 0, contact(452));
    assert.equal(pulls.at(-1), 0.5); assert.equal(advances(), 0);
    assert.deepEqual(viewport(host), bottom, 'feedback does not detach the page from its boundary');
    pointer('pointermove', 0, 0, contact(380)); assert.equal(pulls.at(-1), 1);
    pointer('pointermove', 0, 0, contact(480)); assert.ok(pulls.at(-1)! < 0.25);
    pointer('pointerup', 0, 0, contact(480)); assert.equal(advances(), 0); assert.equal(pulls.at(-1), 0);
    pointer('pointerdown', 0, 0, contact(500));
    pointer('pointerup', 0, 0, contact(404));
    assert.equal(advances(), 1); assert.equal(pulls.at(-1), 0);
    pointer('lostpointercapture', 0, 0, contact(404)); assert.equal(advances(), 1);
    assert.equal(changes.length, 0, 'navigation never changes ink');
  });
});

test('pull counts only travel beyond the bottom and ignores predominantly horizontal drags', () => {
  withEngine(({ host, pointer, advances, pulls }) => {
    pointer('pointerdown', 0, 0, contact(800));
    pointer('pointermove', 0, 0, contact(300));
    assert.equal(pulls.length, 0, 'ordinary travel to page bottom is not a pull');
    pointer('pointerup', 0, 0, contact(300)); assert.equal(advances(), 0);
    wheelTo(host, 100000);
    pointer('pointerdown', 0, 0, contact(500));
    pointer('pointerup', 0, 0, contact(350, 'touch', 2, 800));
    assert.equal(advances(), 0);
  });
});

test('pinch cancels an armed pull and its surviving finger cannot advance', () => {
  withEngine(({ host, pointer, advances, pulls }) => {
    wheelTo(host, 100000);
    pointer('pointerdown', 0, 0, contact(600));
    pointer('pointermove', 0, 0, contact(490)); assert.equal(pulls.at(-1), 1);
    pointer('pointerdown', 0, 0, contact(600, 'touch', 3)); assert.equal(pulls.at(-1), 0);
    pointer('pointermove', 0, 0, contact(300, 'touch', 3));
    pointer('pointerup', 0, 0, contact(300, 'touch', 3));
    pointer('pointerup', 0, 0, contact(-500)); assert.equal(advances(), 0);
    wheelTo(host, 100000);
    pointer('pointerdown', 0, 0, contact(500));
    pointer('pointerup', 0, 0, contact(300)); assert.equal(advances(), 1);
  });
});

test('cancel, capture loss, resize, tool changes and document changes disarm pulls', () => {
  for (const interruption of ['pointercancel', 'lostpointercapture', 'resize', 'tool', 'document', 'wheel', 'zoom']) {
    withEngine(({ engine, host, pointer, advances, pulls, resize }) => {
      wheelTo(host, 100000);
      pointer('pointerdown', 0, 0, contact(500));
      pointer('pointermove', 0, 0, contact(300)); assert.equal(pulls.at(-1), 1);
      if (interruption === 'resize') resize(720, 900);
      else if (interruption === 'tool') engine.setTool('eraser');
      else if (interruption === 'document') engine.setDocument(createDocument());
      else if (interruption === 'wheel') wheelTo(host, 1);
      else if (interruption === 'zoom') engine.zoomBy(1.2);
      else pointer(interruption, 0, 0, contact(300));
      assert.equal(pulls.at(-1), 0, interruption);
      pointer('pointerup', 0, 0, contact(100)); assert.equal(advances(), 0, interruption);
    });
  }
});

test('hand mouse drags advance, but Pencil and finger drawing never do', () => {
  withEngine(({ engine, host, pointer, advances, pulls }) => {
    engine.setTool('hand'); wheelTo(host, 100000);
    pointer('pointerdown', 0, 0, contact(500, 'mouse'));
    pointer('pointerup', 0, 0, contact(300, 'mouse')); assert.equal(advances(), 1);
    pointer('pointerdown', 0, 0, contact(500, 'pen'));
    pointer('pointermove', 0, 0, contact(300, 'pen'));
    pointer('pointerup', 0, 0, contact(300, 'pen')); assert.equal(advances(), 1);
    engine.setTool('pen'); engine.setFingerDrawing(true);
    pointer('pointerdown', 0, 0, contact(500));
    pointer('pointermove', 0, 0, contact(300));
    pointer('pointerup', 0, 0, contact(300)); assert.equal(advances(), 1);
    assert.deepEqual(pulls, [1, 0]);
  });
});

test('Pencil interruption cancels a pull before drawing and ignores the existing finger', () => {
  withEngine(({ host, pointer, advances, pulls }) => {
    wheelTo(host, 100000);
    pointer('pointerdown', 0, 0, contact(500));
    pointer('pointermove', 0, 0, contact(300)); assert.equal(pulls.at(-1), 1);
    pointer('pointerdown', 0, 0, contact(500, 'pen', 1)); assert.equal(pulls.at(-1), 0);
    pointer('pointerup', 0, 0, contact(300, 'pen', 1));
    pointer('pointerup', 0, 0, contact(100)); assert.equal(advances(), 0);
  });
});

test('Pencil in Hand mode suppresses palm movement and page pulls until lifted', () => {
  withEngine(({ engine, host, pointer, advances, pulls }) => {
    engine.setTool('hand'); wheelTo(host, 100000);
    pointer('pointerdown', 0, 0, contact(500, 'pen', 1));
    const beforePalm = viewport(host);
    pointer('pointerdown', 0, 0, contact(500));
    pointer('pointermove', 0, 0, contact(700));
    assert.deepEqual(viewport(host), beforePalm, 'palm does not pan while Pencil is held');
    pointer('pointerup', 0, 0, contact(300, 'pen', 1));
    pointer('pointerup', 0, 0, contact(100));
    assert.equal(advances(), 0); assert.deepEqual(pulls, []);
    pointer('pointerdown', 0, 0, contact(500));
    pointer('pointerup', 0, 0, contact(300));
    assert.equal(advances(), 1, 'a fresh finger gesture works after Pencil lifts');
  });
});

test('overlapping mouse and touch contacts cannot commit a page pull', () => {
  for (const first of ['mouse', 'touch']) {
    withEngine(({ engine, host, pointer, advances, pulls }) => {
      engine.setTool('hand'); wheelTo(host, 100000);
      const second = first === 'mouse' ? 'touch' : 'mouse';
      pointer('pointerdown', 0, 0, contact(500, first, 2));
      pointer('pointermove', 0, 0, contact(300, first, 2));
      assert.equal(pulls.at(-1), 1);
      pointer('pointerdown', 0, 0, contact(500, second, 3));
      pointer('pointerup', 0, 0, contact(300, second, 3));
      pointer('pointerup', 0, 0, contact(100, first, 2));
      assert.equal(advances(), 0, first);
      assert.equal(pulls.at(-1), 0);
    });
  }
});
