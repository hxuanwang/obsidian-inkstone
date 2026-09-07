import { DEFAULT_SETTINGS, type InkstoneSettings, type PencilAction } from './settings';
import { TextLayer, appendTextToSvg } from './text-layer';
import { InkEngine } from './ink-engine';
import { NoteIndex } from './search';
import { appendHighlightedText, matchingWordBoxes, matchSnippet, findMatchRanges } from './search-highlights';
import { inkSignature } from './ink-signature';
import type { RecognitionResult } from './recognition';
import { createPage, MAX_PAGES, MAX_TEXT_LENGTH, type InkDocument, type InkPage, type Paper } from './model';

type Tool = 'pen' | 'highlighter' | 'eraser' | 'hand' | 'lasso' | 'shape' | 'text';
export interface EditorOptions {
  settings?: InkstoneSettings;
  onSettingsChange?: (patch: Partial<InkstoneSettings>) => void;
  onMarkdown?: (doc: InkDocument) => void;
  onAI?: (page: InkPage, svg: string) => Promise<void>;
  document: InkDocument;
  title: string;
  onChange: (doc: InkDocument) => void;
  onExport: (svg: string) => void;
  onRename?: (title: string) => void;
  onNew?: () => void;
  initialPageId?: string;
  onSearch?: () => void;
  onRecognize?: (page: InkPage) => Promise<RecognitionResult>;
}
const paths: Record<string, string> = {
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  list: '<path d="M8 5h13M8 12h13M8 19h13M3 5h.01M3 12h.01M3 19h.01"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  lasso: '<path d="M5 17c-6-5-3-13 7-13s14 9 6 13-15 3-13-1 7-1 4 5"/>',
  shape: '<path d="M3 3h11v11H3Z"/><circle cx="16" cy="16" r="6"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  text: '<path d="M4 5h16M12 5v15M7 20h10"/>',
  nib: '<path d="m16 3 5 5-9 12-8 1 1-8Z"/><path d="m16 3-1 7 6-2M4 21l7-7"/><circle cx="12" cy="13" r="1"/>',
  pen: '<path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14Z"/><path d="m4 14 5 5"/>',
  highlighter: '<path d="m14 3 7 7-9 9-7-7ZM5 12l-3 7 3 3 7-3M2 22h12"/>',
  eraser: '<path d="m14 3 7 7a2 2 0 0 1 0 3l-8 8H7l-5-5a2 2 0 0 1 0-3L11 3a2 2 0 0 1 3 0ZM7 8l10 10M13 21h9"/>',
  hand: '<path d="M8 12V5a2 2 0 0 1 4 0v7-8a2 2 0 0 1 4 0v8-6a2 2 0 0 1 4 0v10c0 4-3 6-7 6h-1c-3 0-5-2-6-4l-3-5a2 2 0 0 1 3-2l2 3"/>',
  undo: '<path d="M8 4 3 9l5 5M3 9h11a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="m16 4 5 5-5 5M21 9H10a6 6 0 0 0 0 12h3"/>',
  export: '<path d="M12 16V3m-5 5 5-5 5 5M4 14v6a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  fit: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  page: '<path d="M14 2H5a1 1 0 0 0-1 1v18a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V8Zm0 0v6h6M8 13h8M8 17h8"/>',
};
function icon(name: string): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.65'); svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = paths[name] || paths.pen;
  return svg;
}
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = className;
  if (text) node.textContent = text; return node;
}
export class InkEditor {
  private pageControls!: HTMLElement;
  private textLayer!: TextLayer;
  private pagePullHint!: HTMLElement;
  private pagePullLabel!: HTMLElement;
  private pagePullRing!: HTMLElement;
  private pageFilter!: HTMLSelectElement;
  private pageMenu!: HTMLDetailsElement;
  private textUndo: InkPage['textBoxes'][] = [];
  private textRedo: InkPage['textBoxes'][] = [];
  private lastTextEdit = 0;
  private root: HTMLElement;
  private engine: InkEngine;
  private titleEl: HTMLElement;
  private counter: HTMLElement;
  private hint: HTMLElement;
  private undoButton: HTMLButtonElement;
  private redoButton: HTMLButtonElement;
  private paperSelect: HTMLSelectElement;
  private toolButtons = new Map<Tool, HTMLButtonElement>();
  private selectedTool: Tool = 'pen';
  private previousTool: Tool = 'highlighter';
  private writingTool: Tool = 'pen';
  private pencilPalette!: HTMLElement;
  private eraserSelect!: HTMLSelectElement;
  private color = '#243c34';
  private toolColors = {pen: '#243c34', highlighter: '#e7bb4b'};
  private swatches: HTMLButtonElement[] = [];
  private sizePresets!: HTMLElement;
  private toolLabel!: HTMLElement;
  private pageCount!: HTMLElement;
  private pagePosition!: HTMLElement;
  private pagesToggle!: HTMLButtonElement;
  private notesToggle!: HTMLButtonElement;
  private sizeSelect: HTMLSelectElement;
  private sizeSlider!: HTMLInputElement;
  private floatingPalette!: HTMLElement;
  private recognitionTimer?: ReturnType<typeof setTimeout>;
  private pendingOCR = new Set<string>();
  private widths = {pen: 3, highlighter: 22, eraser: 20, hand: 3, lasso: 3, shape: 3, text: 28};
  private cleanup: (() => void)[] = [];

