import test from 'node:test';
import assert from 'node:assert/strict';
import { recognizeShape, enclosedStrokes, pointInPolygon } from '../src/geometry';
import type { Point, Stroke } from '../src/model';
const points = (values: number[][]): Point[] => values.map(([x,y], time) => ({ x, y, time, pressure: 0.5 }));
const polygon = points([[0,0],[200,0],[200,200],[0,200]]);

test('lasso includes boundary dots and excludes partly enclosed strokes', () => {
  const stroke = (id: string, values: number[][]): Stroke => ({ id, points: points(values), tool: 'pen', color: '#123456', width: 3 });
  assert.equal(pointInPolygon({x: 100, y: 100}, polygon), true);
  assert.deepEqual(enclosedStrokes([stroke('dot', [[0,100]]), stroke('inside', [[20,20],[100,100]]), stroke('crossing', [[100,100],[210,100]])], polygon), ['dot','inside']);
  assert.deepEqual(enclosedStrokes([stroke('dot', [[0,100]])], []), []);
});

test('shape recognition handles clean and approximate closed geometry', () => {
  assert.equal(recognizeShape(points([[0,0],[40,1],[100,0]]))?.length, 2);
  const rectangle = recognizeShape(points([[0,0],[50,1],[100,0],[101,100],[0,101],[0,2]]));
  assert.equal(rectangle?.length, 5);
  const triangle = recognizeShape(points([[0,100],[50,0],[100,100],[0,100]]));
  assert.equal(triangle?.length, 4);
  const ellipse = Array.from({ length: 49 }, (_,i) => [100+80*Math.cos(i*Math.PI/24), 100+45*Math.sin(i*Math.PI/24)]);
  assert.equal(recognizeShape(points(ellipse))?.length, 97);
});

test('recognition keeps arbitrary scribbles and open curves unchanged', () => {
  assert.equal(recognizeShape(points([[0,0],[100,100],[0,100],[100,0],[0,0]])), null);
  assert.equal(recognizeShape(points([[0,0],[50,30],[100,0]])), null);
  assert.equal(recognizeShape(points([[0,0],[1,1]])), null);
});

const oval = (angle: number, noisy = false, clockwise = false): Point[] => points(Array.from({ length: 121 }, (_, i) => {
  const t = (clockwise ? -1 : 1) * (i/120)**1.6 * Math.PI*2 + 0.8;
  const jitter = noisy ? 1 + 0.035*Math.sin(i*1.7) : 1;
  const x = 100*Math.cos(t)*jitter, y = 40*Math.sin(t)*jitter;
  return [200+x*Math.cos(angle)-y*Math.sin(angle), 200+x*Math.sin(angle)+y*Math.cos(angle)];
}));

test('rotated ovals tolerate Pencil jitter and uneven drawing speed', () => {
  for (const angle of [0, 0.3, 0.7, 1.2]) for (const clockwise of [false, true]) {
    const input = oval(angle, true, clockwise);
    const clean = recognizeShape(input);
    assert.equal(clean?.length, 97, `${angle}, clockwise=${clockwise}`);
    assert.deepEqual({ x: clean![0].x, y: clean![0].y }, { x: clean!.at(-1)!.x, y: clean!.at(-1)!.y });
    assert.ok(Math.hypot(clean![0].x-input[0].x, clean![0].y-input[0].y) < 7, 'preserve where the shape starts');
    const first = clean![0], next = clean![1];
    const turn = (first.x-200)*(next.y-200)-(first.y-200)*(next.x-200);
    assert.equal(Math.sign(turn), clockwise ? -1 : 1, 'preserve drawing direction');
    assert.ok(clean!.every(p => [p.x, p.y, p.pressure, p.time].every(Number.isFinite)));
  }
});

test('oval fit rejects open arcs, retraced loops and invalid input', () => {
  const loop = oval(0.7);
  assert.equal(recognizeShape(loop.slice(0, 100)), null);
  assert.equal(recognizeShape([...loop.slice(0, 61), ...loop.slice(30, 60).reverse(), ...loop.slice(30)]), null);
  assert.equal(recognizeShape(loop.map((p, i) => i === 12 ? { ...p, x: NaN } : p)), null);
});
