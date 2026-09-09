import test from 'node:test';
import assert from 'node:assert/strict';
import { InkEditor } from '../src/editor';
import { createPage } from '../src/model';

const source = 'data:image/png;base64,iVBORw0KGgo=';
function fixture() {
  const page = createPage();
  const inserted: unknown[] = [];
  const editor: any = Object.assign(Object.create(InkEditor.prototype), {
    document: {version: 2, pages: [page]}, activePageId: page.id, lifecycle: 0, disposed: false,
    engine: {addImage: (image: unknown) => inserted.push(image)}, selectTool() {},
    recognitionStatus: {textContent: ''}, root: {classList: {add() {}}}, notesToggle: {setAttribute() {}},
  });
  return {editor, page, inserted};
}

test('image insertion cannot follow a changed page or replacement document during decode', async () => {
  const oldImage = globalThis.Image;
  try {
    for (const change of ['page', 'lifecycle', 'disposed']) {
      let finish!: () => void;
      globalThis.Image = class {
        naturalWidth = 100; naturalHeight = 100;
        decode() { return new Promise<void>(resolve => { finish = resolve; }); }
      } as unknown as typeof Image;
      const {editor, inserted} = fixture();
      const task = editor.insertImage(source);
      if (change === 'page') editor.activePageId = 'another-page';
      if (change === 'lifecycle') editor.lifecycle++;
      if (change === 'disposed') editor.disposed = true;
      finish(); await task;
      assert.equal(inserted.length, 0);
    }
  } finally { globalThis.Image = oldImage; }
});

test('image chosen after switching pages is not inserted into the newly active page', async () => {
  const {editor, page, inserted} = fixture();
  editor.activePageId = 'another-page';
  await editor.insertImage(source, page.id, 0);
  assert.equal(inserted.length, 0);
  assert.equal(editor.recognitionStatus.textContent, '');
});

test('reusing a notebook image creates a new centered image without enlarging it', async () => {
  const oldImage = globalThis.Image;
  try {
    globalThis.Image = class {
      naturalWidth = 100; naturalHeight = 200;
      async decode() {}
    } as unknown as typeof Image;
    const {editor, inserted} = fixture();
    await editor.insertImage(source);
    assert.equal(inserted.length, 1);
    const image = inserted[0] as {src: string; width: number; height: number; x: number; y: number};
    assert.equal(image.src, source); assert.equal(image.width, 100); assert.equal(image.height, 200);
    assert.ok(image.x > 0 && image.y > 0);
  } finally { globalThis.Image = oldImage; }
});
