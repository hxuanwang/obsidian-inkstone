import type { Point } from './model';

export type PenSegment = { start: Point; points: Point[] };
const MAX_SAMPLES = 48;
const mix = (a: Point, b: Point, t: number): Point => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  pressure: a.pressure + (b.pressure - a.pressure) * t,
  time: a.time + (b.time - a.time) * t,
});
const midpoint = (a: Point, b: Point) => mix(a, b, 0.5);

/** A restrained pressure range adds natural variation without turning
 * ordinary handwriting into a broad calligraphy nib. A smooth response avoids visible steps when pressure changes slowly. */
export function penRadius(width: number, pressure: number): number {
  const p = Math.max(0, Math.min(1, Number.isFinite(pressure) ? pressure : 0.5));
  return Math.max(0, Number.isFinite(width) ? width : 0) * 0.5 * (0.75 + 0.25 * p * p * (3 - 2 * p));
}

function quadratic(start: Point, control: Point, end: Point): PenSegment {
  const length = Math.hypot(control.x - start.x, control.y - start.y) + Math.hypot(end.x - control.x, end.y - control.y);
  // Bounded work per incoming event, including long/sparse pointer segments.
  // Subdivide pressure too: a nearly stationary press should not jump in size.
  const pressureTravel = Math.abs(control.pressure - start.pressure) + Math.abs(end.pressure - control.pressure);
  const count = Math.min(MAX_SAMPLES, Math.max(2, Math.ceil(length / 1.25), Math.ceil(pressureTravel * 24)));
  const points = Array.from({ length: count }, (_, i) => {
    const t = (i + 1) / count;
    return i === count - 1 ? { ...end } : mix(mix(start, control, t), mix(control, end, t), t);
  });
  return { start: { ...start }, points };
}

/** Stable part of a streaming midpoint spline. Only three source samples
 * are read; adding another point never changes a segment already committed.
 * Adjacent segments share their endpoint and tangent in position AND pressure.
 * Source samples are retained unchanged for editing, erasing and persistence. */
export function penSegment(points: readonly Point[], index: number): PenSegment | null {
  if (!Number.isInteger(index) || index < 1 || index >= points.length) return null;
  const control = points[index - 1];
  const start = index === 1 ? control : midpoint(points[index - 2], control);
  return quadratic(start, control, midpoint(control, points[index]));
}

/** Temporary tip from the latest stable midpoint to the current Pencil
 * position. Draw separately while writing, then replace when a new sample
 * arrives. Include once when rendering a completed stroke. */
export function penTail(points: readonly Point[]): PenSegment | null {
  if (!points.length) return null;
  const end = points[points.length - 1];
  if (points.length === 1) return { start: { ...end }, points: [] };
  const start = midpoint(points[points.length - 2], end);
  return quadratic(start, midpoint(start, end), end);
}