  private document: InkDocument;
  private activePageId: string;
  private pageList!: HTMLElement;
  private sidebar!: HTMLElement;
  private notesPanel!: HTMLElement;
  private typedText!: HTMLTextAreaElement;
  private transcript!: HTMLTextAreaElement;
  private pageTitle!: HTMLInputElement;
  private searchInput!: HTMLInputElement;
  private recognitionStatus!: HTMLElement;
  private recognizeButton!: HTMLButtonElement;
  private selectionActions!: HTMLElement;
  private lifecycle = 0;
  private disposed = false;
  private recognitionBusy = false;
  private sidebarTitle!: HTMLElement;
  private searchNavigation!: HTMLElement;
  private searchHint!: HTMLElement;
  private textMatches!: HTMLElement;
  private searchMode = false;
  private notebookIndex = new NoteIndex();
  private signatureCache = new WeakMap<InkPage['strokes'], string>();
  private thumbnailCache = new Map<string, {strokes: InkPage["strokes"]; textBoxes: InkPage["textBoxes"]; node: SVGSVGElement}>();
  private pagesTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(host: HTMLElement, private options: EditorOptions) {
    this.document = options.document;
    this.activePageId = options.document.pages.find(page => page.id === options.initialPageId)?.id ?? options.document.pages[0].id;
    this.root = el('section', 'inkstone-editor');
    this.root.dataset.toolbarSize = options.settings?.toolbarSize ?? 'system';
    this.root.setAttribute('aria-label', 'Inkstone handwriting editor');
    const header = el('header', 'inkstone-header');
    const navigation = el('div', 'inkstone-navigation');
    this.pagesToggle = this.button('page', 'Show pages', () => { if(this.searchMode) { this.setSearchQuery(''); this.togglePages(true); } else this.togglePages(); });
    this.pagesToggle.setAttribute('aria-pressed', String(this.root.classList.contains('inkstone-pages-open')));
    navigation.append(this.pagesToggle, this.button('search', 'Search notes', () => {
      this.searchMode = true; this.root.classList.add('inkstone-search-mode'); this.sidebarTitle.textContent = 'Search'; this.togglePages(true); this.searchInput.focus(); this.renderPages();
    }));
    const actions = el('div', 'inkstone-header-actions');
    this.notesToggle = this.button('list', 'Show typed notes and transcript', () => {
      const open = this.root.classList.toggle('inkstone-notes-open'); this.notesToggle.setAttribute('aria-pressed', String(open));
    });
    this.notesToggle.setAttribute('aria-pressed', 'false');
    actions.append(this.button('plus', 'Add page', () => this.addPage()), this.button('export', 'Export note as SVG', () => options.onExport(appendTextToSvg(this.engine.exportSvg(),this.getActivePage().textBoxes))));
    this.pageMenu = el('details', 'inkstone-more'); const summary = el('summary', 'inkstone-button');
    summary.setAttribute('aria-label', 'Page actions'); summary.append(icon('more'));
    this.pageMenu.append(summary, el('div','inkstone-more-menu'));
    this.pageMenu.addEventListener('toggle',()=>{if(this.pageMenu.open)this.renderPageMenu();});
    this.pageMenu.addEventListener('keydown',event=>{if(event.key==='Escape'){this.pageMenu.open=false;summary.focus();}});
    actions.append(this.pageMenu);
    this.titleEl = el('h2', 'inkstone-title', options.title);
    header.append(navigation, actions);

    const workspace = el('div', 'inkstone-workspace');
    const toolbar = this.floatingPalette = el('div', 'inkstone-toolbar'); toolbar.setAttribute('role', 'group'); toolbar.setAttribute('aria-label', 'Tool settings');
    const history = el('div', 'inkstone-tool-group');
    this.undoButton = this.button('undo', 'Undo (⌘Z)', () => this.undo());
    this.redoButton = this.button('redo', 'Redo (⇧⌘Z)', () => this.redo());
    history.append(this.undoButton, this.redoButton);
    const tools = el('div', 'inkstone-primary-tools'); tools.setAttribute('role', 'group'); tools.setAttribute('aria-label', 'Writing tools');
    for (const [tool, label] of [['pen', 'Pen'], ['highlighter', 'Highlighter'], ['eraser', 'Eraser'], ['lasso', 'Lasso selection'], ['shape', 'Shape recognition'], ['hand', 'Move page'], ['text', 'Text tool']] as const) {
      const button = this.button(tool, label, () => this.selectTool(tool));
      button.setAttribute('aria-pressed', String(tool === 'pen'));
      button.dataset.tool = tool; this.toolButtons.set(tool, button); tools.append(button);
    }
    const colors = el('div', 'inkstone-tool-group inkstone-colors');
    const palette = [['#243c34', 'Forest'], ['#1e2025', 'Black'], ['#1976ee', 'Blue'], ['#df332e', 'Red'], ['#e7bb4b', 'Ochre']];
    for (const [color, name] of palette) {
      const button = el('button', 'inkstone-swatch'); button.type = 'button';
      button.title = name; button.setAttribute('aria-label', `${name} ink`);
      button.setAttribute('aria-pressed', String(color === this.color));
      button.style.setProperty('--swatch', color); button.dataset.color = color;
      button.addEventListener('click', () => {
        if (this.selectedTool === 'hand' || this.selectedTool === 'eraser' || this.selectedTool === 'lasso') this.selectTool('pen');
        this.color = color; this.toolColors[this.selectedTool === 'highlighter' ? 'highlighter' : 'pen'] = color;
        this.engine.setColor(color); this.updateColors();
      });
      this.swatches.push(button); colors.append(button);
    }
    const custom = el('label', 'inkstone-custom-color'); custom.title = 'Custom ink color'; custom.append(icon('plus'));
    const colorInput = el('input', ''); colorInput.type = 'color'; colorInput.value = this.color; colorInput.setAttribute('aria-label', 'Custom ink color');
    colorInput.addEventListener('input', () => { if (['hand','eraser','lasso'].includes(this.selectedTool)) this.selectTool('pen'); this.color = colorInput.value; this.toolColors[this.selectedTool === 'highlighter' ? 'highlighter' : 'pen'] = this.color; this.engine.setColor(this.color); this.updateColors(); }); custom.append(colorInput); colors.append(custom);
    const weight = el('label', 'inkstone-weight'); weight.append(el('span', '', 'Size'));
    this.sizeSelect = el('select', 'inkstone-select'); this.sizeSelect.setAttribute('aria-label', 'Stroke size');
    this.sizeSelect.addEventListener('change', () => {
      this.widths[this.selectedTool] = Number(this.sizeSelect.value); this.engine.setWidth(Number(this.sizeSelect.value)); this.updateSizes();
    }); weight.append(this.sizeSelect);
    this.toolLabel = el('span', 'inkstone-current-tool', 'Pen');
    const currentTool = el('div', 'inkstone-tool-caption'); currentTool.append(icon('nib'), this.toolLabel);
    this.sizePresets = el('div', 'inkstone-size-presets'); this.sizePresets.setAttribute('role', 'group'); this.sizePresets.setAttribute('aria-label', 'Quick stroke sizes');
    this.eraserSelect = el('select', 'inkstone-select'); this.eraserSelect.setAttribute('aria-label', 'Eraser mode');
    for(const [value,label] of [['object','Object eraser'],['pixel','Pixel eraser']]) {const option=el('option','',label);option.value=value;this.eraserSelect.append(option);}
    this.eraserSelect.value=options.settings?.eraserMode ?? 'object'; this.eraserSelect.hidden=true;
    this.eraserSelect.addEventListener('change',()=>{const mode=this.eraserSelect.value as 'pixel'|'object';this.engine.setEraserMode(mode);options.onSettingsChange?.({eraserMode:mode});});
    this.sizeSlider = el('input', 'inkstone-size-slider'); this.sizeSlider.type = 'range';
    this.sizeSlider.setAttribute('aria-label', 'Tool size');
    this.sizeSlider.addEventListener('input', () => {
      this.widths[this.selectedTool] = Number(this.sizeSlider.value);
      this.engine.setWidth(this.widths[this.selectedTool]); this.updateSizes();
    });
    toolbar.append(currentTool, this.eraserSelect, this.sizePresets, colors, weight, this.sizeSlider);
    tools.append(this.notesToggle); navigation.append(history); header.insertBefore(tools, actions);
    const surface = el('div', 'inkstone-surface'); surface.tabIndex = 0;
    surface.setAttribute('aria-label', 'Handwriting canvas. Use Apple Pencil or mouse to write; fingers move and zoom the page.');
    this.selectionActions = el('div', 'inkstone-selection-actions'); this.selectionActions.hidden = true;
    this.selectionActions.append(this.button('plus', 'Duplicate selection', () => this.engine.duplicateSelection(), 'Duplicate'),
      this.button('eraser', 'Delete selection', () => this.engine.deleteSelection(), 'Delete'),
      this.button('lasso', 'Clear selection', () => this.engine.clearSelection(), 'Deselect'));
    this.pagePullHint = el('div', 'inkstone-page-pull'); this.pagePullHint.hidden = true;
    this.pagePullLabel=el('span','inkstone-pull-label','Pull to add page');this.pagePullLabel.setAttribute('role','status');
    this.pagePullRing=el('div','inkstone-pull-ring');this.pagePullRing.setAttribute('role','progressbar');this.pagePullRing.setAttribute('aria-label','Pull to add page');this.pagePullRing.setAttribute('aria-valuemin','0');this.pagePullRing.setAttribute('aria-valuemax','100');
    this.pagePullRing.append(icon('plus'));
    const preview=el('div','inkstone-pull-preview');preview.setAttribute('aria-hidden','true');
    this.pagePullHint.append(el('span','inkstone-pull-arrow','↑'),this.pagePullRing,this.pagePullLabel,preview);
    const exitFocus=this.button('close','Exit focus mode',()=>this.root.classList.remove('inkstone-focus-mode'),'Exit focus');exitFocus.classList.add('inkstone-exit-focus');
    this.pencilPalette=el('div','inkstone-pencil-palette');this.pencilPalette.hidden=true;this.pencilPalette.setAttribute('role','dialog');this.pencilPalette.setAttribute('aria-label','Tool palette');
    for(const [tool,label] of [['pen','Pen'],['highlighter','Highlighter'],['eraser','Eraser'],['lasso','Lasso'],['shape','Shapes'],['hand','Move'],['text','Text']] as const)this.pencilPalette.append(this.button(tool,label,()=>{this.selectTool(tool);this.pencilPalette.hidden=true;surface.focus();},label));
    this.pencilPalette.append(this.button('close','Close tool palette',()=>{this.pencilPalette.hidden=true;surface.focus();}));
    workspace.append(surface, toolbar, this.selectionActions, this.pagePullHint,exitFocus,this.pencilPalette);

    const footer = el('footer', 'inkstone-footer');
    const left = el('div', 'inkstone-footer-group');
    const paperLabel = el('label', 'inkstone-paper-picker'); paperLabel.append(icon('page'));
    this.paperSelect = el('select', 'inkstone-select'); this.paperSelect.setAttribute('aria-label', 'Paper style');
    for (const [value, label] of [['dots', 'Dotted paper'], ['ruled', 'Ruled paper'], ['grid', 'Grid paper'], ['blank', 'Blank paper']]) {
      const option = el('option', '', label); option.value = value; this.paperSelect.append(option);
    }
    this.paperSelect.value = this.getActivePage().paper;
    this.paperSelect.addEventListener('change', () => this.engine.setPaper(this.paperSelect.value as Paper));
    paperLabel.append(this.paperSelect); left.append(paperLabel);
    this.counter = el('span', 'inkstone-counter'); left.append(this.counter);
    this.hint = el('span', 'inkstone-hint', 'Pencil writes. Fingers move.');
    const right = el('div', 'inkstone-footer-group');
    const finger = this.button('nib', 'Toggle finger drawing', () => {
      const enabled = finger.getAttribute('aria-pressed') !== 'true';
      finger.setAttribute('aria-pressed', String(enabled)); this.engine.setFingerDrawing(enabled);
      finger.title = enabled ? 'Finger drawing on; use two fingers to move' : 'Pencil only; fingers move';
      this.hint.textContent = enabled ? 'One finger writes. Two fingers move.' : 'Pencil writes. Fingers move.';
    });
    finger.setAttribute('aria-pressed', 'false'); finger.classList.add('inkstone-finger-toggle');
    const zoom = el('button', 'inkstone-zoom', '100%'); zoom.type = 'button'; zoom.title = 'Fit page width'; zoom.setAttribute('aria-label', 'Fit page width'); zoom.addEventListener('click', () => this.engine.fitWidth());
    right.append(finger, this.button('minus', 'Zoom out', () => this.engine.zoomBy(1 / 1.2)), zoom,
      this.button('plus', 'Zoom in', () => this.engine.zoomBy(1.2)), this.button('fit', 'Fit page', () => this.engine.fit()));
    const caption = el('div', 'inkstone-document-caption'); this.pagePosition = el('span', 'inkstone-page-position'); caption.append(this.titleEl, this.pagePosition);
    footer.append(left, caption, right);
    const body = el('div', 'inkstone-body');
    this.buildSidebar(); this.buildNotesPanel();
    body.append(this.sidebar, workspace, this.notesPanel);
    // Keep navigation and tools in one fixed row; secondary page controls live in the menu.
    footer.classList.add('inkstone-page-controls-menu');
    this.root.append(header, body); host.append(this.root);
    this.pageControls = footer;
    this.engine = new InkEngine(surface, {
      document: this.getActivePage(),
      onChange: page => {
        const current = this.document.pages.find(item => item.id === page.id);
        if (!current) return;
        if (current.strokes !== page.strokes && current.transcript) this.recognitionStatus.textContent = 'Ink changed. The saved transcript may need updating.';
        const merged = { ...current, paper: page.paper, strokes: page.strokes, recognition: current.strokes === page.strokes ? current.recognition : undefined };
        if (current.strokes !== page.strokes) this.engine.setSearchHighlights([]);
        this.document = { ...this.document, pages: this.document.pages.map(item => item.id === page.id ? merged : item) };
        this.updateState(merged); this.emitChange(); this.schedulePages();
        if (current.strokes !== page.strokes) this.scheduleRecognition(page.id);
      },
      onActivePageChange: page => {
        this.activePageId = page.id;
        this.syncPageFields(); this.updateState(this.getActivePage()); this.schedulePages(); this.updateSearchHighlights();
      },
      onSelectionChange: count => { this.selectionActions.hidden = count === 0; },
      onViewportChange: scale => { zoom.textContent = `${Math.round(scale * 100)}%`; this.textLayer?.position(); },
      onPagePull: progress => {
        this.pagePullHint.hidden = progress === 0;
        const label=this.document.pages.length>=MAX_PAGES ? '500-page limit reached' : progress>=1 ? 'Release to add page' : 'Pull to add page';
        if(this.pagePullLabel.textContent!==label)this.pagePullLabel.textContent=label;
        this.pagePullRing.setAttribute('aria-valuenow',String(Math.round(progress*100)));
        this.pagePullRing.setAttribute('aria-label','Pull to add page');
        this.pagePullHint.dataset.paper=this.document.pages.at(-1)!.paper;
        this.pagePullHint.dataset.ready=String(progress>=1);
        this.pagePullHint.style.setProperty('--pull',String(progress));
        const lift=Math.min(240,surface.clientHeight*.45)*progress;
        surface.style.setProperty('--ink-pull-lift',`${-lift}px`);
        this.pagePullHint.style.height=`${lift+28}px`;
        const viewport=this.engine?.getViewport();
        if(viewport)this.pagePullHint.style.width=`${Math.min(surface.clientWidth-32,1400*viewport.zoom)}px`;
      },
      onPageAdvance: () => this.addPage(false, false, true),
    });
    this.textLayer = new TextLayer(surface,()=>this.engine.getViewport(),boxes=>{
      const now=Date.now();
      if(now-this.lastTextEdit>700 || boxes.length!==(this.getActivePage().textBoxes??[]).length) {
        this.textUndo.push(this.getActivePage().textBoxes); if(this.textUndo.length>50)this.textUndo.shift();
      }
      this.lastTextEdit=now;this.textRedo=[];
      this.updatePage({textBoxes:boxes});this.updateState(this.getActivePage());
    },()=>this.color);
    this.engine.setPages(this.document.pages);
    this.engine.setColor(this.color); this.engine.setWidth(this.widths.pen);
    this.engine.setEraserMode(options.settings?.eraserMode ?? 'object');
    this.updateSizes(); this.updateState(this.getActivePage()); this.syncPageFields(); this.renderPages();
    this.applySettings(options.settings ?? DEFAULT_SETTINGS);
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || (event.target as HTMLElement).isContentEditable) return;
      if (!event.metaKey && !event.ctrlKey && !event.altKey) {
        const tool = ({p:'pen',h:'highlighter',e:'eraser',l:'lasso',v:'hand',t:'text',s:'shape'} as Record<string,Tool>)[event.key.toLowerCase()];
        if(tool){event.preventDefault();this.selectTool(tool);}
        if(event.key==='Tab' && event.target===surface){event.preventDefault();this.root.classList.toggle('inkstone-focus-mode');}
        if(event.key==='Escape'){this.pencilPalette.hidden=true;this.root.classList.remove('inkstone-focus-mode');this.engine.clearSelection();}
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault(); event.stopPropagation(); event.shiftKey ? this.redo() : this.undo();
      }
    };
    const onVisible = () => { if (!document.hidden) this.scheduleRecognition(); };
    document.addEventListener('visibilitychange', onVisible); this.cleanup.push(() => document.removeEventListener('visibilitychange', onVisible));
    this.root.addEventListener('keydown', onKey); this.cleanup.push(() => this.root.removeEventListener('keydown', onKey));
  }
  private button(name: string, label: string, action: () => void, text?: string): HTMLButtonElement {
    const b = el('button', 'inkstone-button'); b.type = 'button'; b.title = label; b.setAttribute('aria-label', label); b.append(icon(name));
    if (text) b.append(el('span', '', text)); b.addEventListener('click', action); return b;
  }
  private selectTool(tool: Tool): void {
    if(tool!==this.selectedTool)this.previousTool=this.selectedTool;
    if(tool!=='eraser')this.writingTool=tool;
    this.eraserSelect.hidden=tool!=='eraser';
    this.floatingPalette.hidden=['hand','lasso'].includes(tool);
    this.floatingPalette.dataset.tool=tool;
    this.selectedTool = tool; this.engine.setTool(tool === 'text' ? 'hand' : tool); this.textLayer.setEnabled(tool==='text');this.root.classList.toggle('inkstone-text-tool',tool==='text');
    this.hint.textContent=tool==='text'?'Tap the page to type. Drag Move to position text.':tool==='shape'?'Draw one shape, then lift to straighten.':'Pencil writes. Fingers move.';
    if (tool === 'pen' || tool === 'highlighter' || tool === 'shape') { this.color = this.toolColors[tool === 'highlighter' ? 'highlighter' : 'pen']; this.engine.setColor(this.color); }
    this.engine.setWidth(this.widths[tool]);
    for (const [key, button] of this.toolButtons) button.setAttribute('aria-pressed', String(tool === key));
    this.toolLabel.textContent = ({pen:'Pen',highlighter:'Highlighter',eraser:'Eraser',hand:'Move',lasso:'Lasso',shape:'Shapes',text:'Text'})[tool];
    this.updateColors(); this.updateSizes(); this.updateState(this.getActivePage());
  }
  applySettings(settings: InkstoneSettings): void {
    this.options.settings = settings;
    this.root.dataset.toolbarSize=settings.toolbarSize;
    this.typedText.spellcheck = settings.spellcheck; this.transcript.spellcheck = settings.spellcheck;
    this.textLayer.setSpellcheck(settings.spellcheck);
    if (!settings.realTimeOCR) { clearTimeout(this.recognitionTimer); this.pendingOCR.clear(); }
    this.eraserSelect.value=settings.eraserMode;this.engine.setEraserMode(settings.eraserMode);
  }
  performPencilAction(action: PencilAction): void {
    if(action==='eraser')this.selectTool(this.selectedTool==='eraser'?this.writingTool:'eraser');
    else if(action==='previous')this.selectTool(this.previousTool);
    else if(action==='undo')this.undo();
    else if(action==='palette') {this.pencilPalette.hidden=!this.pencilPalette.hidden;if(!this.pencilPalette.hidden)this.pencilPalette.querySelector<HTMLElement>('button')?.focus();}
  }
  private updateSizes(): void {
    this.sizeSelect.replaceChildren();
    const eraser = this.selectedTool === 'eraser';
    this.sizeSlider.hidden = ['hand','lasso','text'].includes(this.selectedTool);
    this.sizeSlider.min = eraser ? '4' : '1'; this.sizeSlider.max = eraser ? '100' : this.selectedTool === 'highlighter' ? '60' : '12';
    this.sizeSlider.step = eraser ? '1' : '.5'; this.sizeSlider.value = String(this.widths[this.selectedTool]);
    this.sizeSlider.setAttribute('aria-valuetext', `${this.widths[this.selectedTool]} px${eraser ? ' diameter' : ''}`);
    const choices = this.selectedTool === 'highlighter' ? [12, 22, 34] : this.selectedTool === 'eraser' ? [12, 20, 36] : [1.5, 3, 5, 8];
    for (const value of choices) { const option = el('option', '', `${value} px`); option.value = String(value); this.sizeSelect.append(option); }
    if (!choices.includes(this.widths[this.selectedTool])) {
      const option = el('option', '', `${this.widths[this.selectedTool]} px`); option.value = String(this.widths[this.selectedTool]); this.sizeSelect.append(option);
    }
    this.sizePresets.replaceChildren();
    for (const value of choices.slice(0, 3)) {
      const button = el('button', 'inkstone-size-preset'); button.type = 'button'; button.setAttribute('aria-label', `${eraser ? 'Eraser diameter' : 'Stroke size'} ${value} px`); button.setAttribute('aria-pressed', String(value === this.widths[this.selectedTool]));
      button.disabled = ['hand','lasso','text'].includes(this.selectedTool); const line = el('span', ''); line.style.height = `${Math.min(7, Math.max(1, value / (this.selectedTool === 'highlighter' ? 5 : 1)))}px`; if (eraser) { line.className='inkstone-eraser-size'; line.style.width=`${value}px`; line.style.height=`${value}px`; } button.append(line);
      button.addEventListener('click', () => { this.widths[this.selectedTool] = value; this.engine.setWidth(value); this.updateSizes(); }); this.sizePresets.append(button);
    }
    this.sizeSelect.value = String(this.widths[this.selectedTool]); this.sizeSelect.disabled = ['hand','lasso','text'].includes(this.selectedTool);
  }
  private updateColors(): void { for (const b of this.swatches) b.setAttribute('aria-pressed', String(b.dataset.color === this.color)); }
  private updateState(doc: InkPage): void {
    this.counter.textContent = `${doc.strokes.length} ${doc.strokes.length === 1 ? 'stroke' : 'strokes'}`;
    this.undoButton.disabled = this.selectedTool==='text' ? !this.textUndo.length : !this.engine.canUndo(); this.redoButton.disabled = this.selectedTool==='text' ? !this.textRedo.length : !this.engine.canRedo();
    this.paperSelect.value = doc.paper;
    this.pagePosition.textContent = `Page ${this.document.pages.findIndex(page => page.id === doc.id) + 1} of ${this.document.pages.length}`;
  }
  private emitChange(): void { this.engine?.setPages(this.document.pages); this.options.onChange(this.document); }
  private updatePage(patch: Partial<InkPage>): void {
    if ('transcript' in patch && !('recognition' in patch)) patch.recognition = undefined;
    this.document = { ...this.document, pages: this.document.pages.map(page => page.id === this.activePageId ? { ...page, ...patch } : page) };
    if ('transcript' in patch || 'text' in patch || 'textBoxes' in patch) this.updateSearchHighlights();
    this.emitChange(); this.schedulePages();
  }
  private togglePages(force?: boolean): void { const open = force ?? !this.root.classList.contains('inkstone-pages-open'); this.root.classList.toggle('inkstone-pages-open', open); this.pagesToggle.setAttribute('aria-pressed', String(open)); if (open) this.schedulePages(); else if (this.searchInput?.value) this.setSearchQuery(''); }
  private buildSidebar(): void {
    this.sidebar = el('aside', 'inkstone-sidebar'); this.sidebar.setAttribute('aria-label', 'Notebook pages');
    const heading = el('div', 'inkstone-sidebar-heading'); this.sidebarTitle = el('strong', '', 'Pages'); heading.append(this.sidebarTitle, this.button('close', 'Close pages', () => this.togglePages(false)));
    const views = el('div', 'inkstone-page-views'); views.setAttribute('role', 'group'); views.setAttribute('aria-label', 'Page display');
    const grid = this.button('grid', 'Thumbnail grid', () => { this.sidebar.classList.remove('inkstone-list-mode'); grid.setAttribute('aria-pressed','true'); list.setAttribute('aria-pressed','false'); });
    const list = this.button('list', 'Page list', () => { this.sidebar.classList.add('inkstone-list-mode'); grid.setAttribute('aria-pressed','false'); list.setAttribute('aria-pressed','true'); });
    grid.setAttribute('aria-pressed','true'); list.setAttribute('aria-pressed','false'); views.append(grid,list);
    this.pageCount = el('div', 'inkstone-pages-count');
    this.searchInput = el('input', 'inkstone-input'); this.searchInput.type = 'search'; this.searchInput.placeholder = 'Search this notebook';
    this.searchInput.setAttribute('aria-label', 'Search page titles, typed notes and transcripts'); this.searchInput.addEventListener('input', () => this.setSearchQuery(this.searchInput.value)); this.searchInput.addEventListener('keydown', event => { if (event.key === 'Enter') this.navigateSearch(1); if (event.key === 'Escape') this.setSearchQuery(''); });
    this.pageFilter=el('select','inkstone-select');this.pageFilter.setAttribute('aria-label','Filter pages');
    for(const [value,label] of [['all','All pages'],['favorite','Favorites'],['outline','Outline']]){const option=el('option','',label);option.value=value;this.pageFilter.append(option);}
    this.pageFilter.addEventListener('change',()=>this.renderPages());
    this.pageList = el('div', 'inkstone-page-list');
    this.pageTitle = el('input', 'inkstone-input'); this.pageTitle.maxLength = 500; this.pageTitle.setAttribute('aria-label', 'Page title');
    this.pageTitle.addEventListener('input', () => this.updatePage({ title: this.pageTitle.value }));
    const controls = el('div', 'inkstone-page-controls');
    controls.append(this.button('plus', 'Duplicate page', () => this.addPage(true), 'Duplicate'),
      this.button('undo', 'Move page earlier', () => this.movePage(-1)), this.button('redo', 'Move page later', () => this.movePage(1)),
      this.button('eraser', 'Delete page', () => this.confirmDeletePage()));
    const inspector = el('details', 'inkstone-page-inspector'); const summary = el('summary', '', 'Page options');
    inspector.append(summary, this.pageTitle, controls, el('p', 'inkstone-panel-hint', 'Ink undo history is retained per page while this notebook is open.'));
    this.searchNavigation = el('div', 'inkstone-search-navigation');
    this.searchHint = el('p','inkstone-panel-hint');
    this.searchNavigation.append(this.button('undo','Previous matching page',()=>this.navigateSearch(-1)), this.button('redo','Next matching page',()=>this.navigateSearch(1)));
    if (this.options.onSearch) this.searchNavigation.append(this.button('search','Search entire vault',()=>this.options.onSearch?.(),'Search vault'));
    this.sidebar.append(heading, views, this.pageFilter, this.searchInput, this.pageCount, this.pageList, this.searchNavigation, this.searchHint, inspector);
  }
  private buildNotesPanel(): void {
    this.notesPanel = el('aside', 'inkstone-notes-panel'); this.notesPanel.setAttribute('aria-label', 'Page text');
    const heading = el('div','inkstone-sidebar-heading'); heading.append(el('strong', '', 'Page text'), this.button('close','Close page text',()=> { this.root.classList.remove('inkstone-notes-open'); this.notesToggle.setAttribute('aria-pressed','false'); })); this.notesPanel.append(heading); this.textMatches = el('div','inkstone-text-matches'); this.textMatches.hidden = true; this.notesPanel.append(this.textMatches);
    const typedLabel = el('label', 'inkstone-text-label', 'Typed notes');
    this.typedText = el('textarea', 'inkstone-textarea'); this.typedText.spellcheck = true; this.typedText.maxLength = MAX_TEXT_LENGTH;
    this.typedText.placeholder = 'Type notes for this page…'; this.typedText.setAttribute('aria-label', 'Typed notes');
    this.typedText.addEventListener('input', () => this.updatePage({ text: this.typedText.value })); typedLabel.append(this.typedText);
    const transcriptLabel = el('label', 'inkstone-text-label', 'Handwriting transcript');
    this.transcript = el('textarea', 'inkstone-textarea'); this.transcript.spellcheck = true; this.transcript.maxLength = MAX_TEXT_LENGTH;
    this.transcript.placeholder = 'Recognize handwriting or enter a transcript…'; this.transcript.setAttribute('aria-label', 'Handwriting transcript');
    this.transcript.addEventListener('input', () => this.updatePage({ transcript: this.transcript.value })); transcriptLabel.append(this.transcript);
    this.recognizeButton = this.button('text', 'Recognize handwriting', () => { void this.recognize(); }, 'Recognize handwriting');
    this.recognizeButton.disabled = !this.options.onRecognize;
    this.recognitionStatus = el('p', 'inkstone-panel-hint'); this.recognitionStatus.setAttribute('role', 'status');
    this.recognitionStatus.textContent = this.options.onRecognize ? 'Recognition replaces the transcript. Review the result for accuracy.' : 'Handwriting recognition is available inside Obsidian when configured.';
    this.notesPanel.append(typedLabel, transcriptLabel, this.recognizeButton, this.recognitionStatus,
      el('p', 'inkstone-panel-hint', 'Your system checks spelling in these text fields. Raw handwritten strokes are not spellchecked.'));
  }
  private schedulePages(): void {
    if(!this.root.classList.contains('inkstone-pages-open'))return;
    if (this.pagesTimer) clearTimeout(this.pagesTimer);
    this.pagesTimer = setTimeout(() => { this.pagesTimer = undefined; if (this.disposed || !this.root.classList.contains('inkstone-pages-open')) return; if (this.engine.isInteracting()) { this.schedulePages(); return; } this.renderPages(); }, 500);
  }
  private renderPages(): void {
    if(!this.root.classList.contains('inkstone-pages-open'))return;
    this.pageList.replaceChildren(); this.pageCount.textContent = `All pages · ${this.document.pages.length}`;
    for (const key of this.thumbnailCache.keys()) if (!this.document.pages.some(page => page.id === key)) this.thumbnailCache.delete(key);
    const query = this.searchInput.value.trim();
    this.notebookIndex.ink('notebook', '', this.document);
    const hits = query ? new Map(this.notebookIndex.search(query, 500).map(hit=>[hit.pageId,hit])) : null;
    this.pageCount.textContent = query ? `${hits!.size} matching ${hits!.size === 1 ? 'page' : 'pages'}` : `All pages · ${this.document.pages.length}`;
    for (const [index, page] of this.document.pages.entries()) {
      if (hits && !hits.has(page.id)) continue;
      if(this.pageFilter.value==='favorite'&&!page.favorite || this.pageFilter.value==='outline'&&!page.outline)continue;
      const button = el('button', 'inkstone-page-card'); button.type = 'button'; button.setAttribute('aria-pressed', String(page.id === this.activePageId));
      button.setAttribute('aria-label', `Page ${index + 1}: ${page.title || 'Untitled page'}`);
      const cached = this.thumbnailCache.get(page.id);
      const preview = cached?.strokes === page.strokes && cached?.textBoxes === page.textBoxes ? cached.node : document.createElementNS('http://www.w3.org/2000/svg', 'svg'); preview.classList.add('inkstone-thumbnail'); preview.setAttribute('viewBox', '0 0 1400 1900'); preview.setAttribute('aria-hidden', 'true'); preview.dataset.paper = page.paper;
      if (cached?.strokes !== page.strokes || cached?.textBoxes !== page.textBoxes) for (const stroke of page.strokes.slice(-200)) {
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        const step = Math.max(1, Math.floor(stroke.points.length / 100));
        const points = stroke.points.filter((_, i) => i % step === 0 || i === stroke.points.length - 1);
        line.setAttribute('points', points.map(p => `${p.x},${p.y}`).join(' ')); line.setAttribute('fill', 'none'); line.setAttribute('stroke', stroke.color);
        line.setAttribute('stroke-width', String(Math.max(stroke.width, 8))); line.setAttribute('stroke-linecap', 'round');
        if (stroke.tool === 'highlighter') line.setAttribute('opacity', '.35'); preview.append(line);
      }
      if(cached?.strokes !== page.strokes || cached?.textBoxes !== page.textBoxes)for(const box of page.textBoxes??[]) {
        const text=document.createElementNS('http://www.w3.org/2000/svg','text');text.setAttribute('x',String(box.x+8));text.setAttribute('y',String(box.y+box.fontSize+8));text.setAttribute('font-size',String(box.fontSize));text.setAttribute('fill',box.color);text.textContent=box.text.split('\n')[0].slice(0,60);preview.append(text);
      }
      this.thumbnailCache.set(page.id, {strokes: page.strokes, textBoxes:page.textBoxes, node: preview});
      if (query) {
        button.classList.add('inkstone-search-card');
        const copy = el('span','inkstone-search-card-copy'); const title = el('strong','',`Page ${index+1}`);
        const snippet = el('span','inkstone-search-snippet'); appendHighlightedText(snippet, hits!.get(page.id)!.snippet || page.title, query);
        copy.append(title,snippet); button.append(copy,preview);
      } else { const caption = el('span','inkstone-page-card-caption'); caption.append(el('b','',String(index+1)), el('span','',`${page.favorite?'★ ':''}${page.outline?'§ ':''}${page.title || 'Untitled page'}`)); button.append(preview, caption); }
      button.addEventListener('click', () => { this.setActivePage(page.id); this.updateSearchHighlights(true); }); this.pageList.append(button);
    }
    const shown=this.pageList.childElementCount;
    this.pageCount.textContent=query?`${shown} matching ${shown===1?'page':'pages'}`:`${this.pageFilter.selectedOptions[0].textContent} · ${shown}`;
    if (!this.pageList.childElementCount) this.pageList.append(el('p', 'inkstone-panel-hint', 'No matching pages.'));
  }
  private addPage(duplicate = false, before = false, atEnd = false): void {
    if (this.document.pages.length >= MAX_PAGES) { this.recognitionStatus.textContent = 'This notebook has reached the 500-page limit.'; this.root.classList.add('inkstone-notes-open'); return; }
    this.engine.flush();
    const active = atEnd ? this.document.pages.at(-1)! : this.getActivePage();
    const page = duplicate ? { ...structuredClone(active), id: createPage().id, title: `${active.title} copy`.slice(0, 500) } : createPage(`Page ${this.document.pages.length + 1}`);
    if(!duplicate)page.paper=active.paper;
    const pages = [...this.document.pages]; pages.splice(pages.findIndex(item => item.id === active.id) + (before ? 0 : 1), 0, page);
    this.document = { ...this.document, pages }; this.emitChange(); this.pageFilter.value='all'; this.setSearchQuery(''); this.setActivePage(page.id);
  }
  private undo(): void {
    if(this.selectedTool!=='text'){this.engine.undo();return;}
    if(!this.textUndo.length)return;
    this.textRedo.push(this.getActivePage().textBoxes); this.updatePage({textBoxes:this.textUndo.pop()});
    this.textLayer.setBoxes(this.getActivePage().textBoxes);this.lastTextEdit=0;this.updateState(this.getActivePage());
  }
  private redo(): void {
    if(this.selectedTool!=='text'){this.engine.redo();return;}
    if(!this.textRedo.length)return;
    this.textUndo.push(this.getActivePage().textBoxes);this.updatePage({textBoxes:this.textRedo.pop()});
    this.textLayer.setBoxes(this.getActivePage().textBoxes);this.lastTextEdit=0;this.updateState(this.getActivePage());
  }
  private renderPageMenu(): void {
    const menu=this.pageMenu.querySelector('.inkstone-more-menu')!;menu.replaceChildren();
    const page=this.getActivePage(),index=this.document.pages.findIndex(p=>p.id===page.id);
    menu.append(el('strong','',`Page ${index+1} · ${page.title}`), this.pageControls);
    const action=(label:string,fn:()=>void)=>menu.append(this.button('page',label,()=>{this.pageMenu.open=false;fn();},label));
    action('Undo',()=>this.undo()); action('Redo',()=>this.redo());
    action('Focus writing (Tab)',()=>this.root.classList.add('inkstone-focus-mode'));
    if(this.options.onMarkdown)action('Export notebook as Markdown',()=>{this.engine.flush();this.options.onMarkdown?.(this.document);});
    if(this.options.onAI)action('Convert page to Markdown with AI…',()=>{this.engine.flush();void this.options.onAI?.(structuredClone(this.getActivePage()),appendTextToSvg(this.engine.exportSvg(),this.getActivePage().textBoxes));});
    action('Add page before',()=>this.addPage(false,true));action('Add page after',()=>this.addPage());
    action('Duplicate page',()=>this.addPage(true));
    action(page.favorite?'Remove from favorites':'Add to favorites',()=>{this.updatePage({favorite:!page.favorite});this.renderPages();});
    action(page.outline?'Remove from outline':'Add to outline',()=>{this.updatePage({outline:!page.outline});this.renderPages();});

    action('Export page as SVG',()=>this.options.onExport(appendTextToSvg(this.engine.exportSvg(),this.getActivePage().textBoxes)));
    const label=el('label','inkstone-go-page','Go to page');const input=el('input','inkstone-input');input.type='number';input.min='1';input.max=String(this.document.pages.length);input.value=String(index+1);input.setAttribute('aria-label','Page number');
    const go=this.button('redo','Go to page',()=>{const page=this.document.pages[Number(input.value)-1];if(page){this.pageMenu.open=false;this.setActivePage(page.id);}},'Go');label.append(input,go);menu.append(label);
    action('Delete page',()=>{this.togglePages(true);this.confirmDeletePage();});
    if(this.options.onNew)action('New notebook',()=>this.options.onNew?.());
  }
  private movePage(direction: number): void {
    const pages = [...this.document.pages]; const from = pages.findIndex(page => page.id === this.activePageId); const to = from + direction;
    if (to < 0 || to >= pages.length) return;
    [pages[from], pages[to]] = [pages[to], pages[from]]; this.document = { ...this.document, pages }; this.emitChange(); this.renderPages(); this.updateState(this.getActivePage());
  }
  private confirmDeletePage(): void {
    if (this.document.pages.length === 1 || this.sidebar.querySelector('.inkstone-delete-confirm')) return;
    const id = this.activePageId;
    const confirm = el('div', 'inkstone-delete-confirm'); confirm.setAttribute('role', 'alertdialog'); confirm.setAttribute('aria-label', 'Confirm page deletion');
    confirm.append(el('p', '', 'Delete this page and its ink and text? This cannot be undone.'),
      this.button('eraser', 'Confirm delete page', () => {
        confirm.remove(); this.engine.flush();
        const index = this.document.pages.findIndex(page => page.id === id); if (index < 0 || this.document.pages.length === 1) return;
        const pages = this.document.pages.filter(page => page.id !== id); this.document = { ...this.document, pages };
        if (this.activePageId === id) this.setActivePage(pages[Math.min(index, pages.length - 1)].id);
        this.emitChange(); this.renderPages();
      }, 'Delete page'), this.button('minus', 'Cancel page deletion', () => confirm.remove(), 'Cancel'));
    this.sidebar.append(confirm); (confirm.querySelector('button') as HTMLButtonElement).focus();
  }
  private syncPageFields(): void {
    const page = this.getActivePage(); this.pageTitle.value = page.title; this.typedText.value = page.text; this.transcript.value = page.transcript;
    this.selectionActions.hidden = true;
    this.textLayer?.setBoxes(page.textBoxes);this.textUndo=[];this.textRedo=[];this.lastTextEdit=0;
  }
  private scheduleRecognition(pageId?: string): void {
    if (!(this.options.settings?.realTimeOCR ?? true) || !this.options.onRecognize || this.disposed) return;
    if (pageId) this.pendingOCR.add(pageId);
    clearTimeout(this.recognitionTimer);
    if (!this.pendingOCR.size) return;
    this.recognitionTimer = setTimeout(() => {
      if (this.disposed) return;
      if (document.hidden) return;
      if (this.engine.isInteracting() || this.recognitionBusy) { this.scheduleRecognition(); return; }
      const id = this.pendingOCR.values().next().value!;
      this.pendingOCR.delete(id); void this.recognize(id, true);
    }, this.options.settings?.recognitionDelayMs ?? 1800);
  }
  private async recognize(pageId = this.activePageId, automatic = false): Promise<void> {
    if (!this.options.onRecognize || this.recognitionBusy) return;
    if (!automatic) this.engine.flush();
    const page = this.document.pages.find(page => page.id === pageId);
    if (!page || !page.strokes.length) { this.pendingOCR.delete(pageId); this.scheduleRecognition(); return; }
    if (automatic && page.recognition?.inkSignature === inkSignature(page.strokes)) {
      this.pendingOCR.delete(pageId); this.scheduleRecognition(); return;
    }
    this.pendingOCR.delete(pageId);
    const lifecycle = this.lifecycle, strokes = page.strokes, transcript = page.transcript;
    this.recognitionBusy = true; this.recognizeButton.disabled = true;
    this.recognitionStatus.textContent = 'Recognizing handwriting locally…';
    try {
      const result = await this.options.onRecognize(page);
      if (this.disposed || lifecycle !== this.lifecycle) return;
      const current = this.document.pages.find(page => page.id === pageId);
      if (!current || current.strokes !== strokes || current.transcript !== transcript) return;
      if (typeof result.text !== 'string' || result.text.length > MAX_TEXT_LENGTH) throw new Error('Recognition returned an invalid or oversized transcript.');
      if (!result.text.trim()) { this.recognitionStatus.textContent = 'No text recognized. Try AI conversion for cursive handwriting or equations.'; return; }
      const updated = {...current, transcript:result.text, recognition:{transcript:result.text, words:result.words, inkSignature:result.inkSignature}};
      this.document = {...this.document, pages:this.document.pages.map(p => p.id === pageId ? updated : p)};
      this.emitChange(); this.schedulePages();
      if (this.activePageId === pageId) { this.transcript.value = result.text; this.updateSearchHighlights(); }
      this.recognitionStatus.textContent = 'Transcript updated. Open Page text to review spelling and recognition.';
    } catch (error) {
      if (!this.disposed && lifecycle === this.lifecycle) this.recognitionStatus.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      this.recognitionBusy = false;
      if (!this.disposed) { this.recognizeButton.disabled = !this.options.onRecognize; this.scheduleRecognition(); }
    }
  }
  setSearchQuery(query: string): void {
    this.searchInput.value = query;
    this.searchMode = !!query.trim(); this.root.classList.toggle('inkstone-search-mode', this.searchMode);
    this.sidebarTitle.textContent = this.searchMode ? 'Search' : 'Pages';
    if (this.searchMode) {this.pageFilter.value='all';this.togglePages(true);}
    this.renderPages(); this.updateSearchHighlights();
  }
  private navigateSearch(direction:number): void {
    const hits=this.notebookIndex.search(this.searchInput.value,500); if(!hits.length) return;
    const current=hits.findIndex(hit=>hit.pageId===this.activePageId); const next=(current+direction+hits.length)%hits.length;
    this.setActivePage(hits[next].pageId!); this.updateSearchHighlights(true);
  }
  private updateSearchHighlights(focus = false): void {
    if (!this.engine || !this.textMatches) return;
    const page=this.getActivePage(), query=this.searchInput.value.trim(), recognition=page.recognition;
    this.textLayer?.setQuery(query);
    let signature=this.signatureCache.get(page.strokes);
    if (query && recognition && !signature) { signature=inkSignature(page.strokes); this.signatureCache.set(page.strokes,signature); }
    const valid=recognition && recognition.transcript===page.transcript && signature===recognition.inkSignature;
    const boxes=query && valid ? matchingWordBoxes(recognition.words,query) : [];
    this.engine.setSearchHighlights(boxes, focus && boxes.length ? 0 : -1);
    if (focus && boxes.length) this.engine.focusSearchHighlight(0);
    this.textMatches.replaceChildren(); this.textMatches.hidden=true;
    if (query) for (const [label,text] of [['Typed notes',[page.text,...(page.textBoxes??[]).map(box=>box.text)].join('\n')],['Transcript',page.transcript]]) {
      if (!findMatchRanges(text,query).length) continue;
      this.textMatches.hidden=false; this.textMatches.append(el('strong','',label));
      const preview=el('p',''); appendHighlightedText(preview,matchSnippet(text,query,350),query); this.textMatches.append(preview);
    }
    if (focus && !boxes.length && !this.textMatches.hidden) { this.root.classList.add('inkstone-notes-open'); this.notesToggle.setAttribute('aria-pressed','true'); }
    this.searchHint.textContent = query && findMatchRanges(page.transcript,query).length && !valid ? 'Recognize this page again to highlight matching words on the ink.' : '';
  }
  setActivePage(pageId: string): void {
    if (pageId === this.activePageId || !this.document.pages.some(page => page.id === pageId)) return;
    this.sidebar.querySelector('.inkstone-delete-confirm')?.remove();
    this.engine.flush(); this.engine.setPages(this.document.pages); this.activePageId = pageId; this.engine.setDocument(this.getActivePage()); this.engine.fitWidth();
    this.syncPageFields(); this.updateState(this.getActivePage()); this.renderPages(); this.updateSearchHighlights();
  }
  getActivePage(): InkPage { return this.document.pages.find(page => page.id === this.activePageId) ?? this.document.pages[0]; }
  setDocument(doc: InkDocument): void {
    this.engine.flush(); clearTimeout(this.recognitionTimer); this.pendingOCR.clear();
    this.lifecycle++; this.thumbnailCache.clear(); this.signatureCache = new WeakMap(); this.document = doc; this.engine.setPages(doc.pages); this.activePageId = doc.pages[0].id; this.engine.setDocument(this.getActivePage());
    this.syncPageFields(); this.updateState(this.getActivePage()); this.renderPages(); this.updateSearchHighlights();
  }
  setTitle(title: string): void { this.titleEl.textContent = title; }
  getDocument(): InkDocument { return this.document; }
  destroy(): void { this.textLayer.destroy(); this.engine.destroy(); this.disposed = true; clearTimeout(this.recognitionTimer); this.pendingOCR.clear(); this.lifecycle++; if (this.pagesTimer) clearTimeout(this.pagesTimer); this.cleanup.forEach(fn => fn()); this.root.remove(); }
}
