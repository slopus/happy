/** Provider-free cold/warm mechanism probe; synthetic MCP initialize delay, not service latency. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
const output = process.argv[2];
assert.ok(output);
const scratch = await mkdtemp(join(tmpdir(), 'codex-cold-inventory-'));
process.env.HAPPY_HOME_DIR = join(scratch, 'happy');
process.env.CODEX_HOME = join(scratch, 'codex');
process.env.CODEX_MULTI_AUTH_DIR = join(scratch, 'no-rotation');
delete process.env.DEBUG;
delete process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING;
await mkdir(process.env.CODEX_HOME, { recursive: true });
const events = join(scratch, 'events.jsonl');
await writeFile(events, '');
const fixture = join(scratch, 'fixture.cjs');
await writeFile(fixture, `
const fs = require('node:fs');
const readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line', line => {
 const q = JSON.parse(line); if(q.id == null) return;
 const send = result => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');
 if(q.method === 'initialize') {
  fs.appendFileSync(process.env.PROBE_EVENTS,JSON.stringify({pair:Number(process.env.PROBE_PAIR),server:Number(process.env.PROBE_SERVER)})+'\\n');
  setTimeout(()=>send({protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'probe',version:'1'}}),Number(process.env.PROBE_DELAY));
 } else if(q.method==='tools/list') send({tools:[{name:'probe',inputSchema:{type:'object',properties:{}}}]});
 else if(q.method==='ping') send({});
 else process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,error:{code:-32601,message:'Unsupported'}})+'\\n');
});
`);
const { CodexAppServerClient } = await import('../../packages/happy-cli/src/codex/codexAppServerClient');
const client = new CodexAppServerClient();
const rows: Array<{pair:number;threadStartMs:number;coldMs:number;warmMs:number;coldPagesMs:number[];warmPagesMs:number[];coldInitializers:number;warmInitializers:number}> = [];
const initializers = async (pair:number) => (await readFile(events,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(e=>e.pair===pair).length;
const median = (a:number[]) => {const b=[...a].sort((x,y)=>x-y);return (b[(b.length-1)>>1]+b[b.length>>1])/2;};
try {
 await client.connect();
 for(let pair=1;pair<=20;pair++) {
  const cwd=join(scratch,'workspace-'+pair);await mkdir(cwd);
  const names=['probe0','probe1','probe2','probe3'];
  const mcpServers=Object.fromEntries(names.map((name,index)=>[name,{command:process.execPath,args:[fixture],env:{PROBE_EVENTS:events,PROBE_PAIR:String(pair),PROBE_SERVER:String(index),PROBE_DELAY:index===0?'0':'400'}}]));
  const start=performance.now();
  const {threadId}=await client.startThread({model:'gpt-6-luna',cwd,approvalPolicy:'never',sandbox:'read-only',mcpServers});
  const threadStartMs=performance.now()-start;
  const countsBefore=await initializers(pair);
  const probe=async()=>{const durations:number[]=[];for(const name of names){const t=performance.now();const r=await client.listMcpServerStatus({threadId,serverNames:[name]});durations.push(performance.now()-t);assert.equal(r.data.length,1);assert.equal(r.data[0].name,name);assert.ok(Object.keys(r.data[0].tools).length>0);assert.equal(r.data[0].runtimeStatus,'connected');}return durations;};
  const coldStart=performance.now();const coldPagesMs=await probe();const coldMs=performance.now()-coldStart;
  const countsAfterCold=await initializers(pair);
  const warmStart=performance.now();const warmPagesMs=await probe();const warmMs=performance.now()-warmStart;
  const countsAfterWarm=await initializers(pair);
  rows.push({pair,threadStartMs,coldMs,warmMs,coldPagesMs,warmPagesMs,coldInitializers:countsAfterCold-countsBefore,warmInitializers:countsAfterWarm-countsAfterCold});
  await writeFile(resolve(output),JSON.stringify({kind:'in-progress-cold-warm-probe',rows},null,2)+'\n');
  assert.equal(countsAfterWarm-countsAfterCold,0);
  if(pair%5===0)console.log(JSON.stringify({completedPairs:pair}));
 }
 const result={kind:'synthetic-startup-delay-real-codex-cold-warm-mechanism',codexVersion:execFileSync('codex',['--version'],{encoding:'utf8'}).trim(),protocol:{pairs:20,servers:4,initializerDelayMs:[0,400,400,400],scope:'isolated homes and cwd per thread; no credentials copied/provider turns',cleanupConfirmed:false},summary:{coldMedianMs:median(rows.map(r=>r.coldMs)),warmMedianMs:median(rows.map(r=>r.warmMs)),startToColdReadyMedianMs:median(rows.map(r=>r.threadStartMs+r.coldMs)),coldPerServerMedianMs:[0,1,2,3].map(i=>median(rows.map(r=>r.coldPagesMs[i]))),warmInitializerCount:rows.reduce((n,r)=>n+r.warmInitializers,0)},limits:['Deliberate fixture startup delay; not ethan latency or its connector root cause.','Cold precedes warm by definition, not randomized A/B of implementations.','One app-server,20 separate threads; tool caches can accumulate.','No bypass of auth/readiness or real network/provider behavior tested.'],rows};
 await writeFile(resolve(output),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result.summary));
} finally {await client.disconnect();await rm(scratch,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
const result=JSON.parse(await readFile(resolve(output),'utf8'));result.protocol.cleanupConfirmed=true;await writeFile(resolve(output),JSON.stringify(result,null,2)+'\n');
