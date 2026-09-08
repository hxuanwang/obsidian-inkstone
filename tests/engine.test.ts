import test from 'node:test';
import assert from 'node:assert/strict';
import { createPage as createDocument, pageDimensions, parseDocument, type InkPage as InkDocument } from '../src/model';
import { InkEngine, pointSegmentDistance, PAGE_GAP, PAGE_HEIGHT } from '../src/ink-engine';

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
  fillStyle = '';
  fills: { width: number; height: number; color: string }[] = [];
  clips: { width: number; height: number }[] = [];
  constructor(readonly canvas: Canvas) {}
  setTransform() {} clearRect() {} save() {} restore() {} beginPath() {} clip() {}
  rect(_x: number, _y: number, width: number, height: number) { this.clips.push({ width, height }); }
  setLineDash() {} strokeRect() {} moveTo() {} lineTo() {} closePath() {} fill() {} stroke() {} fillText() {}
  fillRect(_x: number, _y: number, width: number, height: number) { this.fills.push({ width, height, color: this.fillStyle }); }
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
  engine: InkEngine; host: Host; changes: InkDocument[]; activePages: InkDocument[]; viewportChanges: () => number; pulls: number[]; advances: () => number;
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
  install('Image', class { complete = true; naturalWidth = 100; src = ''; onload = null; });
  install('window', { devicePixelRatio: 2 });
  let onResize = () => {};
  install('ResizeObserver', class { constructor(callback: () => void) { onResize = callback; } observe() {} disconnect() {} });
  install('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  install('cancelAnimationFrame', (id: number) => frames.delete(id));
  const host = new Host();
  const changes: InkDocument[] = [];
  const activePages: InkDocument[] = [];
  const pulls: number[] = []; let advances = 0;
  let zoom = 1; let viewportChanges = 0; let timestamp = 0;
  const engine = new InkEngine(host as unknown as HTMLElement, { document, onChange: value => changes.push(value), onActivePageChange: page => activePages.push(page),
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
  try { flush(); run({ engine, host, changes, activePages, pulls, advances: () => advances, viewportChanges: () => viewportChanges, pointer, event, flush, getZoom: () => zoom, resize: (width, height) => { host.width = width; host.height = height; onResize(); } }); }
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

test('a deliberate vertical pull stays continuous through lateral finger drift', () => {
  withEngine(({ host, pointer, pulls, advances }) => {
    wheelTo(host, 100000);
    pointer('pointerdown', 0, 0, contact(500));
    pointer('pointermove', 0, 0, contact(452));
    assert.equal(pulls.at(-1), 0.5);
    pointer('pointermove', 0, 0, contact(440, 'touch', 2, 800));
    assert.equal(pulls.at(-1), 60 / 96, 'lateral drift does not reset progress');
    pointer('pointerup', 0, 0, contact(480, 'touch', 2, 800));
    assert.equal(advances(), 0, 'reversing still disarms the pull');
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

test('pixel erasing is one undo transaction and redo preserves the gap',()=>{
  const page=createDocument();page.strokes=[{id:'line',tool:'pen',color:'#123456',width:3,points:[{x:100,y:200,pressure:.5,time:0},{x:500,y:200,pressure:.5,time:10}]}];
  withEngine(({engine,pointer,changes})=>{
    engine.setTool('eraser');engine.setEraserMode('pixel');
    pointer('pointerdown',300,150);pointer('pointermove',300,250);pointer('pointerup',300,250);
    assert.equal(changes.length,1);assert.equal(changes[0].strokes.length,2);
    engine.undo();assert.equal(changes.at(-1)!.strokes[0].id,'line');
    engine.redo();assert.equal(changes.at(-1)!.strokes.length,2);
  },page);
});

test('trackpad pull requires a fresh bottom gesture and settles into one page advance',t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});
  withEngine(({host,advances,pulls})=>{
    wheelTo(host,100000);for(let i=0;i<5;i++)wheelTo(host,60);
    t.mock.timers.tick(230);assert.equal(advances(),0,'arrival momentum does not add pages');
    for(let i=0;i<3;i++)wheelTo(host,60);
    assert.equal(pulls.at(-1),1);assert.equal(advances(),0);
    t.mock.timers.tick(230);assert.equal(advances(),1);assert.equal(pulls.at(-1),0);
    for(let i=0;i<4;i++)wheelTo(host,60);
    t.mock.timers.tick(230);assert.equal(advances(),1,'tail events cannot add a second page');
  });
});
test('reversing a trackpad pull or interrupting it with Pencil cancels page creation',t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});
  withEngine(({host,advances,pointer})=>{
    wheelTo(host,100000);t.mock.timers.tick(230);
    for(let i=0;i<3;i++)wheelTo(host,60);wheelTo(host,-60);
    t.mock.timers.tick(230);assert.equal(advances(),0);
    wheelTo(host,100000);t.mock.timers.tick(230);
    for(let i=0;i<3;i++)wheelTo(host,60);
    pointer('pointerdown',0,0,contact(500,'pen',1));
    t.mock.timers.tick(230);assert.equal(advances(),0);
  });
});

test('trackpad reversal unwinds progress before scrolling away from the bottom', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  withEngine(({ host, pulls, advances }) => {
    wheelTo(host, 100000); t.mock.timers.tick(230);
    const bottom = viewport(host);
    for (let i = 0; i < 3; i++) wheelTo(host, 60);
    wheelTo(host, -120);
    assert.equal(pulls.at(-1), 1 / 3);
    assert.deepEqual(viewport(host), bottom, 'remaining pull keeps the page at its boundary');
    wheelTo(host, -80);
    assert.equal(pulls.at(-1), 0);
    assert.equal(viewport(host).y, bottom.y + 20, 'only unused reverse distance scrolls the page');
    for (let i = 0; i < 4; i++) wheelTo(host, 60);
    assert.equal(pulls.at(-1), 0, 'returning to the edge needs a fresh gesture');
    t.mock.timers.tick(230); assert.equal(advances(), 0);
  });
});


