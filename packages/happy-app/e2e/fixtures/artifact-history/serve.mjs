/** Isolated full App + production daemon/native-worker acceptance environment. No model adapter. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import helpers from '../../../../../environments/environments.ts';
const {createEnvironment,getEnvironmentConfig,setEnvironmentTemplate,startEnvironmentServices,seedEnvironment,startEnvironmentWeb,stopEnvironment,removeEnvironment}=helpers;
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../../..');
const output=path.join(root,'packages/happy-app/test-results/artifact-history');await fs.mkdir(output,{recursive:true,mode:0o700});
process.env.HAPPY_E2E_DISABLE_WATCHMAN='1';process.env.HAPPY_E2E_WEB_NO_DEV='0';process.env.S3_HOST='';delete process.env.TSX_TSCONFIG_PATH;
process.env.NO_PROXY=[process.env.NO_PROXY,'localhost','127.0.0.1','::1'].filter(Boolean).join(',');
const log=console.log;console.log=(...args)=>log(...args.map(v=>typeof v==='string'&&v.includes('Auth URL:')?'Auth URL: stored privately':v));
let environment, runtime, accountSocket, controller, daemonEnv, machineId, sessionIds=[], encryption, auth, key, serverUrl, directory;
async function command(args,env=daemonEnv){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(root,'packages/happy-cli/bin/happy.mjs'),...args],{cwd:root,env,stdio:['ignore','pipe','pipe']});let out='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>out+=b);child.once('error',reject);child.once('exit',code=>code===0?resolve(out):reject(new Error('Isolated CLI command failed: '+args.join(' ')+' (see private daemon logs)')));});}
function once(emitter,event,predicate=()=>true,timeout=30000){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{emitter.off(event,listener);reject(new Error('Timeout '+event));},timeout);const listener=value=>{if(!predicate(value))return;clearTimeout(timer);emitter.off(event,listener);resolve(value);};emitter.on(event,listener);});}
async function rpc(method,input={},scope=machineId){const params=encryption.encodeBase64(encryption.encryptLegacy(input,key));const result=await accountSocket.timeout(95000).emitWithAck('rpc-call',{method:scope+':'+method,params});if(!result.ok)throw new Error(result.error||'RPC unavailable');return encryption.decryptLegacy(new Uint8Array(Buffer.from(result.result,'base64')),key);}
async function main(){
 environment=await createEnvironment({noSwitch:true});setEnvironmentTemplate(environment,'authenticated-empty');await startEnvironmentServices(environment,{startWeb:false});await seedEnvironment(environment,{startDaemon:false});const config=getEnvironmentConfig(environment);directory=path.join(root,'environments/data/envs',environment);serverUrl='http://localhost:'+config.serverPort;
 const home=path.join(directory,'cli/home');auth=JSON.parse(await fs.readFile(path.join(home,'access.key'),'utf8'));key=new Uint8Array(Buffer.from(auth.secret,'base64'));machineId=JSON.parse(await fs.readFile(path.join(home,'settings.json'),'utf8')).machineId;
 const project=path.join(directory,'artifact-project');await fs.mkdir(project,{recursive:true});await fs.writeFile(path.join(project,'README.md'),'# Synthetic artifact history acceptance\nAll generated work belongs to this isolated test. Work only inside this directory.\n');
 const codexHome=path.join(directory,'codex-home');await fs.mkdir(codexHome,{mode:0o700});const nativeHome=process.env.CODEX_HOME||path.join(os.homedir(),'.codex');try{await fs.copyFile(path.join(nativeHome,'auth.json'),path.join(codexHome,'auth.json'));await fs.chmod(path.join(codexHome,'auth.json'),0o600);}catch(error){if(error.code!=='ENOENT')throw error;}
 daemonEnv={...process.env,HAPPY_HOME_DIR:home,HAPPY_SERVER_URL:serverUrl,HAPPY_WEBAPP_URL:'http://localhost:'+config.expoPort,CODEX_HOME:codexHome,HAPPY_CODEX_PATH:'/Users/jacky/.local/bin/codex',HAPPY_CODEX_APP_SERVER_MODE:'spawn'};
 for(const name of Object.keys(daemonEnv))if(name==='CLAUDECODE'||name.startsWith('HAPPY_CODEX_ACCOUNT_')||name.startsWith('HAPPY_CODEX_SESSION_'))delete daemonEnv[name];
 encryption=await import('../../../../happy-cli/src/api/encryption.ts');const require=createRequire(path.join(root,'packages/happy-cli/package.json'));const {io}=require('socket.io-client');accountSocket=io(serverUrl,{path:'/v1/updates',transports:['websocket'],reconnection:false,auth:{token:auth.token,clientType:'user-scoped'}});await once(accountSocket,'connect');
 await command(['daemon','start']);
 const capability=await rpc('artifactCapabilities');assert(capability.ok && capability.value.protocol===2,'Production daemon protocol v2 must be registered');
 runtime={environment,pid:process.pid,nodeBinary:process.execPath,machineId,sessionIds,project,home,codexHome,serverUrl,webUrl:'http://localhost:'+config.expoPort,authUrlFile:path.join(output,'auth-url.txt'),boundaries:{app:'full Expo App',server:'isolated PGlite',daemon:'real branch CLI daemon',worker:'real spawned Paws Codex worker + native app-server',model:'gpt-6.1-sol high',files:'synthetic',production:false}};
 await fs.writeFile(runtime.authUrlFile,config.authenticatedWebUrl,{mode:0o600});await fs.writeFile(path.join(output,'runtime.json'),JSON.stringify(runtime,null,2));
 controller=createServer(async(request,response)=>{response.setHeader('Content-Type','application/json');try{const url=new URL(request.url,'http://127.0.0.1');let body={};if(request.method==='POST'){let raw='';for await(const chunk of request)raw+=chunk;assert(raw.length<4*1024*1024);body=raw?JSON.parse(raw):{};}
  if(url.pathname==='/runtime')return response.end(JSON.stringify(runtime));
  if(request.method==='POST'&&url.pathname==='/rpc'){assert(body.method.startsWith('artifact')||['workspaceReadFile','workspaceWriteFile','workspaceListDirectory','stop-session'].includes(body.method));return response.end(JSON.stringify(await rpc(body.method,body.input,body.scope||machineId)));}
  if(request.method==='POST'&&url.pathname==='/spawn'){const result=await rpc('spawn-happy-session',{directory:project,agent:'codex',model:'gpt-6.1-sol',effort:'high'});if(result.type==='success'){sessionIds.push(result.sessionId);await fs.writeFile(path.join(output,'runtime.json'),JSON.stringify(runtime,null,2));}return response.end(JSON.stringify(result));}
  if(request.method==='POST'&&url.pathname==='/restart'){for(const id of sessionIds)await rpc('stop-session',{sessionId:id});await command(['daemon','stop']);await command(['daemon','start']);const caps=await rpc('artifactCapabilities');assert(caps.ok);return response.end(JSON.stringify({restarted:true,protocol:caps.value.protocol}));}
  response.writeHead(404);response.end('{}');
 }catch(error){response.writeHead(500);response.end(JSON.stringify({error:String(error)}));}});await new Promise(resolve=>controller.listen(0,'127.0.0.1',resolve));runtime.controllerUrl='http://127.0.0.1:'+controller.address().port;await fs.writeFile(path.join(output,'runtime.json'),JSON.stringify(runtime,null,2));
 await startEnvironmentWeb(environment,{warmBundle:true});await import('../goal-board/repair-router-types.mjs');log(JSON.stringify({ready:true,webUrl:runtime.webUrl,controllerUrl:runtime.controllerUrl,authUrlFile:runtime.authUrlFile}));
}
let closing=false;async function cleanup(code=0){if(closing)return;closing=true;try{let extra=[];try{extra=JSON.parse(await fs.readFile(path.join(output,'extra-session-ids.json'),'utf8'));}catch{}for(const id of new Set([...sessionIds,...extra]))await rpc('stop-session',{sessionId:id});await command(['daemon','stop']);}catch{}accountSocket?.disconnect();controller?.close();if(environment){stopEnvironment(environment);removeEnvironment(environment);}process.exit(code);}
process.on('SIGTERM',()=>{void cleanup();});process.on('SIGINT',()=>{void cleanup();});main().catch(error=>{console.error(String(error));void cleanup(1);});
