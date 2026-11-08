/** Spawn an actual native worker in a fresh sibling synthetic project. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const output=new URL('../../../test-results/artifact-history/',import.meta.url);
const r=JSON.parse(await fs.readFile(new URL('runtime.json',output),'utf8'));
const auth=JSON.parse(await fs.readFile(path.join(r.home,'access.key'),'utf8'));
const {encryptLegacy,decryptLegacy,encodeBase64}=await import('../../../../happy-cli/src/api/encryption.ts');
const key=Buffer.from(auth.secret,'base64');const name=process.argv[2]??'artifact-replay';assert(/^artifact-replay(?:-[0-9]+)?$/.test(name));const project=path.join(r.project,'..',name);
await fs.mkdir(project);await fs.writeFile(path.join(project,'README.md'),'# Synthetic native history replay\nWork only inside this project. No external files or services.\n');
const require=createRequire(new URL('../../../../happy-cli/package.json',import.meta.url));const {io}=require('socket.io-client');
const socket=io(r.serverUrl,{path:'/v1/updates',transports:['websocket'],reconnection:false,auth:{token:auth.token,clientType:'user-scoped'}});
try{
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Fixture account connection timed out')),10000);socket.once('connect',()=>{clearTimeout(timer);resolve();});});
 const answer=await socket.timeout(95000).emitWithAck('rpc-call',{method:r.machineId+':spawn-happy-session',params:encodeBase64(encryptLegacy({directory:project,agent:'codex',model:'gpt-6.1-sol',effort:'high'},key))});assert(answer.ok);
 const result=decryptLegacy(Buffer.from(answer.result,'base64'),key);assert.equal(result.type,'success');
 const snapshot=await(await fetch(r.serverUrl+'/v2/sessions/'+result.sessionId,{headers:{Authorization:'Bearer '+auth.token}})).json();
 const metadata=decryptLegacy(Buffer.from(snapshot.session.metadata,'base64'),key);
 assert.equal(metadata.path,project);assert.equal(metadata.codexAccountProfileId,undefined,'Isolated daemon must not inherit the parent account profile');assert.equal(metadata.capabilities?.artifactLeases,2);
 const replay={sessionId:result.sessionId,project,url:r.webUrl+'/session/'+result.sessionId};
 await fs.writeFile(new URL('replay.json',output),JSON.stringify(replay,null,2));console.log(JSON.stringify(replay));
 let extra=[];try{extra=JSON.parse(await fs.readFile(new URL('extra-session-ids.json',output),'utf8'));}catch{}extra.push(result.sessionId);await fs.writeFile(new URL('extra-session-ids.json',output),JSON.stringify(extra));
}finally{socket.disconnect();}