test('continuous scrolling crosses page seams without changing world position or pulling', () => {
  const pages = [createDocument(), createDocument(), createDocument()];
  withEngine(({ engine, host, activePages, pulls, advances }) => {
    engine.setPages(pages);
    const first = engine.getViewport();
    wheelTo(host, 1000);
    assert.equal(engine.getDocument().id, pages[1].id);
    const second = engine.getViewport();
    const stride = (PAGE_HEIGHT + PAGE_GAP) * second.zoom;
    assert.ok(Math.abs(second.y - stride - (first.y - 1000)) < 1e-6);
    wheelTo(host, -1000);
    assert.equal(engine.getDocument().id, pages[0].id);
    assert.ok(Math.abs(engine.getViewport().y - first.y) < 1e-6);
    assert.deepEqual(activePages.map(page => page.id), [pages[1].id, pages[0].id]);
    assert.deepEqual(pulls, []); assert.equal(advances(), 0);
  }, pages[0]);
});

test('drawing targets the touched visible page and preserves separate undo histories', () => {
  const pages = [createDocument(), createDocument()];
  withEngine(({ engine, host, pointer }) => {
    engine.setPages(pages);
    pointer('pointerdown', 200, 200); pointer('pointerup', 220, 220);
    wheelTo(host, 800);
    const view = engine.getViewport();
    const nextTop = view.y + (PAGE_HEIGHT + PAGE_GAP) * view.zoom;
    const target = { clientX: view.x + 200 * view.zoom, clientY: nextTop + 100 * view.zoom };
    pointer('pointerdown', 0, 0, target); pointer('pointerup', 0, 0, target);
    assert.equal(engine.getDocument().id, pages[1].id);
    assert.equal(engine.getDocument().strokes.length, 1);
    assert.ok(Math.abs(engine.getDocument().strokes[0].points[0].y - 100) < 1e-6);
    engine.undo(); assert.equal(engine.getDocument().strokes.length, 0);
    wheelTo(host, -800);
    assert.equal(engine.getDocument().id, pages[0].id);
    assert.equal(engine.getDocument().strokes.length, 1);
    engine.undo(); assert.equal(engine.getDocument().strokes.length, 0);
    engine.redo(); assert.equal(engine.getDocument().strokes.length, 1);
    wheelTo(host, 1000);
    assert.equal(engine.getDocument().id, pages[1].id);
    engine.redo(); assert.equal(engine.getDocument().strokes.length, 1);
  }, pages[0]);
});

