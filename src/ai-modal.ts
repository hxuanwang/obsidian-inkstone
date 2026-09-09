import { App, Modal, Notice, Setting, requestUrl } from 'obsidian';
import type { ConversionFormat } from './markdown';
import type { InkstoneSettings } from './settings';

import { transcribeImage, validateEndpoint } from './ai-provider';
export { validateEndpoint } from './ai-provider';
export async function svgImage(svg: string, signal?: AbortSignal): Promise<string> {
  const url=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'}));
  const canvas=document.createElement('canvas');
  const image=new Image();
  let abort:(()=>void)|undefined;
  try {
    if(signal?.aborted)throw new Error('Conversion closed.');
    await new Promise<void>((resolve,reject)=>{
      image.onload=()=>resolve();image.onerror=()=>reject(new Error('Could not render this page.'));
      abort=()=>reject(new Error('Conversion closed.'));signal?.addEventListener('abort',abort,{once:true});image.src=url;
    });
    if(!image.naturalWidth||!image.naturalHeight)throw new Error('Could not read this page’s dimensions.');
    const scale=Math.min(1,1900/Math.max(image.naturalWidth,image.naturalHeight));
    canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
    const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Canvas unavailable.');
    ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);
    return canvas.toDataURL('image/png');
  } finally {image.onload=null;image.onerror=null;if(abort)signal?.removeEventListener('abort',abort);URL.revokeObjectURL(url);canvas.width=0;canvas.height=0;}
}
/** Explicit, single-page submission and editable draft. Closing drops late results. */
export class AIMarkdownModal extends Modal {
  private closed=false;
  private requestController?: AbortController;
  constructor(app: App,private settings: InkstoneSettings,private svg: string,private save: (text:string,format:ConversionFormat)=>Promise<void>) {super(app);}
  onOpen(): void {
    this.closed=false;
    this.contentEl.createEl('h2',{text:'Convert page with AI'});
    let endpoint: string;
    try {endpoint=validateEndpoint(this.settings.aiEndpoint);if(!this.settings.aiModel.trim())throw new Error('Set a vision model in Inkstone settings.');}
    catch {this.contentEl.createEl('p',{text:'Configure a vision-capable Chat Completions endpoint and model in Inkstone settings first.'});return;}
    const config={aiEndpoint:endpoint,aiModel:this.settings.aiModel,aiKey:this.settings.aiKey};
    this.contentEl.createEl('p',{text:`Convert sends an image of this page to ${new URL(endpoint).host} using ${this.settings.aiModel}. Provider charges may apply. Review the draft, especially equations, before saving. Your ink stays intact.`});
    const status=this.contentEl.createEl('p');status.setAttribute('role','status');
    const draft=this.contentEl.createEl('textarea',{cls:'inkstone-ai-draft'});draft.setAttribute('aria-label','Markdown draft');draft.spellcheck=this.settings.spellcheck;draft.hidden=true;
    let busy=false;
    let format:ConversionFormat='markdown';
    let draftFormat:ConversionFormat='markdown';
    let formatControl:import('obsidian').DropdownComponent;
    new Setting(this.contentEl).setName('Output format').addDropdown(control=>{
      formatControl=control;control.addOptions({markdown:'Markdown (Obsidian math)',latex:'LaTeX document (.tex)'}).setValue(format).onChange(value=>{
        format=value==='latex'?'latex':'markdown';
        draft.hidden=true;draft.value='';saveButton.setDisabled(true);status.textContent='';
        saveButton.setButtonText(format==='latex'?'Save LaTeX document':'Save Markdown note');
      });
    });
    new Setting(this.contentEl).addButton(button=>button.setButtonText('Convert page').setCta().onClick(async()=>{
      if(busy||this.closed)return;busy=true;button.setDisabled(true);formatControl.setDisabled(true);saveButton.setDisabled(true);status.textContent='Converting page…';
      const controller=new AbortController();this.requestController=controller;
      const current=()=>!this.closed&&this.requestController===controller;
      try {
        let image:string;
        try {image=await svgImage(this.svg,controller.signal);} catch {throw new Error('Could not render this page for conversion.');}
        if(!current())return;
        const text=await transcribeImage(config,image,this.settings.aiPrompt,requestUrl,controller.signal,format);
        if(!current())return;
        draftFormat=format;draft.setAttribute('aria-label',format==='latex'?'LaTeX draft':'Markdown draft');draft.value=text;draft.hidden=false;saveButton.setDisabled(false);status.textContent=format==='latex'?'Draft ready. Review the LaTeX source, then save a new .tex document.':'Draft ready. Check the Markdown and equations, then save a new note.';draft.focus();
      } catch(error) {if(current())status.textContent=error instanceof Error?error.message:'Conversion failed.';}
      finally {if(current()){this.requestController=undefined;busy=false;button.setDisabled(false);formatControl.setDisabled(false);}}
    }));
    let saveButton: import('obsidian').ButtonComponent;
    new Setting(this.contentEl).addButton(button=>{saveButton=button;button.setButtonText('Save Markdown note').setDisabled(true).onClick(async()=>{
      if(!draft.value.trim()||busy||this.closed)return;busy=true;button.setDisabled(true);
      try {await this.save(draft.value,draftFormat);this.close();}catch {new Notice('Could not save the document. Your draft is still available.');button.setDisabled(false);}finally{busy=false;}
    });});
  }
  onClose(): void {this.closed=true;this.requestController?.abort();this.requestController=undefined;this.contentEl.empty();}
}
