import { type InkPage as InkDocument, type PageFormat, type Paper, type PageImage, type Point, type Stroke, isImageSource, MAX_PAGE_IMAGES, pageDimensions, formatPage } from './model';
import { eraseStroke, type EraserMode } from './eraser';
import { createShape, type ShapeMode, pointInPolygon, enclosedStrokes, recognizeShape, smoothInkSegment, inkSegmentOutline } from './geometry';
import { penRadius, penSegment, penTail, type PenSegment } from './pen-rendering';
import { drawPaper, paperSvg } from './paper';
export { PAGE_HEIGHT, PAGE_WIDTH } from './model';

type Tool = 'pen' | 'highlighter' | 'eraser' | 'hand' | 'lasso' | 'shape';
type Options = { document: InkDocument; onChange: (document: InkDocument) => void; onViewportChange?: (zoom: number) => void; onSelectionChange?: (count: number) => void; onPagePull?: (progress: number) => void; onPageAdvance?: () => void; onActivePageChange?: (page: InkDocument) => void };
export type SearchHighlight = { x: number; y: number; width: number; height: number };
export const PAGE_GAP = 32;
type XY = { x: number; y: number };
type HistoryEntry = { page: InkDocument; counterpart: InkDocument };
const clamp = (n: number, low: number, high: number) => Math.min(high, Math.max(low, n));
const distance = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y);
const radius = (stroke: Stroke, point: Point) => stroke.tool === 'highlighter' ? stroke.width * 0.5 : penRadius(stroke.width, point.pressure);

