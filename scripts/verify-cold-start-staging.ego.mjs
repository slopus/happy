// Real Codex startup through an isolated daemon; every test input uses Ego UI.
const fs=await import('node:fs/promises'),{createRequire}=await import('node:module'),{randomUUID}=await import('node:crypto');
const config=globalThis.coldStartConfig||process.env;
const required=name=>{if(!config[name])throw Error('Missing '+name);return config[name];};
const dir=required('EGO_ARTIFACT_DIR');const mode=config.EGO_RECORDING==='1'?'recorded':'ordinary';
const task=await taskSpace(Number(required('EGO_TASK_SPACE_ID'))),page=task.page('p1'),target=required('EGO_TARGET_ID');
const tab=(await task.tabs()).find(t=>t.label==='p1');if(task.ownership!=='agent'||tab?.targetId!==target||tab.url!==required('EGO_FROM_URL'))throw Error('Ownership/target/URL mismatch');
const c=JSON.parse(await fs.readFile(dir+'/home/access.key','utf8')),setup=JSON.parse(await fs.readFile(dir+'/home/daemon.state.json','utf8'));
const nacl=createRequire(required('EGO_CLI_PACKAGE_PATH'))('tweetnacl');
const decode=v=>{if(!v)return null;const b=Buffer.from(v,'base64'),d=nacl.secretbox.open(b.subarray(24),b.subarray(0,24),Buffer.from(c.secret,'base64'));if(!d)throw Error('Own session decrypt failed');return JSON.parse(Buffer.from(d).toString());};
const api=async path=>{const r=await fetch(new URL(path,required('EGO_TEST_API_URL')),{headers:{Authorization:'Bearer '+c.token},signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('Own API HTTP '+r.status);return r.json();};
const before=new Set((await api('/v1/sessions')).sessions.map(s=>s.id));
const spawn=fetch('http://127.0.0.1:'+setup.httpPort+'/spawn-session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({directory:dir+'/project',agent:'codex',model:'gpt-6.1-sol',effort:'medium'}),signal:AbortSignal.timeout(90000)}).then(r=>r.json());
let raw;const deadline=Date.now()+30000;while(Date.now()<deadline){raw=(await api('/v1/sessions')).sessions.find(s=>!before.has(s.id));if(raw)break;await new Promise(r=>setTimeout(r,100));}if(!raw)throw Error('New own session unavailable');
const sid=raw.id,url=new URL('/session/'+sid,required('EGO_WEB_ORIGIN')).toString(),prefix='COLD_'+randomUUID().slice(0,8).toUpperCase();
await fs.writeFile(dir+'/'+mode+'-session.json',JSON.stringify({sid,url,prefix}));
await page.goto(url);await page.waitForSelector('textarea[data-testid="session-message-input"]',{timeout:12000});
const state=async()=>decode((await api('/v2/sessions/'+sid)).session.agentState);
const release=await page.evaluate(()=>document.querySelector('meta[name="paws-release-revision"]')?.content);if(release!==required('EGO_EXPECTED_REVISION'))throw Error('Unexpected web release');
const nativeBefore=await state();if(nativeBefore?.turnStatus)throw Error('Unexpected existing turn');
// Hold only this isolated worker's real app-server to exercise the dequeue →
// native turn-start interval deterministically, without replacing its protocol.
const {execFileSync}=await import('node:child_process');
const readyDeadline=Date.now()+30000;while(Date.now()<readyDeadline){const m=decode((await api('/v2/sessions/'+sid)).session.metadata);if(m.codexThreadId)break;await new Promise(r=>setTimeout(r,100));}
const children=await (await fetch('http://127.0.0.1:'+setup.httpPort+'/list',{method:'POST'})).json();const worker=children.children.find(c=>c.happySessionId===sid);if(!worker)throw Error('Own worker missing');
const processes=execFileSync('ps',['-axo','pid=,ppid=,command='],{encoding:'utf8'}).split('\n').map(line=>{const m=line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);return m?{pid:Number(m[1]),ppid:Number(m[2]),command:m[3]}:null;}).filter(Boolean);
const descendants=new Set([worker.pid]);for(let i=0;i<8;i++)for(const p of processes)if(descendants.has(p.ppid))descendants.add(p.pid);
const codex=processes.filter(p=>descendants.has(p.pid)&&/\/codex app-server(?: |$)/.test(p.command));if(codex.length!==1)throw Error('Ambiguous isolated app-server: '+codex.length);
let nativeHeld=false;
let recording=false,pump,frames=[],started=Date.now();const captureFrames=[];
const {captureVerifiedBrowserStep}=await import(required('EGO_CAPTURE_HELPER_PATH'));
const capture=async label=>{const frame=await captureVerifiedBrowserStep({cdp,pageInfo,currentTab,listTaskSpaces,useOrCreateTaskSpace},url,{sessionId:required('HAPPY_CAPTURE_SESSION_ID'),runId:required('EGO_RUN_ID'),skillName:'ego-browser',taskSpaceId:Number(required('EGO_TASK_SPACE_ID')),targetId:target});captureFrames.push({label,...frame});cliLog({label,...frame});};
if(mode==='recorded'){await fs.mkdir(dir+'/frames',{recursive:true});await page.events();await page.cdp('Page.startScreencast',{format:'jpeg',quality:85,maxWidth:1920,maxHeight:1080,everyNthFrame:1});recording=true;pump=(async()=>{while(recording){for(const e of await page.events())if(e.method==='Page.screencastFrame'){const path=dir+'/frames/'+String(frames.length).padStart(6,'0')+'.jpg';await fs.writeFile(path,Buffer.from(e.params.data,'base64'));frames.push({path,time:(Date.now()-started)/1000});await page.cdp('Page.screencastFrameAck',{sessionId:e.params.sessionId});}await new Promise(r=>setTimeout(r,150));}})();}
const waitNative=async predicate=>{const until=Date.now()+150000;while(Date.now()<until){const s=await state();if(predicate(s))return s;await new Promise(r=>setTimeout(r,150));}throw Error('Expected native lifecycle not seen');};
const transcript=async()=>{const r=await api('/v3/sessions/'+sid+'/messages?after_seq=0&limit=100');return r.messages.map(m=>{const v=decode(typeof m.content==='string'?m.content:m.content.c);const data=v.content?.data??v.content;return {seq:m.seq,createdAt:m.createdAt,role:v.role,turn:data?.turn,type:data?.ev?.t??data?.type,text:v.role==='user'?data?.text:data?.ev?.t==='text'?data.ev.text:undefined,status:data?.ev?.status};});};
try{
 process.kill(codex[0].pid,'SIGSTOP');nativeHeld=true;
 const input='textarea[data-testid="session-message-input"]';const submit=async text=>{await page.fill(input,text);await page.press(input,'Enter');await page.waitForFunction(()=>document.querySelector('[data-testid="session-message-input"]')?.value==='',undefined,{timeout:10000});};
 const count=n=>page.waitForFunction(n=>document.querySelectorAll('[data-testid^="queued-message-"]').length===n,n,{timeout:10000});
 await submit('冷启动顺序验收 输入 1：仅执行 python3 -c "import time; time.sleep(25)"，不修改文件；结束仅回复 '+prefix+'_REPLY_1。若收到明确插话，同时保留其要求的标记。');
 await submit('输入 2：仅回复 '+prefix+'_REPLY_2。');await submit('输入 3：仅回复 '+prefix+'_REPLY_3。');await submit('输入 4：仅回复 '+prefix+'_REPLY_4。');await count(3);
 const beforeStart=await state();const queuedBeforeNativeStart=beforeStart?.turnStatus?.status!=='running';if(!queuedBeforeNativeStart)throw Error('Did not exercise initial startup window');
 if((beforeStart.queuedMessages??0)<1)throw Error('CLI reported idle after dequeue but before native turn-start');
 process.kill(codex[0].pid,'SIGCONT');nativeHeld=false;const first=await waitNative(s=>s?.turnStatus?.status==='running');await count(3);
 const firstTranscript=await transcript();if(firstTranscript.filter(m=>m.role==='user').length!==1)throw Error('Later input entered transcript before first native turn');
 await submit('明确插话 输入 8：保留原等待任务，最终追加 '+prefix+'_STEER_8。');await count(4);await page.click('[data-testid^="queued-message-"] button[aria-label="现在发送"] >> nth=3');await count(3);
 if((await state()).turnStatus.turnId!==first.turnStatus.turnId)throw Error('Steer replaced turn');
 await submit('输入 5：仅回复 '+prefix+'_REPLY_5。');await count(4);await capture('cold-start-and-steer-queued');
 const finalDeadline=Date.now()+600000;let finalVerified=false;
 while(Date.now()<finalDeadline){const h=await transcript();const last=h.find(m=>m.role==='session'&&m.type==='text'&&m.text===prefix+'_REPLY_5');const current=await state();if(last&&current.turnStatus?.status==='completed'&&current.turnStatus?.turnId===last.turn){finalVerified=true;break;}await new Promise(r=>setTimeout(r,300));}
 if(!finalVerified)throw Error('Final actual reply and native completion not observed');
 await page.waitForFunction(()=>!document.querySelector('[data-testid="message-staging-queue"]')&&!document.querySelector('button[aria-label="停止正在运行的 Agent"]'),undefined,{timeout:12000});
 const history=await transcript();const replies=history.filter(m=>m.role==='session'&&m.type==='text'&&m.turn);
 const one=history.find(m=>m.role==='user'&&m.text?.includes('输入 1：'));if(!one)throw Error('Missing first user input');let previousReply=one;
 const ordered=[];
 for(const number of [1,2,3,4,5]){const user=history.find(m=>m.role==='user'&&m.text?.includes('输入 '+number+'：'));const reply=replies.find(m=>m.text?.includes(prefix+'_REPLY_'+number)&&!m.text?.includes('输入 '+number+'：'));if(!user||!reply||reply.seq<=user.seq||(number>1&&user.seq<=previousReply.seq))throw Error('Input/reply ordering failed for '+number);ordered.push({number,userSeq:user.seq,replySeq:reply.seq,turn:reply.turn});previousReply=reply;}
 const steerReply=replies.find(m=>m.text?.includes(prefix+'_STEER_8')&&!m.text?.includes('明确插话'));if(steerReply?.turn!==first.turnStatus.turnId)throw Error('Steer reply not in first native turn');
 const result={pass:true,mode,sid,url,prefix,queuedBeforeNativeStart,controlledAppServerStartupHold:true,firstTurn:first.turnStatus.turnId,ordered,steerSameTurn:true,secondsFromFirstInput:(Date.now()-one.createdAt)/1000,history};
 await capture('ordered-replies-final');await fs.writeFile(dir+'/'+mode+'-result.json',JSON.stringify({...result,captureFrames},null,2));console.log({...result,history:undefined});await spawn;
}finally{if(nativeHeld)process.kill(codex[0].pid,'SIGCONT');if(recording){recording=false;await pump;await page.cdp('Page.stopScreencast');await fs.writeFile(dir+'/frames.json',JSON.stringify(frames));console.log({videoFrames:frames.length});}}
