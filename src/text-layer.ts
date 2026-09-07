import { PAGE_WIDTH, PAGE_HEIGHT, MAX_TEXT_LENGTH, type TextBox } from './model';
import { findMatchRanges } from './search-highlights';

type Viewport = { x: number; y: number; zoom: number };
/** Page-space text stays separate from ink and the recognition image. */
export class TextLayer {
  private layer = document.createElement('div');
  private enabled = false;
  private spellcheck = true;
  private boxes: TextBox[] = [];
  private revision = 0;
  private query = '';
  private pointers = new Set<number>();
  private tap: {id: number; x: number; y: number} | null = null;
  private cleanup: (() => void)[] = [];
  constructor(private surface: HTMLElement, private viewport: () => Viewport,
    private change: (boxes: TextBox[]) => void, private color: () => string) {
    this.layer.className = 'inkstone-text-layer'; surface.append(this.layer);
    const down = (event: PointerEvent) => {
      if (!this.enabled || (event.target as HTMLElement).closest('.inkstone-text-box') || event.button !== 0) return;
      this.pointers.add(event.pointerId);
      this.tap = this.pointers.size === 1 ? {id: event.pointerId, x:event.clientX, y:event.clientY} : null;
    };
    const move = (event: PointerEvent) => { if (this.tap?.id === event.pointerId && Math.hypot(event.clientX-this.tap.x,event.clientY-this.tap.y)>8) this.tap=null; };
    const up = (event: PointerEvent) => {
      const tap = this.tap; this.tap=null; this.pointers.delete(event.pointerId);
      if (!this.enabled || tap?.id !== event.pointerId || Math.hypot(event.clientX-tap.x,event.clientY-tap.y)>8) return;
      const rect=surface.getBoundingClientRect(), view=this.viewport();
      const x=(event.clientX-rect.left-view.x)/view.zoom, y=(event.clientY-rect.top-view.y)/view.zoom;
      if (x<0 || y<0 || x>PAGE_WIDTH || y>PAGE_HEIGHT || this.boxes.length>=1000) return;
      const box:TextBox={id:crypto.randomUUID(),x:Math.min(x,PAGE_WIDTH-420),y:Math.min(y,PAGE_HEIGHT-200),width:420,height:200,fontSize:28,color:this.color(),text:''};
      this.boxes=[...this.boxes,box]; this.change(this.boxes); this.render(box.id);
    };
    const cancel=(event:PointerEvent)=>{this.tap=null;this.pointers.delete(event.pointerId);};
    for(const [name,fn] of [['pointerdown',down],['pointermove',move],['pointerup',up],['pointercancel',cancel],['lostpointercapture',cancel]] as const) {
      surface.addEventListener(name,fn); this.cleanup.push(()=>surface.removeEventListener(name,fn));
    }
  }
  setSpellcheck(enabled:boolean):void { this.spellcheck=enabled; for(const input of this.layer.querySelectorAll('textarea'))input.spellcheck=enabled; }
  setEnabled(enabled:boolean):void { this.enabled=enabled;for(const input of this.layer.querySelectorAll('textarea')){input.readOnly=!enabled;input.tabIndex=enabled?0:-1;} this.layer.classList.toggle('is-editing',enabled); this.tap=null; this.pointers.clear(); if(!enabled) (this.layer.querySelector(':focus') as HTMLElement)?.blur(); }
  setBoxes(boxes:TextBox[]=[]):void { this.revision++;this.tap=null;this.pointers.clear();this.boxes=boxes;this.render(); }
  setQuery(query:string):void {this.query=query;this.markMatches();}
  position():void { const view=this.viewport();this.layer.style.setProperty('--text-zoom',String(view.zoom));this.layer.style.transform=`translate(${view.x}px,${view.y}px) scale(${view.zoom})`; }
  private update(id:string,patch:Partial<TextBox>,notify=true):void {this.boxes=this.boxes.map(box=>box.id===id?{...box,...patch}:box);if(notify)this.change(this.boxes);}
  private markMatches():void {for(const node of this.layer.querySelectorAll<HTMLElement>('.inkstone-text-box')) {const box=this.boxes.find(box=>box.id===node.dataset.id);node.classList.toggle('has-match',!!box && !!this.query && findMatchRanges(box.text,this.query).length>0);}}
  private render(focus?:string):void {
    this.layer.replaceChildren();
    for(const box of this.boxes) {
      const node=document.createElement('div');node.className='inkstone-text-box';node.dataset.id=box.id;
      node.style.cssText=`left:${box.x}px;top:${box.y}px;width:${box.width}px;height:${box.height}px;color:${box.color};font-size:${box.fontSize}px`;
      const controls=document.createElement('div');controls.className='inkstone-text-box-controls';
      const move=document.createElement('button');move.type='button';move.textContent='Move';move.setAttribute('aria-label','Move text box');
      move.addEventListener('pointerdown',event=>{
        event.preventDefault();event.stopPropagation();move.setPointerCapture(event.pointerId);
        const revision=this.revision;const original=this.boxes.find(b=>b.id===box.id)!;const start={x:event.clientX,y:event.clientY};const zoom=this.viewport().zoom;
        const onMove=(e:PointerEvent)=>{if(e.pointerId!==event.pointerId || revision!==this.revision)return;e.stopPropagation();const x=Math.max(0,Math.min(PAGE_WIDTH-box.width,original.x+(e.clientX-start.x)/zoom));const y=Math.max(0,Math.min(PAGE_HEIGHT-box.height,original.y+(e.clientY-start.y)/zoom));node.style.left=`${x}px`;node.style.top=`${y}px`;this.update(box.id,{x,y},false);};
        const done=(e:PointerEvent)=>{if(e.pointerId!==event.pointerId)return;e.stopPropagation();if(e.type==='pointerup' && revision===this.revision){onMove(e);this.change(this.boxes);}move.removeEventListener('pointermove',onMove);move.removeEventListener('pointerup',done);move.removeEventListener('pointercancel',cancel);move.removeEventListener('lostpointercapture',cancel);};
        const cancel=(e:PointerEvent)=>{if(e.pointerId!==event.pointerId)return;if(revision===this.revision)this.update(box.id,{x:original.x,y:original.y},false);node.style.left=`${original.x}px`;node.style.top=`${original.y}px`;done(e);};
        move.addEventListener('pointermove',onMove);move.addEventListener('pointerup',done);move.addEventListener('pointercancel',cancel);move.addEventListener('lostpointercapture',cancel);
      });
      move.addEventListener('keydown',event=>{const directions:Record<string,[number,number]>={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};const d=directions[event.key];if(!d)return;event.preventDefault();const b=this.boxes.find(b=>b.id===box.id)!;const step=event.shiftKey?20:5;const x=Math.max(0,Math.min(PAGE_WIDTH-b.width,b.x+d[0]*step)),y=Math.max(0,Math.min(PAGE_HEIGHT-b.height,b.y+d[1]*step));this.update(box.id,{x,y});node.style.left=`${x}px`;node.style.top=`${y}px`;});
      const remove=document.createElement('button');remove.type='button';remove.textContent='Remove';remove.setAttribute('aria-label','Remove text box');
      remove.addEventListener('click',()=>{this.boxes=this.boxes.filter(b=>b.id!==box.id);this.change(this.boxes);this.render();});
      const size=document.createElement('select');size.setAttribute('aria-label','Text font size');
      for(const n of [20,28,36,48,64]){const option=document.createElement('option');option.value=String(n);option.textContent=`${n}`;size.append(option);}size.value=String(box.fontSize);
      size.addEventListener('change',()=>{this.update(box.id,{fontSize:Number(size.value)});node.style.fontSize=`${size.value}px`;});
      const input=document.createElement('textarea');input.className='inkstone-page-text-input';input.value=box.text;input.readOnly=!this.enabled;input.tabIndex=this.enabled?0:-1;input.spellcheck=this.spellcheck;input.placeholder='Type here…';input.setAttribute('aria-label','Text on page');
      input.maxLength=Math.min(10000,MAX_TEXT_LENGTH-this.boxes.reduce((n,b)=>n+(b.id===box.id?0:b.text.length),0));
      input.addEventListener('input',()=>{const remaining=MAX_TEXT_LENGTH-this.boxes.reduce((n,b)=>n+(b.id===box.id?0:b.text.length),0);if(input.value.length>remaining)input.value=input.value.slice(0,remaining);this.update(box.id,{text:input.value});this.markMatches();});
      for(const event of ['pointerdown','pointermove','pointerup','pointercancel','wheel'])node.addEventListener(event,e=>e.stopPropagation());
      controls.append(move,size,remove);node.append(controls,input);this.layer.append(node);
      if(box.id===focus) input.focus();
    }
    this.markMatches();this.position();
  }
  destroy():void {this.cleanup.forEach(fn=>fn());this.layer.remove();}
}

