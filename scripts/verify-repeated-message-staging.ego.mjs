// Requires an already-created isolated account, CLI worker and Ego task space.
// Sends real marker prompts through the UI; never injects session or queue state.
const config=globalThis.repeatedMessageStagingConfig||process.env;
const required=name=>{const value=config[name];if(!value)throw Error('Missing '+name);return value;};
const fs=await import('node:fs/promises'),{createRequire}=await import('node:module');
const dir=required('EGO_ARTIFACT_DIR'),mode=config.EGO_RECORDING==='1'?'recorded':'ordinary';
const spaceId=Number(required('EGO_TASK_SPACE_ID'));if(!Number.isSafeInteger(spaceId))throw Error('Invalid task space ID');
const url=required('EGO_SESSION_URL'),sid=new URL(url).pathname.split('/').pop();
if(!sid||!new URL(url).pathname.startsWith('/session/'))throw Error('Expected a test session URL');
const target=required('EGO_TARGET_ID'),task=await taskSpace(spaceId),tab=(await task.tabs()).find(t=>t.label==='p1');
await fs.mkdir(dir,{recursive:true});
if(task.ownership!=='agent'||tab?.targetId!==target||tab.url!==url)throw Error('Ownership/target/URL mismatch');
const {randomUUID}=await import('node:crypto');
const markerPrefix='REPEAT_'+randomUUID().slice(0,8).toUpperCase();
const prepare=text=>text.replaceAll('REPEAT_',markerPrefix+'_');
const page=task.page('p1'),c=JSON.parse(await fs.readFile(required('EGO_TEST_CREDENTIALS_FILE'),'utf8'));
const nacl=createRequire(required('EGO_CLI_PACKAGE_PATH'))('tweetnacl');
const decode=v=>{const b=Buffer.from(v,'base64'),d=nacl.secretbox.open(b.subarray(24),b.subarray(0,24),Buffer.from(c.secret,'base64'));if(!d)throw Error('Own session decrypt failed');return JSON.parse(Buffer.from(d).toString());};
const nativeState=async()=>{const r=await fetch(new URL('/v2/sessions/'+sid,required('EGO_TEST_API_URL')),{headers:{Authorization:'Bearer '+c.token},signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('Own session read failed');const s=(await r.json()).session;return decode(s.agentState).turnStatus;};
const waitState=async predicate=>{const until=Date.now()+180000;while(Date.now()<until){const s=await nativeState();if(predicate(s))return s;await new Promise(r=>setTimeout(r,250));}throw Error('Expected native state not observed');};
const {captureVerifiedBrowserStep}=await import(required('EGO_CAPTURE_HELPER_PATH'));
const captured=[];const capture=async label=>{const frame=await captureVerifiedBrowserStep({cdp,pageInfo,currentTab,listTaskSpaces,useOrCreateTaskSpace},url,{sessionId:required('HAPPY_CAPTURE_SESSION_ID'),runId:required('EGO_RUN_ID'),skillName:'ego-browser',taskSpaceId:spaceId,targetId:target});const timeSeconds=(Date.now()-started)/1000;captured.push({label,timeSeconds,...frame});cliLog({label,timeSeconds,...frame});await fs.copyFile(frame.path,dir+'/'+mode+'-'+label+'.png');if(mode==='recorded')await page.waitForTimeout(900);};
let recording=false,pump,frames=[],started=Date.now();
if(mode==='recorded'){
 await fs.mkdir(dir+'/frames',{recursive:true});await page.events();await page.cdp('Page.startScreencast',{format:'jpeg',quality:85,maxWidth:1920,maxHeight:1080,everyNthFrame:1});recording=true;
 pump=(async()=>{while(recording){for(const e of await page.events())if(e.method==='Page.screencastFrame'){const path=dir+'/frames/'+String(frames.length).padStart(6,'0')+'.jpg';await fs.writeFile(path,Buffer.from(e.params.data,'base64'));frames.push({path,time:(Date.now()-started)/1000});await page.cdp('Page.screencastFrameAck',{sessionId:e.params.sessionId});}await new Promise(r=>setTimeout(r,150));}})();
}
try {
 const input='textarea[data-testid="session-message-input"]';
 const empty=()=>page.waitForFunction(()=>document.querySelector('[data-testid="session-message-input"]')?.value==='',undefined,{timeout:12000});
 const count=n=>page.waitForFunction(n=>document.querySelectorAll('[data-testid^="queued-message-"]').length===n,n,{timeout:12000});
 const submit=async text=>{await page.fill(input,prepare(text));await page.press(input,'Enter');await empty();};
 await page.fill(input,prepare('连续暂存真实验收：仅执行 python3 -c "import time; time.sleep(35)"，不修改文件。完成只输出 REPEAT_ORIGINAL_DONE，并保留后续明确插话要求的标记。'));await page.click('button[data-testid="message-composer-send-button"]');
 await page.waitForSelector('button[aria-label="加入待发送队列（Tab）"]',{timeout:30000});const original=await waitState(s=>s?.status==='running'&&!!s.turnId);
 await submit('明确插话：保留原等待任务，完成时追加 REPEAT_FIRST_STEER_DONE。');await count(1);await page.click('[data-testid^="queued-message-"] button[aria-label="现在发送"]');await count(0);if((await nativeState()).turnId!==original.turnId)throw Error('First Send now replaced turn');
 await submit('下一轮仅执行 python3 -c "import time; time.sleep(18)"，完成只回复 REPEAT_SECOND_TURN_DONE。');
 await submit('仅回复 REPEAT_LAST_DONE。');await count(2);
 if((await nativeState()).turnId!==original.turnId)throw Error('Follow-up input started a replacement turn');
 await capture('followups-staged');
 await page.fill(input,prepare('发送按钮也应暂存：仅回复 REPEAT_BUTTON_DONE。'));await page.click('button[data-testid="message-composer-send-button"]');await empty();await count(3);
 await submit('第二次明确插话：保留原等待任务和前一个插话标记，完成时同时追加 REPEAT_SECOND_STEER_DONE。');await count(4);
 await page.click('[data-testid^="queued-message-"] button[aria-label="现在发送"] >> nth=3');await count(3);if((await nativeState()).turnId!==original.turnId)throw Error('Second Send now replaced turn');
 await page.reload();await page.waitForSelector(input,{timeout:25000});await count(3);
 const second=await waitState(s=>s?.status==='running'&&s.turnId!==original.turnId);
 await submit('跨第二轮仍应暂存：仅回复 REPEAT_LATER_DONE。');await count(3);
 if((await nativeState()).turnId!==second.turnId)throw Error('Second-turn follow-up interrupted active turn');
 await capture('second-turn-staged');
 const markers=['ORIGINAL_DONE','FIRST_STEER_DONE','SECOND_STEER_DONE','SECOND_TURN_DONE','LAST_DONE','BUTTON_DONE','LATER_DONE'].map(suffix=>markerPrefix+'_'+suffix);
 await page.waitForFunction(markers=>{const text=document.body?.innerText||'';return !document.querySelector('[data-testid="message-staging-queue"]')&&!document.querySelector('button[aria-label="停止正在运行的 Agent"]')&&markers.every(m=>text.includes(m+'\n'));},markers,{timeout:240000});
 const final=await nativeState();if(final.status!=='completed'||final.turnId===original.turnId||final.turnId===second.turnId)throw Error('Queue final turn not completed');
 const result={pass:true,mode,originalTurnId:original.turnId,secondTurnId:second.turnId,lastTurnId:final.turnId,firstSendNowSameTurn:true,secondSendNowSameTurn:true,followupEnterQueued:true,nextTurnEnterQueued:true,reloadKeptQueue:true,busySendButtonQueued:true,markerPrefix,actualReplyMarkers:markers.length,seconds:(Date.now()-started)/1000};
 await capture('final');await fs.writeFile(dir+'/'+mode+'-result.json',JSON.stringify({...result,captured},null,2));console.log(result);
}finally{
 if(recording){recording=false;await pump;await page.cdp('Page.stopScreencast');await fs.writeFile(dir+'/frames.json',JSON.stringify(frames));console.log({videoFrames:frames.length});}
}
