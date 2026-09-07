import { DEFAULT_SETTINGS, parseSettings, type InkstoneSettings } from './settings';
import { InkstoneSettingsTab } from './settings-tab';
import { notebookMarkdown } from './markdown';
import { AIMarkdownModal } from './ai-modal';
import { Notice, Plugin, TFile, TextFileView, WorkspaceLeaf, normalizePath } from "obsidian";
import { InkEditor } from "./editor";
import { createDocument, parseDocument, MAX_TEXT_LENGTH, type InkDocument } from "./model";

import { NoteIndex, type SearchHit } from "./search";
import { InkSearchModal } from "./search-modal";
import { LocalRecognizer } from "./recognition";

export const INK_VIEW_TYPE = "inkstone-handwriting";
const INK_EXTENSION = "inkstone";

/** TextFileView owns file loading, vault change handling, and queued saves. */
class InkstoneView extends TextFileView {
  private editor: InkEditor | null = null;
  private document: InkDocument = createDocument();
  private source = "";
  private dirty = false;
  private generation = 0;

  constructor(leaf: WorkspaceLeaf, private plugin: InkstonePlugin) {
    super(leaf);
    this.contentEl.addClass("inkstone-view");
  }

  getViewType(): string { return INK_VIEW_TYPE; }
  getDisplayText(): string { return this.file?.basename ?? "Inkstone"; }
  getIcon(): string { return "pencil"; }
  getViewData(): string {
    if (this.dirty) {
      this.source = JSON.stringify(this.document);
      this.dirty = false;
    }
    return this.source;
  }

  setViewData(data: string, _clear: boolean): void {
    // Preserve the actual loaded source until a real edit occurs. In particular,
    // never autosave a replacement document over a malformed or newer file.
    this.source = data;
    this.dirty = false;
    this.generation += 1;
    this.editor?.destroy();
    this.editor = null;
    this.contentEl.empty();
    try {
      this.document = data.trim() ? parseDocument(data) : createDocument();
    } catch (error) {
      const panel = this.contentEl.createDiv({ cls: "inkstone-file-error" });
      panel.createEl("h2", { text: "This handwriting note could not be opened" });
      panel.createEl("p", { text: "The original file has been preserved. Restore a valid copy from file recovery or inspect its JSON before trying again." });
      panel.createEl("pre", { text: error instanceof Error ? error.message : String(error) });
      return;
    }
    const generation = this.generation;
    const file = this.file;
    this.editor = new InkEditor(this.contentEl, {
      settings: this.plugin.settings,
      onSettingsChange: patch => { void this.plugin.updateSettings(patch); },
      onMarkdown: doc => { if(file)void this.plugin.exportMarkdown(file,notebookMarkdown(doc,file.path)).catch(()=>undefined); },
      onAI: async (_page, svg) => { if(file)new AIMarkdownModal(this.app,{...this.plugin.settings},svg,text=>this.plugin.exportMarkdown(file,text)).open(); },
      document: this.document,
      title: file?.basename ?? "Untitled",
      onChange: (document) => {
        if (generation !== this.generation || this.file !== file) return;
        this.document = document;
        // Serialize when TextFileView's queued save reads the data, keeping
        // whole-document JSON work out of the pen-up input callback.
        this.dirty = true;
        this.requestSave();
        if (file) this.plugin.indexLiveDocument(file, document);
      },
      onExport: (svg) => {
        if (generation !== this.generation || this.file !== file || !file) return;
        void this.plugin.exportSvg(file, svg);
      },
      onNew: () => { void this.plugin.createNote(); },
      onSearch: () => this.plugin.searchNotes(),
      onRecognize: (page) => this.plugin.recognizer.recognize(page),
    });
  }

  applySettings(): void { this.editor?.applySettings(this.plugin.settings); }
  pencilAction(gesture: 'doubleTap' | 'squeeze'): void { this.editor?.performPencilAction(this.plugin.settings[gesture]); }
  getDocument(): InkDocument { return this.document; }
  setActivePage(pageId: string): void { this.editor?.setActivePage(pageId); }
  setSearchQuery(query: string): void { this.editor?.setSearchQuery(query); }
  async recognizeCurrentPage(): Promise<void> {
    if (!this.editor) return;
    await this.plugin.recognizeFilePage(this.file!, this.editor.getActivePage().id);
  }

