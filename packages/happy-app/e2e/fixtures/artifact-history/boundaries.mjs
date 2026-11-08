import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const output=new URL('../../../test-results/artifact-history/',import.meta.url);
const runtime=JSON.parse(await fs.readFile(new URL('runtime.json',output),'utf8'));
async function raw(method,input,scope){const response=await fetch(runtime.controllerUrl+'/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,input,scope})});assert(response.ok);return response.json();}
async function rpc(method,input,scope){const value=await raw(method,input,scope);assert(value.ok,JSON.stringify(value.error));return value.value;}
const [workspace]=await rpc('artifactCatalog',{root:runtime.project});const artifact=workspace.artifacts[0];const ref={workspaceId:workspace.workspaceId,artifactId:artifact.id};
const mode=process.argv[2]??'isolation';const evidence=[];
if(mode==='active'){
 const current=await rpc('artifactRead',ref);assert.equal(current.workingState,'writing','Must run during a real native turn');
 const before=await rpc('artifactVersions',ref);const denied=await raw('artifactRestore',{...ref,operationId:crypto.randomUUID(),expectedRevision:current.workingRevision,versionId:before.versions.at(-1).id});
 assert.equal(denied.error?.code,'WRITER_ACTIVE');assert.deepEqual((await rpc('artifactVersions',ref)).versions,before.versions);evidence.push('real active native writer excludes restore without adding a version');
}else{
 const auth=JSON.parse(await fs.readFile(path.join(runtime.home,'access.key'),'utf8'));
 const {encryptLegacy,encodeBase64}=await import('../../../../happy-cli/src/api/encryption.ts');
 const key=new Uint8Array(Buffer.from(auth.secret,'base64'));
 const {publicKey,privateKey}=crypto.generateKeyPairSync('ed25519');const challenge=crypto.randomBytes(32);
 const response=await fetch(runtime.serverUrl+'/v1/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({publicKey:Buffer.from(publicKey.export({format:'jwk'}).x,'base64url').toString('base64'),challenge:challenge.toString('base64'),signature:crypto.sign(null,challenge,privateKey).toString('base64')})});assert(response.ok);const other=await response.json();
 const headers={Authorization:'Bearer '+other.token};
 const session=await fetch(runtime.serverUrl+'/v2/sessions/'+runtime.sessionIds.at(-1),{headers});assert([403,404].includes(session.status));
 const machines=await(await fetch(runtime.serverUrl+'/v1/machines',{headers})).json();assert(!JSON.stringify(machines).includes(runtime.machineId));
 const require=createRequire(new URL('../../../../happy-cli/package.json',import.meta.url));const {io}=require('socket.io-client');
 const socket=io(runtime.serverUrl,{path:'/v1/updates',transports:['websocket'],reconnection:false,auth:{token:other.token,clientType:'user-scoped'}});
 try {await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Account B connect timed out')),10000);socket.once('connect',()=>{clearTimeout(timer);resolve();});});
  const reply=await socket.timeout(20000).emitWithAck('rpc-call',{method:runtime.machineId+':artifactRead',params:encodeBase64(encryptLegacy(ref,key))});assert.equal(reply.ok,false);
 }finally{socket.disconnect();}
 evidence.push('independent account cannot list the machine, read the session, or route its encrypted artifact RPC');
 const privateDirectory=path.join(runtime.project,'../scope-test');await fs.mkdir(privateDirectory,{recursive:true});await fs.writeFile(path.join(privateDirectory,'private.md'),'synthetic outside session');
 const alias=path.join(runtime.project,'scope-escape');await fs.symlink(privateDirectory,alias).catch(e=>{if(e.code!=='EEXIST')throw e;});
 const scope=runtime.sessionIds.at(-1);
 const denied=await raw('artifactRegister',{root:privateDirectory,entryPath:'private.md',managedPaths:['private.md'],operationId:crypto.randomUUID()},scope);assert.equal(denied.error?.code,'PATH_OUT_OF_BOUNDS');
 const symlink=await raw('artifactRegister',{root:runtime.project,entryPath:'scope-escape/private.md',managedPaths:['scope-escape/private.md'],operationId:crypto.randomUUID()},scope);assert.equal(symlink.error?.code,'PATH_OUT_OF_BOUNDS');
 evidence.push('real session RPC rejects sibling workspace and symlink escape');
}
const result={date:new Date().toISOString(),mode,evidence,production:false};await fs.writeFile(new URL('boundaries-'+mode+'.json',output),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
