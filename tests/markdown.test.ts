import test from 'node:test';
import assert from 'node:assert/strict';
import { notebookMarkdown, readVisionResponse, visionRequest } from '../src/markdown';
import { createDocument } from '../src/model';
import { parseSettings } from '../src/settings';
test('Markdown export retains LaTeX and typed content across notebook pages',()=>{
  const doc=createDocument();doc.pages[0].text='A formula: $x^2$';doc.pages[0].transcript='$$\n\\frac{a}{b}\n$$';
  const output=notebookMarkdown(doc,'Math.inkstone');
  assert.ok(output.includes('[[Math.inkstone]]'));assert.ok(output.includes('$x^2$'));assert.ok(output.includes('\\frac{a}{b}'));
});
test('AI responses reject empty, truncated and invalid output and unwrap Markdown only',()=>{
  assert.equal(readVisionResponse({choices:[{message:{content:'```markdown\n$x^2$\n```'}}]}),'$x^2$');
  assert.equal(readVisionResponse({choices:[{message:{content:'```md\r\n$x^2$\r\n```'}}]}),'$x^2$');
  assert.equal(readVisionResponse({choices:[{message:{content:'```python\nprint(1)\n```'}}]}),'```python\nprint(1)\n```');
  for(const response of [null,{}, {choices:{0:{message:{content:'invalid choices'}}}}, {choices:[{message:{content:[]}}]}, {choices:[{finish_reason:'length',message:{content:'partial'}}]}])assert.throws(()=>readVisionResponse(response));
  for(const content of ['```markdown\n```','```md\n\n```','```\n   \n```','```markdown\r\n\r\n```'])assert.throws(()=>readVisionResponse({choices:[{message:{content}}]}),/empty or invalid/);
  const request=visionRequest('vision','data:image/png;base64,abc') as any;
  assert.equal(request.messages[0].content[1].image_url.url,'data:image/png;base64,abc');
});
test('settings recover from obsolete or invalid saved values',()=>{
  assert.equal(parseSettings(null).eraserMode,'object');
  const settings=parseSettings({eraserMode:'wrong',toolbarSize:'wrong',doubleTap:'wrong',aiKey:42} as any);
  assert.equal(settings.eraserMode,'object');assert.equal(settings.toolbarSize,'system');assert.equal(settings.doubleTap,'eraser');assert.equal(settings.aiKey,'');
});