/** Distance to a segment, used for continuous eraser sweeps even between sparse events. */
export function pointSegmentDistance(point: XY, a: XY, b: XY): number {
  const length = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  const t = length === 0 ? 0 : clamp(((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) / length, 0, 1);
  return distance(point, { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
}

function segmentsDistance(a: XY, b: XY, c: XY, d: XY): number {
  const cross = (p: XY, q: XY, r: XY) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  // Strict crossings; the distance checks below also handle collinear/end-point contact.
  if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return 0;
  return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
}

/** A pair of viewport-sized canvases keeps Pencil updates independent of note history. */
export class InkEngine {
  private readonly base = document.createElement('canvas');
  private readonly live = document.createElement('canvas');
  private readonly scratch = document.createElement('canvas');
  private readonly tip = document.createElement('canvas');
  private readonly searchLayer = document.createElement('div');
  private searchHighlights: SearchHighlight[] = [];
  private searchHighlightIndices: number[] = [];
  private activeSearchHighlight = -1;
  private readonly baseContext: CanvasRenderingContext2D;
  private readonly liveContext: CanvasRenderingContext2D;
  private readonly scratchContext: CanvasRenderingContext2D;
  private readonly tipContext: CanvasRenderingContext2D;
  private readonly observer: ResizeObserver;
  private readonly abort = new AbortController();
  private document: InkDocument;
  private pages: InkDocument[];
  private pageIndex = 0;
  private renderOffset: XY = { x: 0, y: 0 };
  private renderPage: InkDocument | null = null;
  private readonly eraserCursor = document.createElement('div');
  private hover: XY | null = null;
  private readonly histories = new Map<string, { undo: HistoryEntry[]; redo: HistoryEntry[] }>();
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private tool: Tool = 'pen';
  private shapeMode: ShapeMode = 'auto';
  private shapeStart: Point | null = null;
  private readonly imageCache = new Map<string, HTMLImageElement>();
  private eraserMode: EraserMode = 'object';
  setEraserMode(mode: EraserMode): void { this.flush(); this.eraserMode = mode; }
  private color = '#243247';
  private width = 3;
  private fingerDrawing = false;
  private zoom = 1;
  private offset: XY = { x: 0, y: 0 };
  private size: XY = { x: 1, y: 1 };
  private dpr = 1;
  private fitMode: 'width' | 'page' | 'manual' = 'width';
  private active: { pointerId: number; stroke: Stroke } | null = null;
  private erase: { pointerId: number; before: InkDocument; last: XY } | null = null;
  private touches = new Map<number, XY>();
  private pan: { pointerId: number; pointerType: string; last: XY } | null = null;
  private pagePull: { pointerId: number; origin: XY; rawY: number; vertical: boolean } | null = null;
  private pagePullProgress = 0;
  private wheelPull: { distance: number; samples: number; eligible: boolean } | null = null;
  private wheelPullTimer: ReturnType<typeof setTimeout> | undefined;
  private wheelCooldown = 0;
  private frame = 0;
  private disposed = false;
  private selected = new Set<string>();
  private selectionMode: 'rectangle' | 'freehand' = 'freehand';
  private selectionClipboard: { strokes: Stroke[]; images: PageImage[] } | null = null;
  private lasso: { pointerId: number; points: XY[] } | null = null;
  private drag: { pointerId: number; origin: XY; before: InkDocument; dx: number; dy: number; anchor?: XY; box?: { left: number; right: number; top: number; bottom: number } } | null = null;
  private bounds = new WeakMap<Stroke, { left: number; top: number; right: number; bottom: number }>();

  constructor(private readonly host: HTMLElement, private readonly options: Options) {
    this.document = options.document;
    this.pages = [options.document];
    this.baseContext = this.context(this.base);
    this.liveContext = this.context(this.live);
    this.scratchContext = this.context(this.scratch);
    this.tipContext = this.context(this.tip);
    this.host.classList.add('inkstone-canvas-host');
    for (const canvas of [this.base, this.live, this.tip]) {
      canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
      canvas.setAttribute('aria-hidden', 'true');
      this.host.append(canvas);
    }
    this.searchLayer.className = 'inkstone-search-highlights';
    this.searchLayer.style.cssText = 'position:absolute;left:0;top:0;overflow:hidden;pointer-events:none;transform-origin:0 0;';
    this.searchLayer.setAttribute('aria-hidden', 'true');
    this.host.append(this.searchLayer);
    this.eraserCursor.className = 'inkstone-eraser-cursor';
    this.eraserCursor.style.cssText = 'position:absolute;pointer-events:none;border:1.5px solid #526476;border-radius:50%;background:rgba(255,255,255,.18);box-shadow:0 0 0 1px rgba(255,255,255,.7);transform:translate(-50%,-50%);display:none;z-index:5;';
    this.eraserCursor.setAttribute('aria-hidden', 'true'); this.host.append(this.eraserCursor);
    this.host.addEventListener('pointerleave', () => { this.hover = null; this.positionEraserCursor(); }, { signal: this.abort.signal });
    this.host.style.touchAction = 'none';
    this.host.style.overscrollBehavior = 'none';
    const eventOptions = { signal: this.abort.signal };
    this.host.addEventListener('pointerdown', this.pointerDown, eventOptions);
    this.host.addEventListener('pointermove', this.pointerMove, eventOptions);
    this.host.addEventListener('pointerup', this.pointerUp, eventOptions);
    this.host.addEventListener('pointercancel', this.pointerCancel, eventOptions);
    this.host.addEventListener('lostpointercapture', this.lostPointerCapture, eventOptions);
    // Capture can be lost without Pencil leaving the glass. Keep following that
    // pen outside the surface until a real pointerup/cancel ends the stroke.
    const owner = this.host.ownerDocument;
    for (const name of ['pointermove', 'pointerup', 'pointercancel'] as const) {
      owner?.addEventListener(name, this.documentPointer, { ...eventOptions, capture: true });
    }
    // Obsidian's mobile pull-down recognizer can listen on ancestors in the
    // capture phase. A bubbling surface handler is too late to claim the drag.
    const touchRoot = owner?.defaultView ?? this.host;
    for (const name of ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const) {
      touchRoot.addEventListener(name, this.canvasTouch as EventListener, { ...eventOptions, capture: true, passive: false });
    }
    this.host.addEventListener('contextmenu', this.contextMenu, eventOptions);
    this.host.addEventListener('wheel', this.wheel, { ...eventOptions, passive: false });
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(this.host);
    this.resize();
    this.updateCursor();
  }

  private context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
    const context = canvas.getContext('2d', { desynchronized: true });
    if (!context) throw new Error('Inkstone needs Canvas 2D support.');
    return context;
  }

  setTool(tool: Tool): void { this.cancelPagePull(); this.finishActive(); this.finishErase(); this.finishSelection(); if (tool !== 'lasso') this.clearSelection(); this.tool = tool; this.updateCursor(); }
  setShapeMode(mode: ShapeMode): void { this.flush(); this.shapeMode = mode; }
  setColor(color: string): void { if (/^#[0-9a-f]{6}$/i.test(color)) this.color = color; }
  setWidth(width: number): void { if (Number.isFinite(width)) { this.width = clamp(width, 0.5, 100); this.positionEraserCursor(); } }
  setFingerDrawing(enabled: boolean): void { this.cancelPagePull(); this.fingerDrawing = enabled; }
  setPaper(paper: Paper): void { this.setPageFormat({ paper }); }
  /** Resize artwork uniformly to fit; one undo restores both paper and content. */
  setPageFormat(format: PageFormat & { paper?: Paper }): void {
    this.cancelPagePull(); this.flush();
    const next = formatPage(this.document, format);
    if (next === this.document) return;
    this.clearSelection(); this.setSearchHighlights([]);
    this.change(next);
  }
  private get pageSize() { return pageDimensions(this.document); }
  /** Page coordinates remain local; the notebook stacks centered page rectangles. */
  private pageLayout() {
    let height = 0, width = 0;
    const pages = this.pages.map((stored, index) => {
      const page = index === this.pageIndex ? this.document : stored;
      const size = pageDimensions(page), top = height;
      height += size.height + PAGE_GAP; width = Math.max(width, size.width);
      return { page, top, ...size };
    });
    return { pages, width, height: height - PAGE_GAP };
  }
  private pageAt(screenY: number): number {
    const layout = this.pageLayout();
    const y = layout.pages[this.pageIndex].top + (screenY - this.offset.y) / this.zoom;
    const index = layout.pages.findIndex(page => y < page.top + page.height + PAGE_GAP);
    return index < 0 ? layout.pages.length - 1 : index;
  }
  /** Synchronize notebook pages without disturbing the current gesture or scroll position. */
  setPages(pages: InkDocument[]): void {
    if (!pages.length) return;
    // The editor echoes committed ink back with updated metadata. The live
    // layer was already composited; do not replay a whole notebook per stroke.
    const repaint = pages.length !== this.pages.length || pages.some((page, i) => {
      const before = i === this.pageIndex ? this.document : this.pages[i];
      return !before || page.id !== before.id || page.strokes !== before.strokes || page.images !== before.images ||
        page.paper !== before.paper || page.pageSize !== before.pageSize || page.orientation !== before.orientation || page.paperColor !== before.paperColor;
    });
    const previous = this.document;
    const index = pages.findIndex(page => page.id === this.document.id);
    if (index >= 0) {
      this.pages = pages.slice();
      this.pageIndex = index;
      // offset is relative to the active page: keep that page under the pen
      // when pages before it are inserted, removed, or reordered.
      this.document = this.pages[index];
      this.refreshPageFormat(previous);
    } else {
      const nextIndex = Math.min(this.pageIndex, pages.length - 1);
      // Save the outgoing history before installing the replacement array.
      // setDocument remembers the old page and must not write it into new pages.
      this.setDocument(pages[nextIndex]);
      this.pages = pages.slice();
      this.pageIndex = nextIndex;
      this.clampViewport();
      this.options.onActivePageChange?.(this.document);
    }
    const ids = new Set(pages.map(page => page.id));
    for (const id of this.histories.keys()) if (!ids.has(id)) this.histories.delete(id);
    this.positionSearchHighlights();
    if (repaint) this.scheduleRedraw();
  }
  private rememberPage(): void {
    this.pages[this.pageIndex] = this.document;
    this.histories.set(this.document.id, { undo: this.undoStack, redo: this.redoStack });
  }
  private activatePage(index: number): void {
    if (index === this.pageIndex || !this.pages[index]) return;
    this.flush(); this.rememberPage();
    const layout = this.pageLayout(), before = layout.pages[this.pageIndex], after = layout.pages[index];
    const dy = (after.top - before.top) * this.zoom;
    this.offset.x += (before.width - after.width) / 2 * this.zoom;
    this.offset.y += dy;
    if (this.pagePull) this.pagePull.rawY += dy;
    this.pageIndex = index; this.document = this.pages[index];
    const history = this.histories.get(this.document.id);
    this.undoStack = history?.undo ?? []; this.redoStack = history?.redo ?? [];
    this.clearSelection(); this.setSearchHighlights([]);
    this.options.onActivePageChange?.(this.document);
  }
  setDocument(document: InkDocument): void {
    this.pencilPointer = null;
    const previous = this.document;
    this.cancelPagePull();
    this.setSearchHighlights([]);
    this.active = null; this.erase = null; this.pan = null; this.lasso = null; this.drag = null; this.clearSelection(); this.touches.clear();
    this.rememberPage();
    const index = this.pages.findIndex(page => page.id === document.id);
    if (index < 0) { this.pages = [document]; this.pageIndex = 0; }
    else { this.pageIndex = index; this.pages[index] = document; }
    this.document = document;
    const history = this.histories.get(document.id);
    this.undoStack = history?.undo ?? []; this.redoStack = history?.redo ?? [];
    this.refreshPageFormat(previous);
    this.redraw();
  }
  isInteracting(): boolean { return !!(this.active || this.erase || this.lasso || this.drag || this.pan || this.touches.size); }
  flush(): void { this.finishActive(); this.finishErase(); this.finishSelection(); }
  getDocument(): InkDocument { return this.document; }
  getViewport(): { zoom: number; x: number; y: number } { return { zoom: this.zoom, ...this.offset }; }
  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }
  undo(): void {
    this.finishActive(); this.finishErase(); this.finishSelection(); this.clearSelection();
    const previous = this.undoStack.pop();
    if (!previous) return;
    const current = this.document;
    this.document = this.restoreHistory(previous);
    this.redoStack.push({ page: current, counterpart: this.document }); this.refreshPageFormat(current);
    this.redraw(); this.options.onChange(this.document);
  }
  redo(): void {
    this.finishActive(); this.finishErase(); this.finishSelection(); this.clearSelection();
    const next = this.redoStack.pop();
    if (!next) return;
    const current = this.document;
    this.document = this.restoreHistory(next);
    this.undoStack.push({ page: current, counterpart: this.document }); this.refreshPageFormat(current);
    this.redraw(); this.options.onChange(this.document);
  }
  /** Ink history preserves independent text edits, including across paper resizing. */
  private restoreHistory({ page, counterpart }: HistoryEntry): InkDocument {
    const current = this.document;
    const from = pageDimensions(counterpart), to = pageDimensions(page);
    if (from.width === to.width && from.height === to.height) {
      if (current.textBoxes === page.textBoxes) return page;
      const { textBoxes: _oldText, ...inkPage } = page;
      return { ...inkPage, ...(current.textBoxes !== undefined ? { textBoxes: current.textBoxes } : {}) };
    }
    if (current.textBoxes === counterpart.textBoxes) return page;
    const originals = new Map((page.textBoxes ?? []).map(box => [box.id, box]));
    const baseline = new Map((counterpart.textBoxes ?? []).map(box => [box.id, box]));
    const fitted = formatPage({ ...current, strokes: [], images: undefined }, { pageSize: page.pageSize ?? 'standard', orientation: page.orientation ?? 'portrait' });
    const textBoxes = (current.textBoxes ?? []).map((box, index) => {
      const original = originals.get(box.id), expected = baseline.get(box.id);
      if (!original || !expected) return fitted.textBoxes![index];
      if (box === expected) return original;
      // Preserve changes relative to the text geometry produced by the format operation.
      const sx = original.width / expected.width, sy = original.height / expected.height;
      const width = clamp(original.width + (box.width - expected.width) * sx, 80, to.width);
      const height = clamp(original.height + (box.height - expected.height) * sy, 40, to.height);
      return { ...box, width, height,
        x: clamp(original.x + (box.x - expected.x) * sx, 0, to.width - width),
        y: clamp(original.y + (box.y - expected.y) * sy, 0, to.height - height),
        fontSize: clamp(original.fontSize + (box.fontSize - expected.fontSize) * original.fontSize / expected.fontSize, 12, 96) };
    });
    return { ...page, textBoxes };
  }
  private pageTop(): number {
    const toolbar = this.host.parentElement?.querySelector<HTMLElement>('.inkstone-toolbar');
    if (!toolbar) return this.size.x < 620 ? 140 : 100;
    const toolbarRect = toolbar.getBoundingClientRect();
    const hostRect = this.host.getBoundingClientRect();
    return Math.max(20, toolbarRect.bottom - hostRect.top + 20);
  }
  /** Start at a comfortable writing scale, with the first line below the pen palette. */
  fitWidth(): void {
    this.cancelPagePull();
    const { width } = this.pageSize;
    this.zoom = clamp((this.size.x - (this.size.x < 620 ? 32 : 64)) / width, 0.08, 2);
    this.offset = { x: (this.size.x - width * this.zoom) / 2, y: this.pageTop() };
    this.fitMode = 'width'; this.viewportChanged(false);
  }
  fit(): void {
    this.cancelPagePull();
    const top = this.pageTop();
    const { width, height } = this.pageSize;
    const availableHeight = Math.max(1, this.size.y - top - 28);
    this.zoom = clamp(Math.min((this.size.x - 56) / width, availableHeight / height), 0.08, 2);
    this.offset = { x: (this.size.x - width * this.zoom) / 2, y: top + (availableHeight - height * this.zoom) / 2 };
    this.fitMode = 'page'; this.viewportChanged(false);
  }
  zoomBy(factor: number): void {
    if (factor > 0 && Number.isFinite(factor)) this.zoomAt(factor, { x: this.size.x / 2, y: this.size.y / 2 });
  }

  /** Search marks are transient UI and never become part of ink, undo, or export. */
  setSearchHighlights(boxes: SearchHighlight[], activeIndex = -1): void {
    if (this.disposed) return;
    this.searchHighlights = [];
    this.searchHighlightIndices = [];
    this.activeSearchHighlight = -1;
    const { width, height } = this.pageSize;
    for (const [index, box] of boxes.slice(0, 1000).entries()) {
      if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) continue;
      const x = clamp(box.x, 0, width), y = clamp(box.y, 0, height);
      const right = clamp(box.x + box.width, 0, width), bottom = clamp(box.y + box.height, 0, height);
      if (right <= x || bottom <= y) continue;
      if (index === activeIndex) this.activeSearchHighlight = this.searchHighlights.length;
      this.searchHighlights.push({ x, y, width: right - x, height: bottom - y });
      this.searchHighlightIndices.push(index);
    }
    this.renderSearchHighlights();
  }
  focusSearchHighlight(index: number): void {
    if (this.disposed || !Number.isInteger(index)) return;
    const storedIndex = this.searchHighlightIndices.indexOf(index);
    const box = this.searchHighlights[storedIndex];
    if (!box) return;
    this.cancelPagePull();
    this.activeSearchHighlight = storedIndex;
    const top = Math.min(this.pageTop(), this.size.y - 24);
    this.fitMode = 'manual';
    this.offset = {
      x: this.size.x / 2 - (box.x + box.width / 2) * this.zoom,
      y: top + Math.max(1, this.size.y - top - 24) / 2 - (box.y + box.height / 2) * this.zoom,
    };
    this.renderSearchHighlights();
    this.viewportChanged();
  }
  private renderSearchHighlights(): void {
    this.searchLayer.replaceChildren();
    for (const [index, box] of this.searchHighlights.entries()) {
      const mark = document.createElement('div');
      const active = index === this.activeSearchHighlight;
      mark.className = active ? 'inkstone-search-highlight is-active' : 'inkstone-search-highlight';
      mark.style.cssText = `position:absolute;left:${box.x}px;top:${box.y}px;width:${box.width}px;height:${box.height}px;border-radius:4px;background:${active ? 'rgba(255,151,38,.44)' : 'rgba(255,195,83,.30)'};box-shadow:inset 0 0 0 ${active ? 2 : 1}px ${active ? 'rgba(218,113,9,.85)' : 'rgba(231,154,32,.42)'};pointer-events:none;`;
      this.searchLayer.append(mark);
    }
    this.positionSearchHighlights();
  }
  private positionSearchHighlights(): void {
    const { width, height } = this.pageSize;
    this.searchLayer.style.width = `${width}px`; this.searchLayer.style.height = `${height}px`;
    this.searchLayer.style.transform = `translate(${this.offset.x}px, ${this.offset.y}px) scale(${this.zoom})`;
  }

  setSelectionMode(mode: 'rectangle' | 'freehand'): void { this.finishSelection(true); this.selectionMode = mode; }
  getSelectionBounds() { return this.selectionBox(); }
  copySelection(): void {
    this.finishSelection();
    if (!this.selected.size) return;
    this.selectionClipboard = { strokes: this.document.strokes.filter(s => this.selected.has(s.id)), images: (this.document.images ?? []).filter(i => this.selected.has(i.id)) };
  }
  cutSelection(): void { this.copySelection(); this.deleteSelection(); }
  pasteSelection(): void {
    const clip = this.selectionClipboard;
    if (!clip || (this.document.images?.length ?? 0) + clip.images.length > MAX_PAGE_IMAGES) return;
    const bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    const include = (x: number, y: number) => { bounds.left = Math.min(bounds.left, x); bounds.top = Math.min(bounds.top, y); bounds.right = Math.max(bounds.right, x); bounds.bottom = Math.max(bounds.bottom, y); };
    for (const stroke of clip.strokes) for (const p of stroke.points) include(p.x, p.y);
    for (const image of clip.images) { include(image.x, image.y); include(image.x + image.width, image.y + image.height); }
    const scale = Math.min(1, this.pageSize.width / Math.max(1, bounds.right - bounds.left), this.pageSize.height / Math.max(1, bounds.bottom - bounds.top));
    const x = clamp(bounds.left + 24, 0, this.pageSize.width - (bounds.right - bounds.left) * scale);
    const y = clamp(bounds.top + 24, 0, this.pageSize.height - (bounds.bottom - bounds.top) * scale);
    const transform = (p: XY) => ({ x: x + (p.x - bounds.left) * scale, y: y + (p.y - bounds.top) * scale });
    const strokes = clip.strokes.map(s => ({ ...s, id: crypto.randomUUID(), width: s.width * scale, points: s.points.map(p => ({ ...p, ...transform(p) })) }));
    const images = clip.images.map(i => ({ ...i, id: crypto.randomUUID(), ...transform(i), width: i.width * scale, height: i.height * scale }));
    this.selected = new Set([...strokes, ...images].map(i => i.id));
    this.change({ ...this.document, strokes: [...this.document.strokes, ...strokes], images: [...(this.document.images ?? []), ...images] });
    this.options.onSelectionChange?.(this.selected.size);
  }
  private selectionPolygon(): XY[] {
    const points = this.lasso?.points ?? [];
    if (this.selectionMode === 'freehand' || points.length < 2) return points;
    const a = points[0], b = points[points.length - 1];
    return [{x:a.x,y:a.y},{x:b.x,y:a.y},{x:b.x,y:b.y},{x:a.x,y:b.y}];
  }
  clearSelection(): void { this.selected.clear(); this.options.onSelectionChange?.(0); this.scheduleRedraw(); }
  deleteSelection(): void {
    this.finishSelection();
    if (!this.selected.size) return;
    const strokes = this.document.strokes.filter(stroke => !this.selected.has(stroke.id));
    const images = this.document.images?.filter(image => !this.selected.has(image.id));
    this.clearSelection(); this.change({ ...this.document, strokes, ...(images ? { images } : {}) });
  }
  duplicateSelection(): void {
    this.finishSelection();
    const originals = this.document.strokes.filter(stroke => this.selected.has(stroke.id));
    const originalImages = (this.document.images ?? []).filter(image => this.selected.has(image.id));
    if (!originals.length && !originalImages.length) return;
    if ((this.document.images?.length ?? 0) + originalImages.length > MAX_PAGE_IMAGES) return;
    const box = this.selectionBox()!;
    const dx = Math.max(-box.left, Math.min(24, this.pageSize.width - box.right));
    const dy = Math.max(-box.top, Math.min(24, this.pageSize.height - box.bottom));
    const copies = originals.map(stroke => ({ ...stroke, id: crypto.randomUUID(), points: stroke.points.map(p => ({ ...p, x: p.x + dx, y: p.y + dy })) }));
    const imageCopies = originalImages.map(image => ({ ...image, id: crypto.randomUUID(), x: image.x + dx, y: image.y + dy }));
    this.selected = new Set([...copies, ...imageCopies].map(item => item.id));
    this.change({ ...this.document, strokes: [...this.document.strokes, ...copies], ...(imageCopies.length ? { images: [...(this.document.images ?? []), ...imageCopies] } : {}) });
    this.options.onSelectionChange?.(this.selected.size);
  }
  recolorSelection(color: string): void {
    this.finishSelection();
    if (!/^#[0-9a-f]{6}$/i.test(color)) return;
    const strokes = this.document.strokes.map(stroke => this.selected.has(stroke.id) && stroke.color !== color ? { ...stroke, color } : stroke);
    if (strokes.some((stroke, i) => stroke !== this.document.strokes[i])) this.change({ ...this.document, strokes });
  }
  resizeSelection(factor: number): void {
    this.finishSelection();
    const box = this.selectionBox();
    if (!box || !Number.isFinite(factor) || factor <= 0) return;
    const anchor = { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
    this.change(this.scaleSelection(this.document, box, anchor, factor));
  }
  private scaleSelection(before: InkDocument, box: { left: number; right: number; top: number; bottom: number }, anchor: XY, factor: number): InkDocument {
    const limits = [box.left < anchor.x ? anchor.x / (anchor.x - box.left) : Infinity,
      box.right > anchor.x ? (this.pageSize.width - anchor.x) / (box.right - anchor.x) : Infinity,
      box.top < anchor.y ? anchor.y / (anchor.y - box.top) : Infinity,
      box.bottom > anchor.y ? (this.pageSize.height - anchor.y) / (box.bottom - anchor.y) : Infinity];
    factor = Math.max(0.05, Math.min(factor, ...limits));
    const transform = (p: XY) => ({ x: anchor.x + (p.x - anchor.x) * factor, y: anchor.y + (p.y - anchor.y) * factor });
    return { ...before, strokes: before.strokes.map(stroke => this.selected.has(stroke.id) ? { ...stroke, width: clamp(stroke.width * factor, .5, 100), points: stroke.points.map(p => ({ ...p, ...transform(p) })) } : stroke),
      ...(before.images ? { images: before.images.map(image => this.selected.has(image.id) ? { ...image, ...transform(image), width: image.width * factor, height: image.height * factor } : image) } : {}) };
  }
  addImage(image: PageImage): void {
    this.flush();
    if ((this.document.images?.length ?? 0) >= MAX_PAGE_IMAGES) throw new Error('This page has reached the image limit.');
    if (!isImageSource(image.src) || !image.id || ![image.x, image.y, image.width, image.height].every(Number.isFinite) ||
      image.x < 0 || image.y < 0 || image.width <= 0 || image.height <= 0 || image.x + image.width > this.pageSize.width || image.y + image.height > this.pageSize.height ||
      this.document.images?.some(item => item.id === image.id)) throw new Error('The image has invalid data or page dimensions.');
    this.change({ ...this.document, images: [...(this.document.images ?? []), { ...image }] });
  }
  private selectionBox() {
    const strokes = this.document.strokes.filter(stroke => this.selected.has(stroke.id));
    const images = (this.document.images ?? []).filter(image => this.selected.has(image.id));
    if (!strokes.length && !images.length) return null;
    const bounds = strokes.reduce((box, stroke) => { for (const p of stroke.points) {
      box.left = Math.min(box.left, p.x); box.right = Math.max(box.right, p.x);
      box.top = Math.min(box.top, p.y); box.bottom = Math.max(box.bottom, p.y);
    } return box; }, { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity });
    for (const image of images) { bounds.left = Math.min(bounds.left, image.x); bounds.top = Math.min(bounds.top, image.y); bounds.right = Math.max(bounds.right, image.x + image.width); bounds.bottom = Math.max(bounds.bottom, image.y + image.height); }
    return bounds;
  }
  private finishSelection(cancel = false): void {
    if (this.drag) {
      const { before } = this.drag; this.drag = null;
      if (cancel) { this.document = before; this.redraw(); }
      else if (this.document !== before) { const next = this.document; this.document = before; this.change(next); }
    }
    if (this.lasso) {
      if (!cancel) {
        const polygon = this.selectionPolygon();
        this.selected = new Set([...enclosedStrokes(this.document.strokes, polygon), ...(this.document.images ?? []).filter(image => polygon.length >= 3 && [{ x: image.x, y: image.y }, { x: image.x + image.width, y: image.y }, { x: image.x, y: image.y + image.height }, { x: image.x + image.width, y: image.y + image.height }].every(p => pointInPolygon(p, polygon))).map(image => image.id)]);
      }
      this.lasso = null; this.options.onSelectionChange?.(this.selected.size); this.redraw();
    }
  }
  private drawSelection(): void {
    if (!this.selected.size && !this.lasso) return;
    this.options.onSelectionChange?.(this.selected.size);
    this.live.style.opacity = '1';
    this.clipped(this.liveContext, () => {
      const context = this.liveContext;
      context.strokeStyle = '#4b79db'; context.lineWidth = 1.5 / this.zoom; context.setLineDash([6 / this.zoom, 4 / this.zoom]);
      const box = this.selectionBox();
      if (box) { const pad = 6 / this.zoom; context.strokeRect(box.left-pad, box.top-pad, box.right-box.left+pad*2, box.bottom-box.top+pad*2);
        context.setLineDash([]); context.fillStyle = '#ffffff';
        for (const x of [box.left, box.right]) for (const y of [box.top, box.bottom]) { const r = 4 / this.zoom; context.fillRect(x-r, y-r, r*2, r*2); context.strokeRect(x-r, y-r, r*2, r*2); }
      }
      if (this.lasso?.points.length) {
        const polygon = this.selectionPolygon();
        context.beginPath(); context.moveTo(polygon[0].x, polygon[0].y);
        for (const p of polygon.slice(1)) context.lineTo(p.x, p.y);
        context.closePath(); context.stroke();
      }
      context.setLineDash([]);
    });
  }
  private change(next: InkDocument): void {
    const previous = this.document;
    this.undoStack.push({ page: this.document, counterpart: next });
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = []; this.document = next; this.refreshPageFormat(previous);
    this.redraw(); this.options.onChange(this.document);
  }
  private refreshPageFormat(previous: InkDocument): void {
    this.pages[this.pageIndex] = this.document;
    const before = pageDimensions(previous), after = this.pageSize;
    if (before.width === after.width && before.height === after.height) return;
    this.cancelPagePull(); this.setSearchHighlights([]);
    if (this.fitMode === 'width') this.fitWidth();
    else if (this.fitMode === 'page') this.fit();
    else {
      this.offset.x += (before.width - after.width) / 2 * this.zoom;
      this.viewportChanged(false);
    }
  }

  private resize(): void {
    this.cancelPagePull();
    if (this.disposed) return;
    const rect = this.host.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const previous = this.size;
    this.size = { x: rect.width, y: rect.height };
    // Four backing stores together stay below about 48 MB, including on large Retina displays.
    this.dpr = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(3_000_000 / (rect.width * rect.height)));
    for (const canvas of [this.base, this.live, this.scratch, this.tip]) {
      canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
      canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
    }
    if (this.fitMode === 'width') this.fitWidth();
    else if (this.fitMode === 'page') this.fit();
    else {
      this.offset.x += (this.size.x - previous.x) / 2;
      this.offset.y += (this.size.y - previous.y) / 2;
      this.clampViewport();
      this.redraw();
    }
  }

  private clear(context: CanvasRenderingContext2D): void {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, context.canvas.width, context.canvas.height);
  }
  private transform(context: CanvasRenderingContext2D): void {
    context.setTransform(this.zoom * this.dpr, 0, 0, this.zoom * this.dpr, (this.offset.x + this.renderOffset.x) * this.dpr, (this.offset.y + this.renderOffset.y) * this.dpr);
  }
  private clipped(context: CanvasRenderingContext2D, draw: () => void): void {
    context.save(); this.transform(context);
    const { width, height } = pageDimensions(this.renderPage ?? this.document);
    context.beginPath(); context.rect(0, 0, width, height); context.clip();
    draw(); context.restore();
  }
  private drawSegment(context: CanvasRenderingContext2D, stroke: Stroke, point: Point, previous?: Point): void {
    context.fillStyle = stroke.color;
    const r = radius(stroke, point);
    context.beginPath();
    context.arc(point.x, point.y, r, 0, Math.PI * 2);
    context.fill();
    if (!previous) return;
    const outline = inkSegmentOutline(previous, radius(stroke, previous), point, r);
    if (!outline.length) return;
    context.beginPath();
    context.moveTo(outline[0].x, outline[0].y);
    for (const vertex of outline.slice(1)) context.lineTo(vertex.x, vertex.y);
    context.closePath(); context.fill();
  }
  private curved(stroke: Stroke): boolean { return stroke.tool === 'pen' && stroke.smoothing !== 'none'; }
  private drawCurve(context: CanvasRenderingContext2D, stroke: Stroke, segment: PenSegment | null): void {
    if (!segment) return;
    let previous = segment.start;
    for (const point of segment.points) {
      this.drawSegment(context, stroke, point, previous); previous = point;
    }
  }
  private drawTip(stroke: Stroke): void {
    this.clear(this.tipContext);
    if (this.curved(stroke)) this.clipped(this.tipContext, () => this.drawCurve(this.tipContext, stroke, penTail(stroke.points)));
  }
  private drawSample(context: CanvasRenderingContext2D, stroke: Stroke, index: number): void {
    if (this.curved(stroke)) {
      if (index === 0) this.drawSegment(context, stroke, stroke.points[0]);
      else this.drawCurve(context, stroke, penSegment(stroke.points, index));
      return;
    }
    let previous = stroke.points[index - 1];
    for (const point of stroke.smoothing === 'none' ? [stroke.points[index]] : smoothInkSegment(stroke.points[index], previous, stroke.points[index - 2])) {
      this.drawSegment(context, stroke, point, previous); previous = point;
    }
  }
  private drawStroke(context: CanvasRenderingContext2D, stroke: Stroke, includeTail = true): void {
    this.clipped(context, () => {
      for (let index = 0; index < stroke.points.length; index++) this.drawSample(context, stroke, index);
      if (includeTail && this.curved(stroke)) this.drawCurve(context, stroke, penTail(stroke.points));
    });
  }
  private paper(page: InkDocument): void {
    const context = this.baseContext;
    this.transform(context);
    drawPaper(context, page.paper, page);
  }

  private composite(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, alpha: number): void {
    context.save(); context.setTransform(1, 0, 0, 1, 0, 0); context.globalAlpha = alpha;
    context.drawImage(canvas, 0, 0); context.restore();
  }
  private redraw(): void {
    this.positionSearchHighlights();
    this.clear(this.baseContext);
    const layout = this.pageLayout(), active = layout.pages[this.pageIndex];
    for (const entry of layout.pages) {
      const y = this.offset.y + (entry.top - active.top) * this.zoom;
      if (y > this.size.y || y + entry.height * this.zoom < 0) continue;
      this.renderOffset = { x: (active.width - entry.width) / 2 * this.zoom, y: (entry.top - active.top) * this.zoom };
      const page = entry.page; this.renderPage = page;
      this.paper(page);
      for (const item of page.images ?? []) {
        let image = this.imageCache.get(item.src);
        if (!image) { image = new Image(); this.imageCache.set(item.src, image); image.onload = () => this.scheduleRedraw(); image.src = item.src; }
        if (image.complete && image.naturalWidth) this.clipped(this.baseContext, () => this.baseContext.drawImage(image!, item.x, item.y, item.width, item.height));
      }
      for (const stroke of page.strokes) {
        if (!this.visible(stroke)) continue;
        if (stroke.tool === 'highlighter') {
          this.clear(this.scratchContext); this.drawStroke(this.scratchContext, stroke);
          this.composite(this.baseContext, this.scratch, 0.28);
        } else this.drawStroke(this.baseContext, stroke);
      }
    }
    this.renderOffset = { x: 0, y: 0 }; this.renderPage = null;
    this.clear(this.liveContext);
    this.clear(this.tipContext);
    if (this.active) { this.drawStroke(this.liveContext, this.active.stroke, false); this.drawTip(this.active.stroke); }
    else this.drawSelection();
  }
  private scheduleRedraw(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; if (!this.disposed) this.redraw(); });
  }
  private strokeBounds(stroke: Stroke) {
    let bounds = this.bounds.get(stroke);
    if (!bounds) {
      bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
      for (const point of stroke.points) {
        bounds.left = Math.min(bounds.left, point.x - stroke.width); bounds.right = Math.max(bounds.right, point.x + stroke.width);
        bounds.top = Math.min(bounds.top, point.y - stroke.width); bounds.bottom = Math.max(bounds.bottom, point.y + stroke.width);
      }
      this.bounds.set(stroke, bounds);
    }
    return bounds;
  }
  private visible(stroke: Stroke): boolean {
    const bounds = this.strokeBounds(stroke);
    return bounds.right * this.zoom + this.offset.x + this.renderOffset.x >= 0 && bounds.left * this.zoom + this.offset.x + this.renderOffset.x <= this.size.x &&
      bounds.bottom * this.zoom + this.offset.y + this.renderOffset.y >= 0 && bounds.top * this.zoom + this.offset.y + this.renderOffset.y <= this.size.y;
  }
  private positionEraserCursor(): void {
    const visible = this.tool === 'eraser' && this.hover !== null;
    this.eraserCursor.style.display = visible ? 'block' : 'none';
    if (!visible || !this.hover) return;
    const diameter = this.width * this.zoom;
    this.eraserCursor.style.width = `${diameter}px`; this.eraserCursor.style.height = `${diameter}px`;
    this.eraserCursor.style.left = `${this.hover.x}px`; this.eraserCursor.style.top = `${this.hover.y}px`;
  }
  private updateCursor(): void { this.host.style.cursor = this.tool === 'hand' ? 'grab' : this.tool === 'eraser' ? 'none' : 'crosshair'; this.positionEraserCursor(); }
  private viewportBounds() {
    const layout = this.pageLayout(), active = layout.pages[this.pageIndex];
    const width = layout.width * this.zoom, height = layout.height * this.zoom;
    const pageX = (layout.width - active.width) / 2 * this.zoom, pageY = active.top * this.zoom;
    const margin = Math.min(28, this.size.x / 4);
    const top = Math.min(this.pageTop(), Math.max(0, this.size.y - 48));
    const bottom = Math.max(top + 1, this.size.y - 28);
    const centerX = (this.size.x - width) / 2;
    const centerY = top + (bottom - top - height) / 2;
    return {
      left: (width <= this.size.x - margin * 2 ? centerX : this.size.x - margin - width) + pageX,
      right: (width <= this.size.x - margin * 2 ? centerX : margin) + pageX,
      bottom: (height <= bottom - top ? centerY : bottom - height) + pageY,
      top: (height <= bottom - top ? centerY : top) + pageY,
    };
  }
  private clampViewport(): void {
    const bounds = this.viewportBounds();
    this.offset.x = clamp(this.offset.x, bounds.left, bounds.right);
    this.offset.y = clamp(this.offset.y, bounds.bottom, bounds.top);
  }
  private setPagePullProgress(progress: number): void {
    if (progress === this.pagePullProgress) return;
    this.pagePullProgress = progress; this.options.onPagePull?.(progress);
  }
  private cancelPagePull(): void {
    this.pagePull = null; this.wheelPull = null;
    clearTimeout(this.wheelPullTimer);this.wheelPullTimer=undefined;
    this.setPagePullProgress(0);
  }
  private panBy(delta: XY, local: XY, pointerId: number): void {
    this.offset.x += delta.x;
    const pull = this.pagePull;
    if (pull?.pointerId === pointerId) {
      const bounds = this.viewportBounds();
      // Preserve only bottom excess so reversing the finger unwinds the affordance first.
      pull.rawY = Math.min(bounds.top, pull.rawY + delta.y);
      this.offset.y = pull.rawY;
      const upward = pull.origin.y - local.y;
      // Once upward intent is clear, lateral finger drift must not blink the
      // affordance off. Reversing still unwinds the same raw distance directly.
      if (upward > 10 && upward > Math.abs(local.x - pull.origin.x)) pull.vertical = true;
      this.setPagePullProgress(pull.vertical ? clamp((bounds.bottom - pull.rawY) / 96, 0, 1) : 0);
    } else this.offset.y += delta.y;
    this.viewportChanged();
  }
  private viewportChanged(activate = true): void {
    this.clampViewport();
    if (activate && !(this.active || this.erase || this.lasso || this.drag)) {
      const center = (this.pageTop() + this.size.y) / 2;
      this.activatePage(this.pageAt(center));
    }
    this.positionSearchHighlights(); this.positionEraserCursor(); this.scheduleRedraw(); this.options.onViewportChange?.(this.zoom);
  }
  private zoomAt(factor: number, center: XY): void {
    this.cancelPagePull();
    this.fitMode = 'manual';
    const anchor = this.toPage(center); this.zoom = clamp(this.zoom * factor, 0.08, 5);
    this.offset = { x: center.x - anchor.x * this.zoom, y: center.y - anchor.y * this.zoom }; this.viewportChanged();
  }
  private local(event: PointerEvent | WheelEvent): XY {
    const rect = this.host.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
  private toPage(point: XY): XY { return { x: (point.x - this.offset.x) / this.zoom, y: (point.y - this.offset.y) / this.zoom }; }
  private inside(point: XY): boolean { return point.x >= 0 && point.y >= 0 && point.x <= this.pageSize.width && point.y <= this.pageSize.height; }
  private capture(event: PointerEvent): void { try { this.host.setPointerCapture(event.pointerId); } catch { /* Detached hosts cannot capture. */ } }
  private pencilPointer: number | null = null;
  private canvasTouch = (event: TouchEvent): void => {
    const target = event.target as HTMLElement | null;
    if (!target || !this.host.contains(target)) return;
    // PointerEvents still deliver canvas pan/pinch/Pencil input. Native text
    // selection and control clicks keep their defaults, but no part of a
    // canvas touch sequence should reach the host's command gesture handler.
    const control = target.closest?.('input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"])');
    if (!control && event.cancelable && (event.type === 'touchstart' || event.type === 'touchmove')) event.preventDefault();
    event.stopPropagation();
  };
  private documentPointer = (event: PointerEvent): void => {
    if (event.pointerId !== this.pencilPointer || this.host.contains(event.target as Node)) return;
    if (event.type === 'pointermove') this.pointerMove(event);
    else if (event.type === 'pointerup') this.pointerUp(event);
    else this.pointerCancel(event);
  };
  private lostPointerCapture = (event: PointerEvent): void => {
    if (event.pointerId === this.pencilPointer) {
      this.capture(event);
      return;
    }
    this.pointerCancel(event);
  };
  private sample(event: PointerEvent, rect?: DOMRect): Point {
    const point = this.toPage(rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : this.local(event));
    return { ...point, pressure: event.pointerType === 'pen' ? clamp(event.pressure || 0.35, 0.05, 1) : 0.5, time: event.timeStamp };
  }

  private pointerDown = (event: PointerEvent): void => {
    if(this.wheelPull)this.cancelPagePull();
    if (event.button !== 0 && event.button !== 5) return;
    event.preventDefault(); event.stopPropagation(); this.capture(event);
    const local = this.local(event);
    if (this.pagePull && this.pagePull.pointerId !== event.pointerId) this.cancelPagePull();
    if (event.pointerType === 'pen') {
      // A new physical contact also terminates a stale stream whose up event
      // never reached the WebView; never connect separate Pencil strokes.
      if (this.pencilPointer !== null) { this.finishActive(); this.finishErase(); }
      this.pencilPointer = event.pointerId;
      this.cancelPagePull();
      // Pencil takes priority over any finger contact already on the glass.
      if (this.active && this.touches.has(this.active.pointerId)) { this.active = null; this.clear(this.liveContext); this.clear(this.tipContext); }
      if (this.erase && this.touches.has(this.erase.pointerId)) this.finishErase();
      if ((this.lasso && this.touches.has(this.lasso.pointerId)) || (this.drag && this.touches.has(this.drag.pointerId))) this.finishSelection(true);
      this.touches.clear(); this.pan = null;
    }
    if (event.pointerType === 'touch') {
      // Ignore palm contacts throughout a Pencil gesture.
      if ((this.active && this.active.pointerId !== event.pointerId && !this.touches.has(this.active.pointerId)) ||
          (this.erase && !this.touches.has(this.erase.pointerId)) ||
          (this.lasso && !this.touches.has(this.lasso.pointerId)) || (this.drag && !this.touches.has(this.drag.pointerId)) ||
          this.pan?.pointerType === 'pen') return;
      this.touches.set(event.pointerId, local);
      if (this.touches.size > 1) {
        this.cancelPagePull();
        if (this.active && this.touches.has(this.active.pointerId)) { this.active = null; this.clear(this.liveContext); this.clear(this.tipContext); }
        this.finishErase(); this.finishSelection(true); this.pan = null; return;
      }
    }
    if (this.active || this.erase || this.pan || this.lasso || this.drag) return;
    if (this.tool === 'hand' || (event.pointerType === 'touch' && !this.fingerDrawing)) {
      if (event.pointerType !== 'touch') this.pan = { pointerId: event.pointerId, pointerType: event.pointerType, last: local };
      if (event.pointerType === 'touch' || (event.pointerType === 'mouse' && !this.touches.size)) this.pagePull = { pointerId: event.pointerId, origin: local, rawY: this.offset.y, vertical: false };
      return;
    }
    this.activatePage(this.pageAt(local.y));
    const point = this.sample(event);
    if (!this.inside(point)) return;
    if (this.tool === 'eraser' || event.button === 5) {
      this.erase = { pointerId: event.pointerId, before: this.document, last: point }; this.eraseTo(point); return;
    }
    if (this.tool === 'lasso') {
      const box = this.selectionBox();
      if (box && point.x >= box.left - 8 / this.zoom && point.x <= box.right + 8 / this.zoom && point.y >= box.top - 8 / this.zoom && point.y <= box.bottom + 8 / this.zoom) {
        const corner = [{ x: box.left, y: box.top }, { x: box.right, y: box.top }, { x: box.left, y: box.bottom }, { x: box.right, y: box.bottom }].find(p => distance(point, p) <= 10 / this.zoom);
        this.drag = { pointerId: event.pointerId, origin: point, before: this.document, dx: 0, dy: 0, ...(corner ? { box, anchor: { x: corner.x === box.left ? box.right : box.left, y: corner.y === box.top ? box.bottom : box.top } } : {}) };
      } else { this.clearSelection(); this.lasso = { pointerId: event.pointerId, points: [point] }; this.redraw(); }
      return;
    }
    const tool = this.tool === 'highlighter'  ? 'highlighter' : 'pen';
    const stroke: Stroke = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`, tool, color: this.color, width: this.width, points: [point], ...(this.tool === 'shape' ? { smoothing: 'none' as const } : {}) };
    this.shapeStart = this.tool === 'shape' && this.shapeMode !== 'auto' ? point : null;
    this.active = { pointerId: event.pointerId, stroke };
    this.live.style.opacity = tool === 'highlighter' ? '0.28' : '1';
    this.clear(this.liveContext); this.clear(this.tipContext);
    this.clipped(this.liveContext, () => this.drawSegment(this.liveContext, stroke, point));
  };

  private pointerMove = (event: PointerEvent): void => {
    event.preventDefault(); event.stopPropagation();
    this.hover = event.pointerType === 'touch' ? null : this.local(event); this.positionEraserCursor();
    if (this.lasso?.pointerId === event.pointerId) {
      const point = this.sample(event);
      if (distance(point, this.lasso.points[this.lasso.points.length - 1]) >= 2 / this.zoom) this.lasso.points.push(point);
      this.scheduleRedraw(); return;
    }
    if (this.drag?.pointerId === event.pointerId) {
      const point = this.sample(event), drag = this.drag;
      if (drag.anchor && drag.box) {
        const vx = drag.origin.x - drag.anchor.x, vy = drag.origin.y - drag.anchor.y;
        const factor = ((point.x - drag.anchor.x) * vx + (point.y - drag.anchor.y) * vy) / (vx * vx + vy * vy || 1);
        this.document = this.scaleSelection(drag.before, drag.box, drag.anchor, factor); this.scheduleRedraw(); return;
      }
      const current = this.document; this.document = drag.before;
      const box = this.selectionBox()!; this.document = current;
      const dx = clamp(point.x - drag.origin.x, -box.left, this.pageSize.width-box.right);
      const dy = clamp(point.y - drag.origin.y, -box.top, this.pageSize.height-box.bottom);
      if (dx === drag.dx && dy === drag.dy) return;
      drag.dx = dx; drag.dy = dy;
      this.document = { ...drag.before, strokes: drag.before.strokes.map(stroke => this.selected.has(stroke.id) ? { ...stroke, points: stroke.points.map(p => ({ ...p, x: p.x+dx, y: p.y+dy })) } : stroke), ...(drag.before.images ? { images: drag.before.images.map(image => this.selected.has(image.id) ? { ...image, x: image.x + dx, y: image.y + dy } : image) } : {}) };
      this.scheduleRedraw(); return;
    }
    if (this.active?.pointerId === event.pointerId) {
      if (this.touches.has(event.pointerId)) this.touches.set(event.pointerId, this.local(event));
      if (this.shapeStart && this.shapeMode !== 'auto') {
        const { width, height } = this.pageSize;
        const end = this.sample(event); end.x = clamp(end.x, 0, width); end.y = clamp(end.y, 0, height);
        this.active.stroke.points = createShape(this.shapeMode, this.shapeStart, end).map(p => ({ ...p, x: clamp(p.x, 0, width), y: clamp(p.y, 0, height) }));
        this.clear(this.liveContext); this.drawStroke(this.liveContext, this.active.stroke); return;
      }
      let samples: PointerEvent[] = [];
      try { samples = event.getCoalescedEvents?.() ?? []; } catch { /* Older WebKit may expose an unsupported method. */ }
      // Some WebKit batches omit the dispatched event's latest position.
      // The distance/timestamp checks below deduplicate it when it is included.
      samples = [...samples, event];
      const stroke = this.active.stroke;
      const rect = this.host.getBoundingClientRect();
      this.clipped(this.liveContext, () => {
        for (const sample of samples) {
          const previous = stroke.points[stroke.points.length - 1];
          const point = this.sample(sample, rect);
          if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.time < previous.time || distance(previous, point) < 0.1) continue;
          // Stabilize pressure without delaying the spatial Pencil samples.
          point.pressure = previous.pressure * 0.35 + point.pressure * 0.65;
          stroke.points.push(point); this.drawSample(this.liveContext, stroke, stroke.points.length - 1);
        }
      });
      this.drawTip(stroke);
      return;
    }
    if (this.erase?.pointerId === event.pointerId) {
      if (this.touches.has(event.pointerId)) this.touches.set(event.pointerId, this.local(event));
      this.eraseTo(this.sample(event)); return;
    }
    if (this.active || this.erase || this.lasso || this.drag) return;
    const local = this.local(event);
    if (this.touches.has(event.pointerId)) {
      this.fitMode = 'manual';
      const before = [...this.touches.values()];
      this.touches.set(event.pointerId, local);
      const after = [...this.touches.values()];
      if (before.length >= 2) {
        const oldCenter = { x: (before[0].x + before[1].x) / 2, y: (before[0].y + before[1].y) / 2 };
        const newCenter = { x: (after[0].x + after[1].x) / 2, y: (after[0].y + after[1].y) / 2 };
        const anchor = this.toPage(oldCenter);
        const oldDistance = distance(before[0], before[1]);
        if (oldDistance > 2) this.zoom = clamp(this.zoom * distance(after[0], after[1]) / oldDistance, 0.08, 5);
        this.offset = { x: newCenter.x - anchor.x * this.zoom, y: newCenter.y - anchor.y * this.zoom };
      } else {
        this.panBy({ x: after[0].x - before[0].x, y: after[0].y - before[0].y }, local, event.pointerId); return;
      }
      this.viewportChanged();
    } else if (this.pan?.pointerId === event.pointerId) {
      this.fitMode = 'manual';
      const delta = { x: local.x - this.pan.last.x, y: local.y - this.pan.last.y };
      this.pan.last = local; this.panBy(delta, local, event.pointerId);
    }
  };

  private pointerUp = (event: PointerEvent): void => {
    event.stopPropagation();
    let advance = false;
    if (this.pagePull?.pointerId === event.pointerId) {
      this.pointerMove(event);
      advance = this.pagePullProgress >= 1;
      this.cancelPagePull();
    }
    if (this.lasso?.pointerId === event.pointerId || this.drag?.pointerId === event.pointerId) { this.pointerMove(event); this.finishSelection(); }
    if (this.active?.pointerId === event.pointerId) { this.pointerMove(event); this.finishActive(true); }
    if (this.erase?.pointerId === event.pointerId) { this.eraseTo(this.sample(event)); this.finishErase(); }
    this.touches.delete(event.pointerId);
    if (this.pan?.pointerId === event.pointerId) this.pan = null;
    if (event.pointerId === this.pencilPointer) this.pencilPointer = null;
    if (advance) this.options.onPageAdvance?.();
  };
  private pointerCancel = (event: PointerEvent): void => {
    event.stopPropagation();
    if (this.pagePull?.pointerId === event.pointerId) this.cancelPagePull();
    if (this.lasso?.pointerId === event.pointerId || this.drag?.pointerId === event.pointerId) this.finishSelection(true);
    // Keep the real samples received before an OS interruption; no predicted points are persisted.
    if (this.active?.pointerId === event.pointerId) this.finishActive();
    if (this.erase?.pointerId === event.pointerId) this.finishErase();
    this.touches.delete(event.pointerId);
    if (this.pan?.pointerId === event.pointerId) this.pan = null;
    if (event.pointerId === this.pencilPointer) this.pencilPointer = null;
  };
  private finishActive(convertShape = false): void {
    if (!this.active) return;
    let stroke = this.active.stroke; this.active = null; this.shapeStart = null;
    const shape = convertShape && this.tool === 'shape' && this.shapeMode === 'auto' ? recognizeShape(stroke.points) : null;
    if (shape) { stroke = { ...stroke, points: shape, smoothing: 'none' }; this.clear(this.liveContext); this.drawStroke(this.liveContext, stroke); }
    else if (this.curved(stroke)) this.clipped(this.liveContext, () => this.drawCurve(this.liveContext, stroke, penTail(stroke.points)));
    this.clear(this.tipContext);
    this.undoStack.push({ page: this.document, counterpart: this.document }); if (this.undoStack.length > 100) this.undoStack.shift(); this.redoStack = [];
    this.document = { ...this.document, strokes: [...this.document.strokes, stroke] };
    // Commit the live layer without replaying historical strokes.
    this.composite(this.baseContext, this.live, stroke.tool === 'highlighter' ? 0.28 : 1);
    this.clear(this.liveContext); this.options.onChange(this.document);
  }
  private eraseTo(point: XY): void {
    if (!this.erase) return;
    const previous = this.erase.last;
    const eraserRadius = this.width / 2;
    let changed = false;
    const strokes = this.document.strokes.flatMap(stroke => {
      const bounds = this.strokeBounds(stroke);
      if (bounds.right < Math.min(previous.x, point.x) - eraserRadius || bounds.left > Math.max(previous.x, point.x) + eraserRadius ||
          bounds.bottom < Math.min(previous.y, point.y) - eraserRadius || bounds.top > Math.max(previous.y, point.y) + eraserRadius) return [stroke];
      const remaining = eraseStroke(stroke, previous, point, eraserRadius, this.eraserMode);
      if (remaining.length !== 1 || remaining[0] !== stroke) changed = true;
      return remaining;
    });
    this.erase.last = point;
    if (changed) { this.document = { ...this.document, strokes }; this.scheduleRedraw(); }
  }
  private finishErase(): void {
    if (!this.erase) return;
    const before = this.erase.before; this.erase = null;
    if (before === this.document) return;
    this.undoStack.push({ page: before, counterpart: this.document }); if (this.undoStack.length > 100) this.undoStack.shift(); this.redoStack = [];
    this.options.onChange(this.document);
  }
  private contextMenu = (event: Event): void => event.preventDefault();
  private wheel = (event: WheelEvent): void => {
    event.preventDefault();
    if (this.active || this.erase || this.lasso || this.drag || this.pan || this.touches.size) {this.cancelPagePull();return;}
    if (event.ctrlKey || event.metaKey) {this.zoomAt(Math.exp(-event.deltaY * 0.005), this.local(event));return;}
    const unit=event.deltaMode===1?16:event.deltaMode===2?this.size.y:1;
    const dy=event.deltaY*unit,dx=event.deltaX*unit;
    const atBottom=Math.abs(this.offset.y-this.viewportBounds().bottom)<1;
    if(!this.wheelPull)this.wheelPull={distance:0,samples:0,eligible:atBottom && Date.now()>=this.wheelCooldown};
    const pull=this.wheelPull;
    let scrollY=dy;
    // A scroll that merely reaches the end cannot add a page through momentum.
    // Start a fresh, mostly vertical scroll at the bottom; a pause acts as release.
    if(Math.abs(dx)>=Math.abs(dy)||Math.abs(dy)>500||(!atBottom && pull.distance===0))pull.eligible=false;
    if(pull.eligible) {
      const previousDistance=pull.distance;
      pull.distance=Math.max(0,pull.distance+Math.min(60,dy));
      // Reverse through the accumulated overscroll before moving the page.
      // This mirrors touch panning and keeps progress attached to the boundary.
      if(dy<0)scrollY=Math.min(0,dy+previousDistance);
      if(dy>0)pull.samples++;
      this.setPagePullProgress(clamp(pull.distance/180,0,1));
    }
    if(!pull.eligible)this.setPagePullProgress(0);
    this.fitMode='manual';this.offset.x-=dx;this.offset.y-=scrollY;this.viewportChanged();
    clearTimeout(this.wheelPullTimer);
    this.wheelPullTimer=setTimeout(()=>{
      const advance=pull.eligible && pull.samples>=3 && this.pagePullProgress>=1 && !this.disposed;
      this.cancelPagePull();
      if(advance){this.wheelCooldown=Date.now()+500;this.options.onPageAdvance?.();}
    },220);
  };

  exportSvg(): string {
    this.flush();
    const n = (value: number) => Number(value.toFixed(2));
    const { width, height } = this.pageSize;
    const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
      `<defs><clipPath id="page"><rect width="${width}" height="${height}"/></clipPath></defs>`];
    parts.push(paperSvg(this.document.paper, this.document));
    parts.push('<g clip-path="url(#page)">');
    for (const image of this.document.images ?? []) {
      if (isImageSource(image.src)) parts.push(`<image x="${n(image.x)}" y="${n(image.y)}" width="${n(image.width)}" height="${n(image.height)}" href="${image.src}"/>`);
    }
    for (const stroke of this.document.strokes) {
      // Only validated six-digit colors enter the SVG attribute.
      const color = /^#[0-9a-f]{6}$/i.test(stroke.color) ? stroke.color : '#243247';
      parts.push(`<g fill="${color}" opacity="${stroke.tool === 'highlighter' ? 0.28 : 1}">`);
      const appendPoint = (point: Point, previous?: Point) => {
        const r = radius(stroke, point);
        parts.push(`<circle cx="${n(point.x)}" cy="${n(point.y)}" r="${n(r)}"/>`);
        if (previous) {
          const outline = inkSegmentOutline(previous, radius(stroke, previous), point, r);
          if (outline.length) parts.push(`<path d="${outline.map((p, i) => `${i ? 'L' : 'M'}${n(p.x)} ${n(p.y)}`).join('')}Z"/>`);
        }
      };
      const appendCurve = (segment: PenSegment | null) => {
        if (!segment) return;
        let previous = segment.start;
        for (const point of segment.points) { appendPoint(point, previous); previous = point; }
      };
      for (let index = 0; index < stroke.points.length; index++) {
        if (this.curved(stroke)) {
          if (index === 0) appendPoint(stroke.points[0]);
          else appendCurve(penSegment(stroke.points, index));
        } else {
          let previous = stroke.points[index - 1];
          for (const point of stroke.smoothing === 'none' ? [stroke.points[index]] : smoothInkSegment(stroke.points[index], previous, stroke.points[index - 2])) {
            appendPoint(point, previous); previous = point;
          }
        }
      }
      if (this.curved(stroke)) appendCurve(penTail(stroke.points));
      parts.push('</g>');
    }
    parts.push('</g></svg>'); return parts.join('');
  }

  destroy(): void {
    this.cancelPagePull();
    this.finishActive(); this.finishErase(); this.finishSelection(); this.disposed = true;
    this.abort.abort(); this.observer.disconnect(); if (this.frame) cancelAnimationFrame(this.frame);
    this.base.remove(); this.live.remove(); this.tip.remove(); this.eraserCursor.remove(); this.histories.clear(); this.searchLayer.replaceChildren(); this.searchLayer.remove(); this.searchHighlights = []; this.searchHighlightIndices = [];
    for (const canvas of [this.base, this.live, this.scratch, this.tip]) canvas.width = canvas.height = 1;
    for (const image of this.imageCache.values()) image.onload = null; this.imageCache.clear();
    this.touches.clear();
  }
}
