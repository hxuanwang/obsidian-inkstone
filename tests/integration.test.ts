import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { inkSignature } from '../src/ink-signature';
const recognized = (text: string, strokes: any[]) => ({ text, words: [{ text, x: 8, y: 15, width: 80, height: 20 }], inkSignature: inkSignature(strokes) });
const createDocument = (paper = 'ruled') => ({version:2,pages:[{id:'page1',title:'Page 1',paper,strokes:[],text:'',transcript:''}]});

// Exercise the real plugin against narrow host/editor doubles. This verifies
// document isolation and preservation, not Obsidian's own disk-save machinery.
const doubles: Record<string, string> = {
  obsidian: `
    function element() {
      return { addClass: name => state.classes.push(name), empty() {},
        createDiv: () => element(), createEl: (_tag, attrs) => state.messages.push(attrs.text) };
    }
    export class TextFileView {
      constructor(leaf) { this.file = leaf.file; this.contentEl = element(); }
      requestSave() { state.saveRequests++; }
      async onUnloadFile() { state.unloadedData = this.getViewData(); }
      async onClose() { state.closedData = this.getViewData(); }
    }
    export class Plugin {
      constructor(app) { this.app = app; this.manifest = {id:'inkstone',dir:'.obsidian/plugins/inkstone'}; }
      registerView(_type, factory) { state.factory = factory; }
      registerExtensions() {} addRibbonIcon() {} addCommand() {} registerEvent() {}
    }
    export class Modal {}
    export class TFile {}
    export class Notice { constructor(message) { state.messages.push(message); } }
    export const normalizePath = path => path.replace(/^\\//, '');
  `,
  './recognition': `export class LocalRecognizer { constructor() {} async destroy() {} }`,
  './editor': `
    export class InkEditor {
      constructor(host, options) { this.options = options; state.editors.push(this); }
      setActivePage(id) { this.activePage = id; }
      setSearchQuery(query) { this.searchQuery = query; }
      destroy() { this.destroyed = true; if (this.pending) this.options.onChange(this.pending); }
    }
  `,
};
const bundled = build({
  entryPoints: ['src/main.ts'], bundle: true, write: false, format: 'cjs', platform: 'node',
  plugins: [{
    name: 'integration-doubles',
    setup(builder) {
      builder.onResolve({ filter: /^(obsidian|\.\/editor|\.\/recognition)$/ }, args => ({ path: args.path, namespace: 'double' }));
      builder.onLoad({ filter: /.*/, namespace: 'double' }, args => ({ loader: 'js', contents: doubles[args.path] }));
    },
  }],
});

async function fixture() {
  const state: any = { editors: [], saveRequests: 0, classes: [], messages: [] };
  const module = { exports: {} as any };
  const result = await bundled;
  runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, state, crypto });
  const plugin = new module.exports.default({ workspace: { on() {}, onLayoutReady() {}, getLeavesOfType() { return []; } }, vault: { configDir: '.obsidian', adapter: { getResourcePath(path: string) { return path; } }, on() {} } });
  await plugin.onload();
  const fileA = { basename: 'First', path: 'First.inkstone' };
  const view = state.factory({ file: fileA });
  return { state, view, fileA, plugin };
}

test('preserves exact source until edited, then serializes the current document on save', async () => {
  const { state, view } = await fixture();
  const original = JSON.stringify(createDocument(), null, 2);
  view.setViewData(original, true);
  assert.equal(view.getViewData(), original);
  assert.equal(state.saveRequests, 0);
  assert.ok(state.classes.includes('inkstone-view'));
  const next = createDocument('grid');
  state.editors[0].options.onChange(next);
  assert.equal(state.saveRequests, 1);
  assert.deepEqual(JSON.parse(view.getViewData()), next);
  await view.onClose();
  assert.equal(state.editors[0].destroyed, true);
  assert.deepEqual(JSON.parse(state.closedData), next);
});

test('callbacks from a previous note cannot modify or queue saves for the next note', async () => {
  const { state, view } = await fixture();
  view.setViewData(JSON.stringify(createDocument()), true);
  const oldEditor = state.editors[0];
  view.file = { basename: 'Second', path: 'Second.inkstone' };
  const second = JSON.stringify(createDocument('dots'));
  view.setViewData(second, true);
  oldEditor.options.onChange(createDocument('grid'));
  assert.equal(oldEditor.destroyed, true);
  assert.equal(view.getViewData(), second);
  assert.equal(state.saveRequests, 0);
  view.clear();
  state.editors[1].options.onChange(createDocument());
  assert.equal(view.getViewData(), '');
  assert.equal(state.saveRequests, 0);
});

