import type { createWorker, Worker, PSM } from 'tesseract.js';

// Keep Tesseract initialization out of Obsidian startup and empty-page views.
const lazyCreateWorker: typeof createWorker = async (...args) => {
  const engine = await import('tesseract.js');
  return engine.createWorker(...args);
};
import { pageDimensions, type PageFormat, type InkPage, type Stroke, type RecognitionWord } from './model';

import { inkSignature } from './ink-signature';

export type RecognitionResult = { text: string; words: RecognitionWord[]; inkSignature: string };

/** Offline English OCR. Tesseract works best on separated, printed handwriting;
 * its output is a draft for review, never a replacement for the original ink. */
export class LocalRecognizer {
  private worker: Worker | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private readonly base: string;
  private rejectOperation: ((error: Error) => void) | undefined;

  constructor(resourceBase: string, private readonly workerFactory = lazyCreateWorker, private readonly timeoutMs = 120_000) {
    // Obsidian resource URLs may carry a cache query. Appending a filename after
    // that query requests the directory itself instead of the OCR asset.
    this.base = resourceBase.split(/[?#]/, 1)[0].replace(/\/$/, '');
  }

  private async runOperation<T>(operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const failure = new Promise<never>((_, reject) => {
      this.rejectOperation = reject;
      timer = setTimeout(() => reject(new Error('The OCR engine timed out. Try again or reopen the note.')), this.timeoutMs);
    });
    try { return await Promise.race([operation(), failure]); }
    finally { clearTimeout(timer); this.rejectOperation = undefined; }
  }

  recognize(page: InkPage): Promise<RecognitionResult> {
    if (this.closed) return Promise.reject(new Error('Text recognition has been closed. Reopen the note to try again.'));
    clearTimeout(this.idleTimer);
    // Preserve the exact submitted ink while an earlier page is being recognized.
    const signature = inkSignature(page.strokes);
    const format: PageFormat = { pageSize: page.pageSize, orientation: page.orientation };
    const strokes = page.strokes.filter(s => s.tool === 'pen').map(s => ({ ...s, points: s.points.map(p => ({ ...p })) }));
    const job = this.queue.then(async () => {
      if (this.closed) throw new Error('Text recognition was cancelled.');
      if (!strokes.length) return { text: '', words: [], inkSignature: signature };
      let canvas: HTMLCanvasElement | undefined;
      try {
        const crop = renderRecognitionCrop(strokes, format);
        canvas = crop.canvas;
        if (!this.worker) {
          let abandoned = false;
          try {
            this.worker = await this.runOperation(() => this.workerFactory('eng', 1 /* LSTM_ONLY */, {
              workerPath: `${this.base}/worker.min.js`,
              corePath: this.base,
              langPath: this.base,
              workerBlobURL: true,
              gzip: true,
              // Assets are already local; avoid a second, persistent model copy.
              cacheMethod: 'none',
              // v6 does not reject createWorker when language initialization fails.
              errorHandler: error => { if (!abandoned) this.rejectOperation?.(new Error(String(error))); },
            }).then(async worker => {
              if (abandoned || this.closed) { await worker.terminate(); throw new Error('Text recognition was cancelled.'); }
              return worker;
            }));
          } catch (error) { abandoned = true; throw error; }
        }
        if (this.closed) throw new Error('Text recognition was cancelled.');
        // Reset segmentation on every job: a previous low-confidence page may
        // have tried paragraph layout. Rendered pixels now carry 2× ink detail.
        await this.runOperation(() => this.worker!.setParameters({ tessedit_pageseg_mode: '11' as PSM /* SPARSE_TEXT */, user_defined_dpi: String(Math.round(150 * crop.scale)) }));
        let result = await this.runOperation(() => this.worker!.recognize(canvas!, {}, { text: true, blocks: true }));
        // Sparse text handles scattered notes; a paragraph pass can recover
        // connected lines it splits poorly. Never rewrite words via a dictionary.
        // Keep this to one extra pass, on the same bounded raster and worker.
        if (!result.data.text.trim() || (Number.isFinite(result.data.confidence) && result.data.confidence < 55)) {
          await this.runOperation(() => this.worker!.setParameters({ tessedit_pageseg_mode: '6' as PSM /* SINGLE_BLOCK */ }));
          const alternative = await this.runOperation(() => this.worker!.recognize(canvas!, {}, { text: true, blocks: true }));
          if (alternative.data.text.trim() && (!result.data.text.trim() || alternative.data.confidence > result.data.confidence)) result = alternative;
        }
        return { text: result.data.text.trim(), words: mapRecognitionWords(result.data.blocks, crop.left, crop.top, format, crop.scale), inkSignature: signature };
      } catch (error) {
        await this.releaseWorker();
        if (this.closed) throw new Error('Text recognition was cancelled.');
        throw new Error('Local English text recognition failed. Check that the plugin’s assets/ocr folder is installed, then try again. ' + (error instanceof Error ? error.message : String(error)));
      } finally {
        if (canvas) { canvas.width = 0; canvas.height = 0; }
      }
    });
    this.queue = job.catch(() => undefined).then(() => {
      // Most of the engine memory is released shortly after the user stops OCR.
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        this.queue = this.queue.then(() => this.releaseWorker());
      }, 30_000);
    });
    return job;
  }

