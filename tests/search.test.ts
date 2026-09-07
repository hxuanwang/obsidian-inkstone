import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NoteIndex, searchTerms } from '../src/search';
import { createDocument, createPage } from '../src/model';

test('search combines typed text and handwriting transcripts across pages and Markdown', () => {
  const index = new NoteIndex();
  index.ink('Notebook.inkstone', 'Biology', {version:2,pages:[{id:'a',title:'Lecture',paper:'blank',strokes:[],text:'Mitosis lecture',transcript:'Chromosomes divide in the nucleus.'},{id:'b',title:'Revision',paper:'dots',strokes:[],text:'Membrane',transcript:''}]});
  index.markdown('Review.md','Review','A written review of chromosomes.');
  assert.equal(index.search('chromosomes').length,2);
  assert.equal(index.search('mitosis nucleus')[0].pageId,'a');
  assert.equal(index.search('mitosis membrane').length,0);
  assert.equal(index.search('"divide in"')[0].path,'Notebook.inkstone');
});
test('search folds accents/case, handles Unicode, ranks titles and preserves snippets', () => {
  const index = new NoteIndex();
  index.markdown('a.md','Café','line one\n世界 café planning');
  index.markdown('b.md','Other','We discussed a CAFE.');
  assert.equal(index.search('cafe')[0].path,'a.md');
  assert.equal(index.search('世界')[0].line,1);
  assert.ok(index.search('世界')[0].snippet.includes('世界'));
  assert.deepEqual(searchTerms('one "two words" THREE'),['one','two words','three']);
});
test('updates and deletion remove stale search results without accumulating duplicates', () => {
  const index = new NoteIndex(); index.markdown('a.md','Note','old text'); index.markdown('a.md','Note','new text');
  assert.equal(index.search('old').length,0); assert.equal(index.size,1);
  index.remove('a.md'); assert.equal(index.search('new').length,0); assert.equal(index.size,0);
});

test('phrases span line wrapping and retain the original matching line', () => {
  const index = new NoteIndex();
  index.markdown('a.md', 'Note', 'Introduction\n\nThe café\n  planning session starts.');
  const hit = index.search('"CAFE planning"')[0];
  assert.equal(hit.line, 2);
  assert.ok(hit.snippet.includes('café planning'));
});

test('Greek case folding agrees for medial and final sigma', () => {
  const index = new NoteIndex();
  index.markdown('a.md', 'Note', 'ΟΣ ος οσ');
  assert.equal(index.search('ος').length, 1);
  assert.equal(index.search('ΟΣ').length, 1);
});

test('text boxes search alongside typed notes and transcripts and updates remove stale box text', () => {
  const index = new NoteIndex();
  const document = createDocument();
  const page = document.pages[0];
  page.text = 'Mitosis lecture';
  page.transcript = 'Chromosomes divide in the nucleus';
  page.textBoxes = [
    { id: 'box-1', x: 40, y: 50, width: 300, height: 100, fontSize: 24, color: '#243c34', text: 'Café planning' },
    { id: 'box-2', x: 40, y: 200, width: 300, height: 100, fontSize: 24, color: '#243c34', text: '世界 annotation' },
  ];
  document.pages.push({ ...createPage('Another page'), text: 'Membrane' });
  index.ink('Notebook.inkstone', 'Biology', document);
  const hits = index.search('mitosis cafe nucleus');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].pageId, page.id);
  assert.equal(hits[0].kind, 'handwriting');
  const phrase = index.search('"CAFE planning"')[0];
  assert.ok(phrase.snippet.includes('Café planning'));
  assert.equal(phrase.line, 2);
  assert.equal(index.search('世界')[0].pageId, page.id);
  assert.equal(index.search('annotation membrane').length, 0, 'queries cannot combine text from different pages');
  page.textBoxes[0].text = 'Updated schedule';
  page.textBoxes.pop();
  index.ink('Notebook.inkstone', 'Biology', document);
  assert.equal(index.search('cafe').length, 0);
  assert.equal(index.search('世界').length, 0);
  assert.equal(index.search('mitosis schedule nucleus').length, 1);
  assert.equal(index.size, 2);
});
