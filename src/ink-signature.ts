import type { Stroke } from './model';

/** Stable ink identity for OCR snapshots. Call at recognition/load boundaries,
 * never in the pointer event loop. No serialized copy of the ink is allocated. */
export function inkSignature(strokes: readonly Stroke[]): string {
  let a = 0x811c9dc5, b = 0x9e3779b9;
  const bytes = new DataView(new ArrayBuffer(8));
  const byte = (value: number) => {
    a = Math.imul(a ^ value, 0x01000193);
    b = Math.imul(b ^ value, 0x85ebca6b);
  };
  const number = (value: number) => {
    bytes.setFloat64(0, value, true);
    for (let i = 0; i < 8; i++) byte(bytes.getUint8(i));
  };
  const string = (value: string) => {
    number(value.length);
    for (let i = 0; i < value.length; i++) { const c = value.charCodeAt(i); byte(c & 255); byte(c >>> 8); }
  };
  number(strokes.length);
  for (const stroke of strokes) {
    string(stroke.id); string(stroke.tool); string(stroke.color); number(stroke.width); number(stroke.points.length);
    for (const p of stroke.points) { number(p.x); number(p.y); number(p.pressure); number(p.time); }
  }
  return `ink1-${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}