  clear(): void {
    this.generation += 1;
    this.editor?.destroy();
    this.editor = null;
    this.source = "";
    this.dirty = false;
    this.document = createDocument();
    this.contentEl.empty();
  }

  async onUnloadFile(file: TFile): Promise<void> {
    // Finalize any in-flight ink while callbacks still belong to this file;
    // TextFileView then flushes its pending save before another file loads.
    this.editor?.destroy();
    this.editor = null;
    this.generation += 1;
    await super.onUnloadFile(file);
  }

  async onClose(): Promise<void> {
    this.editor?.destroy();
    this.editor = null;
    this.generation += 1;
    await super.onClose();
  }
}

export default class InkstonePlugin extends Plugin {
  settings: InkstoneSettings = {...DEFAULT_SETTINGS};
  async updateSettings(patch: Partial<InkstoneSettings>): Promise<void> {
    this.settings=parseSettings({...this.settings,...patch});
    for(const leaf of this.app.workspace.getLeavesOfType(INK_VIEW_TYPE))(leaf.view as InkstoneView).applySettings();
    await this.saveData(this.settings);
  }
  readonly index = new NoteIndex();
  recognizer!: LocalRecognizer;
  private indexRevisions = new Map<string, number>();
  private skipped = new Set<string>();
  private indexing = false;
  private indexStarted = false;
  private indexTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private queueIndex(file: TFile): void {
    if(!this.indexStarted || this.disposed || !['md',INK_EXTENSION].includes(file.extension))return;
    // Invalidate in-flight reads immediately; coalesce saves and sync bursts.
    this.indexRevisions.set(file.path,(this.indexRevisions.get(file.path)??0)+1);
    clearTimeout(this.indexTimers.get(file.path));
    this.indexTimers.set(file.path,setTimeout(()=>{this.indexTimers.delete(file.path);void this.indexFile(file);},750));
  }
  private disposed = false;
  private recognitionBusy = false;
  private pendingRecognition = new Map<string, Promise<void>>();