/** Portable SVG text, escaped through DOM serialization rather than string interpolation. */
export function appendTextToSvg(svg:string,boxes:TextBox[]=[]):string {
  if(!boxes.length)return svg;
  const doc=new DOMParser().parseFromString(svg,'image/svg+xml');
  const ns='http://www.w3.org/2000/svg';const measure=document.createElement('canvas').getContext('2d');
  for(const box of boxes) {
    const group=doc.createElementNS(ns,'svg');group.setAttribute('x',String(box.x));group.setAttribute('y',String(box.y));group.setAttribute('width',String(box.width));group.setAttribute('height',String(box.height));group.setAttribute('overflow','hidden');
    const text=doc.createElementNS(ns,'text');text.setAttribute('fill',box.color);text.setAttribute('font-family','Arial, sans-serif');text.setAttribute('font-size',String(box.fontSize));
    if(measure)measure.font=`${box.fontSize}px Arial`;
    const lines:string[]=[];
    for(const paragraph of box.text.split('\n')) {let line='';for(const character of paragraph) {if(line && (measure?.measureText(line+character).width??(line.length+1)*box.fontSize*.6)>box.width-16){lines.push(line);line='';}line+=character;}lines.push(line);}
    for(const [index,line] of lines.entries()){const span=doc.createElementNS(ns,'tspan');span.setAttribute('x','8');span.setAttribute('y',String(8+box.fontSize+index*box.fontSize*1.35));span.textContent=line;text.append(span);}
    group.append(text);doc.documentElement.append(group);
  }
  return new XMLSerializer().serializeToString(doc);
}
