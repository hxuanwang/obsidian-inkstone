import test from 'node:test';
import assert from 'node:assert/strict';
import { penRadius, penSegment, penTail } from '../src/pen-rendering';
import type { Point } from '../src/model';

const trace: Point[] = [
  { x: 0, y: 0, pressure: 0.1, time: 0 },
  { x: 20, y: 0, pressure: 0.4, time: 10 },
  { x: 20, y: 20, pressure: 0.9, time: 20 },
  { x: 40, y: 20, pressure: 0.3, time: 30 },
];

test('freehand midpoint curves round sparse corners with continuous position and pressure', () => {
  const a = penSegment(trace, 1)!;
  const b = penSegment(trace, 2)!;
  const c = penSegment(trace, 3)!;
  assert.deepEqual(a.start, trace[0]);
  assert.deepEqual(a.points.at(-1), b.start);
  assert.deepEqual(b.points.at(-1), c.start);
  assert.ok(b.points.some(p => p.x > 15 && p.y > 1 && p.y < 9), 'curve rounds the corner instead of drawing two straight edges');
  assert.ok(b.points.every(p => p.x >= 10 && p.x <= 20 && p.y >= 0 && p.y <= 10));
  const before = a.points.at(-2)!;
  const after = b.points[0];
  assert.ok(Math.abs((a.points.at(-1)!.y - before.y) - (after.y - b.start.y)) < 0.15, 'joined tangents do not form a visible corner');
  for (const segment of [a, b, c]) {
    const samples = [segment.start, ...segment.points];
    for (let i = 1; i < samples.length; i++) assert.ok(Math.abs(samples[i].pressure - samples[i - 1].pressure) < 0.05);
  }
});

test('tip reaches the actual Pencil position and committed segments never change', () => {
  const original = structuredClone(trace);
  const segment = penSegment(trace.slice(0, 3), 2)!;
  assert.deepEqual(segment, penSegment(trace, 2));
  const tail = penTail(trace)!;
  assert.deepEqual(penSegment(trace, 3)!.points.at(-1), tail.start);
  assert.deepEqual(tail.points.at(-1), trace.at(-1));
  assert.deepEqual(trace, original);
  assert.equal(penTail([]), null);
  assert.deepEqual(penTail([trace[0]]), { start: trace[0], points: [] });
  assert.equal(penSegment(trace, 0), null);
  assert.equal(penSegment(trace, 4), null);
});

test('pressure produces subtle width variation without discontinuities', () => {
  assert.ok(penRadius(3, 0.75) / penRadius(3, 0.2) > 1.1);
  assert.ok(penRadius(3, 1) / penRadius(3, 0) <= 4 / 3);
  assert.equal(penRadius(3, 1), 1.5);
  let previous = penRadius(3, 0);
  for (let i = 1; i <= 100; i++) {
    const radius = penRadius(3, i / 100);
    assert.ok(radius >= previous && radius - previous < 0.018);
    previous = radius;
  }
  assert.equal(penRadius(3, -1), penRadius(3, 0));
  assert.equal(penRadius(3, 5), penRadius(3, 1));
  assert.equal(penRadius(3, NaN), penRadius(3, 0.5));
});

test('very sparse and stationary samples keep bounded finite rendering work', () => {
  for (const x of [0, 1e6]) {
    const points = [{ ...trace[0] }, { ...trace[1], x, y: 0 }, { ...trace[2], x, y: 0 }];
    for (const segment of [penSegment(points, 1)!, penSegment(points, 2)!, penTail(points)!]) {
      assert.ok(segment.points.length <= 48);
      assert.ok(segment.points.every(p => Object.values(p).every(Number.isFinite)));
      assert.ok(segment.points.every(p => p.pressure >= 0.1 && p.pressure <= 0.9));
    }
  }
});
