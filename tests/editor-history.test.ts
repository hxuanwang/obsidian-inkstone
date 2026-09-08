import test from 'node:test';
import assert from 'node:assert/strict';
import { InkEditor } from '../src/editor';
import { createPage } from '../src/model';

// Exercise the editor's tool-specific history routing without a browser layout.
function editorHistory() {
  const page = createPage();
  const calls = { undo: 0, redo: 0 };
  const editor = Object.assign(Object.create(InkEditor.prototype), {
    selectedTool: 'text', textUndo: [], textRedo: [], activePageId: page.id,
    document: { version: 2, pages: [page] },
    engine: { canUndo: () => true, canRedo: () => true, undo: () => calls.undo++, redo: () => calls.redo++ },
    textLayer: { setPageFormat() {}, setBoxes() {} },
    counter: { textContent: '' }, pagePosition: { textContent: '' },
    undoButton: { disabled: true }, redoButton: { disabled: true },
  });
  return { editor, page, calls };
}

test('Text tool offers paper undo and redo when there are no local text edits', () => {
  const { editor, page, calls } = editorHistory();
  editor.updateState(page);
  assert.equal(editor.undoButton.disabled, false);
  assert.equal(editor.redoButton.disabled, false);
  editor.undo(); editor.redo();
  assert.deepEqual(calls, { undo: 1, redo: 1 });
  editor.engine.canUndo = () => false; editor.engine.canRedo = () => false;
  editor.updateState(page);
  assert.equal(editor.undoButton.disabled, true);
  assert.equal(editor.redoButton.disabled, true);
});

test('Text tool still prioritizes available local text history', () => {
  const { editor, page, calls } = editorHistory();
  const box = { id: 'box', x: 0, y: 0, width: 300, height: 200, fontSize: 28, color: '#123456', text: 'Typed text' };
  page.textBoxes = [box]; editor.textUndo = [[]];
  editor.updatePage = (patch: object) => Object.assign(page, patch);
  editor.undo(); assert.deepEqual(page.textBoxes, []);
  editor.redo(); assert.deepEqual(page.textBoxes, [box]);
  assert.deepEqual(calls, { undo: 0, redo: 0 });
});
