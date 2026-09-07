import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMatchRanges, matchingWordBoxes, matchSnippet } from '../src/search-highlights';
import type { RecognitionWord } from '../src/model';

const marked = (text: string, query: string) => findMatchRanges(text, query).map(range => text.slice(range.start, range.end));

test('highlight ranges preserve original UTF-16 offsets and combining marks', () => {
  assert.deepEqual(marked('😀 Cafe\u0301 CAFÉ ﬃ 世界', 'cafe ffi 世界'), ['Cafe\u0301', 'CAFÉ', 'ﬃ', '世界']);
  assert.deepEqual(marked('😀 two 😀', '😀'), ['😀', '😀']);
  assert.deepEqual(marked('ΟΣ ος οσ', 'ος'), ['ΟΣ', 'ος', 'οσ']);
});

test('highlights use the same whitespace rules as indexed phrases', () => {
  assert.deepEqual(marked('one café\n  planning two', '"CAFE planning"'), ['café\n  planning']);
  assert.deepEqual(marked('one café planning two', '"cafe   planning"'), ['café planning']);
  assert.deepEqual(marked('café future planning', '"cafe planning"'), []);
});

test('overlapping terms merge and an empty query never marks text', () => {
  assert.deepEqual(findMatchRanges('banana', 'banana ana'), [{start: 0, end: 6}]);
  assert.deepEqual(findMatchRanges('text', '  '), []);
  assert.deepEqual(findMatchRanges('text', '\u0301'), []);
});

test('recognized boxes match phrases, repeated words, accents and partial words', () => {
  const words: RecognitionWord[] = ['Café', 'planning', 'plan', 'again', 'planning'].map((text, i) => ({text, x:i*40, y:0, width:35, height:20}));
  assert.deepEqual(matchingWordBoxes(words, '"cafe planning"'), words.slice(0, 2));
  assert.deepEqual(matchingWordBoxes(words, 'plan'), [words[1], words[2], words[4]]);
  assert.deepEqual(matchingWordBoxes(words, '"planning again"'), []);
  assert.deepEqual(matchingWordBoxes(words, ''), []);
});

test('snippets retain and highlight matches beyond the start of long text', () => {
  const text = 'before '.repeat(80) + 'Café planning' + ' after'.repeat(80);
  const snippet = matchSnippet(text, '"cafe planning"');
  assert.ok(snippet.startsWith('…'));
  assert.ok(snippet.endsWith('…'));
  assert.deepEqual(marked(snippet, '"cafe planning"'), ['Café planning']);
});

test('word boxes follow actual transcript punctuation and scripts without spaces', () => {
  const words: RecognitionWord[] = ['Hello', ',', '世界', '你好', 'Hello'].map((text, i) => ({text, x:i*40, y:0, width:35, height:20}));
  const transcript = 'Hello, 世界你好\nHello';
  assert.deepEqual(matchingWordBoxes(words, '"hello, 世界"', transcript), words.slice(0, 3));
  assert.deepEqual(matchingWordBoxes(words, '世界你好', transcript), words.slice(2, 4));
  assert.deepEqual(matchingWordBoxes(words, 'hello', transcript), [words[0], words[4]]);
  assert.deepEqual(matchingWordBoxes(words, '"hello 世界"', transcript), []);
});
