export const PAGE_WIDTH = 1400;
export const PAGE_HEIGHT = 1900;
export const PAGE_SIZES = [
  { value: 'standard', label: 'Inkstone Standard', width: 1400, height: 1900 },
  { value: 'a4', label: 'A4', width: 1400, height: 1980 },
  { value: 'letter', label: 'US Letter', width: 1400, height: 1812 },
] as const;
export type PageSize = typeof PAGE_SIZES[number]['value'];
export type PageFormat = { pageSize?: PageSize; orientation?: 'portrait' | 'landscape'; paperColor?: string };
export function pageDimensions(page: PageFormat = {}): { width: number; height: number } {
  const size = PAGE_SIZES.find(size => size.value === page.pageSize) ?? PAGE_SIZES[0];
  return page.orientation === 'landscape' ? { width: size.height, height: size.width } : { width: size.width, height: size.height };
}
export function pageColor(page: PageFormat = {}): string { return /^#[0-9a-f]{6}$/i.test(page.paperColor ?? '') ? page.paperColor! : '#faf9ef'; }
/** Fit content uniformly from the top-left, preserving ink and image proportions. */
export function formatPage(page: InkPage, format: PageFormat & { paper?: Paper }): InkPage {
  if ((format.pageSize !== undefined && !PAGE_SIZES.some(size => size.value === format.pageSize)) ||
    (format.orientation !== undefined && format.orientation !== 'portrait' && format.orientation !== 'landscape') ||
    (format.paperColor !== undefined && !/^#[0-9a-f]{6}$/i.test(format.paperColor)) ||
    (format.paper !== undefined && !PAPER_TYPES.includes(format.paper))) throw new Error('The page contains an invalid paper format.');
  if (Object.entries(format).every(([key, value]) => page[key as keyof InkPage] === value)) return page;
  const next = { ...page, ...format }, oldSize = pageDimensions(page), size = pageDimensions(next);
  if (oldSize.width === size.width && oldSize.height === size.height) return next;
  const scale = Math.min(size.width / oldSize.width, size.height / oldSize.height);
  if (scale === 1) return next;
  const box = <T extends { x: number; y: number; width: number; height: number }>(item: T): T => {
    const width = item.width * scale, height = item.height * scale;
    // Keep arithmetic at the bottom/right edge inside the persisted page bounds.
    return { ...item, x: Math.min(item.x * scale, size.width - width), y: Math.min(item.y * scale, size.height - height), width, height };
  };
  // The transcript is retained; OCR word boxes must be refreshed for the resized ink.
  const { recognition: _recognition, ...resizedPage } = next;
  return { ...resizedPage,
    strokes: page.strokes.map(stroke => ({ ...stroke, width: Math.min(100, stroke.width * scale), points: stroke.points.map(point => ({ ...point, x: point.x * scale, y: point.y * scale })) })),
    ...(page.images ? { images: page.images.map(box) } : {}),
    ...(page.textBoxes ? { textBoxes: page.textBoxes.map(item => {
      const resized = box(item); resized.width = Math.max(80, resized.width); resized.height = Math.max(40, resized.height);
      resized.x = Math.min(resized.x, size.width - resized.width); resized.y = Math.min(resized.y, size.height - resized.height);
      return { ...resized, fontSize: Math.max(12, Math.min(96, item.fontSize * scale)) };
    }) } : {}) };
}
export type Point = { x: number; y: number; pressure: number; time: number };
export type Stroke = { id: string; tool: 'pen' | 'highlighter'; color: string; width: number; points: Point[]; smoothing?: 'none' };
export const PAPER_TYPES = ['blank', 'ruled', 'grid', 'dots', 'cornell', 'music', 'isometric', 'planner'] as const;
export type Paper = typeof PAPER_TYPES[number];
export type PageImage = { id: string; x: number; y: number; width: number; height: number; src: string };
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_PAGE_IMAGES = 100;
/** Only self-contained raster images can enter page rendering or SVG exports. */
export function isImageSource(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 40) return false;
  const prefix = /^data:image\/(?:png|jpeg|gif|webp);base64,/.exec(value);
  if (!prefix) return false;
  const data = value.slice(prefix[0].length);
  if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return false;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return data.length / 4 * 3 - padding <= MAX_IMAGE_BYTES;
}
export type RecognitionWord = { text: string; x: number; y: number; width: number; height: number };
export type PageRecognition = { transcript: string; inkSignature: string; words: RecognitionWord[] };
export type TextBox = { id: string; x: number; y: number; width: number; height: number; fontSize: number; color: string; text: string };
export type InkPage = PageFormat & { id: string; title: string; paper: Paper; strokes: Stroke[]; text: string; transcript: string; recognition?: PageRecognition; textBoxes?: TextBox[]; images?: PageImage[]; favorite?: boolean; outline?: boolean };
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
      typeof raw.title !== 'string' || raw.title.length > 500 || typeof raw.paper !== 'string' || !PAPER_TYPES.includes(raw.paper as Paper) ||
      typeof raw.text !== 'string' || raw.text.length > MAX_TEXT_LENGTH || typeof raw.transcript !== 'string' || raw.transcript.length > MAX_TEXT_LENGTH || !Array.isArray(raw.strokes)) throw new Error('The notebook contains an invalid page.');
    if ((raw.pageSize !== undefined && !PAGE_SIZES.some(size => size.value === raw.pageSize)) ||
      (raw.orientation !== undefined && raw.orientation !== 'portrait' && raw.orientation !== 'landscape') ||
      (raw.paperColor !== undefined && (typeof raw.paperColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(raw.paperColor)))) throw new Error('The page contains an invalid paper format.');
    const format: PageFormat = { ...(raw.pageSize !== undefined ? { pageSize: raw.pageSize as PageSize } : {}),
      ...(raw.orientation !== undefined ? { orientation: raw.orientation as 'portrait' | 'landscape' } : {}), ...(raw.paperColor !== undefined ? { paperColor: raw.paperColor as string } : {}) };
    const { width: pageWidth, height: pageHeight } = pageDimensions(format);
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
      return { id: stroke.id, tool: stroke.tool as Stroke['tool'], color: stroke.color, width: stroke.width, points, ...(stroke.smoothing === 'none' ? { smoothing: 'none' as const } : {}) };
    });
    let textBoxes: TextBox[] | undefined;
    if (raw.textBoxes !== undefined) {
      if (!Array.isArray(raw.textBoxes) || raw.textBoxes.length > 1000) throw new Error('The page contains too many text boxes.');
      const textIds = new Set<string>(); let length = 0;
      textBoxes = raw.textBoxes.map((box: unknown) => {
        if (!record(box) || typeof box.id !== 'string' || !box.id || box.id.length > 200 || textIds.has(box.id) ||
          !finite(box.x) || !finite(box.y) || !finite(box.width) || !finite(box.height) || !finite(box.fontSize) ||
          box.x < 0 || box.y < 0 || box.width < 80 || box.height < 40 || box.x + box.width > pageWidth || box.y + box.height > pageHeight ||
          box.fontSize < 12 || box.fontSize > 96 || typeof box.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(box.color) ||
          typeof box.text !== 'string' || box.text.length > MAX_TEXT_LENGTH) throw new Error('The page contains an invalid text box.');
        textIds.add(box.id); length += box.text.length;
        if (length > MAX_TEXT_LENGTH) throw new Error('The page contains too much text.');
        return {id:box.id, x:box.x, y:box.y, width:box.width, height:box.height, fontSize:box.fontSize, color:box.color, text:box.text};
      });
    }
    let images: PageImage[] | undefined;
    if (raw.images !== undefined) {
      if (!Array.isArray(raw.images) || raw.images.length > MAX_PAGE_IMAGES) throw new Error('The page contains too many images.');
      const imageIds = new Set<string>();
      images = raw.images.map((entry: unknown) => {
        if (!record(entry) || typeof entry.id !== 'string' || !entry.id || entry.id.length > 200 || imageIds.has(entry.id) ||
          !finite(entry.x) || !finite(entry.y) || !finite(entry.width) || !finite(entry.height) ||
          entry.x < 0 || entry.y < 0 || entry.width <= 0 || entry.height <= 0 ||
          entry.x + entry.width > pageWidth || entry.y + entry.height > pageHeight || !isImageSource(entry.src)) {
          throw new Error('The page contains an invalid image. Use PNG, JPEG, GIF, or WebP images up to 10 MB.');
        }
        imageIds.add(entry.id);
        return { id: entry.id, x: entry.x, y: entry.y, width: entry.width, height: entry.height, src: entry.src };
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
          word.x + word.width > pageWidth || word.y + word.height > pageHeight) throw new Error('The note contains an invalid recognized word.');
        wordTextLength += word.text.length;
        if (wordTextLength > MAX_TEXT_LENGTH) throw new Error('The note contains too much recognized text.');
        return { text: word.text, x: word.x, y: word.y, width: word.width, height: word.height };
      });
      recognition = { transcript: r.transcript, inkSignature: r.inkSignature, words };
    }
    return { ...format, id: raw.id, title: raw.title, paper: raw.paper as Paper, strokes, text: raw.text, transcript: raw.transcript,
      ...(images ? { images } : {}), ...(recognition ? { recognition } : {}), ...(textBoxes ? {textBoxes} : {}),
      ...(raw.favorite !== undefined ? {favorite: raw.favorite as boolean} : {}), ...(raw.outline !== undefined ? {outline: raw.outline as boolean} : {}) };
  });
  return { version: 2, pages };
}