  async destroy(): Promise<void> {
    this.closed = true;
    this.rejectOperation?.(new Error('Text recognition was cancelled.'));
    clearTimeout(this.idleTimer);
    await this.queue;
    clearTimeout(this.idleTimer);
    await this.releaseWorker();
  }

  private async releaseWorker(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate();
  }
}

/** Crop blank margins and rerender vector ink at higher resolution with a white border.
 * Highlighters and paper guides are deliberately omitted from the OCR image. */
export function renderRecognitionInk(strokes: Stroke[], format: PageFormat = {}): HTMLCanvasElement {
  return renderRecognitionCrop(strokes, format).canvas;
}

export function renderRecognitionCrop(strokes: Stroke[], format: PageFormat = {}): { canvas: HTMLCanvasElement; left: number; top: number; scale: number } {
  const { width, height } = pageDimensions(format);
  let left = width, right = 0, top = height, bottom = 0;
  const pens = strokes.filter(stroke => stroke.tool === 'pen' && stroke.points.length);
  for (const stroke of pens) for (const p of stroke.points) {
    left = Math.min(left, p.x - stroke.width); right = Math.max(right, p.x + stroke.width);
    top = Math.min(top, p.y - stroke.width); bottom = Math.max(bottom, p.y + stroke.width);
  }
  // Include whitespace beyond page edges too: tightly clipped letters are
  // easily mistaken for page borders by Tesseract. Boxes are clamped on return.
  left = Math.max(0, Math.min(width, Math.floor(left))) - 32;
  top = Math.max(0, Math.min(height, Math.floor(top))) - 32;
  right = Math.max(0, Math.min(width, Math.ceil(right))) + 32;
  bottom = Math.max(0, Math.min(height, Math.ceil(bottom))) + 32;
  const cropWidth = Math.max(64, right - left), cropHeight = Math.max(64, bottom - top);
  // Bound the raster to ~24 MB of RGBA even on a full A4 page. A vector
  // rerender preserves small pen curves instead of enlarging a blurry bitmap.
  const scale = Math.min(2, Math.sqrt(6_000_000 / (cropWidth * cropHeight)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(cropWidth * scale); canvas.height = Math.floor(cropHeight * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('A drawing canvas is unavailable.');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);
  ctx.translate(-left, -top);
  ctx.strokeStyle = '#000000'; ctx.fillStyle = '#000000'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const stroke of pens) {
    const first = stroke.points[0];
    if (!first) continue;
    ctx.lineWidth = Math.max(1, stroke.width * 0.8);
    if (stroke.points.length === 1) {
      ctx.beginPath(); ctx.arc(first.x, first.y, ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.beginPath(); ctx.moveTo(first.x, first.y);
      for (let i = 1; i < stroke.points.length; i++) ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
      ctx.stroke();
    }
  }
  return { canvas, left, top, scale };
}

/** Convert cropped raster pixels back to page units for ink search/spelling. */
type WordBlocks = readonly { paragraphs: readonly { lines: readonly { words: readonly {
  text: string; bbox: { x0: number; y0: number; x1: number; y1: number };
}[] }[] }[] }[];
export function mapRecognitionWords(blocks: WordBlocks | null, left: number, top: number, format: PageFormat = {}, scale = 1): RecognitionWord[] {
  const words: RecognitionWord[] = [];
  if (!Number.isFinite(scale) || scale <= 0) return words;
  const { width, height } = pageDimensions(format);
  for (const block of blocks ?? []) for (const paragraph of block.paragraphs) for (const line of paragraph.lines) for (const word of line.words) {
    const { x0, y0, x1, y1 } = word.bbox;
    if (!word.text.trim() || ![x0, y0, x1, y1, left, top].every(Number.isFinite) || x1 <= x0 || y1 <= y0) continue;
    const x = Math.max(0, x0 / scale + left), y = Math.max(0, y0 / scale + top);
    const right = Math.min(width, x1 / scale + left), bottom = Math.min(height, y1 / scale + top);
    if (right > x && bottom > y) words.push({ text: word.text, x, y, width: right - x, height: bottom - y });
  }
  return words;
}
