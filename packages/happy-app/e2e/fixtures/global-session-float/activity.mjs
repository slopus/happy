// Disposable loopback-only activity driver for the complete project-goals App fixture.
// No model messages, production account, or daemon is involved.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { decryptLegacy, encryptLegacy, encodeBase64 } from '../../../../happy-cli/src/api/encryption.ts';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../../..');
const runtime=JSON.parse(await fs.readFile(path.join(root,'packages/happy-app/test-results/project-goals/runtime.json'),'utf8'));
assert(['localhost','127.0.0.1'].includes(new URL(runtime.serverUrl).hostname));
process.env.HAPPY_SERVER_URL=runtime.serverUrl;
const { ApiSessionClient } = await import('../../../../happy-cli/src/api/apiSession.ts');
const auth=JSON.parse(await fs.readFile(path.join(root,'environments/data/envs',runtime.environment,'cli/home/access.key'),'utf8'));
const secret=new Uint8Array(Buffer.from(auth.secret,'base64'));
const encode=value=>encodeBase64(encryptLegacy(value,secret));
const headers={Authorization:'Bearer '+auth.token,'content-type':'application/json'};
const clients=[];
const connect=async session=>{
 const metadata=decryptLegacy(new Uint8Array(Buffer.from(session.metadata,'base64')),secret);
 const agentState=session.agentState ? decryptLegacy(new Uint8Array(Buffer.from(session.agentState,'base64')),secret) : {};
 const client=new ApiSessionClient(auth.token,{id:session.id,encryptionKey:secret,encryptionVariant:'legacy',seq:session.seq,metadataVersion:session.metadataVersion,agentStateVersion:session.agentStateVersion,metadata,agentState});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('fixture connect timeout')),15000);client.socket.once('connect',()=>{clearTimeout(timer);resolve();});});
 clients.push(client);return client;
};
for(const id of runtime.sessionIds){const response=await fetch(runtime.serverUrl+'/v2/sessions/'+id,{headers});assert(response.ok);await connect((await response.json()).session);}
const response=await fetch(runtime.serverUrl+'/v1/sessions',{method:'POST',headers,body:JSON.stringify({tag:randomUUID(),metadata:encode({machineId:runtime.machineId,path:runtime.taskDirectory,name:'待查看的验收结果',host:'project-goals-fixture.local',flavor:'codex',lifecycleState:'running',startedBy:'terminal'}),agentState:encode({}),dataEncryptionKey:null})});
assert(response.ok);await connect((await response.json()).session);
const state=async(index,status,thinking=false)=>{const client=clients[index];await client.updateAgentState(previous=>({...previous,turnStatus:{status,turnId:'float-fixture-'+index,updatedAt:Date.now()}}));client.keepAlive(thinking,'remote');};
const reset=async()=>{await state(0,'failed');await state(1,'running');await state(2,'running',true);};
await reset();
const server=createServer(async(req,res)=>{try{
 assert.equal(req.method,'POST');
 if(req.url==='/reset')await reset();
 else if(req.url==='/pulse')clients[0].socket.emit('machine-alive',{machineId:runtime.machineId,time:Date.now()});
 else if(req.url==='/complete')await state(2,'completed');
 else if(req.url==='/shutdown'){res.end('{}');server.close();for(const c of clients)await c.close();return;}
 else throw Error('unknown action');
 res.setHeader('content-type','application/json');res.end('{}');
}catch(error){res.writeHead(500);res.end(JSON.stringify({error:String(error)}));}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const output=path.join(root,'packages/happy-app/test-results/global-session-float/activity.json');
await fs.writeFile(output,JSON.stringify({controllerUrl:'http://127.0.0.1:'+server.address().port,sessionIds:clients.map(c=>c.sessionId)}));
console.log({ready:true,output});
