import { writeFileSync } from 'node:fs';
import { smoothInkSegment, inkSegmentOutline } from '../../src/geometry';
import type { Point } from '../../src/model';
const n = (v:number) => v.toFixed(3);
function draw(points:Point[], width:number, improved:boolean) {
  const parts:string[] = [];
  for (let i=0;i<points.length;i++) {
    let prev = points[i-1];
    for (const p of improved ? smoothInkSegment(points[i],prev,points[i-2]) : [points[i]]) {
      const r = width*(.18+p.pressure*.62);
      parts.push(`<circle cx="${n(p.x)}" cy="${n(p.y)}" r="${n(r)}"/>`);
      if (prev) {
        const pr=width*(.18+prev.pressure*.62), len=Math.hypot(p.x-prev.x,p.y-prev.y);
        let vertices;
        if(improved)vertices=inkSegmentOutline(prev,pr,p,r);
        else if(len>.001) {
          const nx=-(p.y-prev.y)/len,ny=(p.x-prev.x)/len;
          vertices=[{x:prev.x+nx*pr,y:prev.y+ny*pr},{x:p.x+nx*r,y:p.y+ny*r},{x:p.x-nx*r,y:p.y-ny*r},{x:prev.x-nx*pr,y:prev.y-ny*pr}];
        }
        if(vertices?.length)parts.push(`<path d="${vertices.map((v,j)=>`${j?'L':'M'}${n(v.x)} ${n(v.y)}`).join('')}Z"/>`);
      }
      prev=p;
    }
  }
  return `<g fill="#243247">${parts.join('')}</g>`;
}
const curve=Array.from({length:50},(_,i)=>({x:20+i*5,y:35+20*Math.sin(i*.2),pressure:.45+.35*Math.sin(i*.22),time:i}));
const pressure=Array.from({length:65},(_,i)=>({x:20+i*4,y:30+Math.sin(i*.11)*7,pressure:.15+.8*(.5+.5*Math.sin(i*.44)),time:i}));
const sharp=[[20,40],[65,40],[65,10],[110,10],[110,40],[160,10],[190,40],[230,40]].map(([x,y],i)=>({x,y,pressure:.5,time:i}));
let svg='<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="1400" viewBox="0 0 1400 1400"><rect width="1400" height="1400" fill="white"/><g font-family="Arial" fill="#243247"><text x="40" y="45" font-size="25">Inkstone stroke rendering · same samples · 2× zoom</text><text x="40" y="93" font-size="21">Before</text><text x="735" y="93" font-size="21">After</text></g><path d="M700 75V980" stroke="#ddd"/>';
for(const [row, entry] of [{points:curve,width:3,label:'Fine curved writing / varying pressure'}, {points:curve,width:9,label:'Thick curved writing / varying pressure'},{points:pressure,width:14,label:'Pressure transitions'},{points:sharp,width:5,label:'Sharp corners / constructed shapes'}].entries()) {
 const y=145+row*215;
 for(const improved of [false,true]){
  const x=improved?735:40;
  svg+=`<text x="${x}" y="${y}" font-family="Arial" font-size="17" fill="#687384">${entry.label}</text><g transform="translate(${x},${y+20}) scale(2)">${draw(entry.points,entry.width,improved)}</g>`;
 }
}
svg+='</svg>';
writeFileSync('output/stroke-review/before-after.svg',svg);
