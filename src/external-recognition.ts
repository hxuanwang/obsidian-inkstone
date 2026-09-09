import { transcribeImage, type ProviderConfig, type ProviderTransport } from './ai-provider';
import { inkSignature } from './ink-signature';
import type { InkPage } from './model';
import { renderRecognitionCrop, type RecognitionResult } from './recognition';

/** Manual-only vision OCR. Background recognition must continue using LocalRecognizer.
 * Concurrent identical submissions share one request; completed drafts are not cached,
 * so an explicit retry can improve a poor result without retaining private page images. */
export class ExternalRecognizer {
  private closed=false;
  private jobs=new Map<string,{controller:AbortController;promise:Promise<RecognitionResult>}>();
  constructor(private config:()=>ProviderConfig,private transport:ProviderTransport) {}

  recognize(page:InkPage):Promise<RecognitionResult> {
    if(this.closed)return Promise.reject(new Error('Text recognition has been closed.'));
    const signature=inkSignature(page.strokes);
    const strokes=page.strokes.filter(stroke=>stroke.tool==='pen'&&stroke.points.length);
    if(!strokes.length)return Promise.resolve({text:'',words:[],inkSignature:signature});
    const config={...this.config()};
    const key=JSON.stringify([page.id,page.pageSize,page.orientation,signature,config.aiEndpoint,config.aiModel,config.aiKey]);
    const existing=this.jobs.get(key);if(existing)return existing.promise;
    const controller=new AbortController();
    // Rasterize synchronously before awaiting the provider, preserving submitted ink.
    let image:string;
    try {
      const {canvas}=renderRecognitionCrop(strokes,page);
      try {image=canvas.toDataURL('image/png');} finally {canvas.width=0;canvas.height=0;}
    } catch {return Promise.reject(new Error('Could not render handwriting for external recognition.'));}
    const promise=transcribeImage(config,image,'Recognize handwriting in its original language, including cursive and mathematical notation. Preserve all visible text and line order. Do not add commentary.',this.transport,controller.signal)
      .then(text=>({text,words:[],inkSignature:signature}))
      .finally(()=>{this.jobs.delete(key);});
    this.jobs.set(key,{controller,promise});
    return promise;
  }
  async destroy():Promise<void> {
    this.closed=true;
    const jobs=[...this.jobs.values()];
    for(const job of jobs)job.controller.abort();
    await Promise.allSettled(jobs.map(job=>job.promise));
    this.jobs.clear();
  }
}
