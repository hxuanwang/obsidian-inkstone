import test from 'node:test';
import assert from 'node:assert/strict';
import { TextLayer } from '../src/text-layer';
import type { TextBox } from '../src/model';

// Minimal DOM doubles exercise pointer transactions; native focus/capture need browser QA.
class Element extends EventTarget {
  children: Element[] = [];
  parent: Element | null = null;
  get parentElement() { return this.parent; }
  clientWidth = 420;
  scrollLeft = 0;
  scrollTop = 0;
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
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: (tag: string) => new Element(tag), createTextNode: (text: string) => Object.assign(new Element('#text'), {textContent: text}) } });
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


test('on-page search marks only matching text and follows scrolling', () => {
  withLayer(({layer, surface, input}) => {
    layer.setBoxes([box({text: 'Hello world Hello'})]);
    layer.setQuery('hello');
    const mirror = surface.querySelector('.inkstone-text-highlight-content')!;
    assert.equal(mirror.querySelectorAll('mark').length, 2);
    input().scrollTop = 24;
    input().dispatchEvent(new Event('scroll'));
    assert.equal(mirror.style.transform, 'translate(0px,-24px)');
    layer.setQuery('absent');
    assert.equal(mirror.children.length, 0);
  });
});

test('text insertion and page overlay use the current paper dimensions', () => {
  withLayer(({ layer, surface, changes }) => {
    layer.setPageFormat({ pageSize: 'a4' });
    pointer(surface, 'pointerdown', 40 + 500 * 2, 60 + 1950 * 2);
    pointer(surface, 'pointerup', 40 + 500 * 2, 60 + 1950 * 2);
    assert.equal(changes.at(-1)!.at(-1)!.y, 1780, 'A4 text can reach below the standard-page edge');
    layer.setPageFormat({ pageSize: 'a4', orientation: 'landscape' });
    layer.setBoxes([]);
    const overlay = surface.querySelector('.inkstone-text-layer')!;
    assert.equal(overlay.style.width, '1980px'); assert.equal(overlay.style.height, '1400px');
    pointer(surface, 'pointerdown', 40 + 1900 * 2, 60 + 1350 * 2);
    pointer(surface, 'pointerup', 40 + 1900 * 2, 60 + 1350 * 2);
    assert.equal(changes.at(-1)![0].x, 1560); assert.equal(changes.at(-1)![0].y, 1200);
    const count = changes.length;
    pointer(surface, 'pointerdown', 40 + 1900 * 2, 60 + 1500 * 2);
    pointer(surface, 'pointerup', 40 + 1900 * 2, 60 + 1500 * 2);
    assert.equal(changes.length, count, 'clicks beyond the landscape bottom cannot create unsavable text');
  });
});

test('paper changes cancel pending insertion and text dragging clamps to landscape bounds', () => {
  withLayer(({ layer, surface, changes, move }) => {
    pointer(surface, 'pointerdown', 500, 500);
    layer.setPageFormat({ pageSize: 'a4', orientation: 'landscape' });
    pointer(surface, 'pointerup', 500, 500);
    assert.equal(changes.length, 0);
    const handle = move();
    pointer(handle, 'pointerdown', 200, 300);
    pointer(handle, 'pointerup', 10000, 10000);
    assert.equal(changes.at(-1)![0].x, 1560);
    assert.equal(changes.at(-1)![0].y, 1200);
  });
});

import type { SpellingDictionary } from '../src/spelling';
const dictionary = { misspellings: (text: string) => [...text.matchAll(/\bheello\b/g)].map(match => ({ start: match.index!, end: match.index! + match[0].length, word: match[0] })) } as SpellingDictionary;
async function withSpellingLayer(loader: () => Promise<SpellingDictionary>, run: (state: { layer: TextLayer; surface: Element; input: () => Element }) => Promise<void>) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: (tag: string) => new Element(tag), createTextNode: (text: string) => Object.assign(new Element('#text'), {textContent: text}) } });
  const surface = new Element();
  const layer = new TextLayer(surface as unknown as HTMLElement, () => ({ x: 0, y: 0, zoom: 1 }), () => {}, () => '#123456', loader);
  try { layer.setBoxes([box({ text: 'heello world' })]); await run({ layer, surface, input: () => surface.querySelector('textarea')! }); }
  finally { layer.destroy(); if (descriptor) Object.defineProperty(globalThis, 'document', descriptor); else Reflect.deleteProperty(globalThis, 'document'); }
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test('typed spelling lazily loads once, coexists with search, follows scroll and clears when disabled', async () => {
  let loads = 0;
  await withSpellingLayer(async () => { loads++; return dictionary; }, async ({ layer, surface, input }) => {
    assert.equal(loads, 0);
    layer.setSpellcheck(true); layer.setSpellcheck(true); await settle();
    assert.equal(loads, 1);
    layer.setQuery('heello');
    const mirror = surface.querySelector('.inkstone-text-highlight-content')!;
    assert.equal(mirror.querySelectorAll('.inkstone-spelling-word').length, 1);
    assert.equal(mirror.querySelectorAll('mark').length, 1);
    input().scrollTop = 45; input().scrollLeft = 8; input().clientWidth = 405;
    input().dispatchEvent(new Event('scroll'));
    assert.equal(mirror.style.transform, 'translate(-8px,-45px)');
    assert.equal(mirror.style.width, '405px');
    layer.setSpellcheck(false);
    assert.equal(mirror.querySelectorAll('.inkstone-spelling-word').length, 0);
    assert.equal(mirror.querySelectorAll('mark').length, 1, 'disabling spelling preserves search matches');
  });
});