test('page list synchronization keeps the active paper anchored and never resurrects deleted pages', () => {
  const pages = [createDocument(), createDocument(), createDocument()];
  withEngine(({ engine, host }) => {
    engine.setPages(pages); wheelTo(host, 1000);
    const before = engine.getViewport();
    engine.setPages([pages[1], pages[0], pages[2]]);
    assert.equal(engine.getDocument().id, pages[1].id);
    assert.deepEqual(engine.getViewport(), before, 'reordering keeps active paper stationary');
    engine.setPages([pages[0], pages[2]]);
    assert.equal(engine.getDocument().id, pages[0].id);
    wheelTo(host, 100000);
    assert.equal(engine.getDocument().id, pages[2].id, 'surviving last page was not overwritten');
    engine.setPages([pages[0]]);
    assert.equal(engine.getDocument().id, pages[0].id);
    wheelTo(host, 100000);
    assert.equal(engine.getDocument().id, pages[0].id, 'deleted active page did not extend the notebook');
  }, pages[0]);
});

test('finger panning scrolls existing pages and only pulls beyond the last page', () => {
  const pages = [createDocument(), createDocument()];
  withEngine(({ engine, host, pointer, pulls, advances }) => {
    engine.setPages(pages);
    pointer('pointerdown', 0, 0, contact(1400));
    pointer('pointermove', 0, 0, contact(400));
    assert.equal(engine.getDocument().id, pages[1].id);
    assert.deepEqual(pulls, []);
    pointer('pointerup', 0, 0, contact(400));
    assert.equal(advances(), 0);
    wheelTo(host, 100000);
    pointer('pointerdown', 0, 0, contact(500));
    pointer('pointermove', 0, 0, contact(452));
    assert.equal(pulls.at(-1), 0.5);
    pointer('pointerup', 0, 0, contact(404));
    assert.equal(advances(), 1);
  }, pages[0]);
});

test('lasso recoloring and resizing preserve pressure and are separately undoable', () => {
  withEngine(({ engine, pointer }) => {
    pointer('pointerdown', 200, 300, { pressure: .3 }); pointer('pointerup', 400, 400, { pressure: .8 });
    const original = engine.getDocument().strokes[0];
    engine.setTool('lasso');
    pointer('pointerdown', 180, 280); pointer('pointermove', 420, 280); pointer('pointermove', 420, 420); pointer('pointermove', 180, 420); pointer('pointerup', 180, 280);
    engine.recolorSelection('#ff0000'); engine.resizeSelection(2);
    const changed = engine.getDocument().strokes[0];
    assert.equal(changed.color, '#ff0000');
    assert.ok(Math.abs(changed.points[0].x - 100) < 1e-6);
    assert.ok(Math.abs(changed.points[1].y - 450) < 1e-6);
    assert.deepEqual(changed.points.map(p => p.pressure), original.points.map(p => p.pressure));
    engine.undo(); assert.equal(engine.getDocument().strokes[0].color, '#ff0000');
    assert.deepEqual(engine.getDocument().strokes[0].points, original.points);
    engine.undo(); assert.deepEqual(engine.getDocument().strokes[0], original);
  });
});

test('corner resize is one transaction and cancellation restores the selection', () => {
  withEngine(({ engine, pointer, changes }) => {
    pointer('pointerdown', 200, 300); pointer('pointerup', 400, 400);
    engine.setTool('lasso');
    pointer('pointerdown', 180, 280); pointer('pointermove', 420, 280); pointer('pointermove', 420, 420); pointer('pointermove', 180, 420); pointer('pointerup', 180, 280);
    const before = engine.getDocument();
    pointer('pointerdown', 400, 400); pointer('pointermove', 600, 500); pointer('pointercancel', 600, 500);
    assert.equal(engine.getDocument(), before);
    pointer('pointerdown', 400, 400); pointer('pointermove', 500, 450); pointer('pointerup', 600, 500);
    assert.equal(changes.length, 2);
    assert.ok(Math.abs(engine.getDocument().strokes[0].points[1].x - 600) < 1e-6);
    engine.undo(); assert.equal(engine.getDocument(), before);
  });
});

