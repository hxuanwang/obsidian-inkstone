import { App, Modal, Notice, Setting, requestUrl } from 'obsidian';
import { visionRequest, readVisionResponse } from './markdown';
import type { InkstoneSettings } from './settings';

export function validateEndpoint(raw: string): string {
  const url=new URL(raw);
  if(url.username||url.password||url.hash)throw new Error('Use an endpoint without embedded credentials or a fragment.');
  if(url.protocol!=='https:' && !(url.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw new Error('Use HTTPS, or HTTP for a local provider.');
  return url.href;
}
export async function svgImage(svg: string): Promise<string> {
  const url=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'}));
  const canvas=document.createElement('canvas');
  try {
    const image=new Image();
    await new Promise<void>((resolve,reject)=>{image.onload=()=>resolve();image.onerror=()=>reject(new Error('Could not render this page.'));image.src=url;});
    canvas.width=1400;canvas.height=1900;
    const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Canvas unavailable.');
    ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);
    return canvas.toDataURL('image/png');
  } finally {URL.revokeObjectURL(url);canvas.width=0;canvas.height=0;}
}
/** Explicit, single-page submission and editable draft. Closing drops late results. */
export class AIMarkdownModal extends Modal {
  private closed=false;
  private rejectPending?: (error: Error) => void;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(app: App,private settings: InkstoneSettings,private svg: string,private save: (text:string)=>Promise<void>) {super(app);}
  onOpen(): void {
    this.contentEl.createEl('h2',{text:'Convert page to Markdown'});
    let endpoint: string;
    try {endpoint=validateEndpoint(this.settings.aiEndpoint);if(!this.settings.aiModel.trim())throw new Error('Set a vision model in Inkstone settings.');}
    catch {this.contentEl.createEl('p',{text:'Configure a vision-capable Chat Completions endpoint and model in Inkstone settings first.'});return;}
    this.contentEl.createEl('p',{text:`Convert sends an image of this page to ${new URL(endpoint).host} using ${this.settings.aiModel}. Provider charges may apply. Review the draft, especially equations, before saving. Your ink stays intact.`});
    const status=this.contentEl.createEl('p');status.setAttribute('role','status');
    const draft=this.contentEl.createEl('textarea',{cls:'inkstone-ai-draft'});draft.setAttribute('aria-label','Markdown draft');draft.spellcheck=this.settings.spellcheck;draft.hidden=true;
    let busy=false;
    new Setting(this.contentEl).addButton(button=>button.setButtonText('Convert page').setCta().onClick(async()=>{
      if(busy)return;busy=true;button.setDisabled(true);status.textContent='Converting page…';
      try {
        const image=await svgImage(this.svg);if(this.closed)return;
        const result=await Promise.race([
          requestUrl({url:endpoint,method:'POST',headers:{'Content-Type':'application/json',...(this.settings.aiKey?{Authorization:`Bearer ${this.settings.aiKey}`}:{})},body:JSON.stringify(visionRequest(this.settings.aiModel,image,this.settings.aiPrompt)),throw:false}),
          new Promise<never>((_,reject)=>{this.rejectPending=reject;this.timer=setTimeout(()=>reject(new Error('The provider timed out. It may still be processing the request.')),120_000);}),
        ]);
        if(this.closed)return;
        if(result.status<200||result.status>=300)throw new Error(`Provider returned HTTP ${result.status}. Check the endpoint, model and API key.`);
        draft.value=readVisionResponse(result.json);draft.hidden=false;saveButton.setDisabled(false);status.textContent='Draft ready. Check the Markdown and LaTeX, then save a new note.';draft.focus();
      } catch(error) {if(!this.closed)status.textContent=error instanceof Error?error.message:'Conversion failed.';}
      finally {clearTimeout(this.timer);this.rejectPending=undefined;if(!this.closed){busy=false;button.setDisabled(false);}}
    }));
    let saveButton: import('obsidian').ButtonComponent;
    new Setting(this.contentEl).addButton(button=>{saveButton=button;button.setButtonText('Save Markdown note').setDisabled(true).onClick(async()=>{
      if(!draft.value.trim()||busy)return;busy=true;button.setDisabled(true);
      try {await this.save(draft.value);this.close();}catch {new Notice('Could not save Markdown. Your draft is still available.');button.setDisabled(false);}finally{busy=false;}
    });});
  }
  onClose(): void {this.closed=true;this.rejectPending?.(new Error('Conversion closed.'));clearTimeout(this.timer);this.contentEl.empty();}
}
