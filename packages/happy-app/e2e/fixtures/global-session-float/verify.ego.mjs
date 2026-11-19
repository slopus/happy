// Execute only through ego-browser nodejs. Bind one context to one owned task/tab.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
const config=globalThis.floatConfig;
assert(config?.contextPath && ['before','after'].includes(config.phase));
const ctx=JSON.parse(await fs.readFile(config.contextPath,'utf8'));
const runtime=JSON.parse(await fs.readFile(ctx.runtimePath,'utf8'));
const output=path.join(ctx.root,'packages/happy-app/test-results/global-session-float');
const activity=JSON.parse(await fs.readFile(path.join(output,'activity.json'),'utf8'));
assert(['localhost','127.0.0.1'].includes(new URL(runtime.webUrl).hostname));
const task=await taskSpace(ctx.taskSpaceId),page=task.page(ctx.pageLabel);
assert.equal((await task.tabs()).find(t=>t.label===ctx.pageLabel)?.targetId,ctx.targetId);
const route=runtime.webUrl+'/projects?'+new URLSearchParams({machine:runtime.machineId,project:runtime.projectPath,feature:runtime.featurePath}).toString().replace(/\+/g,'%20');
let expectedUrl=route;
const frames=[],cases=[];
const capture=async(id,label)=>{
 if(!config.capture)return;
 const {captureVerifiedBrowserStep}=await import('file:///Users/jacky/Deployments/paws-cli/releases/project-github-link-14308bb6-20261120/packages/happy-cli/scripts/capture-browser-step.mjs');
 const result=await captureVerifiedBrowserStep({cdp:(m,p)=>page.cdp(m,p),pageInfo:()=>page.evaluate(()=>({url:location.href,w:innerWidth,h:innerHeight})),currentTab:async()=>(await task.tabs()).find(t=>t.active),listTaskSpaces,useOrCreateTaskSpace:async id=>({id:(await taskSpace(id)).spaceId})},expectedUrl,{sessionId:ctx.sessionId,runId:ctx.runId,skillName:'ego-browser',taskSpaceId:ctx.taskSpaceId,targetId:ctx.targetId});
 frames.push({id,label,...result});console.log({frame:id,label,...result});
};
const exists=selector=>page.evaluate(s=>[...document.querySelectorAll(s)].some(n=>n.getBoundingClientRect().width>0),selector);
const rect=()=>page.evaluate(()=>{const r=document.querySelector('[data-testid="session-activity-panel"]').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};});
const pause=()=>config.record?new Promise(resolve=>setTimeout(resolve,1100)):Promise.resolve();
await page.cdp('Emulation.setDeviceMetricsOverride',{width:1680,height:960,deviceScaleFactor:1,mobile:false});
await page.goto(route,{timeout:60000});
await page.waitForSelector('[data-testid="global-session-entry"]',{timeout:30000});
// Emit a fixture-owned presence event only after the reloaded App is subscribed.
await fetch(ctx.pulseUrl ?? activity.controllerUrl+'/pulse',{method:'POST'});
await page.waitForFunction(()=>document.body.innerText.includes('工作区方案')&&!document.body.innerText.includes('这台机器已离线'),undefined,{timeout:30000});
await page.evaluate(()=>document.fonts.ready);
await fetch(activity.controllerUrl+'/reset',{method:'POST'});
await page.waitForFunction(()=>document.querySelector('[data-testid="global-session-entry"]')?.textContent.includes('2'),undefined,{timeout:15000});
await fetch(activity.controllerUrl+'/complete',{method:'POST'});
await page.waitForFunction(()=>document.querySelector('[data-testid="project-session-unread"]')?.textContent.includes('1'),undefined,{timeout:15000});
let stopRecording,video;
if(config.record){const {recordEgoPage}=await import(pathToFileURL(path.join(ctx.root,'packages/happy-app/e2e/fixtures/codex-settings/record-chat-regressions.ego.mjs')).href);stopRecording=await recordEgoPage(page,path.join(output,'video-'+config.phase));}
try{
 const before=config.phase==='before';
 if(!before){assert(await exists('[data-testid="sidebar-global-sessions-button"]'));assert(!await exists('[data-testid="sidebar-global-sessions-button-badge"]'));await pause();await capture('C1-off','C1 新版 OFF：侧栏入口保留、小窗关闭');}
 await page.click(before?'[data-testid="global-session-entry"]':'[data-testid="sidebar-global-sessions-button"]');
 await page.waitForSelector('[data-testid="session-activity-panel"]',{timeout:10000});
 if(!before)assert(await exists('[data-testid="sidebar-global-sessions-button-badge"]'));
 await pause();await capture('C1-on',before?'C1 旧版：项目内弹窗，侧栏没有开关':'C1 新版 ON：侧栏开关与紧凑小窗同步');
 cases.push({id:'C1',status:'pass',phase:config.phase,panel:await rect()});
 await page.click('[data-testid="session-activity-tab-running"]');
 const old=await rect();
 await page.mouse.move(old.x+140,old.y+22);await page.mouse.down();
 for(let i=1;i<=12;i++){await page.mouse.move(old.x+140+i*18,old.y+22+i*9);if(config.record)await new Promise(resolve=>setTimeout(resolve,45));}
 await page.mouse.up();
 const moved=await rect();
 if(before){assert(Math.abs(moved.x-old.x)<2);assert(Math.abs(moved.y-old.y)<2);}else{assert(Math.abs(moved.x-old.x-216)<3);assert(Math.abs(moved.y-old.y-108)<3);assert(moved.x>=0&&moved.x+moved.width<=1680);}
 await pause();await capture('C2-drag',before?'C2 旧版：尝试拖动后位置不变':'C2 新版：真实鼠标拖动，位置跟随且在视口内');
 cases.push({id:'C2',status:'pass',phase:config.phase,from:old,to:moved});
 await page.click('[data-testid="session-activity-tab-unread"]');await pause();
 const id=activity.sessionIds[2];assert(await exists(`[data-testid="session-activity-open-${id}"]`));
 if(!before)await capture('C3-unread','C3 进入会话前：待查看 1');
 await page.click(`[data-testid="session-activity-open-${id}"]`);
 expectedUrl=runtime.webUrl+'/session/'+encodeURIComponent(id);
 await page.waitForURL(expectedUrl,{timeout:30000});
 await page.waitForSelector('textarea[data-testid="session-message-input"]',{state:'visible',timeout:30000});
 assert.equal(await exists('[data-testid="session-activity-panel"]'),!before);
 if(!before){await page.waitForFunction(()=>document.querySelector('[data-testid="session-activity-tab-unread"]')?.textContent.includes('0'),undefined,{timeout:15000});assert(await exists('[data-testid="sidebar-global-sessions-button-badge"]'));}
 await pause();await capture('C3-open',before?'C3 旧版：打开会话后弹窗消失':'C3 新版：会话输入框就绪、小窗保留，待查看归零');
 cases.push({id:'C3',status:'pass',phase:config.phase,windowRetained:!before,realSessionInput:true,unreadCleared:!before});
 if(!before){await page.click('[data-testid="session-activity-close"]');assert(!await exists('[data-testid="session-activity-panel"]'));assert(!await exists('[data-testid="sidebar-global-sessions-button-badge"]'));await pause();await capture('C1-close','C1 关闭完成：小窗收起，侧栏 ON 消失');}
}finally{if(stopRecording)video=await stopRecording();await fs.writeFile(path.join(output,config.phase+(config.record?'-record':'-normal')+'.json'),JSON.stringify({cases,frames,video,phase:config.phase,viewport:{width:1680,height:960,dpr:1},modelMessages:0},null,2));}
console.log({complete:cases.length===3,cases,video});
