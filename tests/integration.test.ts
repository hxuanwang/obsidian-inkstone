import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { inkSignature } from '../src/ink-signature';
import { pencilSqueezeShortcutUrl } from '../src/pencil-shortcut';
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
      requestSave() { this.dirty = true; state.saveRequests++; }
      async save() { this.dirty = false; state.diskData = this.getViewData(); }
      async onLoadFile() { this.setViewData(state.diskData, true); }
      async onUnloadFile() { await this.save(); state.unloadedData = state.diskData; }
      async onClose() { await this.save(); state.closedData = state.diskData; }
    }
    export class Plugin {
      constructor(app) { this.app = app; this.manifest = {id:'inkstone',dir:'.obsidian/plugins/inkstone'}; }
      registerView(_type, factory) { state.factory = factory; }
      async loadData() { return null; } async saveData() {} addSettingTab() {}
      registerExtensions() {} addRibbonIcon() {} addCommand(command) { state.commands[command.id] = command; } registerEvent() {}
      registerObsidianProtocolHandler(action, handler) { state.protocols[action] = handler; }
    }
    export class Setting {}
    export const requestUrl = async () => { throw new Error('Unexpected network request'); };
    export class PluginSettingTab {}
    export class Modal {}
    export class TFile {}
    export class TFolder {}
    state.folderClass = TFolder;
    export class Notice { constructor(message) { state.messages.push(message); } }
    export const normalizePath = path => path.replace(/^\\//, '');
  `,
  './recognition': `export class LocalRecognizer { constructor() {} async destroy() {} } export function renderRecognitionCrop() { throw new Error('Unexpected raster request'); }`,
  './editor': `
    export class InkEditor {
      constructor(host, options) { this.options = options; state.editors.push(this); }
      setActivePage(id) { this.activePage = id; }
      setSearchQuery(query) { this.searchQuery = query; }
      performPencilAction(action) { state.pencilActions.push(action); }
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
  const state: any = { editors: [], saveRequests: 0, classes: [], messages: [], commands: {}, protocols: {}, pencilActions: [] };
  const module = { exports: {} as any };
  const result = await bundled;
  runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, state, crypto, setTimeout, clearTimeout });
  const plugin = new module.exports.default({ workspace: { on(event: string, callback: unknown) { if(event === "file-menu") state.fileMenu = callback; }, onLayoutReady() {}, getLeavesOfType() { return []; }, getActiveViewOfType() {return state.activeView ?? null;} }, vault: { configDir: '.obsidian', getName() {return 'My vault';}, adapter: { getResourcePath(path: string) { return path; } }, on() {} } });
  await plugin.onload();
  const fileA = { basename: 'First', path: 'First.inkstone' };
  const view = state.factory({ file: fileA });
  return { state, view, fileA, plugin };
}

test('squeeze Shortcut targets the current page and reads the current action mapping', async () => {
  const { state, view, plugin } = await fixture();
  view.setViewData(JSON.stringify(createDocument()), true);
  state.activeView = view;
  const squeeze = state.protocols['inkstone-pencil'];
  squeeze({ action: 'inkstone-pencil', gesture: 'squeeze', vault: 'My vault' });
  assert.deepEqual(state.pencilActions, ['palette']);
  plugin.settings.squeeze = 'eraser';
  squeeze({ action: 'inkstone-pencil', gesture: 'squeeze', vault: 'My vault' });
  assert.deepEqual(state.pencilActions, ['palette', 'eraser']);
  assert.equal(state.saveRequests, 0);
});

test('squeeze Shortcut rejects other gestures, mismatched vaults, and missing writing pages', async () => {
  const { state, view } = await fixture();
  view.setViewData(JSON.stringify(createDocument()), true);
  state.activeView = view;
  const squeeze = state.protocols['inkstone-pencil'];
  squeeze({ action: 'inkstone-pencil', gesture: 'doubleTap' });
  squeeze({ action: 'inkstone-pencil', gesture: 'squeeze', vault: 'Another vault' });
  state.activeView = null;
  squeeze({ action: 'inkstone-pencil', gesture: 'squeeze' });
  assert.deepEqual(state.pencilActions, []);
  assert.match(state.messages.join(' '), /gesture=squeeze.*open the vault.*open a writing page/);
});

