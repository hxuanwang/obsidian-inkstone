import test from 'node:test';
import assert from 'node:assert/strict';
import { eraseStroke } from '../src/eraser';
import type { Stroke } from '../src/model';
const stroke: Stroke={id:'s',tool:'pen',color:'#123456',width:2,points:[{x:0,y:50,pressure:.5,time:0},{x:100,y:50,pressure:.5,time:100}]};
test('pixel eraser cuts a sparse crossing into independent pressure-preserving fragments',()=>{
  const fragments=eraseStroke(stroke,{x:50,y:0},{x:50,y:100},5,'pixel');
  assert.equal(fragments.length,2);
  assert.ok(Math.abs(fragments[0].points.at(-1)!.x-44.02)<.001);
  assert.ok(Math.abs(fragments[1].points[0].x-55.98)<.001);
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
  assert.equal(fragments[1].points.filter(p=>p.x===100).length,2);
});
