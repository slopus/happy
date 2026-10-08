import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeLaunchPolicyStore, nativeCodexMode } from './nativeLaunchPolicy';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { mapCodexMcpMessageToSessionEnvelopes } from '@/codex/utils/sessionProtocolMapper';

const policy = { binding: { id:'binding',serviceId:'service',revision:1,permissions:['chat'],appId:'advisor',machineId:'machine',engine:'codex',accountRef:{kind:'codex-profile',id:'exact'},requestedModel:'gpt-6-astra',reasoning:{mode:'explicit',value:'high'},serviceTier:'fast',permissionMode:'chat-only' }, systemPrompt:'trusted',directory:'/private/work' } as any;
describe('trusted native application launch',()=>{
 it('persists exact policy separately from mutable session metadata and rejects another session',async()=>{
  const root=await mkdtemp(join(tmpdir(),'native-policy-'));
  try {
   const store=new NativeLaunchPolicyStore(root);
   await store.save({...policy,sessionId:'s1'});
   expect(await store.forSession('s1',{application:{appId:'advisor',bindingId:'binding'},machineId:'machine',codexAccountProfileId:'exact'} as any)).toEqual({...policy,sessionId:'s1'});
   expect((await store.forSession('s1',{application:{appId:'advisor',bindingId:'binding'},machineId:'machine',codexAccountProfileId:'exact',currentOperatingModeCode:'yolo'} as any))?.binding.permissionMode).toBe('chat-only');
   await expect(store.forSession('s1',{machineId:'machine',codexAccountProfileId:'exact'} as any)).rejects.toThrow();
   await expect(store.forSession('s1',{application:{appId:'advisor',bindingId:'binding'},machineId:'machine',codexAccountProfileId:'default'} as any)).rejects.toThrow();
   await expect(store.forSession('s2',{application:{appId:'advisor',bindingId:'binding'},machineId:'machine',codexAccountProfileId:'exact'} as any)).rejects.toThrow();
   expect(nativeCodexMode(policy)).toEqual({permissionMode:'read-only',model:'gpt-6-astra',effort:'high',fast:true});
  }finally{await rm(root,{recursive:true,force:true});}
 });
 it('batches every accepted localId without mixing the following mode',async()=>{
  const queue=new MessageQueue2<string>(x=>x);
  queue.push('a','same',undefined,'a-id');queue.push('b','same',undefined,'b-id');queue.push('c','next',undefined,'c-id');
  const batch=await queue.waitForMessagesAndGetAsString();
  expect(batch?.localIds).toEqual(['a-id','b-id']);
  const mapped=mapCodexMcpMessageToSessionEnvelopes({type:'task_started',turn_id:'native-turn'},{currentTurnId:null,localIds:batch?.localIds});
  expect(mapped.envelopes[0].ev).toEqual({t:'turn-start',localIds:['a-id','b-id']});
  expect((await queue.waitForMessagesAndGetAsString())?.localIds).toEqual(['c-id']);
 });
});

