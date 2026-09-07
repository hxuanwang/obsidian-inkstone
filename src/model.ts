export const PAGE_WIDTH = 1400;
export const PAGE_HEIGHT = 1900;
export type Point = { x: number; y: number; pressure: number; time: number };
export type Stroke = { id: string; tool: 'pen' | 'highlighter'; color: string; width: number; points: Point[] };
export type Paper = 'blank' | 'ruled' | 'grid' | 'dots';
export type RecognitionWord = { text: string; x: number; y: number; width: number; height: number };
export type PageRecognition = { transcript: string; inkSignature: string; words: RecognitionWord[] };
export type TextBox = { id: string; x: number; y: number; width: number; height: number; fontSize: number; color: string; text: string };
export type InkPage = { id: string; title: string; paper: Paper; strokes: Stroke[]; text: string; transcript: string; recognition?: PageRecognition; textBoxes?: TextBox[]; favorite?: boolean; outline?: boolean };
export type InkDocument = { version: 2; pages: InkPage[] };
export const MAX_PAGES = 500;
export const MAX_TEXT_LENGTH = 1_000_000;
export function createPage(title = 'Page 1'): InkPage {
  return { id: crypto.randomUUID(), title: title.slice(0, 500), paper: 'ruled', strokes: [], text: '', transcript: '' };
}
export function createDocument(): InkDocument { return { version: 2, pages: [createPage()] }; }
export function parseDocument(text: string): InkDocument {
  if (text.length > 50_000_000) throw new Error('This handwriting note exceeds the 50 MB limit.');
  const value: unknown = JSON.parse(text);
  const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (!record(value) || (value.version !== 1 && value.version !== 2)) throw new Error('This file is not a supported Inkstone note.');
  const rawPages: unknown[] = value.version === 1 ? [{ ...value, id: 'migrated-page-1', title: 'Page 1', text: '', transcript: '' }] : Array.isArray(value.pages) ? value.pages : [];
  if (rawPages.length < 1 || rawPages.length > MAX_PAGES) throw new Error('A notebook must contain between 1 and 500 pages.');
  let pointCount = 0;
  const pageIds = new Set<string>();
  const pages = rawPages.map(raw => {
    if (!record(raw) || typeof raw.id !== 'string' || !raw.id || raw.id.length > 200 || pageIds.has(raw.id) ||
      typeof raw.title !== 'string' || raw.title.length > 500 || typeof raw.paper !== 'string' || !['blank', 'ruled', 'grid', 'dots'].includes(raw.paper) ||
      typeof raw.text !== 'string' || raw.text.length > MAX_TEXT_LENGTH || typeof raw.transcript !== 'string' || raw.transcript.length > MAX_TEXT_LENGTH || !Array.isArray(raw.strokes)) throw new Error('The notebook contains an invalid page.');
    pageIds.add(raw.id);
    const ids = new Set<string>();
    const strokes: Stroke[] = raw.strokes.map((stroke: unknown) => {
      if (!record(stroke) || typeof stroke.id !== 'string' || !stroke.id || stroke.id.length > 200 || ids.has(stroke.id) ||
        typeof stroke.tool !== 'string' || !['pen', 'highlighter'].includes(stroke.tool) || typeof stroke.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(stroke.color) ||
        !finite(stroke.width) || stroke.width <= 0 || stroke.width > 100 || !Array.isArray(stroke.points) || stroke.points.length === 0) throw new Error('The note contains an invalid stroke.');
      ids.add(stroke.id); pointCount += stroke.points.length;
      if (pointCount > 1_000_000) throw new Error('This note contains too many ink points.');
      const points: Point[] = stroke.points.map((point: unknown) => {
        if (!record(point) || !finite(point.x) || !finite(point.y) || Math.abs(point.x) > 100_000 || Math.abs(point.y) > 100_000 || !finite(point.pressure) || point.pressure < 0 || point.pressure > 1 || !finite(point.time)) throw new Error('The note contains an invalid ink point.');
        return { x: point.x, y: point.y, pressure: point.pressure, time: point.time };
      });
      return { id: stroke.id, tool: stroke.tool as Stroke['tool'], color: stroke.color, width: stroke.width, points };
    });
    let textBoxes: TextBox[] | undefined;
    if (raw.textBoxes !== undefined) {
      if (!Array.isArray(raw.textBoxes) || raw.textBoxes.length > 1000) throw new Error('The page contains too many text boxes.');
      const textIds = new Set<string>(); let length = 0;
      textBoxes = raw.textBoxes.map((box: unknown) => {
        if (!record(box) || typeof box.id !== 'string' || !box.id || box.id.length > 200 || textIds.has(box.id) ||
          !finite(box.x) || !finite(box.y) || !finite(box.width) || !finite(box.height) || !finite(box.fontSize) ||
          box.x < 0 || box.y < 0 || box.width < 80 || box.height < 40 || box.x + box.width > PAGE_WIDTH || box.y + box.height > PAGE_HEIGHT ||
          box.fontSize < 12 || box.fontSize > 96 || typeof box.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(box.color) ||
          typeof box.text !== 'string' || box.text.length > MAX_TEXT_LENGTH) throw new Error('The page contains an invalid text box.');
        textIds.add(box.id); length += box.text.length;
        if (length > MAX_TEXT_LENGTH) throw new Error('The page contains too much text.');
        return {id:box.id, x:box.x, y:box.y, width:box.width, height:box.height, fontSize:box.fontSize, color:box.color, text:box.text};
      });
    }
    for (const key of ['favorite', 'outline']) if (raw[key] !== undefined && typeof raw[key] !== 'boolean') throw new Error('The page contains invalid navigation metadata.');
    let recognition: PageRecognition | undefined;
    if (raw.recognition !== undefined) {
      const r = raw.recognition;
      if (!record(r) || typeof r.transcript !== 'string' || r.transcript.length > MAX_TEXT_LENGTH ||
        typeof r.inkSignature !== 'string' || !r.inkSignature || r.inkSignature.length > 200 ||
        !Array.isArray(r.words) || r.words.length > 100_000) throw new Error('The note contains invalid recognition data.');
      let wordTextLength = 0;
      const words: RecognitionWord[] = r.words.map((word: unknown) => {
        if (!record(word) || typeof word.text !== 'string' || !word.text.trim() || word.text.length > MAX_TEXT_LENGTH ||
          !finite(word.x) || !finite(word.y) || !finite(word.width) || !finite(word.height) ||
          word.x < 0 || word.y < 0 || word.width <= 0 || word.height <= 0 ||
          word.x + word.width > PAGE_WIDTH || word.y + word.height > PAGE_HEIGHT) throw new Error('The note contains an invalid recognized word.');
        wordTextLength += word.text.length;
        if (wordTextLength > MAX_TEXT_LENGTH) throw new Error('The note contains too much recognized text.');
        return { text: word.text, x: word.x, y: word.y, width: word.width, height: word.height };
      });
      recognition = { transcript: r.transcript, inkSignature: r.inkSignature, words };
    }
    return { id: raw.id, title: raw.title, paper: raw.paper as Paper, strokes, text: raw.text, transcript: raw.transcript,
      ...(recognition ? { recognition } : {}), ...(textBoxes ? {textBoxes} : {}),
      ...(raw.favorite !== undefined ? {favorite: raw.favorite as boolean} : {}), ...(raw.outline !== undefined ? {outline: raw.outline as boolean} : {}) };
  });
  return { version: 2, pages };
}
