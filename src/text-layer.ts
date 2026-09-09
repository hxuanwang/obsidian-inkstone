import { pageDimensions, MAX_TEXT_LENGTH, TEXT_FONTS, type PageFormat, type TextBox } from './model';
import { findMatchRanges } from './search-highlights';
import { appendSpellingText, loadSpelling, type SpellingDictionary } from './spelling';

type Viewport = { x: number; y: number; zoom: number };
/** Page-space text stays separate from ink and the recognition image. */
export class TextLayer {
  private layer = document.createElement('div');
  private enabled = false;
  private toolbar = document.createElement('div');
  private selected: string | null = null;
  private defaults: Pick<TextBox, 'fontSize' | 'color' | 'fontFamily' | 'bold' | 'italic' | 'textAlign' | 'lineHeight'> = {fontSize:28,color:'#20242b',fontFamily:'sans',bold:false,italic:false,textAlign:'left',lineHeight:1.35};
  private settings = new Map<string, HTMLInputElement | HTMLSelectElement | HTMLButtonElement>();
  private spellcheck = true;
  private spelling: SpellingDictionary | null = null;
  private spellingLoad: Promise<void> | null = null;
  private spellingTimer: ReturnType<typeof setTimeout> | undefined;
  private destroyed = false;
  private boxes: TextBox[] = [];
  private dimensions = pageDimensions();
  private revision = 0;
  private query = '';
  private pointers = new Set<number>();
  private tap: {id: number; x: number; y: number} | null = null;
  private cleanup: (() => void)[] = [];
  constructor(private surface: HTMLElement, private viewport: () => Viewport,
    private change: (boxes: TextBox[]) => void, private color: () => string,
    private spellingLoader: () => Promise<SpellingDictionary> = loadSpelling) {
    this.layer.className = 'inkstone-text-layer'; surface.append(this.layer);
    this.defaults.color=this.color();this.buildToolbar();
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
      if (x<0 || y<0 || x>this.dimensions.width || y>this.dimensions.height || this.boxes.length>=1000) return;
      const box:TextBox={id:crypto.randomUUID(),x:Math.min(x,this.dimensions.width-420),y:Math.min(y,this.dimensions.height-200),width:420,height:200,...this.defaults,text:''};
      this.boxes=[...this.boxes,box]; this.change(this.boxes); this.render(box.id);
    };
    const cancel=(event:PointerEvent)=>{this.tap=null;this.pointers.delete(event.pointerId);};
    for(const [name,fn] of [['pointerdown',down],['pointermove',move],['pointerup',up],['pointercancel',cancel],['lostpointercapture',cancel]] as const) {
      surface.addEventListener(name,fn); this.cleanup.push(()=>surface.removeEventListener(name,fn));
    }
  }
  getToolbar():HTMLElement {return this.toolbar;}
  private buildToolbar():void {
    this.toolbar.className='inkstone-text-settings';this.toolbar.setAttribute('role','toolbar');this.toolbar.setAttribute('aria-label','Text settings');
    for(const event of ['pointerdown','pointermove','pointerup','pointercancel'])this.toolbar.addEventListener(event,e=>e.stopPropagation());
    const select=(key:string,label:string,options:[string,string][])=>{
      const control=document.createElement('select');control.setAttribute('aria-label',label);control.title=label;
      for(const [value,label] of options){const option=document.createElement('option');option.value=value;option.textContent=label;control.append(option);}
      control.addEventListener('change',()=>this.applySetting({[key]:key==='fontSize'||key==='lineHeight'?Number(control.value):control.value}));
      this.settings.set(key,control);this.toolbar.append(control);
    };
    const color=document.createElement('input');color.type='color';color.className='inkstone-text-color';color.setAttribute('aria-label','Text color');color.title='Text color';
    color.addEventListener('input',()=>this.applySetting({color:color.value}));this.settings.set('color',color);this.toolbar.append(color);
    select('fontSize','Text font size',[12,16,20,24,28,32,36,48,64,72,96].map(n=>[String(n),String(n)]));
    select('fontFamily','Text font family',[['sans','Modern'],['serif','Classic'],['mono','Mono']]);
    for(const [key,label,glyph] of [['bold','Bold','B'],['italic','Italic','I']] as const){
      const button=document.createElement('button');button.type='button';button.textContent=glyph;button.title=label;button.setAttribute('aria-label',label);button.className=`inkstone-text-${key}`;
      button.addEventListener('pointerdown',event=>event.preventDefault());
      button.addEventListener('click',()=>this.applySetting({[key]:!this.currentStyle()[key]}));this.settings.set(key,button);this.toolbar.append(button);
    }
    select('textAlign','Text alignment',[['left','Left'],['center','Center'],['right','Right']]);
    select('lineHeight','Text line spacing',[[ '1','1.0×'],['1.15','1.15×'],['1.35','1.35×'],['1.5','1.5×'],['2','2.0×']]);
    this.syncToolbar();
  }
  private currentStyle():typeof this.defaults {
    const box=this.boxes.find(box=>box.id===this.selected);
    return box?{fontSize:box.fontSize,color:box.color,fontFamily:box.fontFamily??'sans',bold:box.bold??false,italic:box.italic??false,textAlign:box.textAlign??'left',lineHeight:box.lineHeight??1.35}:{...this.defaults};
  }
  private syncToolbar():void {
    const style=this.currentStyle();
    for(const [key,control] of this.settings){const value=style[key as keyof typeof style];
      if(key==='bold'||key==='italic'){control.setAttribute('aria-pressed',String(!!value));control.classList.toggle('is-active',!!value);}
      else {if((key==='fontSize'||key==='lineHeight') && !Array.from(control.children).some(child=>(child as HTMLOptionElement).value===String(value))){const option=document.createElement('option');option.value=String(value);option.textContent=String(value);control.append(option);}control.value=String(value);}
    }
  }
  private applySetting(patch:Partial<TextBox>):void {
    this.defaults={...this.currentStyle(),...patch};
    if(this.selected){this.update(this.selected,patch);const node=Array.from(this.layer.querySelectorAll<HTMLElement>('.inkstone-text-box')).find(node=>node.dataset.id===this.selected);const box=this.boxes.find(box=>box.id===this.selected);if(node&&box){this.styleBox(node,box);this.positionHighlights(node);}}
    this.syncToolbar();
  }
  private styleBox(node:HTMLElement,box:TextBox):void {
    node.style.color=box.color;node.style.fontSize=`${box.fontSize}px`;node.style.fontFamily=TEXT_FONTS[box.fontFamily??'sans'];node.style.fontWeight=box.bold?'700':'400';node.style.fontStyle=box.italic?'italic':'normal';node.style.textAlign=box.textAlign??'left';node.style.lineHeight=String(box.lineHeight??1.35);
    for(const child of node.querySelectorAll<HTMLElement>('.inkstone-page-text-input')){child.style.lineHeight='inherit';child.style.textAlign='inherit';}
    for(const child of node.querySelectorAll<HTMLElement>('.inkstone-text-highlight-content')){child.style.lineHeight='inherit';child.style.textAlign='inherit';}
  }
  setSpellcheck(enabled:boolean):void {
    if(this.destroyed)return;
    this.spellcheck=enabled;
    clearTimeout(this.spellingTimer);
    for(const input of this.layer.querySelectorAll('textarea'))input.spellcheck=enabled;
    this.markMatches();
    if(enabled && !this.spelling && !this.spellingLoad) {
      this.spellingLoad=this.spellingLoader().then(dictionary=>{
        if(this.destroyed)return;
        this.spelling=dictionary;
        if(this.spellcheck)this.markMatches();
      }).catch(()=>{ /* Native spelling remains available if the dictionary cannot load. */ })
        .finally(()=>{this.spellingLoad=null;});
    }
  }
  setEnabled(enabled:boolean):void { this.enabled=enabled;for(const input of this.layer.querySelectorAll('textarea')){input.readOnly=!enabled;input.tabIndex=enabled?0:-1;} this.layer.classList.toggle('is-editing',enabled); this.tap=null; this.pointers.clear(); if(!enabled) (this.layer.querySelector(':focus') as HTMLElement)?.blur(); }
  setBoxes(boxes:TextBox[]=[]):void { this.revision++;this.tap=null;this.pointers.clear();this.boxes=boxes;this.selected=null;this.render();this.syncToolbar(); }
  /** Geometry only; the editor supplies the page's saved text boxes separately. */
  setPageFormat(format:PageFormat):void {
    const dimensions=pageDimensions(format);
    if(dimensions.width!==this.dimensions.width || dimensions.height!==this.dimensions.height){this.revision++;this.tap=null;this.pointers.clear();}
    this.dimensions=dimensions;
    this.layer.style.width=`${dimensions.width}px`;this.layer.style.height=`${dimensions.height}px`;
  }
  setQuery(query:string):void {this.query=query;this.markMatches();}
  position():void { const view=this.viewport();this.layer.style.setProperty('--text-zoom',String(view.zoom));this.layer.style.transform=`translate(${view.x}px,${view.y}px) scale(${view.zoom})`; }
  private update(id:string,patch:Partial<TextBox>,notify=true):void {this.boxes=this.boxes.map(box=>box.id===id?{...box,...patch}:box);if(notify)this.change(this.boxes);}
  private markMatches(includeSpelling=true):void {
    if(this.destroyed)return;
    const dictionary=includeSpelling && this.spellcheck ? this.spelling : null;
    for(const node of this.layer.querySelectorAll<HTMLElement>('.inkstone-text-box')) {
      const box=this.boxes.find(box=>box.id===node.dataset.id);
      const mirror=node.querySelector<HTMLElement>('.inkstone-text-highlight-content')!;
      const matches=!!box && !!this.query && findMatchRanges(box.text,this.query).length>0;
      node.classList.toggle('has-match',matches);
      mirror.parentElement!.hidden=!matches && !dictionary;
      if(box && (matches || dictionary)) appendSpellingText(mirror,box.text,dictionary,this.query);
      else mirror.replaceChildren();
      this.positionHighlights(node);
    }
  }
  private positionHighlights(node:HTMLElement):void {
    const input=node.querySelector('textarea')!;
    const mirror=node.querySelector<HTMLElement>('.inkstone-text-highlight-content')!;
    // Match the textarea's wrapping width, including space reserved for its scrollbar.
    mirror.style.width=`${input.clientWidth}px`;
    mirror.style.transform=`translate(${-input.scrollLeft}px,${-input.scrollTop}px)`;
  }
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
        const onMove=(e:PointerEvent)=>{if(e.pointerId!==event.pointerId || revision!==this.revision)return;e.stopPropagation();const x=Math.max(0,Math.min(this.dimensions.width-box.width,original.x+(e.clientX-start.x)/zoom));const y=Math.max(0,Math.min(this.dimensions.height-box.height,original.y+(e.clientY-start.y)/zoom));node.style.left=`${x}px`;node.style.top=`${y}px`;this.update(box.id,{x,y},false);};
        const done=(e:PointerEvent)=>{if(e.pointerId!==event.pointerId)return;e.stopPropagation();if(e.type==='pointerup' && revision===this.revision){onMove(e);this.change(this.boxes);}move.removeEventListener('pointermove',onMove);move.removeEventListener('pointerup',done);move.removeEventListener('pointercancel',cancel);move.removeEventListener('lostpointercapture',cancel);};
        const cancel=(e:PointerEvent)=>{if(e.pointerId!==event.pointerId)return;if(revision===this.revision)this.update(box.id,{x:original.x,y:original.y},false);node.style.left=`${original.x}px`;node.style.top=`${original.y}px`;done(e);};
        move.addEventListener('pointermove',onMove);move.addEventListener('pointerup',done);move.addEventListener('pointercancel',cancel);move.addEventListener('lostpointercapture',cancel);
      });
      move.addEventListener('keydown',event=>{const directions:Record<string,[number,number]>={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};const d=directions[event.key];if(!d)return;event.preventDefault();const b=this.boxes.find(b=>b.id===box.id)!;const step=event.shiftKey?20:5;const x=Math.max(0,Math.min(this.dimensions.width-b.width,b.x+d[0]*step)),y=Math.max(0,Math.min(this.dimensions.height-b.height,b.y+d[1]*step));this.update(box.id,{x,y});node.style.left=`${x}px`;node.style.top=`${y}px`;});
      const remove=document.createElement('button');remove.type='button';remove.textContent='Remove';remove.setAttribute('aria-label','Remove text box');
      remove.addEventListener('click',()=>{this.boxes=this.boxes.filter(b=>b.id!==box.id);this.change(this.boxes);if(this.selected===box.id)this.selected=null;this.render();this.syncToolbar();});
      const input=document.createElement('textarea');input.className='inkstone-page-text-input';input.value=box.text;input.readOnly=!this.enabled;input.tabIndex=this.enabled?0:-1;input.spellcheck=this.spellcheck;input.placeholder='Type here…';input.setAttribute('aria-label','Text on page');
      const highlights=document.createElement('div');highlights.className='inkstone-text-highlight-overlay';highlights.setAttribute('aria-hidden','true');
      const mirror=document.createElement('div');mirror.className='inkstone-text-highlight-content';highlights.append(mirror);
      input.addEventListener('focus',()=>{this.selected=box.id;this.defaults=this.currentStyle();this.syncToolbar();});
      input.addEventListener('scroll',()=>this.positionHighlights(node));
      input.maxLength=Math.min(10000,MAX_TEXT_LENGTH-this.boxes.reduce((n,b)=>n+(b.id===box.id?0:b.text.length),0));
      input.addEventListener('input',()=>{const remaining=MAX_TEXT_LENGTH-this.boxes.reduce((n,b)=>n+(b.id===box.id?0:b.text.length),0);if(input.value.length>remaining)input.value=input.value.slice(0,remaining);this.update(box.id,{text:input.value});this.markMatches(false);clearTimeout(this.spellingTimer);if(this.spellcheck)this.spellingTimer=setTimeout(()=>this.markMatches(),250);});
      for(const event of ['pointerdown','pointermove','pointerup','pointercancel','wheel'])node.addEventListener(event,e=>e.stopPropagation());
      controls.append(move,remove);node.append(controls,highlights,input);this.styleBox(node,box);this.layer.append(node);
      if(box.id===focus){this.selected=box.id;input.focus();this.syncToolbar();}
    }
    this.markMatches();this.position();
  }
  destroy():void {this.destroyed=true;clearTimeout(this.spellingTimer);this.cleanup.forEach(fn=>fn());this.layer.remove();this.toolbar.remove();}
}

