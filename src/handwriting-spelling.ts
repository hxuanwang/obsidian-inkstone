import { pageDimensions, type InkPage } from './model';
import { inkSignature } from './ink-signature';
import { loadSpelling, type SpellingDictionary } from './spelling';

/** Review-only marks: never stored, exported, or sent back into OCR. */
export class HandwritingSpelling {
  private layer: HTMLDivElement;
  private page: InkPage | undefined;
  private enabled = false;
  private closed = false;
  private dictionary: SpellingDictionary | undefined;
  private loading = false;
  private rendered: InkPage['recognition'] | undefined;
  private renderedStrokes: InkPage['strokes'] | undefined;
  constructor(host: HTMLElement, private viewport: () => {x:number;y:number;zoom:number}, private loader = loadSpelling) {
    this.layer=host.ownerDocument.createElement('div');
    this.layer.className='inkstone-spelling-layer';this.layer.setAttribute('aria-hidden','true');host.append(this.layer);
  }
  setEnabled(enabled: boolean): void { this.enabled=enabled;this.rendered=undefined;this.refresh(); }
  setPage(page: InkPage): void { this.page=page;this.refresh(); }
  position(): void {
    const view=this.viewport();
    this.layer.style.transform=`translate(${view.x}px,${view.y}px) scale(${view.zoom})`;
  }
  private refresh(): void {
    if(this.closed)return;
    const page=this.page, recognition=page?.recognition;
    if(!this.enabled || !page || !recognition || recognition.transcript!==page.transcript) {this.layer.replaceChildren();this.rendered=undefined;return;}
    if(this.rendered===recognition && this.renderedStrokes===page.strokes){this.position();return;}
    this.rendered=undefined;
    this.layer.replaceChildren();
    if(recognition.inkSignature!==inkSignature(page.strokes))return;
    if(!this.dictionary){
      if(!this.loading){this.loading=true;void this.loader().then(dictionary=>{if(!this.closed){this.dictionary=dictionary;this.refresh();}}).catch(()=>{}).finally(()=>{this.loading=false;});}
      return;
    }
    const {width,height}=pageDimensions(page);
    this.layer.style.width=`${width}px`;this.layer.style.height=`${height}px`;
    for(const word of recognition.words){
      if(!this.dictionary.misspellings(word.text).length)continue;
      const mark=this.layer.ownerDocument.createElement('div');mark.className='inkstone-ink-spelling-mark';
      mark.style.left=`${word.x}px`;mark.style.top=`${Math.min(height-6,word.y+word.height+2)}px`;mark.style.width=`${word.width}px`;
      this.layer.append(mark);
    }
    this.rendered=recognition;this.renderedStrokes=page.strokes;this.position();
  }
  destroy(): void {this.closed=true;this.layer.remove();}
}
