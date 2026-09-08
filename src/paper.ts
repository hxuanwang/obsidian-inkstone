import { pageDimensions, pageColor, type PageFormat, type Paper } from './model';

export const PAPER_TEMPLATES: ReadonlyArray<{ value: Paper; label: string }> = [
  { value: 'blank', label: 'Blank' }, { value: 'ruled', label: 'Ruled' },
  { value: 'grid', label: 'Grid' }, { value: 'dots', label: 'Dots' },
  { value: 'cornell', label: 'Cornell notes' }, { value: 'music', label: 'Music staff' },
  { value: 'isometric', label: 'Isometric' }, { value: 'planner', label: 'Weekly planner' },
];
type Line = [number, number, number, number];
type Label = { text: string; x: number; y: number };
type Layout = { lines: Line[]; dots: [number, number][]; labels: Label[] };
const layouts = new Map<string, Layout>();
/** Shared geometry keeps canvas, thumbnails and exports consistent. */
export function paperLayout(paper: Paper, format: PageFormat = {}): Layout {
  const { width, height } = pageDimensions(format);
  const key = `${paper}:${width}:${height}`;
  const cached = layouts.get(key); if (cached) return cached;
  const lines: Line[] = [], dots: [number, number][] = [], labels: Label[] = [];
  const line = (x: number, y: number, x2: number, y2: number) => lines.push([x, y, x2, y2]);
  if (paper === 'dots') {
    for (let y = 40; y < height; y += 40) for (let x = 40; x < width; x += 40) dots.push([x, y]);
  } else if (paper === 'ruled' || paper === 'grid') {
    for (let y = paper === 'ruled' ? 100 : 40; y < height; y += 40) line(0, y, width, y);
    if (paper === 'grid') for (let x = 40; x < width; x += 40) line(x, 0, x, height);
  } else if (paper === 'cornell') {
    const cue = Math.round(width * 360 / 1400), summary = height - 400, right = width - 60;
    line(60, 160, right, 160); line(cue, 160, cue, summary); line(60, summary, right, summary);
    for (let y = 240; y < summary; y += 40) line(cue + 20, y, right, y);
    for (let y = summary + 100; y <= height - 80; y += 40) line(60, y, right, y);
    labels.push({ text: 'TOPIC / DATE', x: 60, y: 90 }, { text: 'CUES', x: 60, y: 205 }, { text: 'NOTES', x: cue + 20, y: 205 }, { text: 'SUMMARY', x: 60, y: summary + 50 });
  } else if (paper === 'music') {
    for (let top = 160; top + 72 <= height - 48; top += 180) {
      for (let row = 0; row < 5; row++) line(80, top + row * 18, width - 80, top + row * 18);
      line(80, top, 80, top + 72); line(width - 80, top, width - 80, top + 72);
    }
  } else if (paper === 'isometric') {
    const spacing = 40, slope = Math.sqrt(3);
    for (let x = 40; x < width; x += spacing) line(x, 0, x, height);
    for (const direction of [-1, 1]) {
      for (let intercept = -Math.ceil(width / spacing) * spacing * slope; intercept <= height + width * slope; intercept += spacing * slope) {
        const m = direction * slope;
        const x1 = Math.max(0, Math.min((0 - intercept) / m, (height - intercept) / m));
        const x2 = Math.min(width, Math.max((0 - intercept) / m, (height - intercept) / m));
        if (x1 < x2) line(x1, Math.max(0, Math.min(height, m * x1 + intercept)), x2, Math.max(0, Math.min(height, m * x2 + intercept)));
      }
    }
  } else if (paper === 'planner') {
    labels.push({ text: 'WEEK OF', x: 60, y: 90 });
    const days = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY', 'NOTES'];
    const columnWidth = (width - 120) / 2, rowHeight = (height - 220) / 4;
    for (let i = 0; i < days.length; i++) {
      const x = 60 + (i % 2) * columnWidth, y = 150 + Math.floor(i / 2) * rowHeight;
      line(x, y, x + columnWidth, y); line(x, y + rowHeight, x + columnWidth, y + rowHeight);
      line(x, y, x, y + rowHeight); line(x + columnWidth, y, x + columnWidth, y + rowHeight);
      labels.push({ text: days[i], x: x + 24, y: y + 42 });
      for (let offset = 110; offset < rowHeight - 20; offset += 50) line(x + 24, y + offset, x + columnWidth - 24, y + offset);
    }
  }
  const layout = { lines, dots, labels }; layouts.set(key, layout); return layout;
}

/** Draws the paper background and guides in page coordinates. */
export function drawPaper(context: CanvasRenderingContext2D, paper: Paper, format: PageFormat = {}): void {
  const layout = paperLayout(paper, format), { width, height } = pageDimensions(format);
  context.save();
  context.fillStyle = pageColor(format); context.fillRect(0, 0, width, height);
  context.strokeStyle = '#d8dcd8'; context.lineWidth = 1; context.beginPath();
  for (const [x, y, x2, y2] of layout.lines) { context.moveTo(x, y); context.lineTo(x2, y2); }
  context.stroke(); context.fillStyle = '#cbd2cc'; context.beginPath();
  for (const [x, y] of layout.dots) { context.moveTo(x + 1.4, y); context.arc(x, y, 1.4, 0, Math.PI * 2); }
  context.fill(); context.fillStyle = '#8a968e'; context.font = '18px sans-serif';
  for (const label of layout.labels) context.fillText(label.text, label.x, label.y);
  context.restore();
}
/** SVG background and guides, including the page fill. */
export function paperSvg(paper: Paper, format: PageFormat = {}): string {
  const { width, height } = pageDimensions(format);
  const layout = paperLayout(paper, format), n = (value: number) => Number(value.toFixed(2));
  return `<rect width="${width}" height="${height}" fill="${pageColor(format)}"/>` +
    `<g stroke="#d8dcd8" stroke-width="1" fill="none">${layout.lines.map(([x,y,x2,y2]) => `<path d="M${n(x)} ${n(y)}L${n(x2)} ${n(y2)}"/>`).join('')}</g>` +
    `<g fill="#cbd2cc">${layout.dots.map(([x,y]) => `<circle cx="${x}" cy="${y}" r="1.4"/>`).join('')}</g>` +
    `<g fill="#8a968e" font-family="sans-serif" font-size="18">${layout.labels.map(label => `<text x="${label.x}" y="${label.y}">${label.text}</text>`).join('')}</g>`;
}
