import type { InkDocument } from './model';
export type SearchEntry = { key: string; path: string; title: string; pageId?: string; body: string; kind: 'markdown' | 'handwriting' };
export type SearchHit = SearchEntry & { query: string; snippet: string; score: number; line: number };
/** Keep indexing and highlight offsets on the same Unicode/whitespace folding rules. */
export function foldSearchText(value: string): { text: string; starts: number[]; ends: number[] } {
  let text = '', offset = 0;
  const starts: number[] = [], ends: number[] = [];
  for (const char of value) {
    const normalized = char.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/ς/g, 'σ');
    if (!normalized.length && ends.length) ends[ends.length - 1] = offset + char.length;
    for (const foldedChar of normalized) {
      const folded = /\s/u.test(foldedChar) ? ' ' : foldedChar;
      if (folded === ' ' && text.endsWith(' ')) { ends[ends.length - 1] = offset + char.length; continue; }
      text += folded;
      for (let i = 0; i < folded.length; i++) { starts.push(offset); ends.push(offset + char.length); }
    }
    offset += char.length;
  }
  return { text, starts, ends };
}
const normalize = (value: string) => foldSearchText(value).text;
/** Quoted phrases stay together; unquoted words use AND matching, in any order. */
export function searchTerms(query: string): string[] {
  return [...query.matchAll(/"([^"]+)"|(\S+)/g)].map(match => normalize((match[1] ?? match[2]).trim())).filter(Boolean).slice(0, 20);
}
export class NoteIndex {
  private entries = new Map<string, SearchEntry>();
  private normalized = new Map<string, { title: string; body: string }>();
  private listeners = new Set<() => void>();
  get size(): number { return this.entries.size; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private notify(): void { for (const fn of this.listeners) fn(); }
  remove(path: string): void {
    let changed = false;
    for (const [key, entry] of this.entries) if (entry.path === path) { this.entries.delete(key); this.normalized.delete(key); changed = true; }
    if (changed) this.notify();
  }
  replace(path: string, entries: SearchEntry[]): void {
    const keep = new Set(entries.map(entry => entry.key));
    let changed = false;
    for (const [key, value] of this.entries) if (value.path === path && !keep.has(key)) { this.entries.delete(key); this.normalized.delete(key); changed = true; }
    for (const entry of entries) {
      const old = this.entries.get(entry.key);
      if (old?.title === entry.title && old?.body === entry.body && old?.path === entry.path && old?.pageId === entry.pageId && old?.kind === entry.kind) continue;
      this.entries.set(entry.key, entry); this.normalized.set(entry.key, {title: normalize(entry.title), body: normalize(entry.body)}); changed = true;
    }
    if (changed) this.notify();
  }
  ink(path: string, title: string, document: InkDocument): void {
    this.replace(path, document.pages.map(page => ({ key: `${path}#${page.id}`, path, title: `${title} · ${page.title}`, pageId: page.id,
      body: [page.text, ...(page.textBoxes ?? []).map(box => box.text), page.transcript].filter(Boolean).join('\n\n'), kind: 'handwriting' })));
  }
  markdown(path: string, title: string, text: string): void { this.replace(path, [{key: path, path, title, body: text, kind: 'markdown'}]); }
  search(query: string, limit = 100): SearchHit[] {
    const terms = searchTerms(query);
    if (!terms.length) return [];
    const hits: SearchHit[] = [];
    for (const [key, entry] of this.entries) {
      const normalized = this.normalized.get(key)!;
      if (!terms.every(term => normalized.title.includes(term) || normalized.body.includes(term))) continue;
      const offsets = terms.map(term => normalized.body.indexOf(term)).filter(offset => offset >= 0);
      const offset = offsets.length ? Math.min(...offsets) : 0;
      // Folding can expand ligatures or collapse whitespace; retain original line positions.
      const originalOffset = foldSearchText(entry.body).starts[offset] ?? 0;
      const start = Math.max(0, originalOffset - 55), end = Math.min(entry.body.length, originalOffset + 170);
      const snippet = `${start ? '…' : ''}${entry.body.slice(start, end).replace(/\s+/g, ' ')}${end < entry.body.length ? '…' : ''}`;
      const score = terms.reduce((total, term) => total + (normalized.title.includes(term) ? 10 : 0) + (normalized.body.includes(term) ? 1 : 0), 0);
      hits.push({...entry, query, snippet, score, line: entry.body.slice(0, originalOffset).split('\n').length - 1});
    }
    return hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title) || a.key.localeCompare(b.key)).slice(0, limit);
  }
}