/** Portable SVG text, escaped through DOM serialization rather than string interpolation. */
export function appendTextToSvg(svg:string,boxes:TextBox[]=[]):string {
  if(!boxes.length)return svg;
  const doc=new DOMParser().parseFromString(svg,'image/svg+xml');
  const ns='http://www.w3.org/2000/svg';const measure=document.createElement('canvas').getContext('2d');
  for(const box of boxes) {
    const group=doc.createElementNS(ns,'svg');group.setAttribute('x',String(box.x));group.setAttribute('y',String(box.y));group.setAttribute('width',String(box.width));group.setAttribute('height',String(box.height));group.setAttribute('overflow','hidden');
    const text=doc.createElementNS(ns,'text');text.setAttribute('fill',box.color);text.setAttribute('font-family',TEXT_FONTS[box.fontFamily??'sans']);text.setAttribute('font-size',String(box.fontSize));text.setAttribute('font-weight',box.bold?'700':'400');text.setAttribute('font-style',box.italic?'italic':'normal');text.setAttribute('text-anchor',box.textAlign==='center'?'middle':box.textAlign==='right'?'end':'start');
    if(measure)measure.font=`${box.italic?'italic ':''}${box.bold?'bold ':''}${box.fontSize}px ${TEXT_FONTS[box.fontFamily??'sans']}`;
    const lines:string[]=[];
    for(const paragraph of box.text.split('\n')) {let line='';for(const character of paragraph) {if(line && (measure?.measureText(line+character).width??(line.length+1)*box.fontSize*.6)>box.width-16){lines.push(line);line='';}line+=character;}lines.push(line);}
    for(const [index,line] of lines.entries()){const span=doc.createElementNS(ns,'tspan');span.setAttribute('x',String(box.textAlign==='center'?box.width/2:box.textAlign==='right'?box.width-8:8));span.setAttribute('y',String(8+box.fontSize+index*box.fontSize*(box.lineHeight??1.35)));span.textContent=line;text.append(span);}
    group.append(text);doc.documentElement.append(group);
  }
  return new XMLSerializer().serializeToString(doc);
}
