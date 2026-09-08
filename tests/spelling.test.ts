import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSpelling } from '../src/spelling';
import { HandwritingSpelling } from '../src/handwriting-spelling';
import { createPage } from '../src/model';
import { inkSignature } from '../src/ink-signature';

const dictionary=createSpelling(readFileSync('node_modules/dictionary-en/index.aff','utf8'),readFileSync('node_modules/dictionary-en/index.dic','utf8'));
test('English dictionary flags misspelled words and respects inflections, contractions, and scripts',()=>{
  const text="Hello, this is a speling mistkae. Running cats don't worry. 中文 español variable_name 123abc";
  const issues=dictionary.misspellings(text);
  assert.deepEqual(issues.map(i=>i.word),['speling','mistkae']);
  for(const issue of issues)assert.equal(text.slice(issue.start,issue.end),issue.word);
  assert.deepEqual(dictionary.misspellings('spelling mistake'),[]);
});

class Node {
  className=''; style:Record<string,string>={}; children:Node[]=[];
  ownerDocument={createElement:()=>new Node()};
  append(child:Node){this.children.push(child);} replaceChildren(){this.children=[];} setAttribute(){} remove(){}
}
test('handwriting spelling marks only dictionary errors on current OCR and follows the viewport',async()=>{
  const host=new Node(),view={x:5,y:8,zoom:2};
  const layer=new HandwritingSpelling(host as any,()=>view,async()=>dictionary);
  const page=createPage();page.transcript='hello speling';
  page.recognition={transcript:page.transcript,inkSignature:inkSignature(page.strokes),words:[
    {text:'hello',x:10,y:20,width:60,height:30},{text:'speling',x:80,y:20,width:90,height:30}]};
  layer.setEnabled(true);layer.setPage(page);await Promise.resolve();
  const overlay=host.children[0];assert.equal(overlay.children.length,1);
  assert.equal(overlay.children[0].style.left,'80px');
  assert.equal(overlay.style.transform,'translate(5px,8px) scale(2)');
  view.y=50;layer.position();assert.ok(overlay.style.transform.includes('50px'));
  layer.setPage({...page,transcript:'hello spelling'});assert.equal(overlay.children.length,0);
  layer.setPage({...page,strokes:[{id:'new',tool:'pen',color:'#000000',width:3,points:[{x:0,y:0,time:0,pressure:.5}]}]});
  assert.equal(overlay.children.length,0,'stale OCR positions are hidden');
  layer.setPage(page);assert.equal(overlay.children.length,1);
  layer.setEnabled(false);assert.equal(overlay.children.length,0);layer.destroy();
});
