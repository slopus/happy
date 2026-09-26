#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const at = process.argv.indexOf('--run'); const run = at >= 0 ? process.argv[at+1] : '';
if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(run)) throw Error('--run is required');
const path = join(root,'.abp',run,'env.json');
const reportPath = join(root,'.abp',run,'rollback-report.json');
if (!existsSync(path)) { const old = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath)) : { run, alreadyDown:true }; console.log(JSON.stringify(old)); process.exit(0); }
const listed = execFileSync('docker', ['ps','-aq','--filter',`label=ai.saycode.abp-run=${run}`], {encoding:'utf8'}).trim();
if (!listed && existsSync(reportPath)) { console.log(readFileSync(reportPath,'utf8')); process.exit(0); }
const env = JSON.parse(readFileSync(path)); const keys = JSON.parse(readFileSync(join(root,'.abp',run,'keys.json')));
const docker = (...args) => execFileSync('docker', args, {encoding:'utf8'}).trim();
const owned = id => docker('inspect','-f','{{index .Config.Labels "ai.saycode.abp-run"}}',id) === run;
for (const id of Object.values(env.containers)) if (!owned(id)) throw Error('container ownership mismatch');
const canonical = v => v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
const canonicalGrant = task => { const now=Date.now()-5000; const grant={kind:'agent-grant',grantId:`rollback-${randomUUID()}`,principalId:task.owner.principalId,workspaceId:task.owner.workspaceId,machineId:task.owner.machineId,agentSessionId:task.agentSessionId,profileId:task.profileId,allowedOrigins:['http://a.poc-one.test:8080'],operations:['cancel','getTask'],taskSpaceIds:[],issuedAtMs:now,expiresAtMs:now+60_000}; const b=Buffer.from(canonical(grant)).toString('base64url'); return `abp1.${b}.${createHmac('sha256',keys.agentKey).update(`abp1.${b}`).digest('base64url')}`; };
const op = async (name,data,task) => { const r=await fetch(`http://127.0.0.1:${env.ports.runtime}/v1/ops/${name}`,{method:'POST',headers:{authorization:`Bearer ${canonicalGrant(task)}`,'content-type':'application/json'},body:JSON.stringify(data)}); return r.json(); };
const report={run,flag:'HAPPY_BROWSER_TASK_RUNTIME_URL',flagDisabledBy:'unset on agent launch',runtimeStopped:false,canaryVerified:false,cancelled:[],cancelErrors:[],cleanup:false};
// Discovery is read-only through the run-owned Runtime container; cancellation uses the public task API.
const files=docker('exec',env.containers.runtime,'sh','-c','find /var/lib/abp/tasks -name task.json -type f 2>/dev/null || true').split('\n').filter(Boolean);
for(const file of files){
  const task=JSON.parse(docker('exec',env.containers.runtime,'cat',file));
  if(['succeeded','failed','cancelled'].includes(task.status)) continue;
  const result=await op('cancel',{taskId:task.taskId,requestId:randomUUID()},task);
  if(result.ok && result.result?.status==='cancel-accepted') report.cancelled.push(task.taskId);
  else report.cancelErrors.push({taskId:task.taskId,code:result.error?.code??'unknown'});
}
if(report.cancelErrors.length) throw Error(`fence failed: ${JSON.stringify(report.cancelErrors)}`);
const canary=`a12-${randomUUID()}`;
docker('exec',env.containers.browserA,'sh','-c',`printf '%s' '${canary}' > /home/browser/profile/.a12-rollback-canary`);
const volume=env.names.profileA;
if(docker('volume','inspect','-f','{{index .Labels "ai.saycode.abp-run"}}',volume)!==run) throw Error('profile volume ownership mismatch');
docker('stop',env.containers.runtime); report.runtimeStopped=true;
docker('restart',env.containers.browserA);
let read=''; for(let attempt=0;attempt<30;attempt++){ try { read=docker('exec',env.containers.browserA,'cat','/home/browser/profile/.a12-rollback-canary'); if(read===canary) break; } catch {} await new Promise(r=>setTimeout(r,1000)); }
report.canaryVerified=read===canary && docker('volume','inspect','-f','{{index .Labels "ai.saycode.abp-run"}}',volume)===run;
if(!report.canaryVerified) throw Error('profile volume canary verification failed');
const publishedPort = Number(docker('port',env.containers.browserA,'6080').match(/127\.0\.0\.1:(\d+)/)?.[1]);
report.novncPortReassigned = publishedPort !== env.ports.novncA;
report.viewerAvailable=false;
for(let attempt=0;attempt<30;attempt++){ try { const response=await fetch(`http://127.0.0.1:${publishedPort}/vnc.html`); if(response.ok){report.viewerAvailable=true;break;} } catch {} await new Promise(r=>setTimeout(r,1000)); }
if(!report.viewerAvailable) throw Error('noVNC viewer unavailable after browser restart');
// Leave synthetic profile volumes intact for inspection; remove containers/network only.
docker('rm','-f',...Object.values(env.containers));
for (const network of docker('network','ls','-q','--filter',`label=ai.saycode.abp-run=${run}`).split('\n').filter(Boolean)) docker('network','rm',network);
report.cleanup=true; report.profileVolumesPreserved=[env.names.profileA,env.names.profileB];
writeFileSync(reportPath,JSON.stringify(report,null,2)); console.log(JSON.stringify(report));