  private liveView(path: string): InkstoneView | undefined {
    return this.app.workspace.getLeavesOfType(INK_VIEW_TYPE).map(leaf => leaf.view as InkstoneView).find(view => view.file?.path === path);
  }
  private async indexFile(file: TFile): Promise<void> {
    if (file.extension !== 'md' && file.extension !== INK_EXTENSION) return;
    const path = file.path;
    const revision = (this.indexRevisions.get(path) ?? 0) + 1;
    this.indexRevisions.set(path, revision);
    try {
      const source = await this.app.vault.cachedRead(file);
      if (this.disposed || file.path !== path || this.indexRevisions.get(path) !== revision) return;
      if (file.extension === INK_EXTENSION) this.index.ink(path, file.basename, parseDocument(source));
      else this.index.markdown(path, file.basename, source!);
      this.skipped.delete(path);
    } catch { if(!this.disposed && file.path === path && this.indexRevisions.get(path)===revision){this.skipped.add(path);this.index.remove(path);} }
  }
  indexLiveDocument(file: TFile, document: InkDocument): void {
    if(!this.indexStarted)return;
    this.indexRevisions.set(file.path, (this.indexRevisions.get(file.path) ?? 0) + 1);
    clearTimeout(this.indexTimers.get(file.path));
    this.indexTimers.set(file.path,setTimeout(()=>{
      this.indexTimers.delete(file.path);
      if(!this.disposed)this.index.ink(file.path,file.basename,document);
    },750));
  }
  private async buildIndex(): Promise<void> {
    const files = this.app.vault.getFiles();
    for (let i = 0; i < files.length && !this.disposed; i++) {
      await this.indexFile(files[i]);
      if (i % 8 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    this.indexing = false;
  }
  searchNotes(): void {
    if(!this.indexStarted){this.indexStarted=true;this.indexing=true;void this.buildIndex();}
    new InkSearchModal(this.app, this.index,
      () => `${this.index.size} pages and Markdown notes indexed${this.indexing ? ' · Building index…' : ''}${this.skipped.size ? ` · ${this.skipped.size} unreadable files skipped` : ''}`,
      hit => this.openSearchHit(hit)).open();
  }
  private async openSearchHit(hit: SearchHit): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(hit.path);
    if (!(file instanceof TFile)) { new Notice('This note has moved or been deleted. Search again.'); return; }
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file, hit.pageId ? undefined : {eState: {line: hit.line}});
    if (hit.pageId && leaf.view instanceof InkstoneView) {
      leaf.view.setActivePage(hit.pageId);
      leaf.view.setSearchQuery(hit.query);
    }
  }
  async recognizeFilePage(file: TFile, pageId: string): Promise<void> {
    const key = `${file.path}#${pageId}`;
    if (this.pendingRecognition.has(key)) return this.pendingRecognition.get(key)!;
    const job = this.recognizeAndStore(file, pageId).finally(() => this.pendingRecognition.delete(key));
    this.pendingRecognition.set(key, job); return job;
  }
  private async recognizeAndStore(file: TFile, pageId: string): Promise<void> {
    const live = this.liveView(file.path);
    if (live) await live.save();
    const before = parseDocument(await this.app.vault.read(file));
    const page = before.pages.find(page => page.id === pageId);
    if (!page || !page.strokes.length) return;
    const ink = JSON.stringify(page.strokes), oldTranscript = page.transcript;
    const result = await this.recognizer.recognize(page);
    if (this.disposed) return;
    if (typeof result.text !== 'string' || result.text.length > MAX_TEXT_LENGTH) throw new Error('Recognition returned an invalid or oversized transcript.');
    if (!result.text.trim()) return;
    // Atomic file process keeps text/page changes made during OCR. Never replace
    // a user's transcript correction or attach recognition to different ink.
    const currentView = this.liveView(file.path);
    if (currentView) await currentView.save();
    await this.app.vault.process(file, source => {
      const current = parseDocument(source), target = current.pages.find(candidate => candidate.id === pageId);
      if (!target || JSON.stringify(target.strokes) !== ink || target.transcript !== oldTranscript) return source;
      target.transcript = result.text;
      target.recognition = { transcript: result.text, words: result.words, inkSignature: result.inkSignature };
      return JSON.stringify(current);
    });
  }
  private async recognizeAll(): Promise<void> {
    if (this.recognitionBusy) { new Notice('Handwriting recognition is already running.'); return; }
    this.recognitionBusy = true;
    const progress = new Notice('Recognizing handwriting locally…', 0);
    let completed = 0, failed = 0;
    try {
      for (const file of this.app.vault.getFiles().filter(file => file.extension === INK_EXTENSION)) {
        if (this.disposed) break;
        try {
          const live = this.liveView(file.path); if (live) await live.save();
          const doc = parseDocument(await this.app.vault.read(file));
          for (const page of doc.pages) {
            if (this.disposed) break;
            if (!page.strokes.length || page.transcript.trim()) continue;
            await this.recognizeFilePage(file, page.id); completed++;
            progress.setMessage(`Recognized ${completed} pages locally…`);
          }
        } catch { failed++; }
      }
    } finally { this.recognitionBusy = false; progress.hide(); }
    if (!this.disposed) new Notice(`Recognized ${completed} pages. ${failed ? `${failed} notes could not be processed. ` : ''}Review transcripts for recognition errors.`);
  }
  onunload(): void { this.disposed = true; for(const timer of this.indexTimers.values())clearTimeout(timer);this.indexTimers.clear(); void this.recognizer?.destroy(); }

