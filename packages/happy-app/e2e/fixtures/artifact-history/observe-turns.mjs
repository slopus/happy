/** Recording observer: encrypted account events, no business polling or model adapter. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
const output=new URL('../../../test-results/artifact-history/',import.meta.url);
const r=JSON.parse(await fs.readFile(new URL('runtime.json',output),'utf8'));
const replay=JSON.parse(await fs.readFile(new URL('replay.json',output),'utf8'));
const auth=JSON.parse(await fs.readFile(path.join(r.home,'access.key'),'utf8'));
const require=createRequire(new URL('../../../../happy-cli/package.json',import.meta.url));const {io}=require('socket.io-client');const nacl=require('tweetnacl');
const socket=io(r.serverUrl,{path:'/v1/updates',transports:['websocket'],reconnection:false,auth:{token:auth.token,clientType:'user-scoped'}});
socket.once('connect',()=>console.log(JSON.stringify({ready:true})));
socket.on('update',event=>{const b=event?.body;if(b?.t!=='update-session'||b.id!==replay.sessionId||!b.agentState?.value)return;const bytes=Buffer.from(b.agentState.value,'base64');const plain=nacl.secretbox.open(bytes.subarray(24),bytes.subarray(0,24),Buffer.from(auth.secret,'base64'));if(!plain)return;const state=JSON.parse(Buffer.from(plain).toString());console.log(JSON.stringify({status:state?.turnStatus?.status}));});
process.on('SIGTERM',()=>{socket.disconnect();process.exit(0);});
