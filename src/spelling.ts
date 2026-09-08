import nspell from 'nspell';
import { findMatchRanges } from './search-highlights';

export type SpellingIssue = { start: number; end: number; word: string };
export interface SpellingDictionary { misspellings(text: string): SpellingIssue[] }
export function createSpelling(aff: string, dic: string): SpellingDictionary {
  const dictionary = nspell(aff, dic);
  const cache = new Map<string, boolean>();
  return { misspellings(text) {
    const issues: SpellingIssue[] = [];
    // Whole Unicode tokens prevent partial English checks inside other scripts,
    // identifiers, or numbers. This dictionary supports English only.
    for (const match of text.matchAll(/[\p{L}\p{M}\p{N}_]+(?:['’][\p{L}\p{M}]+)*/gu)) {
      const word = match[0], normalized = word.replace(/’/g, "'");
      if (!/^[a-z]+(?:'[a-z]+)*$/i.test(normalized) || word.length > 60) continue;
      let correct = cache.get(normalized);
      if (correct === undefined) {
        correct = dictionary.correct(normalized) || dictionary.correct(normalized.toLowerCase());
        if (cache.size >= 5000) cache.clear();
        cache.set(normalized, correct);
      }
      if (!correct) issues.push({ start: match.index!, end: match.index! + word.length, word });
      if (issues.length >= 2000) break;
    }
    return issues;
  } };
}
let pending: Promise<SpellingDictionary> | undefined;
export function loadSpelling(): Promise<SpellingDictionary> {
  return pending ??= import('./spelling-data').then(({ aff, dic }) => createSpelling(aff, dic)).catch(error => {
    pending = undefined; throw error;
  });
}

/** Safe text nodes preserve whitespace, search marks, and spelling together. */
export function appendSpellingText(host: HTMLElement, text: string, dictionary: SpellingDictionary | null, query = ''): void {
  const spelling = dictionary?.misspellings(text) ?? [], matches = query ? findMatchRanges(text, query) : [];
  const boundaries = [...new Set([0, text.length, ...spelling.flatMap(r => [r.start, r.end]), ...matches.flatMap(r => [r.start, r.end])])].sort((a,b) => a-b);
  host.replaceChildren();
  for (let i=0; i<boundaries.length-1; i++) {
    const start=boundaries[i], end=boundaries[i+1];
    const wrong=spelling.some(r=>r.start<=start && r.end>=end), found=matches.some(r=>r.start<=start && r.end>=end);
    const node=document.createElement(found ? 'mark' : 'span');
    node.className=[found?'inkstone-search-mark':'',wrong?'inkstone-spelling-word':''].filter(Boolean).join(' ');
    node.textContent=text.slice(start,end);host.append(node);
  }
}
