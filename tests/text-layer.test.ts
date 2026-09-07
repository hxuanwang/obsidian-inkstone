import test from 'node:test';
import assert from 'node:assert/strict';
import { TextLayer } from '../src/text-layer';
import type { TextBox } from '../src/model';

// Minimal DOM doubles exercise pointer transactions; native focus/capture need browser QA.
class Element extends EventTarget {
  children: Element[] = [];
  parent: Element | null = null;
  className = '';
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  style: Record<string, unknown> = { setProperty(name: string, value: string) { this[name] = value; } };
  readOnly = false;
  tabIndex = 0;
  value = '';
  focused = false;
  classList = { toggle: (name: string, force: boolean) => {
    const classes = new Set(this.className.split(' ').filter(Boolean));
    if (force) classes.add(name); else classes.delete(name);
    this.className = [...classes].join(' ');
  } };
  constructor(readonly tagName = 'div') { super(); }
  append(...children: Element[]) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren() { for (const child of this.children) child.parent = null; this.children = []; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  matches(selector: string): boolean {
    if (selector === ':focus') return this.focused;
    return selector.startsWith('.') ? this.className.split(' ').includes(selector.slice(1)) : this.tagName === selector;
  }
  closest(selector: string): Element | null { return this.matches(selector) ? this : this.parent?.closest(selector) ?? null; }
  querySelectorAll(selector: string): Element[] { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] ?? null; }
  setPointerCapture() {}
  getBoundingClientRect() { return { left: 10, top: 20 }; }
  focus() { this.focused = true; }
  blur() { this.focused = false; }
}
const box = (patch: Partial<TextBox> = {}): TextBox => ({ id: 'text-1', x: 100, y: 200, width: 420, height: 200, text: 'Hello', color: '#123456', fontSize: 28, ...patch });
function pointer(target: Element, type: string, x: number, y: number, pointerId = 1) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { clientX: x, clientY: y, pointerId, button: 0, pointerType: 'touch' });
  target.dispatchEvent(event);
}
function withLayer(run: (state: { layer: TextLayer; surface: Element; changes: TextBox[][]; move: () => Element; input: () => Element }) => void) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: (tag: string) => new Element(tag) } });
  const surface = new Element();
  const changes: TextBox[][] = [];
  const layer = new TextLayer(surface as unknown as HTMLElement, () => ({ x: 30, y: 40, zoom: 2 }), boxes => changes.push(structuredClone(boxes)), () => '#123456');
  const move = () => surface.querySelectorAll('button').find(element => element.attributes['aria-label'] === 'Move text box')!;
  const input = () => surface.querySelector('textarea')!;
  try { layer.setBoxes([box()]); layer.setEnabled(true); run({ layer, surface, changes, move, input }); }
  finally { layer.destroy(); if (descriptor) Object.defineProperty(globalThis, 'document', descriptor); else Reflect.deleteProperty(globalThis, 'document'); }
}

test('page replacement and capture loss cancel pending text insertion taps', () => {
  for (const interruption of ['page', 'capture']) withLayer(({ layer, surface, changes }) => {
    pointer(surface, 'pointerdown', 500, 500);
    if (interruption === 'page') layer.setBoxes([box({ id: 'another-page' })]);
    else pointer(surface, 'lostpointercapture', 500, 500);
    pointer(surface, 'pointerup', 500, 500);
    assert.equal(changes.length, 0, interruption);
    pointer(surface, 'pointerdown', 500, 500); pointer(surface, 'pointerup', 500, 500);
    assert.equal(changes.length, 1, 'a fresh tap still inserts text');
    assert.deepEqual({ x: changes[0][1].x, y: changes[0][1].y }, { x: 230, y: 220 }, 'insertion uses page coordinates');
  });
});

test('text dragging previews without saves and commits the final release coordinate once', () => {
  withLayer(({ changes, move }) => {
    const handle = move();
    pointer(handle, 'pointerdown', 200, 300);
    pointer(handle, 'pointermove', 220, 340);
    pointer(handle, 'pointermove', 260, 360);
    assert.equal(changes.length, 0);
    pointer(handle, 'pointerup', 300, 400);
    assert.equal(changes.length, 1);
    assert.equal(changes[0][0].x, 150); assert.equal(changes[0][0].y, 250);
    pointer(handle, 'lostpointercapture', 300, 400);
    assert.equal(changes.length, 1, 'implicit capture release does not commit or revert twice');
  });
});

test('cancelled text drags discard intermediate positions from later edits', () => {
  for (const interruption of ['pointercancel', 'lostpointercapture']) withLayer(({ changes, move, input }) => {
    const handle = move();
    pointer(handle, 'pointerdown', 200, 300); pointer(handle, 'pointermove', 500, 600);
    pointer(handle, interruption, 500, 600);
    pointer(handle, 'pointerup', 500, 600);
    assert.equal(changes.length, 0);
    input().value = 'After cancellation'; input().dispatchEvent(new Event('input'));
    assert.equal(changes[0][0].x, 100); assert.equal(changes[0][0].y, 200);
    assert.equal(changes[0][0].text, 'After cancellation');
  });
});

test('a stale drag cannot update a replacement page with the same text box ID', () => {
  withLayer(({ layer, changes, move, input }) => {
    const handle = move();
    pointer(handle, 'pointerdown', 200, 300); pointer(handle, 'pointermove', 500, 600);
    layer.setBoxes([box({ x: 600, y: 700 })]);
    pointer(handle, 'pointerup', 700, 800);
    assert.equal(changes.length, 0);
    input().value = 'Destination'; input().dispatchEvent(new Event('input'));
    assert.equal(changes[0][0].x, 600); assert.equal(changes[0][0].y, 700);
  });
});

test('text inputs become read-only and leave keyboard navigation when text tool is disabled', () => {
  withLayer(({ layer, input }) => {
    assert.equal(input().readOnly, false); assert.equal(input().tabIndex, 0);
    input().focus(); layer.setEnabled(false);
    assert.equal(input().readOnly, true); assert.equal(input().tabIndex, -1); assert.equal(input().focused, false);
    layer.setBoxes([box({ id: 'replacement' })]);
    assert.equal(input().readOnly, true); assert.equal(input().tabIndex, -1);
    layer.setEnabled(true);
    assert.equal(input().readOnly, false); assert.equal(input().tabIndex, 0);
  });
});
