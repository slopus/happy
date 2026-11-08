/** Run through ego-browser nodejs; records the real, already-verified native path. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
export async function run(context){
 const {taskSpace,cdp,pageInfo,currentTab,listTaskSpaces,useOrCreateTaskSpace}=context;
 const output=fileURLToPath(new URL('../../../test-results/artifact-history/',import.meta.url));
 const replay=JSON.parse(await fs.readFile(path.join(output,'replay.json'),'utf8'));
 const runtime=JSON.parse(await fs.readFile(path.join(output,'runtime.json'),'utf8'));assert(runtime.nodeBinary);
 const nativeEvents=new EventEmitter();let buffered='';
 const observer=spawn(runtime.nodeBinary,[fileURLToPath(new URL('./observe-turns.mjs',import.meta.url))],{stdio:['ignore','pipe','pipe']});
 observer.stdout.on('data',data=>{buffered+=data;for(let newline;(newline=buffered.indexOf('\n'))>=0;){const line=buffered.slice(0,newline);buffered=buffered.slice(newline+1);const event=JSON.parse(line);nativeEvents.emit(event.ready?'ready':'update',event);}});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Recording observer connection timed out')),10000);nativeEvents.once('ready',()=>{clearTimeout(timer);resolve();});observer.once('error',reject);}).catch(error=>{observer.kill('SIGTERM');throw error;});
 const task=await taskSpace(79),page=task.page('p1');
 const targetId='364E03533903C2814BFCC166B973E5FE';
 assert.equal((await task.tabs()).find(t=>t.label==='p1')?.targetId,targetId);assert.equal(await page.url(),replay.url);
 const frames=path.join(output,'native-replay-frames-'+replay.sessionId);await fs.mkdir(frames,{recursive:true});
 const timeline=[],steps=[];let stopped=false,recordingError=null;
 const pause=ms=>new Promise(r=>setTimeout(r,ms));
 const progress=label=>{console.log('TASK5_PROGRESS '+label);steps.push({label,time:Date.now()});};
 const privacy=()=>{const install=()=>{if(!document.head)return;let s=document.getElementById('task5-privacy');if(!s){s=document.createElement('style');s.id='task5-privacy';s.textContent='[aria-label^="Working directory:"],[aria-label^="Machine:"],[title^="Machine:"]{visibility:hidden!important}';document.head.append(s);}for(const x of document.querySelectorAll('div'))if(x.childElementCount===0&&(x.textContent?.includes('/Volumes/')||x.textContent==='jackydeMac-mini.local'))x.style.visibility='hidden';};new MutationObserver(install).observe(document,{childList:true,subtree:true});install();};
 await page.cdp('Emulation.setDeviceMetricsOverride',{width:1680,height:960,deviceScaleFactor:1,mobile:false});
 const script=await page.cdp('Page.addScriptToEvaluateOnNewDocument',{source:'('+privacy.toString()+')()'});await page.evaluate(privacy);
 await page.events();await page.cdp('Page.startScreencast',{format:'jpeg',quality:80,maxWidth:1680,maxHeight:960,everyNthFrame:1});
 // This timer drains recording frames only. It never queries business state.
 const pump=(async()=>{while(!stopped){for(const event of await page.events())if(event.method==='Page.screencastFrame'){
  const n=String(timeline.length).padStart(6,'0'),file=path.join(frames,n+'.jpg');await fs.writeFile(file,Buffer.from(event.params.data,'base64'));timeline.push({file,timestamp:event.params.metadata.timestamp});await page.cdp('Page.screencastFrameAck',{sessionId:event.params.sessionId});
 }await pause(150);}})().catch(e=>{recordingError=e;});
 const {captureVerifiedBrowserStep}=await import('file:///Users/jacky/Deployments/paws-cli/releases/external-session-reads-83e8c991-20261107/packages/happy-cli/scripts/capture-browser-step.mjs');
 const frame=async label=>{assert.equal(await page.url(),replay.url);await pause(900);const result=await captureVerifiedBrowserStep({cdp,pageInfo,currentTab,listTaskSpaces,useOrCreateTaskSpace},replay.url,{sessionId:'cmw6bt8ug0c8nmga80groqknd',runId:'task5-native-history-20261108-0b5cb740',skillName:'ego-browser',taskSpaceId:79,targetId});console.log('TASK5_FRAME '+JSON.stringify({label,...result}));progress(label);};
 const send=async(text,complete)=>{
  let listener,timer;const done=new Promise((resolve,reject)=>{let started=false;timer=setTimeout(()=>reject(new Error('Native model did not complete')),180000);listener=event=>{const status=event.status;if(status==='running')started=true;if(started&&['completed','failed','cancelled'].includes(status)){clearTimeout(timer);status==='completed'?resolve():reject(new Error('Native turn '+status));}};nativeEvents.on('update',listener);});
  try{await page.fill('loc=css:textarea[placeholder="Type a message ..."]',text);await page.click('loc=role:button[name="Send message"]');await pause(300);if((await page.snapshot()).includes('Not sent or delivery uncertain.'))throw new Error('The UI queue refused delivery before native execution');await done;await page.waitForSelector('text="'+complete+'"',{timeout:15000});}
  finally{clearTimeout(timer);nativeEvents.off('update',listener);}
 };
 const file=relative=>'loc=css:button[aria-label="'+replay.project+'/'+relative+'"]';
 const open=async relative=>{const selector=file(relative);if(!await page.evaluate(s=>!!document.querySelector(s),selector.slice('loc=css:'.length))){const parent=file(relative.split('/')[0]);await page.waitForSelector(parent);await page.click(parent);await page.waitForSelector(selector);}await page.click(selector);await page.waitForSelector('loc=css:[data-testid="workspace-history-open"]');};
 const history=async()=>{await page.click('loc=css:[data-testid="workspace-history-open"]');await page.waitForSelector('loc=css:[data-testid="workspace-history-panel"]');};
 const close=()=>page.click('loc=css:[data-testid="workspace-history-close"]');
 const register=async(relative,paths)=>{await open(relative);await history();await page.waitForSelector('loc=css:[data-testid="workspace-history-paths"]');await page.fill('loc=css:[data-testid="workspace-history-paths"]',paths.join('\n'));await page.click('loc=css:[data-testid="workspace-history-register"]');await page.waitForSelector('text="V1 · Current"');await close();};
 const select=async sequence=>{await page.click('loc=role:button[name="V'+sequence+'"]');await page.waitForFunction(()=>{const b=document.querySelector('[data-testid="workspace-history-restore"]');return b&&b.getAttribute('aria-disabled')!=='true';},undefined,{timeout:20000});};
 const restore=async()=>{await page.click('loc=css:[data-testid="workspace-history-restore"]');await page.waitForSelector('text="OK"');await page.click('text="OK"');await page.waitForSelector('text="V4 · Current"',{timeout:20000});await close();};
 try{
  progress('开始连续录制：真实原生模型生成');
  await send('这是授权的合成验收。只在当前项目生成五个文件，保留README，不用外部服务。docs/report.md：标题 REPLAY MD V1，两段中文正文，单独一段 ![版本图](image.svg)。docs/image.svg：240x90红底白字V1。site/index.html：标题和h1 REPLAY HTML V1，引用style.css与defer app.js，id=counter按钮文本 Count: 0，id=marker段落。site/style.css：浅米色背景、清晰文字。site/app.js：显示 JS V1，并点击counter累计 Count: 1、2。完成只回复 REPLAY V1 COMPLETE 和两个Markdown文件链接。','REPLAY V1 COMPLETE');
  await fs.access(path.join(replay.project,'docs/report.md'));await fs.access(path.join(replay.project,'site/index.html'));
  await page.click('loc=role:tab[name="Files"]');await page.snapshot();
  await register('docs/report.md',['docs/report.md','docs/image.svg']);await register('site/index.html',['site/index.html','site/style.css','site/app.js']);
  await frame('录像：两类真实作品及依赖启用 V1 历史');
  for(const n of [2,3]){
   await send(`继续仅修改当前项目五个作品文件为第${n}版。report.md标题 REPLAY MD V${n}，正文注明第${n}版，保留图片引用；image.svg改${n===2?'绿':'蓝'}底白字V${n}；index.html标题和h1 REPLAY HTML V${n}；style.css浅${n===2?'绿':'蓝'}背景；app.js显示 JS V${n}，保留Count计数功能。完成仅回复 REPLAY V${n} COMPLETE。`,`REPLAY V${n} COMPLETE`);
   assert.match(await fs.readFile(path.join(replay.project,'docs/report.md'),'utf8'),new RegExp('REPLAY MD V'+n));progress('录像：真实 AI V'+n+' 已完成');
  }
  await open('docs/report.md');await history();await page.waitForSelector('text="V3 · Current"');await select(1);await page.waitForSelector('text="REPLAY MD V1"');
  await frame('录像：Markdown V3 保持当前，预览 V1 与原图');await restore();
  await open('site/index.html');await history();await page.waitForSelector('text="V3 · Current"');await select(1);await page.waitForSelector('text="REPLAY HTML V1"');
  await frame('录像：HTML V3 保持当前，预览 V1 冻结资源');await restore();
  assert.match(await fs.readFile(path.join(replay.project,'docs/report.md'),'utf8'),/REPLAY MD V1/);assert.match(await fs.readFile(path.join(replay.project,'site/index.html'),'utf8'),/REPLAY HTML V1/);
  await frame('录像：两格式恢复为新增 V4，磁盘回到 V1');
  await send('基于刚恢复的第一版续写。先读取确认 docs/report.md 和 site/index.html 均为V1。然后把标题分别改 REPLAY MD V5 与 REPLAY HTML V5，正文加“基于恢复的第一版续写”。image.svg橙底白字V5，style.css浅橙背景，app.js显示 JS V5 且保留Count计数。只改当前项目五个作品文件，路径引用不变。完成仅回复 REPLAY V5 COMPLETE。','REPLAY V5 COMPLETE');
  await page.waitForSelector('text="REPLAY HTML V5"',{timeout:20000});await page.click('loc=role:button[name="Run interaction"]');await page.waitForSelector('text="JS V5"');await page.click('loc=css:#counter');await page.waitForSelector('text="Count: 1"');
  await frame('录像：恢复后真实 AI V5 与 HTML 交互运行');
  await open('docs/report.md');await page.waitForSelector('text="REPLAY MD V5"');await history();await page.waitForSelector('text="V5 · Current"');await frame('录像：Markdown V5 与完整历史');await close();
  await page.reload();await page.waitForSelector('text="REPLAY MD V5"',{timeout:30000});await history();await page.waitForSelector('text="V5 · Current"');await frame('录像：刷新后作品和 V1–V5 历史保留');
  progress('连续录像完整路径通过');
 }finally{
  await pause(500);stopped=true;await pump;await page.cdp('Page.stopScreencast');await page.cdp('Page.removeScriptToEvaluateOnNewDocument',{identifier:script.identifier});
  observer.kill('SIGTERM');await fs.writeFile(path.join(output,'native-replay-timeline.json'),JSON.stringify({timeline,steps,recordingError:recordingError?String(recordingError):null},null,2));console.log('TASK5_RECORDING '+JSON.stringify({frames:timeline.length,steps:steps.length,recordingError:recordingError?String(recordingError):null}));
 }
 if(recordingError)throw recordingError;
}