test('typed spelling checks the latest edit after debounce and removes corrected underlines', async () => {
  await withSpellingLayer(async () => dictionary, async ({ layer, surface, input }) => {
    layer.setSpellcheck(true); await settle();
    const mirror = surface.querySelector('.inkstone-text-highlight-content')!;
    assert.equal(mirror.querySelectorAll('.inkstone-spelling-word').length, 1);
    input().value = 'heello again'; input().dispatchEvent(new Event('input'));
    assert.equal(mirror.querySelectorAll('.inkstone-spelling-word').length, 0, 'stale underlines are removed immediately');
    await new Promise(resolve => setTimeout(resolve, 280));
    assert.equal(mirror.querySelectorAll('.inkstone-spelling-word').length, 1);
    input().value = 'hello again'; input().dispatchEvent(new Event('input'));
    await new Promise(resolve => setTimeout(resolve, 280));
    assert.equal(mirror.querySelectorAll('.inkstone-spelling-word').length, 0);
  });
});

test('late dictionary loading cannot revive spelling after disable or destroy', async () => {
  for (const action of ['disable', 'destroy']) {
    let resolve!: (dictionary: SpellingDictionary) => void;
    await withSpellingLayer(() => new Promise(done => { resolve = done; }), async ({ layer, surface }) => {
      layer.setSpellcheck(true);
      if (action === 'disable') layer.setSpellcheck(false); else layer.destroy();
      resolve(dictionary); await settle();
      assert.equal(surface.querySelectorAll('.inkstone-spelling-word').length, 0, action);
    });
  }
});

test('floating text settings edit the selected box in place and carry style to fresh boxes', () => {
  withLayer(({ layer, surface, changes, input }) => {
    const toolbar = layer.getToolbar() as unknown as Element;
    const control = (label: string) => toolbar.querySelectorAll('select').concat(toolbar.querySelectorAll('button'), toolbar.querySelectorAll('input')).find(node => node.attributes['aria-label'] === label)!;
    const original = input();
    original.dispatchEvent(new Event('focus'));
    control('Text font size').value = '48'; control('Text font size').dispatchEvent(new Event('change'));
    control('Bold').dispatchEvent(new Event('click'));
    control('Text alignment').value = 'center'; control('Text alignment').dispatchEvent(new Event('change'));
    control('Text line spacing').value = '1.5'; control('Text line spacing').dispatchEvent(new Event('change'));
    assert.equal(input(), original, 'formatting keeps the textarea and its native selection intact');
    assert.equal(changes.at(-1)![0].fontSize, 48); assert.equal(changes.at(-1)![0].bold, true);
    assert.equal(changes.at(-1)![0].textAlign, 'center'); assert.equal(changes.at(-1)![0].lineHeight, 1.5);
    assert.equal(control('Bold').attributes['aria-pressed'], 'true');
    pointer(surface, 'pointerdown', 700, 700); pointer(surface, 'pointerup', 700, 700);
    const added = changes.at(-1)![1];
    assert.notEqual(added.id, 'text-1'); assert.equal(added.text, ''); assert.equal(added.fontSize, 48);
    assert.equal(added.bold, true); assert.equal(added.textAlign, 'center');
    assert.equal(surface.querySelectorAll('select').length, 0, 'box controls only contain Move and Remove');
  });
});

test('selecting a legacy text box resets formatting controls and changing pages clears selection', () => {
  withLayer(({ layer, input, changes }) => {
    const toolbar = layer.getToolbar() as unknown as Element;
    const bold = toolbar.querySelectorAll('button').find(node => node.attributes['aria-label'] === 'Bold')!;
    layer.setBoxes([box({ bold: true, fontFamily: 'serif' }), box({ id: 'legacy' })]);
    input().dispatchEvent(new Event('focus')); assert.equal(bold.attributes['aria-pressed'], 'true');
    layer.setBoxes([box({ id: 'legacy' })]);input().dispatchEvent(new Event('focus'));
    assert.equal(bold.attributes['aria-pressed'], 'false');
    layer.setBoxes([]);bold.dispatchEvent(new Event('click'));
    assert.equal(changes.length, 0, 'setting defaults after page replacement must not edit the previous page');
  });
});
