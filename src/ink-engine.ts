import { type InkPage as InkDocument, type Paper, type Point, type Stroke, PAGE_HEIGHT, PAGE_WIDTH } from './model';
import { eraseStroke, type EraserMode } from './eraser';
import { enclosedStrokes, recognizeShape } from './geometry';
export { PAGE_HEIGHT, PAGE_WIDTH } from './model';

type Tool = 'pen' | 'highlighter' | 'eraser' | 'hand' | 'lasso' | 'shape';
type Options = { document: InkDocument; onChange: (document: InkDocument) => void; onViewportChange?: (zoom: number) => void; onSelectionChange?: (count: number) => void; onPagePull?: (progress: number) => void; onPageAdvance?: () => void; onActivePageChange?: (page: InkDocument) => void };
export type SearchHighlight = { x: number; y: number; width: number; height: number };
export const PAGE_GAP = 32;
const PAGE_STRIDE = PAGE_HEIGHT + PAGE_GAP;
type XY = { x: number; y: number };
const clamp = (n: number, low: number, high: number) => Math.min(high, Math.max(low, n));
const distance = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y);
const radius = (stroke: Stroke, point: Point) => stroke.width * (stroke.tool === 'highlighter' ? 0.5 : 0.18 + point.pressure * 0.62);

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
  private readonly searchLayer = document.createElement('div');
  private searchHighlights: SearchHighlight[] = [];
  private searchHighlightIndices: number[] = [];
  private activeSearchHighlight = -1;
  private readonly baseContext: CanvasRenderingContext2D;
  private readonly liveContext: CanvasRenderingContext2D;
  private readonly scratchContext: CanvasRenderingContext2D;
  private readonly observer: ResizeObserver;
  private readonly abort = new AbortController();
  private document: InkDocument;
  private pages: InkDocument[];
  private pageIndex = 0;
  private renderOffset = 0;
  private readonly eraserCursor = document.createElement('div');
  private hover: XY | null = null;
  private readonly histories = new Map<string, { undo: InkDocument[]; redo: InkDocument[] }>();
  private undoStack: InkDocument[] = [];
  private redoStack: InkDocument[] = [];
  private tool: Tool = 'pen';
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
  private pagePull: { pointerId: number; origin: XY; rawY: number } | null = null;
  private pagePullProgress = 0;
  private wheelPull: { distance: number; samples: number; eligible: boolean } | null = null;
  private wheelPullTimer: ReturnType<typeof setTimeout> | undefined;
  private wheelCooldown = 0;
  private frame = 0;
  private disposed = false;
  private selected = new Set<string>();
  private lasso: { pointerId: number; points: XY[] } | null = null;
  private drag: { pointerId: number; origin: XY; before: InkDocument; dx: number; dy: number } | null = null;
  private bounds = new WeakMap<Stroke, { left: number; top: number; right: number; bottom: number }>();

  constructor(private readonly host: HTMLElement, private readonly options: Options) {
    this.document = options.document;
    this.pages = [options.document];
    this.baseContext = this.context(this.base);
    this.liveContext = this.context(this.live);
    this.scratchContext = this.context(this.scratch);
    this.host.classList.add('inkstone-canvas-host');
    for (const canvas of [this.base, this.live]) {
      canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
      canvas.setAttribute('aria-hidden', 'true');
      this.host.append(canvas);
    }
    this.searchLayer.className = 'inkstone-search-highlights';
    this.searchLayer.style.cssText = `position:absolute;left:0;top:0;width:${PAGE_WIDTH}px;height:${PAGE_HEIGHT}px;overflow:hidden;pointer-events:none;transform-origin:0 0;`;
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
    this.host.addEventListener('lostpointercapture', this.pointerCancel, eventOptions);
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
  setColor(color: string): void { if (/^#[0-9a-f]{6}$/i.test(color)) this.color = color; }
  setWidth(width: number): void { if (Number.isFinite(width)) { this.width = clamp(width, 0.5, 100); this.positionEraserCursor(); } }
  setFingerDrawing(enabled: boolean): void { this.cancelPagePull(); this.fingerDrawing = enabled; }
  setPaper(paper: Paper): void {
    if (paper === this.document.paper) return;
    this.finishActive(); this.finishErase();
    this.change({ ...this.document, paper });
  }
  /** Synchronize notebook pages without disturbing the current gesture or scroll position. */
  setPages(pages: InkDocument[]): void {
    if (!pages.length) return;
    const index = pages.findIndex(page => page.id === this.document.id);
    if (index >= 0) {
      this.pages = pages.slice();
      this.pageIndex = index;
      // offset is relative to the active page: keep that page under the pen
      // when pages before it are inserted, removed, or reordered.
      this.document = this.pages[index];
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
    this.scheduleRedraw();
  }
  private rememberPage(): void {
    this.pages[this.pageIndex] = this.document;
    this.histories.set(this.document.id, { undo: this.undoStack, redo: this.redoStack });
  }
  private activatePage(index: number): void {
    if (index === this.pageIndex || !this.pages[index]) return;
    this.flush(); this.rememberPage();
    this.offset.y += (index - this.pageIndex) * PAGE_STRIDE * this.zoom;
    if (this.pagePull) this.pagePull.rawY += (index - this.pageIndex) * PAGE_STRIDE * this.zoom;
    this.pageIndex = index; this.document = this.pages[index];
    const history = this.histories.get(this.document.id);
    this.undoStack = history?.undo ?? []; this.redoStack = history?.redo ?? [];
    this.clearSelection(); this.setSearchHighlights([]);
    this.options.onActivePageChange?.(this.document);
  }
  setDocument(document: InkDocument): void {
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
    this.redoStack.push(this.document); this.document = previous;
    this.redraw(); this.options.onChange(this.document);
  }
  redo(): void {
    this.finishActive(); this.finishErase(); this.finishSelection(); this.clearSelection();
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.document); this.document = next;
    this.redraw(); this.options.onChange(this.document);
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
    this.zoom = clamp((this.size.x - (this.size.x < 620 ? 32 : 64)) / PAGE_WIDTH, 0.08, 2);
    this.offset = { x: (this.size.x - PAGE_WIDTH * this.zoom) / 2, y: this.pageTop() };
    this.fitMode = 'width'; this.viewportChanged();
  }
  fit(): void {
    this.cancelPagePull();
    const top = this.pageTop();
    const availableHeight = Math.max(1, this.size.y - top - 28);
    this.zoom = clamp(Math.min((this.size.x - 56) / PAGE_WIDTH, availableHeight / PAGE_HEIGHT), 0.08, 2);
    this.offset = { x: (this.size.x - PAGE_WIDTH * this.zoom) / 2, y: top + (availableHeight - PAGE_HEIGHT * this.zoom) / 2 };
    this.fitMode = 'page'; this.viewportChanged();
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
    for (const [index, box] of boxes.slice(0, 1000).entries()) {
      if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) continue;
      const x = clamp(box.x, 0, PAGE_WIDTH), y = clamp(box.y, 0, PAGE_HEIGHT);
      const right = clamp(box.x + box.width, 0, PAGE_WIDTH), bottom = clamp(box.y + box.height, 0, PAGE_HEIGHT);
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
    this.searchLayer.style.transform = `translate(${this.offset.x}px, ${this.offset.y}px) scale(${this.zoom})`;
  }

  clearSelection(): void { this.selected.clear(); this.options.onSelectionChange?.(0); this.scheduleRedraw(); }
  deleteSelection(): void {
    this.finishSelection();
    if (!this.selected.size) return;
    const strokes = this.document.strokes.filter(stroke => !this.selected.has(stroke.id));
    this.clearSelection(); this.change({ ...this.document, strokes });
  }
  duplicateSelection(): void {
    this.finishSelection();
    const originals = this.document.strokes.filter(stroke => this.selected.has(stroke.id));
    if (!originals.length) return;
    const box = this.selectionBox()!;
    const dx = Math.max(-box.left, Math.min(24, PAGE_WIDTH - box.right));
    const dy = Math.max(-box.top, Math.min(24, PAGE_HEIGHT - box.bottom));
    const copies = originals.map(stroke => ({ ...stroke, id: crypto.randomUUID(), points: stroke.points.map(p => ({ ...p, x: p.x + dx, y: p.y + dy })) }));
    this.selected = new Set(copies.map(stroke => stroke.id));
    this.change({ ...this.document, strokes: [...this.document.strokes, ...copies] });
    this.options.onSelectionChange?.(copies.length);
  }
  private selectionBox() {
    const strokes = this.document.strokes.filter(stroke => this.selected.has(stroke.id));
    if (!strokes.length) return null;
    return strokes.reduce((box, stroke) => { for (const p of stroke.points) {
      box.left = Math.min(box.left, p.x); box.right = Math.max(box.right, p.x);
      box.top = Math.min(box.top, p.y); box.bottom = Math.max(box.bottom, p.y);
    } return box; }, { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity });
  }
  private finishSelection(cancel = false): void {
    if (this.drag) {
      const { before } = this.drag; this.drag = null;
      if (cancel) { this.document = before; this.redraw(); }
      else if (this.document !== before) { const next = this.document; this.document = before; this.change(next); }
    }
    if (this.lasso) {
      if (!cancel) this.selected = new Set(enclosedStrokes(this.document.strokes, this.lasso.points));
      this.lasso = null; this.options.onSelectionChange?.(this.selected.size); this.redraw();
    }
  }
  private drawSelection(): void {
    if (!this.selected.size && !this.lasso) return;
    this.live.style.opacity = '1';
    this.clipped(this.liveContext, () => {
      const context = this.liveContext;
      context.strokeStyle = '#4b79db'; context.lineWidth = 1.5 / this.zoom; context.setLineDash([6 / this.zoom, 4 / this.zoom]);
      const box = this.selectionBox();
      if (box) { const pad = 6 / this.zoom; context.strokeRect(box.left-pad, box.top-pad, box.right-box.left+pad*2, box.bottom-box.top+pad*2); }
      if (this.lasso?.points.length) {
        context.beginPath(); context.moveTo(this.lasso.points[0].x, this.lasso.points[0].y);
        for (const p of this.lasso.points.slice(1)) context.lineTo(p.x, p.y);
        context.closePath(); context.stroke();
      }
      context.setLineDash([]);
    });
  }
  private change(next: InkDocument): void {
    this.undoStack.push(this.document);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = []; this.document = next;
    this.redraw(); this.options.onChange(this.document);
  }

  private resize(): void {
    this.cancelPagePull();
    if (this.disposed) return;
    const rect = this.host.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const previous = this.size;
    this.size = { x: rect.width, y: rect.height };
    // Three backing stores together stay below about 48 MB, including on large Retina displays.
    this.dpr = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(4_000_000 / (rect.width * rect.height)));
    for (const canvas of [this.base, this.live, this.scratch]) {
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
    context.setTransform(this.zoom * this.dpr, 0, 0, this.zoom * this.dpr, this.offset.x * this.dpr, (this.offset.y + this.renderOffset) * this.dpr);
  }
  private clipped(context: CanvasRenderingContext2D, draw: () => void): void {
    context.save(); this.transform(context);
    context.beginPath(); context.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT); context.clip();
    draw(); context.restore();
  }
  private drawSegment(context: CanvasRenderingContext2D, stroke: Stroke, point: Point, previous?: Point): void {
    context.fillStyle = stroke.color;
    const r = radius(stroke, point);
    context.beginPath();
    context.arc(point.x, point.y, r, 0, Math.PI * 2);
    context.fill();
    if (!previous) return;
    const length = distance(previous, point);
    if (length < 0.001) return;
    const previousRadius = radius(stroke, previous);
    const nx = -(point.y - previous.y) / length;
    const ny = (point.x - previous.x) / length;
    context.beginPath();
    context.moveTo(previous.x + nx * previousRadius, previous.y + ny * previousRadius);
    context.lineTo(point.x + nx * r, point.y + ny * r);
    context.lineTo(point.x - nx * r, point.y - ny * r);
    context.lineTo(previous.x - nx * previousRadius, previous.y - ny * previousRadius);
    context.closePath(); context.fill();
  }
  private drawStroke(context: CanvasRenderingContext2D, stroke: Stroke): void {
    this.clipped(context, () => {
      for (let index = 0; index < stroke.points.length; index++) this.drawSegment(context, stroke, stroke.points[index], stroke.points[index - 1]);
    });
  }
  private paper(page: InkDocument): void {
    const context = this.baseContext;
    this.transform(context);
    context.fillStyle = '#faf9ef'; context.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);
    context.strokeStyle = '#d8dcd8'; context.fillStyle = '#cbd2cc'; context.lineWidth = 1;
    const paper = page.paper;
    if (paper === 'dots') {
      context.beginPath();
      for (let y = 40; y < PAGE_HEIGHT; y += 40) for (let x = 40; x < PAGE_WIDTH; x += 40) {
        context.moveTo(x + 1.4, y); context.arc(x, y, 1.4, 0, Math.PI * 2);
      }
      context.fill();
    } else if (paper === 'ruled' || paper === 'grid') {
      context.beginPath();
      for (let y = paper === 'ruled' ? 100 : 40; y < PAGE_HEIGHT; y += 40) { context.moveTo(0, y); context.lineTo(PAGE_WIDTH, y); }
      if (paper === 'grid') for (let x = 40; x < PAGE_WIDTH; x += 40) { context.moveTo(x, 0); context.lineTo(x, PAGE_HEIGHT); }
      context.stroke();
    }
  }
  private composite(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, alpha: number): void {
    context.save(); context.setTransform(1, 0, 0, 1, 0, 0); context.globalAlpha = alpha;
    context.drawImage(canvas, 0, 0); context.restore();
  }
  private redraw(): void {
    this.positionSearchHighlights();
    this.clear(this.baseContext);
    const worldY = this.offset.y - this.pageIndex * PAGE_STRIDE * this.zoom;
    const first = clamp(Math.floor(-worldY / (PAGE_STRIDE * this.zoom)), 0, this.pages.length - 1);
    const last = clamp(Math.floor((this.size.y - worldY) / (PAGE_STRIDE * this.zoom)), 0, this.pages.length - 1);
    for (let index = first; index <= last; index++) {
      this.renderOffset = (index - this.pageIndex) * PAGE_STRIDE * this.zoom;
      const page = index === this.pageIndex ? this.document : this.pages[index];
      this.paper(page);
      for (const stroke of page.strokes) {
        if (!this.visible(stroke)) continue;
        if (stroke.tool === 'highlighter') {
          this.clear(this.scratchContext); this.drawStroke(this.scratchContext, stroke);
          this.composite(this.baseContext, this.scratch, 0.28);
        } else this.drawStroke(this.baseContext, stroke);
      }
    }
    this.renderOffset = 0;
    this.clear(this.liveContext);
    if (this.active) this.drawStroke(this.liveContext, this.active.stroke);
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
    return bounds.right * this.zoom + this.offset.x >= 0 && bounds.left * this.zoom + this.offset.x <= this.size.x &&
      bounds.bottom * this.zoom + this.offset.y + this.renderOffset >= 0 && bounds.top * this.zoom + this.offset.y + this.renderOffset <= this.size.y;
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
    const width = PAGE_WIDTH * this.zoom, height = (this.pages.length * PAGE_STRIDE - PAGE_GAP) * this.zoom;
    const margin = Math.min(28, this.size.x / 4);
    const top = Math.min(this.pageTop(), Math.max(0, this.size.y - 48));
    const bottom = Math.max(top + 1, this.size.y - 28);
    const centerX = (this.size.x - width) / 2;
    const centerY = top + (bottom - top - height) / 2;
    return {
      left: width <= this.size.x - margin * 2 ? centerX : this.size.x - margin - width,
      right: width <= this.size.x - margin * 2 ? centerX : margin,
      bottom: (height <= bottom - top ? centerY : bottom - height) + this.pageIndex * PAGE_STRIDE * this.zoom,
      top: (height <= bottom - top ? centerY : top) + this.pageIndex * PAGE_STRIDE * this.zoom,
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
      const deliberate = upward > 10 && upward > Math.abs(local.x - pull.origin.x);
      this.setPagePullProgress(deliberate ? clamp((bounds.bottom - pull.rawY) / 96, 0, 1) : 0);
    } else this.offset.y += delta.y;
    this.viewportChanged();
  }
  private viewportChanged(): void {
    this.clampViewport();
    if (!(this.active || this.erase || this.lasso || this.drag)) {
      const center = (this.pageTop() + this.size.y) / 2;
      const index = clamp(this.pageIndex + Math.floor((center - this.offset.y) / (PAGE_STRIDE * this.zoom)), 0, this.pages.length - 1);
      this.activatePage(index);
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
  private inside(point: XY): boolean { return point.x >= 0 && point.y >= 0 && point.x <= PAGE_WIDTH && point.y <= PAGE_HEIGHT; }
  private capture(event: PointerEvent): void { try { this.host.setPointerCapture(event.pointerId); } catch { /* Detached hosts cannot capture. */ } }
  private sample(event: PointerEvent, rect?: DOMRect): Point {
    const point = this.toPage(rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : this.local(event));
    return { ...point, pressure: event.pointerType === 'pen' ? clamp(event.pressure || 0.35, 0.05, 1) : 0.5, time: event.timeStamp };
  }

  private pointerDown = (event: PointerEvent): void => {
    if(this.wheelPull)this.cancelPagePull();
    if (event.button !== 0 && event.button !== 5) return;
    event.preventDefault(); this.capture(event);
    const local = this.local(event);
    if (this.pagePull && this.pagePull.pointerId !== event.pointerId) this.cancelPagePull();
    if (event.pointerType === 'pen') {
      this.cancelPagePull();
      // Pencil takes priority over any finger contact already on the glass.
      if (this.active && this.touches.has(this.active.pointerId)) { this.active = null; this.clear(this.liveContext); }
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
        if (this.active && this.touches.has(this.active.pointerId)) { this.active = null; this.clear(this.liveContext); }
        this.finishErase(); this.finishSelection(true); this.pan = null; return;
      }
    }
    if (this.active || this.erase || this.pan || this.lasso || this.drag) return;
    if (this.tool === 'hand' || (event.pointerType === 'touch' && !this.fingerDrawing)) {
      if (event.pointerType !== 'touch') this.pan = { pointerId: event.pointerId, pointerType: event.pointerType, last: local };
      if (event.pointerType === 'touch' || (event.pointerType === 'mouse' && !this.touches.size)) this.pagePull = { pointerId: event.pointerId, origin: local, rawY: this.offset.y };
      return;
    }
    const index = this.pageIndex + Math.floor((local.y - this.offset.y) / (PAGE_STRIDE * this.zoom));
    if (index >= 0 && index < this.pages.length) this.activatePage(index);
    const point = this.sample(event);
    if (!this.inside(point)) return;
    if (this.tool === 'eraser' || event.button === 5) {
      this.erase = { pointerId: event.pointerId, before: this.document, last: point }; this.eraseTo(point); return;
    }
    if (this.tool === 'lasso') {
      const box = this.selectionBox();
      if (box && point.x >= box.left - 8 / this.zoom && point.x <= box.right + 8 / this.zoom && point.y >= box.top - 8 / this.zoom && point.y <= box.bottom + 8 / this.zoom) {
        this.drag = { pointerId: event.pointerId, origin: point, before: this.document, dx: 0, dy: 0 };
      } else { this.clearSelection(); this.lasso = { pointerId: event.pointerId, points: [point] }; this.redraw(); }
      return;
    }
    const tool = this.tool === 'highlighter'  ? 'highlighter' : 'pen';
    const stroke: Stroke = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`, tool, color: this.color, width: this.width, points: [point] };
    this.active = { pointerId: event.pointerId, stroke };
    this.live.style.opacity = tool === 'highlighter' ? '0.28' : '1';
    this.clear(this.liveContext);
    this.clipped(this.liveContext, () => this.drawSegment(this.liveContext, stroke, point));
  };

  private pointerMove = (event: PointerEvent): void => {
    event.preventDefault();
    this.hover = event.pointerType === 'touch' ? null : this.local(event); this.positionEraserCursor();
    if (this.lasso?.pointerId === event.pointerId) {
      const point = this.sample(event);
      if (distance(point, this.lasso.points[this.lasso.points.length - 1]) >= 2 / this.zoom) this.lasso.points.push(point);
      this.scheduleRedraw(); return;
    }
    if (this.drag?.pointerId === event.pointerId) {
      const point = this.sample(event), drag = this.drag;
      const current = this.document; this.document = drag.before;
      const box = this.selectionBox()!; this.document = current;
      const dx = clamp(point.x - drag.origin.x, -box.left, PAGE_WIDTH-box.right);
      const dy = clamp(point.y - drag.origin.y, -box.top, PAGE_HEIGHT-box.bottom);
      if (dx === drag.dx && dy === drag.dy) return;
      drag.dx = dx; drag.dy = dy;
      this.document = { ...drag.before, strokes: drag.before.strokes.map(stroke => this.selected.has(stroke.id) ? { ...stroke, points: stroke.points.map(p => ({ ...p, x: p.x+dx, y: p.y+dy })) } : stroke) };
      this.scheduleRedraw(); return;
    }
    if (this.active?.pointerId === event.pointerId) {
      if (this.touches.has(event.pointerId)) this.touches.set(event.pointerId, this.local(event));
      let samples: PointerEvent[] = [];
      try { samples = event.getCoalescedEvents?.() ?? []; } catch { /* Older WebKit may expose an unsupported method. */ }
      if (!samples.length) samples = [event];
      const stroke = this.active.stroke;
      const rect = this.host.getBoundingClientRect();
      this.clipped(this.liveContext, () => {
        for (const sample of samples) {
          const previous = stroke.points[stroke.points.length - 1];
          const point = this.sample(sample, rect);
          if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.time < previous.time || distance(previous, point) < 0.1) continue;
          // Stabilize pressure without delaying the spatial Pencil samples.
          point.pressure = previous.pressure * 0.35 + point.pressure * 0.65;
          stroke.points.push(point); this.drawSegment(this.liveContext, stroke, point, previous);
        }
      });
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
    if (advance) this.options.onPageAdvance?.();
  };
  private pointerCancel = (event: PointerEvent): void => {
    if (this.pagePull?.pointerId === event.pointerId) this.cancelPagePull();
    if (this.lasso?.pointerId === event.pointerId || this.drag?.pointerId === event.pointerId) this.finishSelection(true);
    // Keep the real samples received before an OS interruption; no predicted points are persisted.
    if (this.active?.pointerId === event.pointerId) this.finishActive();
    if (this.erase?.pointerId === event.pointerId) this.finishErase();
    this.touches.delete(event.pointerId);
    if (this.pan?.pointerId === event.pointerId) this.pan = null;
  };
  private finishActive(convertShape = false): void {
    if (!this.active) return;
    let stroke = this.active.stroke; this.active = null;
    const shape = convertShape && this.tool === 'shape' ? recognizeShape(stroke.points) : null;
    if (shape) { stroke = { ...stroke, points: shape }; this.clear(this.liveContext); this.drawStroke(this.liveContext, stroke); }
    this.undoStack.push(this.document); if (this.undoStack.length > 100) this.undoStack.shift(); this.redoStack = [];
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
    this.undoStack.push(before); if (this.undoStack.length > 100) this.undoStack.shift(); this.redoStack = [];
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
    // A scroll that merely reaches the end cannot add a page through momentum.
    // Start a fresh, mostly vertical scroll at the bottom; a pause acts as release.
    if(Math.abs(dx)>=Math.abs(dy)||Math.abs(dy)>500)pull.eligible=false;
    if(pull.eligible) {
      pull.distance=Math.max(0,pull.distance+Math.max(-60,Math.min(60,dy)));
      if(dy>0)pull.samples++;
      this.setPagePullProgress(clamp(pull.distance/180,0,1));
    }
    if(!pull.eligible)this.setPagePullProgress(0);
    this.fitMode='manual';this.offset.x-=dx;this.offset.y-=dy;this.viewportChanged();
    clearTimeout(this.wheelPullTimer);
    this.wheelPullTimer=setTimeout(()=>{
      const advance=pull.eligible && pull.samples>=3 && this.pagePullProgress>=1 && !this.disposed;
      this.cancelPagePull();
      if(advance){this.wheelCooldown=Date.now()+500;this.options.onPageAdvance?.();}
    },220);
  };

  exportSvg(): string {
    this.finishActive(); this.finishErase();
    const n = (value: number) => Number(value.toFixed(2));
    const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_WIDTH}" height="${PAGE_HEIGHT}" viewBox="0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}">`,
      '<defs><clipPath id="page"><rect width="1400" height="1900"/></clipPath></defs><rect width="1400" height="1900" fill="#faf9ef"/>'];
    if (this.document.paper === 'dots') {
      parts.push('<g fill="#cbd2cc">');
      for (let y = 40; y < PAGE_HEIGHT; y += 40) for (let x = 40; x < PAGE_WIDTH; x += 40) parts.push(`<circle cx="${x}" cy="${y}" r="1.4"/>`);
      parts.push('</g>');
    } else if (this.document.paper === 'grid' || this.document.paper === 'ruled') {
      parts.push('<g stroke="#d8dcd8" stroke-width="1">');
      for (let y = this.document.paper === 'ruled' ? 100 : 40; y < PAGE_HEIGHT; y += 40) parts.push(`<path d="M0 ${y}H${PAGE_WIDTH}"/>`);
      if (this.document.paper === 'grid') for (let x = 40; x < PAGE_WIDTH; x += 40) parts.push(`<path d="M${x} 0V${PAGE_HEIGHT}"/>`);
      parts.push('</g>');
    }
    parts.push('<g clip-path="url(#page)">');
    for (const stroke of this.document.strokes) {
      // Only validated six-digit colors enter the SVG attribute.
      const color = /^#[0-9a-f]{6}$/i.test(stroke.color) ? stroke.color : '#243247';
      parts.push(`<g fill="${color}" opacity="${stroke.tool === 'highlighter' ? 0.28 : 1}">`);
      for (let index = 0; index < stroke.points.length; index++) {
        const point = stroke.points[index]; const r = radius(stroke, point);
        parts.push(`<circle cx="${n(point.x)}" cy="${n(point.y)}" r="${n(r)}"/>`);
        if (!index) continue;
        const previous = stroke.points[index - 1]; const length = distance(previous, point); if (length < 0.001) continue;
        const pr = radius(stroke, previous), nx = -(point.y - previous.y) / length, ny = (point.x - previous.x) / length;
        parts.push(`<path d="M${n(previous.x + nx * pr)} ${n(previous.y + ny * pr)}L${n(point.x + nx * r)} ${n(point.y + ny * r)}L${n(point.x - nx * r)} ${n(point.y - ny * r)}L${n(previous.x - nx * pr)} ${n(previous.y - ny * pr)}Z"/>`);
      }
      parts.push('</g>');
    }
    parts.push('</g></svg>'); return parts.join('');
  }

  destroy(): void {
    this.cancelPagePull();
    this.finishActive(); this.finishErase(); this.finishSelection(); this.disposed = true;
    this.abort.abort(); this.observer.disconnect(); if (this.frame) cancelAnimationFrame(this.frame);
    this.base.remove(); this.live.remove(); this.eraserCursor.remove(); this.histories.clear(); this.searchLayer.replaceChildren(); this.searchLayer.remove(); this.searchHighlights = []; this.searchHighlightIndices = [];
    for (const canvas of [this.base, this.live, this.scratch]) canvas.width = canvas.height = 1;
    this.touches.clear();
  }
}
