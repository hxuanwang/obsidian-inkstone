import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDocument, createPage, parseDocument, MAX_TEXT_LENGTH, PAGE_WIDTH, PAGE_HEIGHT } from '../src/model';
const stroke = { id: 's1', tool: 'pen', color: '#243c34', width: 3, points: [{ x: 25, y: 50, pressure: .65, time: 123 }] };
const parse = (value: unknown) => parseDocument(JSON.stringify(value));
test('v1 migration preserves paper, strokes, pressure and timestamps without inventing text', () => {
  const old = { version: 1, paper: 'grid', strokes: [stroke] };
  const migrated = parse(old);
  assert.equal(migrated.version, 2); assert.equal(migrated.pages.length, 1);
  assert.equal(migrated.pages[0].paper, old.paper); assert.deepEqual(migrated.pages[0].strokes, old.strokes);
  assert.equal(migrated.pages[0].text, ''); assert.equal(migrated.pages[0].transcript, '');
  assert.deepEqual(parse(old), migrated, 'migration IDs remain stable until the file is saved');
});
test('v2 pages round trip text, transcripts, titles and ink independently', () => {
  const document = createDocument();
  document.pages[0].text = 'Typed notes'; document.pages[0].transcript = 'Recognized words';
  document.pages.push({ ...createPage('Second page'), strokes: [stroke as any] });
  assert.deepEqual(parse(document), document); assert.notEqual(document.pages[0].id, document.pages[1].id);
});
test('invalid page lists, duplicate IDs and excessive text are rejected', () => {
  const page = createPage();
  for (const value of [{ version: 2, pages: [] }, { version: 2, pages: [page, page] },
    { version: 2, pages: Array.from({ length: 501 }, (_, i) => ({ ...page, id: String(i) })) },
    { version: 2, pages: [{ ...page, text: 'x'.repeat(MAX_TEXT_LENGTH + 1) }] },
    { version: 2, pages: [{ ...page, transcript: 123 }] }, { version: 3, pages: [page] }]) assert.throws(() => parse(value));
});
test('untrusted stroke fields cannot inject SVG and invalid pressure remains rejected', () => {
  const page = createPage();
  for (const invalid of [{ ...stroke, color: '\" onload=\"alert(1)' }, { ...stroke, width: 1000 },
    { ...stroke, points: [{ x: 0, y: 0, pressure: 2, time: 0 }] }]) assert.throws(() => parse({ version: 2, pages: [{ ...page, strokes: [invalid] }] }));
  assert.throws(() => parse({ version: 2, pages: [{ ...page, strokes: [stroke, stroke] }] }));
  assert.throws(() => parseDocument('{broken'));
});
test('word geometry recognition metadata round-trips as an optional v2 extension', () => {
  const document = createDocument();
  document.pages[0].recognition = { transcript: 'algebra', inkSignature: 'ink1-abc', words: [{ text: 'algebra', x: 10, y: 20, width: 90, height: 30 }] };
  document.pages[0].transcript = 'algebra';
  assert.deepEqual(parse(document), document);
});
test('recognition metadata rejects unbounded geometry, text and invalid shape', () => {
  const page = createPage();
  const word = { text: 'algebra', x: 10, y: 20, width: 90, height: 30 };
  const recognition = { transcript: 'algebra', inkSignature: 'ink1-abc', words: [word] };
  for (const invalid of [null, {}, { ...recognition, words: 'oops' },
    { ...recognition, transcript: 'x'.repeat(MAX_TEXT_LENGTH + 1) },
    { ...recognition, words: Array(100_001).fill(word) },
    ...[{ x: -1 }, { y: -1 }, { x: 1400 }, { height: 0 }, { width: 1500 }, { y: 1900 }, { text: '' }, { width: null }].map(fields => ({ ...recognition, words: [{ ...word, ...fields }] }))]) {
    assert.throws(() => parse({ version: 2, pages: [{ ...page, recognition: invalid }] }));
  }
});

const textBox = { id: 'box-1', x: 40, y: 60, width: 300, height: 100, fontSize: 24, color: '#243c34', text: 'A movable note 世界' };
test('text boxes and page navigation metadata persist without changing legacy pages', () => {
  const document = createDocument();
  document.pages[0].text = 'Legacy typed notes';
  document.pages[0].transcript = 'Recognized handwriting';
  document.pages[0].textBoxes = [textBox, { ...textBox, id: 'box-2', x: PAGE_WIDTH - 80, y: PAGE_HEIGHT - 40, width: 80, height: 40, text: '' }];
  document.pages[0].favorite = true;
  document.pages[0].outline = false;
  document.pages.push({ ...createPage('Second'), textBoxes: [], favorite: false, outline: true });
  document.pages.push(createPage('Legacy'));
  const restored = parse(document);
  assert.deepEqual(restored, document);
  assert.equal(Object.hasOwn(restored.pages[2], 'textBoxes'), false);
  assert.equal(Object.hasOwn(restored.pages[2], 'favorite'), false);
  assert.equal(Object.hasOwn(restored.pages[2], 'outline'), false);
});

test('text boxes reject invalid geometry, duplicate IDs, and style injection', () => {
  const page = createPage();
  const invalidFields = [
    { id: '' }, { id: 'x'.repeat(201) }, { text: 123 },
    { x: -1 }, { y: -1 }, { x: null }, { width: 79 }, { height: 39 },
    { x: PAGE_WIDTH - textBox.width + 1 }, { y: PAGE_HEIGHT - textBox.height + 1 },
    { fontSize: 11 }, { fontSize: 97 }, { fontSize: '24' },
    { color: '#243c34; background:url(https://example.com)' }, { color: '" onload="alert(1)' },
  ];
  for (const fields of invalidFields) {
    assert.throws(() => parse({ version: 2, pages: [{ ...page, textBoxes: [{ ...textBox, ...fields }] }] }), JSON.stringify(fields));
  }
  for (const boxes of [null, {}, 'text', [null], [textBox, textBox]]) {
    assert.throws(() => parse({ version: 2, pages: [{ ...page, textBoxes: boxes }] }));
  }
  const restored = parse({ version: 2, pages: [{ ...page, textBoxes: [{ ...textBox, onload: 'alert(1)', text: '<script>alert(1)</script>' }] }] });
  assert.equal(restored.pages[0].textBoxes![0].text, '<script>alert(1)</script>', 'plain text survives persistence verbatim');
  assert.equal(Object.hasOwn(restored.pages[0].textBoxes![0], 'onload'), false);
});

test('text box limits apply to both each box and the total text on a page', () => {
  const page = createPage();
  const boxesAtLimit = [{ ...textBox, text: 'x'.repeat(MAX_TEXT_LENGTH) }];
  assert.equal(parse({ version: 2, pages: [{ ...page, textBoxes: boxesAtLimit }] }).pages[0].textBoxes![0].text.length, MAX_TEXT_LENGTH);
  for (const boxes of [
    [{ ...textBox, text: 'x'.repeat(MAX_TEXT_LENGTH + 1) }],
    [...boxesAtLimit, { ...textBox, id: 'box-2', text: 'x' }],
    Array.from({ length: 1001 }, (_, i) => ({ ...textBox, id: String(i), text: '' })),
  ]) assert.throws(() => parse({ version: 2, pages: [{ ...page, textBoxes: boxes }] }));
});

test('favorite and outline metadata reject non-boolean values', () => {
  for (const key of ['favorite', 'outline']) {
    for (const value of [null, 0, 1, 'true', [], {}]) {
      assert.throws(() => parse({ version: 2, pages: [{ ...createPage(), [key]: value }] }));
    }
  }
});