import { nativeCodexConfig, nativeCodexRequest, nativeClaudeOptions } from './nativeProviderPolicy';
import { mapClaudeLogMessageToSessionEnvelopes, closeClaudeTurnWithStatus } from '@/claude/utils/sessionProtocolMapper';
import type { ClaudeSessionProtocolState } from '@/claude/utils/sessionProtocolMapper';
it('constrains thread resume and every turn despite caller model, sandbox, prompt and tool overrides',()=>{
 for(const method of ['thread/start','thread/resume','thread/fork']) {
  const request=nativeCodexRequest(policy,method,{model:'wrong',sandbox:'danger-full-access',baseInstructions:'attacker',developerInstructions:'override',config:{mcp_servers:{host:{command:'shell'}}},dynamicTools:[{name:'shell'}],selectedCapabilityRoots:['host']});
  expect(request).toMatchObject({model:'gpt-6-astra',sandbox:'read-only',baseInstructions:'trusted',developerInstructions:null,dynamicTools:[],selectedCapabilityRoots:[],environments:[],config:{mcp_servers:{},'features.shell_tool':false,'features.skip_host_skill_discovery':true,project_doc_max_bytes:0}});
 }
 expect(nativeCodexRequest(policy,'turn/start',{model:'other',effort:'low',sandboxPolicy:{type:'dangerFullAccess'}})).toMatchObject({model:'gpt-6-astra',effort:'high',sandboxPolicy:{type:'readOnly'},serviceTier:'priority'});
 expect(nativeCodexConfig(policy)['features.unified_exec']).toBe(false);
 const readOnly={...policy,binding:{...policy.binding,permissionMode:'read-only'}};
 expect(nativeCodexConfig(readOnly)['features.shell_tool']).toBe(true);
 expect(nativeCodexRequest(readOnly,'turn/start',{}).sandboxPolicy).toEqual({type:'readOnly'});
});
it('uses exact Claude executable and trusted prompt with no host settings or tools; unsupported policy fails closed',()=>{
 const claude={...policy,binding:{...policy.binding,engine:'claude',reasoning:{mode:'default'},serviceTier:'default'}};
 expect(nativeClaudeOptions(claude,'/verified/claude')).toMatchObject({pathToClaudeCodeExecutable:'/verified/claude',systemPrompt:'trusted',tools:[],mcpServers:{},settingSources:[],permissionMode:'dontAsk',extraArgs:{'safe-mode':null}});
 expect(()=>nativeClaudeOptions({...claude,binding:{...claude.binding,permissionMode:'read-only'}},'/verified/claude')).toThrow('parameter-unsupported');
});
it('attributes Claude turns to each accepted batch rather than later queued messages',()=>{
 const state:ClaudeSessionProtocolState={currentTurnId:null,acceptedLocalIds:[['a','b'],['c']]};
 const message={type:'assistant',uuid:'assistant',message:{role:'assistant',content:[{type:'text',text:'answer'}]}} as any;
 const first=mapClaudeLogMessageToSessionEnvelopes(message,state);
 expect(first.envelopes[0].ev).toEqual({t:'turn-start',localIds:['a','b']});
 closeClaudeTurnWithStatus(state,'completed');
 expect(mapClaudeLogMessageToSessionEnvelopes({...message,uuid:'next'},state).envelopes[0].ev).toEqual({t:'turn-start',localIds:['c']});
});

it('discards correlation for input cancelled before provider output',()=>{const state:ClaudeSessionProtocolState={currentTurnId:null,acceptedLocalIds:[['cancelled']]};closeClaudeTurnWithStatus(state,'cancelled');state.acceptedLocalIds!.push(['next']);const result=mapClaudeLogMessageToSessionEnvelopes({type:'assistant',uuid:'a',message:{role:'assistant',content:[{type:'text',text:'reply'}]}} as any,state);expect(result.envelopes[0].ev).toEqual({t:'turn-start',localIds:['next']});});

it('emits a failed correlated terminal for A with no assistant and gives only B its later answer',()=>{
 const state:ClaudeSessionProtocolState={currentTurnId:null,acceptedLocalIds:[['A']]};
 const failed=closeClaudeTurnWithStatus(state,'failed');
 expect(failed.envelopes.map(e=>e.ev)).toEqual([{t:'turn-start',localIds:['A']},{t:'turn-end',status:'failed'}]);
 expect(failed.envelopes[0].turn).toBe(failed.envelopes[1].turn);
 state.acceptedLocalIds!.push(['B']);
 const response=mapClaudeLogMessageToSessionEnvelopes({type:'assistant',uuid:'B-answer',message:{role:'assistant',content:[{type:'text',text:'B only'}]}} as any,state);
 expect(response.envelopes[0].ev).toEqual({t:'turn-start',localIds:['B']});
 expect(closeClaudeTurnWithStatus(state,'completed').envelopes[0].ev).toEqual({t:'turn-end',status:'completed'});
 expect(state.acceptedLocalIds).toEqual([]);
});
it('retires command-only batches and failure batches one at a time without clearing later inputs',()=>{
 const state:ClaudeSessionProtocolState={currentTurnId:null,acceptedLocalIds:[[],['next']]};
 expect(closeClaudeTurnWithStatus(state,'completed').envelopes.map(e=>e.ev)).toEqual([{t:'turn-start'},{t:'turn-end',status:'completed'}]);
 expect(state.acceptedLocalIds).toEqual([['next']]);
 state.acceptedLocalIds!.unshift(['failed']);
 expect(closeClaudeTurnWithStatus(state,'failed').envelopes[0].ev).toEqual({t:'turn-start',localIds:['failed']});
 expect(state.acceptedLocalIds).toEqual([['next']]);
});
