/** Real SDK control/result protocol fixture; no upstream model invocation. */
import { it, expect } from 'vitest';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionEnvelope } from '@slopus/happy-wire';
import { claudeRemote } from './claudeRemote';
import { claudeIdentityId } from '@/daemon/appDelegation/serviceCapabilities';
import { closeClaudeTurnWithStatus, mapClaudeLogMessageToSessionEnvelopes, type ClaudeSessionProtocolState } from './utils/sessionProtocolMapper';

it('initializes before input, closes an empty failed A, then attributes B only to its own answer', async()=>{
 const root=await mkdtemp(join(tmpdir(),'native-claude-ready-'));
 const executable=join(root,'claude');
 const login={loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',orgId:'org',accountUuid:'fixture'};
 const original={PATH:process.env.PATH,HAPPY_NATIVE_APPLICATION_POLICY:process.env.HAPPY_NATIVE_APPLICATION_POLICY,ANTHROPIC_API_KEY:process.env.ANTHROPIC_API_KEY,ANTHROPIC_AUTH_TOKEN:process.env.ANTHROPIC_AUTH_TOKEN,ANTHROPIC_BASE_URL:process.env.ANTHROPIC_BASE_URL};
 try {
  await writeFile(executable,`#!${process.execPath}
const readline=require('node:readline');
if(process.argv.includes('--version')){console.log('2.1.251 (Claude Code)');process.exit(0);}
if(process.argv.includes('auth')){console.log(${JSON.stringify(JSON.stringify(login))});process.exit(0);}
const rl=readline.createInterface({input:process.stdin});
let initialized=false,turn=0;
rl.on('line',line=>{
 const message=JSON.parse(line);
 if(message.type==='control_request'){
  initialized=true;
  console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:message.request_id,response:{commands:[],models:[],output_style:'default',available_output_styles:['default'],account:{}}}}));
 }
 if(message.type==='user'){
  if(!initialized)throw Error('Input before initialization');
  turn++;
  if(message.message.content!==(turn===1?'A':'B')||turn>2)throw Error('Unexpected or synthetic user input');
  if(turn===2)console.log(JSON.stringify({type:'assistant',uuid:'assistant-B',session_id:'fixture',parent_tool_use_id:null,message:{id:'message-B',type:'message',role:'assistant',model:'fixture',content:[{type:'text',text:'B answer'}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:1,output_tokens:1}}}));
  console.log(JSON.stringify({type:'result',subtype:turn===1?'error_during_execution':'success',is_error:turn===1,errors:turn===1?['Fixture error']:[],result:turn===1?'':'B answer',duration_ms:1,duration_api_ms:1,num_turns:1,total_cost_usd:0,usage:{},modelUsage:{},permission_denials:[],session_id:'fixture',uuid:'result-'+turn}));
 }
});
rl.on('close',()=>process.exit(0));
`);
  await chmod(executable,0o700);
  process.env.PATH=root+':'+original.PATH;
  for(const key of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL'])delete process.env[key];
  process.env.HAPPY_NATIVE_APPLICATION_POLICY=JSON.stringify({directory:root,systemPrompt:'trusted application',binding:{id:'binding',serviceId:'service',appId:'advisor',revision:1,machineId:'machine',engine:'claude',accountRef:{kind:'device-identity',machineId:'machine',identityId:claudeIdentityId(login)},requestedModel:null,reasoning:{mode:'default'},permissions:['chat'],permissionMode:'chat-only'}});
  let ready=false,received=0;
  const state:ClaudeSessionProtocolState={currentTurnId:null,acceptedLocalIds:[]};
  const envelopes:SessionEnvelope[]=[];
  await claudeRemote({sessionId:null,path:root,allowedTools:[],hookSettingsPath:join(root,'unused.json'),signal:AbortSignal.timeout(10000),
   canCallTool:async()=>({behavior:'deny',message:'No tools'}),onProcessorReady:()=>{ready=true;},
   nextMessage:async()=>{expect(ready).toBe(true);received++;if(received>2)return null;const id=received===1?'A':'B';state.acceptedLocalIds!.push([id]);return {message:id,mode:{permissionMode:'plan'}};},
   onReady:status=>{envelopes.push(...closeClaudeTurnWithStatus(state,status??'completed').envelopes);},isAborted:()=>false,onSessionFound:()=>{},
   onMessage:message=>{if(message.type==='assistant')envelopes.push(...mapClaudeLogMessageToSessionEnvelopes(message as any,state).envelopes);}});
  expect(ready).toBe(true);expect(received).toBe(3);
  expect(envelopes.map(e=>e.ev)).toEqual([{t:'turn-start',localIds:['A']},{t:'turn-end',status:'failed'},{t:'turn-start',localIds:['B']},{t:'text',text:'B answer'},{t:'turn-end',status:'completed'}]);
  expect(envelopes[0].turn).toBe(envelopes[1].turn);
  expect(envelopes[2].turn).toBe(envelopes[4].turn);
  expect(envelopes[0].turn).not.toBe(envelopes[2].turn);
  expect(state.acceptedLocalIds).toEqual([]);
 }finally{
  for(const [key,value] of Object.entries(original)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  await rm(root,{recursive:true,force:true});
 }
},15000);
