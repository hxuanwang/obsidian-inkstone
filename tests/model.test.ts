import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDocument, createPage, parseDocument, formatPage, pageDimensions, PAGE_SIZES, MAX_TEXT_LENGTH, PAGE_WIDTH, PAGE_HEIGHT, type InkPage } from '../src/model';
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

test('all page templates survive document persistence', async () => {
  const { PAPER_TYPES } = await import('../src/model');
  const document = createDocument();
  document.pages = PAPER_TYPES.map(paper => ({ ...createPage(paper), paper }));
  assert.deepEqual(parse(document), document);
  assert.throws(() => parse({ version: 2, pages: [{ ...createPage(), paper: 'unknown' }] }));
});

const pageImage = { id: 'image-1', x: 50, y: 60, width: 500, height: 300, src: 'data:image/png;base64,aGVsbG8=' };
test('embedded images round-trip and legacy pages stay unchanged', () => {
  const document = createDocument();
  document.pages[0].images = [pageImage];
  document.pages.push(createPage('Legacy'));
  assert.deepEqual(parse(document), document);
  assert.equal(Object.hasOwn(parse(document).pages[1], 'images'), false);
});

test('image validation rejects remote content, SVG, malformed data, duplicates and out-of-page geometry', () => {
  const invalid = [{ id: '' }, { id: 'x'.repeat(201) }, { x: -1 }, { y: -1 }, { width: 0 }, { height: 0 },
    { x: PAGE_WIDTH }, { y: PAGE_HEIGHT }, { width: null }, { src: 'https://example.com/image.png' },
    { src: 'data:image/svg+xml;base64,PHN2Zz4=' }, { src: 'data:image/png;base64,' },
    { src: 'data:image/png;base64,aGVsbG8=" onload="alert(1)' }, { src: 'data:image/png;base64,AA=A' }];
  for (const fields of invalid) assert.throws(() => parse({ version: 2, pages: [{ ...createPage(), images: [{ ...pageImage, ...fields }] }] }));
  for (const images of [null, {}, [pageImage, pageImage], Array.from({length: 101}, (_, i) => ({...pageImage, id: String(i)}))]) {
    assert.throws(() => parse({ version: 2, pages: [{ ...createPage(), images }] }));
  }
});

test('image source validation enforces the decoded 10 MiB limit', async () => {
  const { isImageSource, MAX_IMAGE_BYTES } = await import('../src/model');
  for (const mime of ['png', 'jpeg', 'gif', 'webp']) assert.equal(isImageSource(`data:image/${mime};base64,aGVsbG8=`), true);
  assert.equal(isImageSource('data:image/png;base64,' + Buffer.alloc(MAX_IMAGE_BYTES).toString('base64')), true);
  assert.equal(isImageSource('data:image/png;base64,' + Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64')), false);
});

test('all paper sizes, orientations and colors round-trip with content at their actual edges', () => {
  const document = createDocument();
  document.pages = PAGE_SIZES.flatMap(size => (['portrait', 'landscape'] as const).map(orientation => {
    const format = { pageSize: size.value, orientation, paperColor: '#e7f0e9' };
    const { width, height } = pageDimensions(format);
    return { ...createPage(), ...format,
      images: [{ ...pageImage, x: width - 500, y: height - 300 }],
      textBoxes: [{ ...textBox, x: width - 300, y: height - 100 }],
      recognition: { transcript: 'edge', inkSignature: 'ink1-test', words: [{ text: 'edge', x: width - 90, y: height - 30, width: 90, height: 30 }] },
    };
  }));
  assert.deepEqual(parse(document), document);
  for (const page of document.pages) {
    assert.throws(() => parse({ version: 2, pages: [{ ...page, images: [{ ...page.images![0], x: page.images![0].x + 1 }] }] }));
    assert.throws(() => parse({ version: 2, pages: [{ ...page, textBoxes: [{ ...page.textBoxes![0], y: page.textBoxes![0].y + 1 }] }] }));
  }
  for (const format of [{ pageSize: 'a3' }, { orientation: 'diagonal' }, { paperColor: '" onload="alert(1)' }]) {
    assert.throws(() => parse({ version: 2, pages: [{ ...createPage(), ...format }] }));
  }
});

test('format changes fit artwork uniformly and preserve every saved text field', () => {
  const original: InkPage = { ...createPage(), strokes: [stroke as InkPage['strokes'][number]], images: [pageImage], textBoxes: [textBox],
    text: 'Typed notes', transcript: 'Recognized words', recognition: { transcript: 'Recognized words', inkSignature: 'ink1-test', words: [] } };
  const colored = formatPage(original, { paperColor: '#ffffff', paper: 'grid' });
  assert.equal(colored.strokes, original.strokes); assert.equal(colored.images, original.images);
  assert.equal(colored.textBoxes, original.textBoxes); assert.equal(colored.recognition, original.recognition);
  assert.equal(formatPage(colored, { paperColor: '#ffffff', paper: 'grid' }), colored, 'identical format is not an edit');
  const resized = formatPage(colored, { pageSize: 'a4', orientation: 'landscape' });
  const scale = 1400 / 1900;
  assert.equal(resized.strokes[0].points[0].x, original.strokes[0].points[0].x * scale);
  assert.equal(resized.strokes[0].points[0].pressure, original.strokes[0].points[0].pressure);
  assert.equal(resized.strokes[0].points[0].time, original.strokes[0].points[0].time);
  assert.ok(Math.abs(resized.images![0].width / resized.images![0].height - pageImage.width / pageImage.height) < 1e-12);
  assert.equal(resized.textBoxes![0].text, textBox.text);
  assert.equal(resized.text, original.text); assert.equal(resized.transcript, original.transcript);
  assert.equal(resized.recognition, undefined, 'resized ink requires fresh OCR word coordinates');
  assert.deepEqual(parse({ version: 2, pages: [resized] }).pages[0], resized);
  assert.equal(original.pageSize, undefined, 'source snapshot remains available for undo');
});

test('format resizing keeps full-page images and minimum-size text within every paper boundary', () => {
  for (const from of PAGE_SIZES) for (const before of ['portrait', 'landscape'] as const) {
    const format = { pageSize: from.value, orientation: before }, size = pageDimensions(format);
    const page = { ...createPage(), ...format, images: [{ ...pageImage, x: 0, y: 0, width: size.width, height: size.height }],
      textBoxes: [{ ...textBox, x: size.width - 80, y: size.height - 40, width: 80, height: 40, fontSize: 12 }] };
    for (const to of PAGE_SIZES) for (const orientation of ['portrait', 'landscape'] as const) {
      const resized = formatPage(page, { pageSize: to.value, orientation });
      assert.deepEqual(parse({ version: 2, pages: [resized] }).pages[0], resized);
    }
  }
});

test('text typography round trips while invalid and injected formatting is rejected', () => {
  const document = createDocument();
  const box = {id:'styled',x:0,y:0,width:420,height:200,fontSize:28,color:'#123456',text:'Styled text',fontFamily:'serif' as const,bold:true,italic:true,textAlign:'center' as const,lineHeight:1.5};
  document.pages[0].textBoxes=[box];
  assert.deepEqual(parse(document),document);
  for (const patch of [{fontFamily:'__proto__'},{fontFamily:'Arial; color:red'},{bold:'true'},{italic:1},{textAlign:'justify'},{lineHeight:0},{lineHeight:2.1}]) {
    assert.throws(()=>parse({...document,pages:[{...document.pages[0],textBoxes:[{...box,...patch}]}]}), /invalid text formatting/);
  }
});
