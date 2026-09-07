import type { Point, Stroke } from './model';
export type XY = { x: number; y: number };
const distance = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y);
export function pointSegmentDistance(p: XY, a: XY, b: XY): number {
  const length = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / length)) : 0;
  return distance(p, { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
}
export function pointInPolygon(point: XY, polygon: XY[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if (pointSegmentDistance(point, a, b) < 0.001) return true;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
export function enclosedStrokes(strokes: Stroke[], polygon: XY[]): string[] {
  if (polygon.length < 3) return [];
  return strokes.filter(stroke => stroke.points.every((p, i) => {
    if (!pointInPolygon(p, polygon)) return false;
    const previous = stroke.points[Math.max(0, i - 1)];
    // Sample sparse segments so a stroke crossing a concave boundary is not selected.
    const steps = Math.ceil(distance(previous, p) / 4);
    for (let n = 1; n < steps; n++) if (!pointInPolygon({ x: previous.x + (p.x - previous.x) * n / steps, y: previous.y + (p.y - previous.y) * n / steps }, polygon)) return false;
    return true;
  })).map(stroke => stroke.id);
}
function simplify(points: XY[], epsilon: number): XY[] {
  if (points.length <= 2) return points;
  let maximum = 0, index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = pointSegmentDistance(points[i], points[0], points[points.length - 1]);
    if (d > maximum) { maximum = d; index = i; }
  }
  if (maximum <= epsilon) return [points[0], points[points.length - 1]];
  return [...simplify(points.slice(0, index + 1), epsilon).slice(0, -1), ...simplify(points.slice(index), epsilon)];
}
/** Equal travel samples keep pauses and varying Pencil speed from biasing a fit. */
function resampleLoop(points: XY[], count = 128): XY[] {
  const loop = [...points, points[0]];
  const lengths = [0];
  for (let i = 1; i < loop.length; i++) lengths.push(lengths[i - 1] + distance(loop[i - 1], loop[i]));
  let segment = 1;
  return Array.from({ length: count }, (_, i) => {
    const target = lengths[lengths.length - 1] * i / count;
    while (segment < loop.length - 1 && lengths[segment] < target) segment++;
    const fraction = (target - lengths[segment - 1]) / (lengths[segment] - lengths[segment - 1] || 1);
    const a = loop[segment - 1], b = loop[segment];
    return { x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction };
  });
}
/** Conservative geometric recognition; returns null for handwriting or ambiguous scribbles. */
export function recognizeShape(points: Point[]): Point[] | null {
  if (points.length < 2 || points.some(p => ![p.x, p.y, p.pressure, p.time].every(Number.isFinite))) return null;
  // Recognition runs only at lift; bound its work for unusually long gestures.
  if (points.length > 1024) { const source = points; points = Array.from({ length: 1024 }, (_, i) => source[Math.round(i * (source.length - 1) / 1023)]); }
  const first = points[0], last = points[points.length - 1];
  const length = points.slice(1).reduce((sum, p, i) => sum + distance(p, points[i]), 0);
  const span = distance(first, last);
  const left = Math.min(...points.map(p => p.x)), right = Math.max(...points.map(p => p.x));
  const top = Math.min(...points.map(p => p.y)), bottom = Math.max(...points.map(p => p.y));
  const diagonal = Math.hypot(right - left, bottom - top);
  const pressure = points.reduce((sum, p) => sum + p.pressure, 0) / points.length;
  const result = (vertices: XY[]) => vertices.map((p, i) => ({ ...p, pressure, time: first.time + (last.time - first.time) * i / Math.max(1, vertices.length - 1) }));
  if (span > 18 && length / span < 1.12 && points.every(p => pointSegmentDistance(p, first, last) <= Math.max(2, span * 0.035))) return result([first, last]);
  if (diagonal < 25 || span > diagonal * 0.18 || length < diagonal * 1.7 || length > diagonal * 3.6) return null;
  let vertices = simplify([...points, first], diagonal * 0.045).slice(0, -1);
  // A stroke may begin midway down an edge; remove that redundant closing vertex.
  if (vertices.length > 3 && pointSegmentDistance(vertices[0], vertices[vertices.length - 1], vertices[1]) < diagonal * 0.06) vertices = vertices.slice(1);
  if (vertices.length === 3) {
    const area = Math.abs(vertices.reduce((sum, p, i) => { const q = vertices[(i + 1) % 3]; return sum + p.x * q.y - q.x * p.y; }, 0)) / 2;
    if (area > diagonal * diagonal * 0.08) return result([...vertices, vertices[0]]);
  }
  if (vertices.length === 4) {
    const corners = vertices.every((p, i) => {
      const a = vertices[(i + 3) % 4], b = vertices[(i + 1) % 4];
      return Math.abs(((a.x - p.x) * (b.x - p.x) + (a.y - p.y) * (b.y - p.y)) / (distance(a, p) * distance(b, p))) < 0.25;
    });
    if (corners) {
      const center = { x: vertices.reduce((s, p) => s + p.x, 0) / 4, y: vertices.reduce((s, p) => s + p.y, 0) / 4 };
      const angle = Math.atan2(vertices[1].y - vertices[0].y, vertices[1].x - vertices[0].x);
      const u = { x: Math.cos(angle), y: Math.sin(angle) }, v = { x: -Math.sin(angle), y: Math.cos(angle) };
      const w = (distance(vertices[0], vertices[1]) + distance(vertices[2], vertices[3])) / 4;
      const h = (distance(vertices[1], vertices[2]) + distance(vertices[3], vertices[0])) / 4;
      const clean = [[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,y]) => ({ x: center.x + x*w*u.x + y*h*v.x, y: center.y + x*w*u.y + y*h*v.y }));
      return result([...clean, clean[0]]);
    }
  }
  // Fit in the trace's principal axes so a tilted oval is still an oval.
  const samples = resampleLoop(points);
  const mean = samples.reduce((sum, p) => ({ x: sum.x + p.x / samples.length, y: sum.y + p.y / samples.length }), { x: 0, y: 0 });
  let xx = 0, yy = 0, xy = 0;
  for (const p of samples) { const x = p.x - mean.x, y = p.y - mean.y; xx += x*x; yy += y*y; xy += x*y; }
  const angle = Math.atan2(2*xy, xx-yy) / 2;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const project = (p: XY) => ({ x: (p.x-mean.x)*cos + (p.y-mean.y)*sin, y: -(p.x-mean.x)*sin + (p.y-mean.y)*cos });
  const local = samples.map(project);
  const minX = Math.min(...local.map(p => p.x)), maxX = Math.max(...local.map(p => p.x));
  const minY = Math.min(...local.map(p => p.y)), maxY = Math.max(...local.map(p => p.y));
  const rx = (maxX-minX)/2, ry = (maxY-minY)/2, cx = (minX+maxX)/2, cy = (minY+maxY)/2;
  if (rx < 10 || ry < 10 || points.length < 12) return null;
  const errors = local.map(p => Math.abs(Math.hypot((p.x-cx)/rx, (p.y-cy)/ry) - 1));
  if (Math.max(...errors) > 0.28 || errors.reduce((sum, error) => sum+error*error, 0)/errors.length > 0.01) return null;
  // Check the actual trace, not only the fit: a loop with backtracking is ambiguous.
  const trace = points.map(project);
  let winding = 0, travel = 0;
  for (let i = 1; i < trace.length; i++) {
    let d = Math.atan2((trace[i].y-cy)/ry, (trace[i].x-cx)/rx) - Math.atan2((trace[i-1].y-cy)/ry, (trace[i-1].x-cx)/rx);
    if (d > Math.PI) d -= Math.PI*2; if (d < -Math.PI) d += Math.PI*2;
    winding += d; travel += Math.abs(d);
  }
  if (Math.abs(Math.abs(winding) - Math.PI*2) > 0.65 || travel > Math.PI*2*1.2) return null;
  const start = Math.atan2((trace[0].y-cy)/ry, (trace[0].x-cx)/rx);
  const clean = Array.from({ length: 96 }, (_, i) => {
    const theta = start + Math.sign(winding)*i*Math.PI*2/96;
    const x = cx+rx*Math.cos(theta), y = cy+ry*Math.sin(theta);
    return { x: mean.x+x*cos-y*sin, y: mean.y+x*sin+y*cos };
  });
  return result([...clean, clean[0]]);
}
