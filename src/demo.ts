import { LocalRecognizer } from './recognition';
import { InkEditor } from './editor';
import { createDocument, parseDocument, type InkDocument } from './model';
const key = 'inkstone-demo-v1';
const host = document.getElementById('app')!;
const status = document.getElementById('demo-status')!;
let note: InkDocument = createDocument();
let timer: ReturnType<typeof setTimeout> | undefined;
let blocked = false;
try { const saved = localStorage.getItem(key); if (saved) note = parseDocument(saved); }
catch { blocked = true; status.textContent = 'Previous preview could not be read. Storage is protected; export your work.'; }
const recognizer = new LocalRecognizer(new URL('/ocr/', location.href).href);
const editor = new InkEditor(host, {
  onRecognize: page => recognizer.recognize(page),
  document: note, title: 'A little space to think',
  onChange: doc => { note = doc; status.textContent = blocked ? 'Export to keep these changes' : 'Saving preview…'; clearTimeout(timer); timer = setTimeout(save, 400); },
  onExport: svg => {
    const url = URL.createObjectURL(new Blob([svg], {type: 'image/svg+xml'}));
    const link = document.createElement('a'); link.href = url; link.download = 'Inkstone note.svg'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
});
function save() {
  if (blocked) return;
  try { localStorage.setItem(key, JSON.stringify(note)); status.textContent = 'Preview saved on this device'; }
  catch { status.textContent = 'Preview storage unavailable — export to keep your note'; }
}
document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
window.addEventListener('pagehide', save);
// Keep editor alive for the lifetime of this preview.
void editor;