test('explicit shapes preview exact geometry and commit with undo', () => {
  for (const mode of ['rectangle', 'ellipse', 'line', 'arrow'] as const) withEngine(({ engine, pointer, changes }) => {
    engine.setTool('shape'); engine.setShapeMode(mode);
    pointer('pointerdown', 200, 300); pointer('pointermove', 250, 600); pointer('pointerup', 400, 400);
    const stroke = engine.getDocument().strokes[0];
    assert.equal(stroke.points.length, mode === 'ellipse' ? 97 : mode === 'line' ? 2 : 5);
    assert.ok(stroke.points.every(p => p.y < 450), 'preview samples must not survive in committed shape');
    assert.equal(changes.length, 1); engine.undo(); assert.equal(engine.getDocument().strokes.length, 0);
  });
});

test('inserted images can be selected, resized, duplicated, deleted and exported', () => {
  withEngine(({ engine, pointer }) => {
    const src = 'data:image/png;base64,aGVsbG8=';
    engine.addImage({ id: 'image-1', src, x: 200, y: 300, width: 200, height: 100 });
    assert.ok(engine.exportSvg().includes(`href="${src}"`));
    engine.setTool('lasso');
    pointer('pointerdown', 180, 280); pointer('pointermove', 420, 280); pointer('pointermove', 420, 420); pointer('pointermove', 180, 420); pointer('pointerup', 180, 280);
    engine.resizeSelection(2); assert.equal(engine.getDocument().images![0].width, 400);
    engine.duplicateSelection(); assert.equal(engine.getDocument().images!.length, 2);
    engine.deleteSelection(); assert.equal(engine.getDocument().images!.length, 1);
    engine.undo(); assert.equal(engine.getDocument().images!.length, 2);
  });
});

test('format changes resize content in one undo transaction and export the actual paper', () => {
  const page = note();
  page.textBoxes = [{ id: 'text', x: 900, y: 1600, width: 300, height: 200, fontSize: 28, color: '#123456', text: 'Keep this note' }];
  page.images = [{ id: 'image', x: 800, y: 1300, width: 500, height: 500, src: 'data:image/png;base64,aGVsbG8=' }];
  withEngine(({ engine, host, changes, flush }) => {
    const beforeZoom = engine.getViewport().zoom;
    engine.setPageFormat({ pageSize: 'a4', orientation: 'landscape', paperColor: '#e7f0e9', paper: 'cornell' });
    flush();
    const after = engine.getDocument();
    assert.equal(changes.length, 1);
    assert.deepEqual(pageDimensions(after), { width: 1980, height: 1400 });
    assert.ok(engine.getViewport().zoom < beforeZoom, 'fit width follows the wider paper');
    assert.ok(after.strokes[0].points[0].x < page.strokes[0].points[0].x);
    assert.equal(after.textBoxes![0].text, 'Keep this note');
    assert.equal(after.images![0].src, page.images![0].src);
    assert.deepEqual(parseDocument(JSON.stringify({ version: 2, pages: [after] })).pages[0], after);
    const svg = engine.exportSvg();
    assert.match(svg, /width="1980" height="1400" viewBox="0 0 1980 1400"/);
    assert.match(svg, /clipPath id="page"><rect width="1980" height="1400"/);
    assert.match(svg, /fill="#e7f0e9"/);
    assert.ok(host.canvases[0].context.fills.some(fill => fill.width === 1980 && fill.height === 1400 && fill.color === '#e7f0e9'));
    assert.equal(host.layers[0].style.width, '1980px'); assert.equal(host.layers[0].style.height, '1400px');
    engine.undo(); assert.deepEqual(engine.getDocument(), page); assert.equal(engine.getViewport().zoom, beforeZoom);
    engine.redo(); assert.deepEqual(engine.getDocument(), after);
    const saves = changes.length;
    engine.setPageFormat({ pageSize: 'a4', orientation: 'landscape', paperColor: '#e7f0e9', paper: 'cornell' });
    assert.equal(changes.length, saves, 'reapplying identical paper does not create history');
  }, page);
});