test('direct tool commands only execute on writing pages and never execute during availability checks', async () => {
  const { state, view } = await fixture();
  view.setViewData(JSON.stringify(createDocument()), true);
  for (const action of ['eraser', 'previous', 'palette']) {
    const command = state.commands[`tool-${action}`];
    assert.equal(command.checkCallback(false), false);
    state.activeView = view;
    assert.equal(command.checkCallback(true), true);
    assert.equal(state.pencilActions.length, 0);
    assert.equal(command.checkCallback(false), true);
    assert.deepEqual(state.pencilActions, [action]);
    state.pencilActions.length = 0;
    state.activeView = null;
  }
});

test('squeeze Shortcut URL encodes vault names and avoids Obsidian reserved action parameter', () => {
  const url = new URL(pencilSqueezeShortcutUrl('研究 & Notes / 2026'));
  assert.equal(url.hostname, 'inkstone-pencil');
  assert.equal(url.searchParams.get('vault'), '研究 & Notes / 2026');
  assert.equal(url.searchParams.get('gesture'), 'squeeze');
  assert.equal(url.searchParams.has('action'), false);
});

test('Pencil command fallbacks use live mappings and respect command availability checks', async () => {
  const { state, view, plugin } = await fixture();
  view.setViewData(JSON.stringify(createDocument()), true);
  for (const gesture of ['doubleTap', 'squeeze'] as const) {
    const command = state.commands[`pencil-${gesture}`];
    assert.equal(command.checkCallback(false), false);
    state.activeView = view;
    plugin.settings[gesture] = 'undo';
    assert.equal(command.checkCallback(true), true);
    assert.deepEqual(state.pencilActions, []);
    assert.equal(command.checkCallback(false), true);
    assert.deepEqual(state.pencilActions, ['undo']);
    plugin.settings[gesture] = 'none';
    command.checkCallback(false);
    assert.deepEqual(state.pencilActions, ['undo', 'none']);
    state.pencilActions.length = 0;
    state.activeView = null;
  }
});

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

test('startup and ordinary vault edits do not read files or build the search index',async()=>{
  const {plugin}=await fixture();
  let reads=0;
  plugin.app.vault.cachedRead=async()=>{reads++;return '# note';};
  const file={path:'note.md',extension:'md',basename:'note'};
  plugin.queueIndex(file);
  plugin.indexLiveDocument({path:'note.inkstone',extension:'inkstone',basename:'note'},createDocument());
  assert.equal(reads,0);assert.equal(plugin.index.size,0);assert.equal(plugin.indexTimers.size,0);
  assert.equal(plugin.indexStarted,false);plugin.onunload();
});

test('index events coalesce and unloading cancels queued work',async()=>{
  const {plugin}=await fixture();plugin.indexStarted=true;
  const file={path:'note.md',extension:'md',basename:'note'};
  for(let i=0;i<50;i++)plugin.queueIndex(file);
  assert.equal(plugin.indexTimers.size,1);
  plugin.onunload();assert.equal(plugin.indexTimers.size,0);
});

test('a search read started before a rename cannot replace the new path index', async () => {
  const { plugin } = await fixture();
  const file = { path: 'before.md', extension: 'md', basename: 'before' };
  let finishRead!: (source: string) => void;
  plugin.app.vault.cachedRead = () => new Promise(resolve => { finishRead = resolve; });
  const pending = plugin.indexFile(file);
  file.path = 'after.md'; file.basename = 'after';
  // Both path counters may coincidentally have the same revision.
  plugin.indexRevisions.set('after.md', 1);
  plugin.index.markdown('after.md', 'after', 'current content');
  finishRead('outdated content');
  await pending;
  assert.equal(plugin.index.search('current').length, 1);
  assert.equal(plugin.index.search('outdated').length, 0);
  plugin.onunload();
});

