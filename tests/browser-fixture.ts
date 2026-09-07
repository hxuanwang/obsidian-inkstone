/** Browser-only QA harness. Synthetic ink never reads or writes user storage. */
import { InkEditor } from '../src/editor';
import { LocalRecognizer } from '../src/recognition';
import { createDocument, type InkDocument, type Stroke } from '../src/model';

const note = createDocument();
note.pages[0].title = 'HELLO OCR fixture';
note.pages[0].paper = 'blank';
const glyphs: number[][][] = [
  [[0, 0, 0, 70], [42, 0, 42, 70], [0, 35, 42, 35]],
  [[42, 0, 0, 0, 0, 70, 42, 70], [0, 35, 36, 35]],
  [[0, 0, 0, 70, 42, 70]],
  [[0, 0, 0, 70, 42, 70]],
  [[10, 0, 32, 0, 42, 10, 42, 60, 32, 70, 10, 70, 0, 60, 0, 10, 10, 0]],
];
let strokeId = 0;
for (let letter = 0; letter < glyphs.length; letter++) {
  for (const coordinates of glyphs[letter]) {
    const stroke: Stroke = { id: `fixture-${++strokeId}`, tool: 'pen', color: '#000000', width: 5, points: [] };
    for (let i = 0; i < coordinates.length; i += 2) {
      stroke.points.push({ x: 180 + letter * 64 + coordinates[i], y: 180 + coordinates[i + 1], pressure: .5, time: i });
    }
    note.pages[0].strokes.push(stroke);
  }
}
const status = document.getElementById('qa-status')!;
function persist(document: InkDocument) {
  // JSON round trip represents the exact saved document without disk/storage.
  const saved: InkDocument = JSON.parse(JSON.stringify(document));
  status.textContent = JSON.stringify({
    pages: saved.pages.length,
    pageDetails: saved.pages.map(page => ({
      id: page.id, title: page.title, strokes: page.strokes.length,
      textBoxes: page.textBoxes ?? [], text: page.text, transcript: page.transcript,
      recognitionWords: page.recognition?.words.length ?? 0,
    })),
  });
}
const recognizer = new LocalRecognizer(new URL('/ocr/', location.href).href);
const editor = new InkEditor(document.getElementById('app')!, {
  title: 'Inkstone browser QA', document: note,
  onRecognize: page => recognizer.recognize(page),
  onChange: persist,
  onExport: svg => {
    const output = document.getElementById('qa-export') as HTMLTextAreaElement;
    output.value = svg;
    document.getElementById('qa-export-status')!.textContent = `Exported SVG: ${svg.length} characters`;
  },
});
persist(note);
window.addEventListener('pagehide', () => { void recognizer.destroy(); });
void editor;