  async onload(): Promise<void> {
    this.settings=parseSettings(await this.loadData());
    this.addSettingTab(new InkstoneSettingsTab(this));
    for(const gesture of ['doubleTap','squeeze'] as const)this.addCommand({id:`pencil-${gesture}`,name:`Run Pencil ${gesture==='doubleTap'?'double-tap':'squeeze'} action`,checkCallback: checking => {const view=this.app.workspace.getActiveViewOfType(InkstoneView);if(!view)return false;if(!checking)view.pencilAction(gesture);return true;}});
    const pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    this.recognizer = new LocalRecognizer(this.app.vault.adapter.getResourcePath(`${pluginDir}/assets/ocr`));
    this.registerEvent(this.app.vault.on('create', file => { if (file instanceof TFile) this.queueIndex(file); }));
    this.registerEvent(this.app.vault.on('modify', file => { if (file instanceof TFile) this.queueIndex(file); }));
    this.registerEvent(this.app.vault.on('delete', file => { this.indexRevisions.set(file.path, (this.indexRevisions.get(file.path) ?? 0) + 1); this.index.remove(file.path); this.skipped.delete(file.path);clearTimeout(this.indexTimers.get(file.path));this.indexTimers.delete(file.path); }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => { this.indexRevisions.set(oldPath, (this.indexRevisions.get(oldPath) ?? 0) + 1); this.index.remove(oldPath);clearTimeout(this.indexTimers.get(oldPath));this.indexTimers.delete(oldPath); if (file instanceof TFile) this.queueIndex(file); }));
    this.addCommand({id:'search-all-notes',name:'Search handwritten and typed notes',callback:() => this.searchNotes()});
    this.addCommand({id:'recognize-unindexed-handwriting',name:'Recognize handwriting in pages without transcripts',callback:() => { void this.recognizeAll(); }});
    this.registerView(INK_VIEW_TYPE, (leaf) => new InkstoneView(leaf, this));
    this.registerExtensions([INK_EXTENSION], INK_VIEW_TYPE);
    this.addRibbonIcon("pencil", "Create handwriting note", () => { void this.createNote(); });
    this.addCommand({
      id: "create-handwriting-note",
      name: "Create handwriting note",
      callback: () => { void this.createNote(); },
    });
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (!(file instanceof TFile) || file.extension !== INK_EXTENSION) return;
      menu.addItem((item) => item.setTitle("Open handwriting note").setIcon("pencil").onClick(async () => {
        await this.app.workspace.getLeaf(false).openFile(file);
      }));
    }));
  }

  private availablePath(folder: string, basename: string, extension: string): string {
    let suffix = 0;
    let path: string;
    do {
      path = normalizePath(`${folder ? `${folder}/` : ""}${basename}${suffix ? ` ${suffix}` : ""}.${extension}`);
      suffix += 1;
    } while (this.app.vault.getAbstractFileByPath(path));
    return path;
  }

  async createNote(): Promise<void> {
    try {
      const folder = this.app.fileManager.getNewFileParent(this.app.workspace.getActiveFile()?.path ?? "");
      const path = this.availablePath(folder.path === "/" ? "" : folder.path, "Untitled handwriting", INK_EXTENSION);
      const file = await this.app.vault.create(path, JSON.stringify(createDocument(), null, 2));
      await this.app.workspace.getLeaf(false).openFile(file);
    } catch (error) {
      new Notice(`Could not create handwriting note: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async exportMarkdown(file: TFile, text: string): Promise<void> {
    const folder=file.parent?.path==='/'?'':file.parent?.path??'';
    try {const path=this.availablePath(folder,`${file.basename} Markdown`,'md');await this.app.vault.create(path,text);new Notice(`Exported ${path}`);}
    catch(error){new Notice('Could not export Markdown.');throw error;}
  }
  async exportSvg(file: TFile, svg: string): Promise<void> {
    try {
      const folder = file.parent?.path === "/" ? "" : file.parent?.path ?? "";
      const path = this.availablePath(folder, file.basename, "svg");
      await this.app.vault.create(path, svg);
      new Notice(`Exported ${path}. Embed it in a note with ![[${path}]].`);
    } catch (error) {
      new Notice(`Could not export handwriting: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
