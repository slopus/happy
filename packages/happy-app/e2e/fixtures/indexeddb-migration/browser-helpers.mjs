import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
export const output = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../test-results/indexeddb-migration');
export const runtime = JSON.parse(await fs.readFile(path.join(output, 'runtime.json'), 'utf8'));
export async function control(action) {
 const response=await fetch(`${runtime.controllerUrl}/${action}`,{method:'POST'});assert(response.ok);return response.json();
}
export async function metrics() { const response=await fetch(`${runtime.controllerUrl}/metrics`);assert(response.ok);return response.json(); }
export async function persisted(account='A') { const response=await fetch(`${runtime.controllerUrl}/persisted?account=${account}`);assert(response.ok);return response.json(); }
export async function authenticate(page,label='A') {
 const account=runtime.accounts.find(a=>a.label===label);
 const url=(await fs.readFile(account.authUrlFile,'utf8')).trim();
 await page.goto(url);
 await page.waitForFunction(()=>!location.search&&!document.body.innerText.includes('正在恢复本地数据'),undefined,{timeout:30000});
 await page.goto(`${runtime.webUrl}/session/${account.sessionId}`);
 await page.waitForSelector('textarea',{state:'visible',timeout:30000});
 return account;
}

export async function result(id,detail) {
 const file=path.join(output,'cases.json');
 const cases=await fs.readFile(file,'utf8').then(JSON.parse,()=>[]);
 cases.push({id,at:new Date().toISOString(),...detail});await fs.writeFile(file,JSON.stringify(cases,null,2));
}
export async function videoFrame(task,page,targetId,expectedUrl,label) {
 assert((await task.tabs()).some(t=>t.targetId===targetId&&t.url===expectedUrl),'Pinned video page changed');
 const folder=path.join(output,'video-frames');await fs.mkdir(folder,{recursive:true});
 const manifest=path.join(folder,'frames.json');const frames=await fs.readFile(manifest,'utf8').then(JSON.parse,()=>[]);
 const filename=`${String(frames.length).padStart(3,'0')}.jpg`;
 const frame=await page.cdp('Page.captureScreenshot',{format:'jpeg',quality:85,captureBeyondViewport:false});
 await fs.writeFile(path.join(folder,filename),Buffer.from(frame.data,'base64'));frames.push({filename,label});await fs.writeFile(manifest,JSON.stringify(frames,null,2));
}
export async function clickTextButton(page,labels) {
 const matches=await page.evaluate(labels=>[...document.querySelectorAll('button')].map((n,index)=>({index,text:n.innerText.replace(/[\uE000-\uF8FF]/g,'').trim(),visible:n.checkVisibility()})).filter(n=>n.visible&&labels.includes(n.text)),labels);
 assert.equal(matches.length,1,`Expected one button: ${labels.join('/')}`);
 await page.click(`loc=css:button >> nth=${matches[0].index}`);
}