test('finalizes active ink before delegating file unload to the host save lifecycle', async () => {
  const { state, view, fileA } = await fixture();
  view.setViewData(JSON.stringify(createDocument()), true);
  const latest = createDocument('blank');
  state.editors[0].pending = latest;
  await view.onUnloadFile(fileA);
  assert.deepEqual(JSON.parse(state.unloadedData), latest);
  assert.equal(state.saveRequests, 1);
  state.editors[0].options.onChange(createDocument());
  assert.deepEqual(JSON.parse(view.getViewData()), latest);
  assert.equal(state.saveRequests, 1);
});

test('malformed and unsupported documents retain original bytes and invalidate old callbacks', async () => {
  const { state, view } = await fixture();
  view.setViewData(JSON.stringify(createDocument()), true);
  const oldEditor = state.editors[0];
  for (const invalid of ['{broken json', '{"version":999,"strokes":[],"paper":"ruled"}']) {
    view.setViewData(invalid, true);
    oldEditor.options.onChange(createDocument());
    assert.equal(view.getViewData(), invalid);
    assert.equal(state.saveRequests, 0);
  }
  assert.equal(state.editors.length, 1);
  assert.ok(state.messages.some((message: string) => message.includes('original file has been preserved')));
});


test('recognition preserves concurrent typed edits and does not replace a corrected transcript', async () => {
  const { plugin, fileA } = await fixture();
  const note = createDocument();
  (note.pages[0].strokes as any[]).push({id:'s1',tool:'pen',color:'#123456',width:3,points:[{x:10,y:20,pressure:.5,time:0}]});
  let source = JSON.stringify(note);
  plugin.app.vault.read = async () => source;
  plugin.app.vault.process = async (_file: unknown, update: (source: string) => string) => { source = update(source); };
  plugin.recognizer.recognize = async () => {
    const edited = JSON.parse(source); edited.pages[0].text = 'Written during recognition'; source = JSON.stringify(edited); return recognized('Recognized text', note.pages[0].strokes);
  };
  await plugin.recognizeFilePage(fileA, 'page1');
  assert.equal(JSON.parse(source).pages[0].text, 'Written during recognition');
  assert.equal(JSON.parse(source).pages[0].transcript, 'Recognized text');
  assert.deepEqual(JSON.parse(source).pages[0].recognition, { transcript: 'Recognized text', words: recognized('Recognized text', note.pages[0].strokes).words, inkSignature: inkSignature(note.pages[0].strokes) });
  plugin.recognizer.recognize = async () => {
    const edited = JSON.parse(source); edited.pages[0].transcript = 'My correction'; source = JSON.stringify(edited); return recognized('Late OCR', note.pages[0].strokes);
  };
  await plugin.recognizeFilePage(fileA, 'page1');
  assert.equal(JSON.parse(source).pages[0].transcript, 'My correction');
  assert.equal(JSON.parse(source).pages[0].recognition.transcript, 'Recognized text', 'late recognition must not replace prior word positions');
});

test('recognition discards results when ink changes during the job', async () => {
  const { plugin, fileA } = await fixture();
  const note = createDocument();
  (note.pages[0].strokes as any[]).push({id:'s1',tool:'pen',color:'#123456',width:3,points:[{x:10,y:20,pressure:.5,time:0}]});
  let source = JSON.stringify(note);
  plugin.app.vault.read = async () => source;
  plugin.app.vault.process = async (_file: unknown, update: (source: string) => string) => { source = update(source); };
  plugin.recognizer.recognize = async () => {
    const edited = JSON.parse(source); edited.pages[0].strokes[0].points[0].x = 60; source = JSON.stringify(edited); return recognized('Stale words', note.pages[0].strokes);
  };
  await plugin.recognizeFilePage(fileA, 'page1');
  assert.equal(JSON.parse(source).pages[0].transcript, '');
  assert.equal(JSON.parse(source).pages[0].recognition, undefined);
  assert.equal(JSON.parse(source).pages[0].strokes[0].points[0].x, 60);
});


test('note view forwards a search query after switching to the result page', async () => {
  const { view, state } = await fixture();
  view.setViewData(JSON.stringify(createDocument()), false);
  view.setActivePage('page1');
  view.setSearchQuery('handwritten word');
  const editor = state.editors.at(-1);
  assert.equal(editor.activePage, 'page1');
  assert.equal(editor.searchQuery, 'handwritten word');
});
