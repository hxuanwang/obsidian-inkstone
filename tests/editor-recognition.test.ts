import test from 'node:test';
import assert from 'node:assert/strict';
import { InkEditor } from '../src/editor';
import { createPage } from '../src/model';
import { inkSignature } from '../src/ink-signature';

// Exercise the editor's asynchronous merge boundary without browser rendering.
function fixture() {
  const page = createPage();
  page.strokes = [{id:'ink', tool:'pen', color:'#000000', width:3,
    points:[{x:20,y:30,pressure:.5,time:0}]}];
  let finish!: (value: any) => void;
  let calls = 0;
  const editor: any = Object.create(InkEditor.prototype);
  Object.assign(editor, {
    document:{version:2,pages:[page]}, activePageId:page.id, lifecycle:0,
    disposed:false, recognitionBusy:false, pendingOCR:new Set(),
    options:{onRecognize:() => { calls++; return new Promise(resolve => {finish=resolve;}); }},
    engine:{flush() {}}, recognizeButton:{disabled:false}, recognitionStatus:{textContent:''},
    transcript:{value:''}, emitChange() {}, schedulePages() {}, updateSearchHighlights() {},
    scheduleRecognition() {},
  });
  const result = {text:'hello', words:[], inkSignature:inkSignature(page.strokes)};
  return {editor, page, result, finish:(value=result)=>finish(value), calls:()=>calls};
}

test('automatic OCR merges concurrent typed edits but preserves transcript corrections and newer ink', async () => {
  for (const change of ['text','transcript','strokes'] as const) {
    const f = fixture();
    const job = f.editor.recognize(f.page.id, true);
    const changed = {...f.page, [change]:change==='strokes' ? [] : 'user edit'};
    f.editor.document.pages = [changed];
    f.finish(); await job;
    const saved = f.editor.document.pages[0];
    assert.equal(saved[change], changed[change]);
    assert.equal(saved.transcript, change==='text' ? 'hello' : changed.transcript);
  }
});

test('automatic OCR skips unchanged recognized ink, including corrected transcripts', async () => {
  const f = fixture();
  f.page.recognition = {transcript:'hello',words:[],inkSignature:f.result.inkSignature};
  f.page.transcript = 'corrected by user';
  await f.editor.recognize(f.page.id, true);
  assert.equal(f.calls(), 0);
  assert.equal(f.page.transcript, 'corrected by user');
});

test('late recognition cannot alter a replacement document', async () => {
  const f = fixture();
  const job = f.editor.recognize(f.page.id, true);
  f.editor.lifecycle++;
  const replacement = {...f.page, transcript:'replacement'};
  f.editor.document.pages = [replacement];
  f.finish(); await job;
  assert.equal(f.editor.document.pages[0], replacement);
  assert.equal(f.editor.recognitionBusy, false);
});


test('manual external OCR uses the external provider and background OCR remains local', async () => {
  const f = fixture(); let externalCalls = 0;
  f.editor.options.onRecognizeExternal = async () => { externalCalls++; return f.result; };
  await f.editor.recognize(f.page.id, false, true);
  assert.equal(externalCalls, 1); assert.equal(f.calls(), 0);
  assert.equal(f.editor.document.pages[0].transcript, f.result.text);
  await f.editor.recognize(f.page.id, true);
  assert.equal(f.calls(), 0, 'local background OCR must preserve the external transcript for unchanged ink');
  f.editor.document.pages[0].recognition = undefined;
  const local = f.editor.recognize(f.page.id, true);
  assert.equal(f.calls(), 1); assert.equal(externalCalls, 1);
  f.finish(); await local;
});