test('empty OCR does not erase an existing transcript or write the note', async () => {
  const { plugin, fileA } = await fixture();
  const note = createDocument();
  note.pages[0].transcript = 'Reviewed handwriting';
  (note.pages[0].strokes as any[]).push({ id: 's1', tool: 'pen', color: '#123456', width: 3, points: [{ x: 10, y: 20, pressure: .5, time: 0 }] });
  plugin.app.vault.read = async () => JSON.stringify(note);
  plugin.app.vault.process = async () => { assert.fail('An empty OCR result must not write the note'); };
  plugin.recognizer.recognize = async () => recognized('  ', note.pages[0].strokes);
  await plugin.recognizeFilePage(fileA, 'page1');
  plugin.onunload();
});


test('host autosave resets its dirty flag before serialization; reopened content survives', async () => {
  const { state, view } = await fixture();
  view.setViewData(JSON.stringify(createDocument()), true);
  const next = createDocument('grid');
  next.pages[0].text = 'Keep my typed notes';
  next.pages[0].transcript = 'Keep my handwriting transcript';
  (next.pages[0].strokes as any[]).push({id:'s1',tool:'pen',color:'#123456',width:3,points:[{x:10,y:20,pressure:.5,time:0}]});
  state.editors[0].options.onChange(next);
  await view.save();
  assert.deepEqual(JSON.parse(state.diskData), next);
  await view.save();
  assert.deepEqual(JSON.parse(state.diskData), next, 'unchanged saves preserve serialized edits');
  view.clear();
  await view.onLoadFile();
  assert.deepEqual(JSON.parse(view.getViewData()), next);
  assert.equal(state.editors.at(-1).options.document.pages[0].strokes.length, 1);
  state.editors.at(-1).options.onChange(createDocument('dots'));
  await view.save();
  assert.equal(JSON.parse(state.diskData).pages[0].paper, 'dots');
});

test('New writing folder action creates a unique note in the selected folder and opens it', async () => {
  const { state, plugin } = await fixture();
  const folder = new state.folderClass(); folder.path = 'Projects/Math';
  let action: () => Promise<void>;
  const item = { setTitle(title: string) { assert.equal(title, 'New writing'); return this; }, setIcon() { return this; }, onClick(callback: () => Promise<void>) { action = callback; return this; } };
  state.fileMenu({addItem(callback: (item: any) => void) { callback(item); }}, folder);
  let opened: any;
  plugin.app.vault.getAbstractFileByPath = (path: string) => path === 'Projects/Math/Untitled handwriting.inkstone' ? {} : null;
  plugin.app.vault.create = async (path: string, source: string) => {
    assert.equal(path, 'Projects/Math/Untitled handwriting 1.inkstone');
    assert.equal(JSON.parse(source).pages.length, 1);
    return { path };
  };
  plugin.app.workspace.getLeaf = () => ({openFile(file: any) { opened = file; }});
  await action!();
  assert.equal(opened.path, 'Projects/Math/Untitled handwriting 1.inkstone');
});


test('New writing can target the vault root', async () => {
  const { plugin } = await fixture();
  let created = '';
  plugin.app.vault.getAbstractFileByPath = () => null;
  plugin.app.vault.create = async (path: string) => { created = path; return { path }; };
  plugin.app.workspace.getLeaf = () => ({async openFile() {}});
  await plugin.createNote({path:'/'});
  assert.equal(created, 'Untitled handwriting.inkstone');
});


test('conversion exports Markdown and LaTeX beside the notebook with unique filenames', async () => {
  const { plugin, fileA } = await fixture();
  const file = {...fileA, parent: {path:'Math'}};
  const written = new Map<string, string>();
  plugin.app.vault.getAbstractFileByPath = (path: string) => written.has(path) ? {} : null;
  plugin.app.vault.create = async (path: string, source: string) => { written.set(path, source); return {path}; };
  await plugin.exportConverted(file, '# Formula', 'markdown');
  await plugin.exportConverted(file, String.raw`\documentclass{article}`, 'latex');
  await plugin.exportConverted(file, 'second draft', 'latex');
  assert.equal(written.get('Math/First Markdown.md'), '# Formula');
  assert.equal(written.get('Math/First LaTeX.tex'), String.raw`\documentclass{article}`);
  assert.equal(written.get('Math/First LaTeX 1.tex'), 'second draft');
});