test('mixed page sizes scroll continuously using cumulative heights and a shared horizontal center', () => {
  const pages: InkDocument[] = [createDocument(), { ...createDocument(), pageSize: 'a4', orientation: 'landscape', paperColor: '#e8f0ff' }, { ...createDocument(), pageSize: 'letter' }];
  withEngine(({ engine, host, activePages, pulls, flush }) => {
    engine.setPages(pages);
    const first = engine.getViewport();
    wheelTo(host, 1600);
    const second = engine.getViewport();
    assert.equal(engine.getDocument().id, pages[1].id);
    assert.ok(Math.abs(second.y - (1900 + PAGE_GAP) * second.zoom - (first.y - 1600)) < 1e-6);
    assert.ok(Math.abs(second.x + 1980 / 2 * second.zoom - (first.x + 1400 / 2 * first.zoom)) < 1e-6);
    wheelTo(host, 1000);
    const third = engine.getViewport();
    assert.equal(engine.getDocument().id, pages[2].id);
    assert.ok(Math.abs(third.y - (1900 + 1400 + PAGE_GAP * 2) * third.zoom - (first.y - 2600)) < 1e-6);
    assert.equal(third.x, first.x);
    wheelTo(host, -2600);
    assert.equal(engine.getDocument().id, pages[0].id);
    assert.ok(Math.abs(engine.getViewport().y - first.y) < 1e-6);
    assert.deepEqual(activePages.map(page => page.id), [pages[1].id, pages[2].id, pages[0].id]);
    assert.deepEqual(pulls, []);
    host.canvases[0].context.fills = [];
    wheelTo(host, 2100); flush();
    const fills = host.canvases[0].context.fills;
    assert.ok(fills.some(fill => fill.width === 1980 && fill.height === 1400 && fill.color === '#e8f0ff'));
    assert.ok(fills.some(fill => fill.width === 1400 && fill.height === 1812));
    wheelTo(host, 100000);
    const bottom = engine.getViewport();
    assert.equal(engine.getDocument().id, pages[2].id);
    assert.ok(Math.abs(bottom.y + 1812 * bottom.zoom - 872) < 1e-6, 'last page bottom uses its real height');
  }, pages[0]);
});

test('drawing on a wider neighboring page uses its centered local coordinates and separate history', () => {
  const pages: InkDocument[] = [createDocument(), { ...createDocument(), pageSize: 'a4', orientation: 'landscape' }];
  withEngine(({ engine, host, pointer }) => {
    engine.setPages(pages); wheelTo(host, 800);
    const view = engine.getViewport();
    assert.equal(engine.getDocument().id, pages[0].id);
    const target = {
      clientX: view.x + (1400 - 1980) / 2 * view.zoom + 1800 * view.zoom,
      clientY: view.y + (1900 + PAGE_GAP + 100) * view.zoom,
    };
    pointer('pointerdown', 0, 0, target); pointer('pointerup', 0, 0, target);
    assert.equal(engine.getDocument().id, pages[1].id);
    const point = engine.getDocument().strokes[0].points[0];
    assert.ok(Math.abs(point.x - 1800) < 1e-6); assert.ok(Math.abs(point.y - 100) < 1e-6);
    engine.undo(); assert.equal(engine.getDocument().strokes.length, 0);
    engine.redo(); assert.equal(engine.getDocument().strokes.length, 1);
    wheelTo(host, -800); assert.equal(engine.getDocument().id, pages[0].id);
    assert.equal(engine.canUndo(), false);
  }, pages[0]);
});

