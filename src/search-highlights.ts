import { foldSearchText, searchTerms } from './search';
import type { RecognitionWord } from './model';
export type MatchRange = {start:number;end:number};
/** Map folded characters back to original offsets, including combining marks. */
export function findMatchRanges(text: string, query: string): MatchRange[] {
  const { text: folded, starts, ends } = foldSearchText(text);
  const ranges:MatchRange[]=[];
  for (const term of searchTerms(query)) {
    let at=0;
    while (ranges.length<1000 && (at=folded.indexOf(term,at))>=0) { ranges.push({start:starts[at],end:ends[at+term.length-1]}); at += term.length; }
  }
  ranges.sort((a,b)=>a.start-b.start||a.end-b.end);
  const merged:MatchRange[]=[];
  for (const range of ranges) { const last=merged.at(-1); if(last && range.start<=last.end) last.end=Math.max(last.end,range.end); else merged.push({...range}); }
  return merged;
}
export function appendHighlightedText(host: HTMLElement, text: string, query: string): void {
  host.replaceChildren(); let position=0;
  for(const range of findMatchRanges(text,query)) {
    host.append(document.createTextNode(text.slice(position,range.start)));
    const mark=document.createElement('mark'); mark.className='inkstone-search-mark'; mark.textContent=text.slice(range.start,range.end); host.append(mark); position=range.end;
  }
  host.append(document.createTextNode(text.slice(position)));
}
export function matchingWordBoxes(words: RecognitionWord[], query: string, transcript = words.map(word => word.text).join(' ')): RecognitionWord[] {
  const ranges = findMatchRanges(transcript, query);
  let offset = 0;
  return words.filter(word => {
    // Match the actual OCR transcript so punctuation and scripts without spaces
    // do not introduce artificial phrase boundaries between word boxes.
    if (!word.text.length) return false;
    const start = transcript.indexOf(word.text, offset);
    if (start < 0) return false;
    offset = start + word.text.length;
    return ranges.some(range => range.start < offset && range.end > start);
  });
}
export function matchSnippet(text:string,query:string,maxLength=190):string {
  const first=findMatchRanges(text,query)[0]; const start=Math.max(0,(first?.start??0)-40),end=Math.min(text.length,start+maxLength);
  return `${start?'…':''}${text.slice(start,end)}${end<text.length?'…':''}`;
}
