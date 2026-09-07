import { App, Modal } from 'obsidian';
import { NoteIndex, type SearchHit } from './search';
import { appendHighlightedText } from './search-highlights';

export class InkSearchModal extends Modal {
  private unsubscribe?: () => void;
  constructor(app: App, private index: NoteIndex, private status: () => string, private openHit: (hit: SearchHit) => Promise<void>) { super(app); }
  onOpen(): void {
    this.contentEl.addClass('inkstone-search-modal');
    this.contentEl.createEl('h2', {text:'Search your notes'});
    const input = this.contentEl.createEl('input', {type:'search',placeholder:'Words or "an exact phrase"'});
    input.setAttribute('aria-label','Search handwritten and typed notes'); input.spellcheck = false;
    const status = this.contentEl.createEl('p', {cls:'inkstone-search-status'});
    const results = this.contentEl.createDiv({cls:'inkstone-search-results'});
    const render = () => {
      status.textContent = this.status(); results.empty();
      if (!input.value.trim()) { results.createEl('p',{text:'Search Markdown, typed page notes, and recognized handwriting. Run Recognize handwriting on ink pages to make them searchable.'}); return; }
      const hits = this.index.search(input.value);
      const count = results.createEl('p',{text:hits.length === 100 ? 'Showing the first 100 matches. Narrow your search for more specific results.' : `${hits.length} ${hits.length === 1 ? 'match' : 'matches'}`});
      count.setAttribute('role','status');
      for (const hit of hits) {
        const button = results.createEl('button',{cls:'inkstone-search-result'});
        appendHighlightedText(button.createEl('strong'), hit.title, input.value);
        appendHighlightedText(button.createEl('span'), hit.snippet || hit.path, input.value);
        button.createEl('small',{text:`${hit.kind === 'handwriting' ? 'Inkstone page' : 'Markdown'} · ${hit.path}`});
        button.addEventListener('click', () => { this.close(); void this.openHit(hit); });
      }
    };
    input.addEventListener('input',render);
    input.addEventListener('keydown', event => { if (event.key === 'Enter') (results.querySelector('button') as HTMLButtonElement | null)?.click(); });
    this.unsubscribe = this.index.subscribe(render); render(); input.focus();
  }
  onClose(): void { this.unsubscribe?.(); this.contentEl.empty(); }
}
