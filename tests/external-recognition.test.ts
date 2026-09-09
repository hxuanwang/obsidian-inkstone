import test from 'node:test';
import assert from 'node:assert/strict';
import { ExternalRecognizer } from '../src/external-recognition';
import { createPage } from '../src/model';
import { inkSignature } from '../src/ink-signature';
import type { ProviderRequest } from '../src/ai-provider';
const config={aiEndpoint:'https://provider.example/v1/chat/completions',aiModel:'vision',aiKey:''};
const response={status:200,json:{choices:[{message:{content:'中文 $x^2$'}}]}};
function fixture() {
  const original=globalThis.document;
  const sizes:number[][]=[];
  globalThis.document={createElement:()=>{
    const canvas={width:0,height:0,getContext:()=>({fillRect(){},scale(){},translate(){},beginPath(){},arc(){},fill(){},moveTo(){},lineTo(){},stroke(){}}),toDataURL:()=>{sizes.push([canvas.width,canvas.height]);return 'data:image/png;base64,ink';}};
    return canvas;
  }} as unknown as Document;
  const page=createPage();page.strokes=[{id:'s',tool:'pen',color:'#000',width:3,points:[{x:100,y:100,pressure:.5,time:0},{x:140,y:120,pressure:.5,time:1}]}];
  return {page,sizes,restore:()=>{globalThis.document=original;}};
}
test('external OCR crops ink, deduplicates pending requests, preserves submitted signature, and reads fresh settings',async()=>{
  const {page,sizes,restore}=fixture();let finish!:(value:typeof response)=>void;let calls=0;let current={...config};
  const requests:ProviderRequest[]=[];
  const recognizer=new ExternalRecognizer(()=>current,request=>{calls++;requests.push(request);return new Promise(resolve=>{finish=resolve;});});
  try {
    const signature=inkSignature(page.strokes),first=recognizer.recognize(page),second=recognizer.recognize(page);
    assert.equal(first,second);assert.equal(calls,1);assert.ok(sizes[0][0]<400&&sizes[0][1]<400);
    page.strokes[0].points[0].x++;
    finish(response);assert.deepEqual(await first,{text:'中文 $x^2$',words:[],inkSignature:signature});
    current={...config,aiModel:'new-model'};
    const retry=recognizer.recognize(page);assert.equal(calls,2);assert.equal(JSON.parse(requests[1].body!).model,'new-model');finish(response);await retry;
  } finally {await recognizer.destroy();restore();}
});
test('external OCR sends no empty pages and destroy rejects pending requests without accepting late results',async()=>{
  const {page,restore}=fixture();let calls=0;
  const recognizer=new ExternalRecognizer(()=>config,async()=>{calls++;return new Promise(()=>{});});
  try {
    assert.equal((await recognizer.recognize(createPage())).text,'');assert.equal(calls,0);
    const pending=assert.rejects(recognizer.recognize(page),/closed/);
    await recognizer.destroy();await pending;
    await assert.rejects(recognizer.recognize(page),/closed/);
  } finally {await recognizer.destroy();restore();}
});