test('landscape search, selection resizing and inserted image bounds use its full width', () => {
  const page: InkDocument = { ...createDocument(), pageSize: 'a4', orientation: 'landscape' };
  withEngine(({ engine, host, pointer }) => {
    engine.setSearchHighlights([{ x: 1960, y: 1380, width: 50, height: 50 }]);
    assert.match(host.layers[0].children[0].style.cssText, /width:20px;height:20px/);
    engine.addImage({ id: 'edge', src: 'data:image/png;base64,aGVsbG8=', x: 1800, y: 1000, width: 150, height: 100 });
    assert.throws(() => engine.addImage({ id: 'outside', src: 'data:image/png;base64,aGVsbG8=', x: 1800, y: 1400, width: 150, height: 100 }));
    const at = (type: string, x: number, y: number) => {
      const view = engine.getViewport(); pointer(type, 0, 0, { clientX: view.x + x * view.zoom, clientY: view.y + y * view.zoom });
    };
    engine.setTool('lasso');
    at('pointerdown', 1780, 980); at('pointermove', 1970, 980); at('pointermove', 1970, 1120); at('pointermove', 1780, 1120); at('pointerup', 1780, 980);
    engine.resizeSelection(2); engine.duplicateSelection();
    assert.equal(engine.getDocument().images!.length, 2);
    for (const image of engine.getDocument().images!) {
      assert.ok(image.width > 150); assert.ok(image.x + image.width <= 1980); assert.ok(image.y + image.height <= 1400);
    }
    assert.doesNotThrow(() => parseDocument(JSON.stringify({ version: 2, pages: [engine.getDocument()] })));
  }, page);
});


test('format undo preserves subsequent text edits, additions and deletions with valid geometry', () => {
  const page = note();
  page.textBoxes = [
    { id: 'edited', x: 900, y: 1600, width: 300, height: 200, fontSize: 28, color: '#123456', text: 'Before' },
    { id: 'deleted', x: 100, y: 100, width: 300, height: 200, fontSize: 28, color: '#123456', text: 'Remove me' },
  ];
  withEngine(({ engine }) => {
    engine.setPageFormat({ orientation: 'landscape' });
    const formatted = engine.getDocument();
    const edited = { ...formatted, textBoxes: [
      { ...formatted.textBoxes![0], text: 'Keep my later edit', color: '#ff0000', x: formatted.textBoxes![0].x + 20 },
      { id: 'new', x: 1600, y: 1100, width: 300, height: 200, fontSize: 28, color: '#123456', text: 'New note' },
    ] };
    engine.setPages([edited]);
    engine.undo();
    const restored = engine.getDocument();
    assert.deepEqual(pageDimensions(restored), pageDimensions(page));
    assert.deepEqual(restored.textBoxes!.map(box => box.id), ['edited', 'new']);
    assert.equal(restored.textBoxes![0].text, 'Keep my later edit');
    assert.equal(restored.textBoxes![0].color, '#ff0000');
    assert.ok(restored.textBoxes![0].x > page.textBoxes![0].x, 'later movement survives');
    assert.equal(restored.textBoxes![0].y, page.textBoxes![0].y, 'unchanged geometry restores exactly');
    assert.equal(restored.textBoxes![0].fontSize, 28);
    assert.doesNotThrow(() => parseDocument(JSON.stringify({ version: 2, pages: [restored] })));
    engine.redo(); assert.deepEqual(engine.getDocument(), edited, 'redo restores edited text exactly');
    engine.undo(); assert.deepEqual(engine.getDocument(), restored, 'repeated undo is stable');
  }, page);
});

test('ordinary ink undo retains current text before undoing the earlier format', () => {
  const page = note();
  page.textBoxes = [{ id: 'text', x: 100, y: 200, width: 300, height: 200, fontSize: 28, color: '#123456', text: 'Before' }];
  withEngine(({ engine, pointer }) => {
    engine.setPageFormat({ orientation: 'landscape' });
    pointer('pointerdown', 100, 100); pointer('pointerup', 120, 130);
    const edited = { ...engine.getDocument(), textBoxes: engine.getDocument().textBoxes!.map(box => ({ ...box, text: 'After drawing' })) };
    engine.setPages([edited]);
    engine.undo(); assert.equal(engine.getDocument().textBoxes![0].text, 'After drawing');
    engine.undo(); assert.equal(engine.getDocument().textBoxes![0].text, 'After drawing');
    assert.equal(engine.getDocument().textBoxes![0].x, 100);
    engine.redo(); engine.redo(); assert.equal(engine.getDocument().textBoxes![0].text, 'After drawing');
  }, page);
});
