import test from 'node:test';
import assert from 'node:assert/strict';
import { eraseStroke } from '../src/eraser';
import type { Stroke } from '../src/model';
const stroke: Stroke={id:'s',tool:'pen',color:'#123456',width:2,points:[{x:0,y:50,pressure:.5,time:0},{x:100,y:50,pressure:.5,time:100}]};
test('pixel eraser cuts a sparse crossing into independent pressure-preserving fragments',()=>{
  const fragments=eraseStroke(stroke,{x:50,y:0},{x:50,y:100},5,'pixel');
  assert.equal(fragments.length,2);
  // Half-pressure ink has radius .59; the swept eraser adds another 5.
  assert.ok(Math.abs(fragments[0].points.at(-1)!.x-44.41)<.001);
  assert.ok(Math.abs(fragments[1].points[0].x-55.59)<.001);
  assert.equal(fragments[0].points[0].x,0);assert.equal(fragments[1].points.at(-1)!.x,100);
  assert.notEqual(fragments[0].id,fragments[1].id);
  for(const fragment of fragments)for(const p of fragment.points){assert.equal(p.pressure,.5);assert.equal(p.x,p.time);}
  assert.equal(stroke.points.length,2);
});
test('object eraser removes the entire intersected stroke; misses preserve identity',()=>{
  assert.deepEqual(eraseStroke(stroke,{x:50,y:0},{x:50,y:100},5,'object'),[]);
  for(const mode of ['pixel','object'] as const)assert.equal(eraseStroke(stroke,{x:50,y:0},{x:50,y:10},5,mode)[0],stroke);
});
test('stationary pixel erasing clips round caps and handles dots and repeated points',()=>{
  assert.equal(eraseStroke(stroke,{x:50,y:50},{x:50,y:50},5,'pixel').length,2);
  const dot={...stroke,points:[stroke.points[0]]};
  assert.equal(eraseStroke(dot,{x:0,y:50},{x:0,y:50},5,'pixel').length,0);
  assert.equal(eraseStroke({...dot,points:[...dot.points,...dot.points]},{x:0,y:50},{x:0,y:50},5,'pixel').length,0);
  assert.equal(eraseStroke(stroke,{x:-10,y:50},{x:110,y:50},5,'pixel').length,0);
});
test('a curved stroke keeps separate gaps when the eraser crosses it repeatedly',()=>{
  const curve={...stroke,points:[...stroke.points,{x:100,y:100,pressure:.5,time:150},{x:0,y:100,pressure:.5,time:250}]};
  const fragments=eraseStroke(curve,{x:50,y:0},{x:50,y:150},5,'pixel');
  assert.equal(fragments.length,3);
  assert.ok(fragments[1].points.every(p => p.x !== 100 || (p.y > 50 && p.y < 100)), 'rounded corners do not regain the raw source edges');
  assert.ok(fragments.every(fragment => fragment.smoothing === 'none'));
});


test('eraser hits the visible rounded curve and ignores the discarded raw corner', () => {
  const curve: Stroke = { ...stroke, width: 1, points: [
    { x: 0, y: 0, pressure: 0.5, time: 0 },
    { x: 100, y: 0, pressure: 0.5, time: 10 },
    { x: 100, y: 100, pressure: 0.5, time: 20 },
  ] };
  // The quadratic at t=0.5 passes through (87.5,12.5), far from both raw edges.
  for (const mode of ['object', 'pixel'] as const) {
    assert.equal(eraseStroke(curve, { x: 100, y: 0 }, { x: 100, y: 0 }, 1, mode)[0], curve);
    const fragments = eraseStroke(curve, { x: 87.5, y: 12.5 }, { x: 87.5, y: 12.5 }, 1, mode);
    assert.equal(fragments.length, mode === 'pixel' ? 2 : 0);
    for (const fragment of fragments) {
      assert.equal(fragment.smoothing, 'none');
      assert.equal(eraseStroke(fragment, { x: 87.5, y: 12.5 }, { x: 87.5, y: 12.5 }, 1, mode)[0], fragment,
        'repeated erasing neither reshapes nor reopens the same cut');
    }
  }
});

test('pen dot erasing uses the same modest pressure radius as visible ink', () => {
  const dot = { ...stroke, width: 10, points: [{ x: 0, y: 0, pressure: 1, time: 0 }] };
  assert.equal(eraseStroke(dot, { x: 6, y: 0 }, { x: 6, y: 0 }, 0.5, 'object')[0], dot);
  assert.deepEqual(eraseStroke(dot, { x: 5.4, y: 0 }, { x: 5.4, y: 0 }, 0.5, 'object'), []);
});
