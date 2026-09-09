import type { Point, Stroke } from './model';
import { penRadius, penSegment, penTail } from './pen-rendering';
import { smoothInkSegment } from './geometry';
type XY = { x: number; y: number };
export type EraserMode = 'pixel' | 'object';

/** Use the same centerline as canvas/SVG. Fragments retain these vertices so
 * erasing does not fit a new curve through the surviving source samples. */
function* renderedPoints(stroke: Stroke): Generator<Point> {
  if (stroke.smoothing === 'none') { yield* stroke.points; return; }
  if (stroke.tool === 'pen') {
    if (!stroke.points.length) return;
    yield stroke.points[0];
    for (let i = 1; i < stroke.points.length; i++) yield* penSegment(stroke.points, i)!.points;
    yield* penTail(stroke.points)!.points;
  } else {
    for (let i = 0; i < stroke.points.length; i++)
      yield* smoothInkSegment(stroke.points[i], stroke.points[i - 1], stroke.points[i - 2]);
  }
}

/** Clip centerline segments against the swept eraser capsule. Retain pressure/time
 * at cut boundaries and separate surviving fragments so gaps never reconnect. */
export function eraseStroke(stroke: Stroke, from: XY, to: XY, radius: number, mode: EraserMode): Stroke[] {
  const vx = to.x - from.x, vy = to.y - from.y, length = vx * vx + vy * vy;
  const inkRadius = (p: Point) => stroke.tool === 'highlighter' ? stroke.width * .5 : penRadius(stroke.width, p.pressure);
  const mix = (a: Point, b: Point, t: number): Point => ({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,pressure:a.pressure+(b.pressure-a.pressure)*t,time:a.time+(b.time-a.time)*t});
  const distance = (p: XY) => {
    const t = length ? Math.max(0, Math.min(1, ((p.x-from.x)*vx+(p.y-from.y)*vy)/length)) : 0;
    return Math.hypot(p.x-from.x-t*vx,p.y-from.y-t*vy);
  };
  if (stroke.points.length === 1) return distance(stroke.points[0]) <= radius + inkRadius(stroke.points[0]) ? [] : [stroke];
  let changed = false, run: Point[] = [];
  const fragments: Point[][] = [];
  const finish = () => { if(run.length) fragments.push(run); run=[]; };
  let previous: Point | undefined;
  for (const point of renderedPoints(stroke)) {
    if (!previous) { previous = point; continue; }
    const a = previous, b = point; previous = point;
    const dx=b.x-a.x, dy=b.y-a.y;
    const r=radius+Math.max(inkRadius(a),inkRadius(b));
    const u=length?((a.x-from.x)*vx+(a.y-from.y)*vy)/length:0;
    const du=length?(dx*vx+dy*vy)/length:0;
    const breaks=[0,1];
    if(du) for(const edge of [0,1]) { const t=(edge-u)/du; if(t>0&&t<1)breaks.push(t); }
    breaks.sort((a,b)=>a-b);
    const cuts=[...breaks];
    for(let j=1;j<breaks.length;j++) {
      const lo=breaks[j-1],hi=breaks[j],projection=u+du*(lo+hi)/2;
      let x=a.x-from.x,y=a.y-from.y,sx=dx,sy=dy;
      if(length && projection>=0 && projection<=1) {x-=u*vx;y-=u*vy;sx-=du*vx;sy-=du*vy;}
      else if(projection>1) {x-=vx;y-=vy;}
      const A=sx*sx+sy*sy,B=2*(x*sx+y*sy),C=x*x+y*y-r*r;
      const discriminant=B*B-4*A*C;
      if(A>1e-12 && discriminant>=0) for(const t of [(-B-Math.sqrt(discriminant))/(2*A),(-B+Math.sqrt(discriminant))/(2*A)]) if(t>lo&&t<hi)cuts.push(t);
    }
    cuts.sort((a,b)=>a-b);
    for(let j=1;j<cuts.length;j++) {
      const lo=cuts[j-1],hi=cuts[j]; if(hi-lo<1e-10)continue;
      if(distance(mix(a,b,(lo+hi)/2))<=r) {changed=true;if(mode==='object')return [];finish();}
      else {if(!run.length)run.push(mix(a,b,lo));run.push(mix(a,b,hi));}
    }
  }
  finish();
  if(!changed)return [stroke];
  return fragments.map(points=>({...stroke,id:crypto.randomUUID(),points,smoothing:'none'}));
}
