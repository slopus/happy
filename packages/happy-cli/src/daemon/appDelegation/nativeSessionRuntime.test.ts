import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeSessionRuntime, nativeTranscript, type NativeMessage, type NativeSessionHooks } from './nativeSessionRuntime';
import type { ExecutionBinding } from '@slopus/happy-wire';
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
const binding={id:'binding',serviceId:'service',revision:1,appId:'advisor',machineId:'machine',engine:'codex',accountRef:{kind:'codex-profile',id:'precise'},requestedModel:'model',reasoning:{mode:'explicit',value:'medium'},permissions:['chat'],permissionMode:'chat-only'} as ExecutionBinding;
async function fixture() {
 const root=await mkdtemp(join(tmpdir(),'paws-native-'));roots.push(root);
 const phases:string[]=[];
 const messages:NativeMessage[]=[];const listeners=new Set<(message:NativeMessage)=>void>();
 let active=true,running=false,starts=0,sends=0,dropResponse=false;
 const append=(content:unknown,localId:string|null=null)=>{const message={id:String(messages.length+1),seq:messages.length+1,content,localId};messages.push(message);for(const consume of listeners)consume(message);};
 const event=(ev:unknown,turn='turn')=>append({role:'session',content:{type:'session',data:{role:'agent',turn,ev}}});
 const hooks:NativeSessionHooks={
  connect:async()=>{},get:async()=>({id:'session',active,metadata:{machineId:'machine',application:{appId:'advisor',bindingId:'binding'},codexAccountProfileId:'precise',path:root},agentState:{turnStatus:{status:running?'running':'completed'}}}),
  historyPage:async(_id,{afterSeq})=>({messages:messages.filter(m=>m.seq>afterSeq),hasMore:false}),
  watch:async(_id,options)=>{const consume=(message:NativeMessage)=>{if(message.seq>options.afterSeq)options.onMessage(message);};listeners.add(consume);messages.forEach(consume);return {sync:async()=>messages.forEach(consume),unsubscribe:()=>{listeners.delete(consume);}};},
  start:async input=>{expect(input.binding.accountRef).toEqual({kind:'codex-profile',id:'precise'});expect(input.binding.permissionMode).toBe('chat-only');starts++;active=true;append({role:'agent',content:{type:'event',data:{type:'ready'}}});return {type:'success',sessionId:'session'};},
  send:async input=>{sends++;append({role:'user',content:{type:'text',text:input.text}},input.localId);event({t:'turn-start',localIds:[input.localId]},input.localId);event({t:'text',text:'answer'},input.localId);event({t:'turn-end',status:'completed'},input.localId);if(dropResponse)throw Error('lost acknowledgment');},cancel:async()=>{throw Error('must not cancel another surface');},
 };
 const runtime=createNativeSessionRuntime({hooks,root,machineId:'machine',readyTimeoutMs:20,pollMs:1});
 const execute=(requestId:string,sessionId?:string,signal=new AbortController().signal)=>runtime.execute(binding,{id:requestId,requestId,conversationId:'conversation',createdAt:0,messages:[{role:'user',text:requestId}]},{sessionId,systemPrompt:'policy',codexSessionGrant:'exact-grant',attach:async()=>{}},signal,event=>{if(event.type==='phase')phases.push(event.phase);});
 return {runtime,hooks,execute,phases,messages,append,event,setActive:(value:boolean)=>{active=value;},setRunning:(value:boolean)=>{running=value;},drop:()=>{dropResponse=true;},counts:()=>({starts,sends})};
}
describe('native application sessions',()=>{
 it('spawns once, sends only new input, then reuses the same session',async()=>{const f=await fixture();expect((await f.execute('first')).sessionId).toBe('session');await f.execute('second','session');expect(f.counts()).toEqual({starts:1,sends:2});expect(nativeTranscript(f.messages).filter(m=>m.role==='user').map(m=>m.text)).toEqual(['first','second']);});
 it('resumes the bound session after exit preserving exact identity and permissions',async()=>{const f=await fixture();await f.execute('first');f.setActive(false);await f.execute('second','session');expect(f.counts().starts).toBe(2);});
 it('reconciles dropped send response and repeated request without resending',async()=>{const f=await fixture();f.drop();expect((await f.execute('first')).text).toBe('answer');expect((await f.execute('first','session')).text).toBe('answer');expect(f.counts()).toEqual({starts:1,sends:1});});
 it('rejects another machine/application/account before submitting',async()=>{const f=await fixture();const get=f.hooks.get;f.hooks.get=async id=>({...await get(id),metadata:{machineId:'other'}});await expect(f.execute('first')).rejects.toThrow('permission-denied');expect(f.counts().sends).toBe(0);});
 it('does not send or cancel when a Paws turn is running',async()=>{const f=await fixture();f.setRunning(true);await expect(f.execute('first','session')).rejects.toThrow('resource-busy');expect(f.counts()).toEqual({starts:0,sends:0});});

 it('ignores another queued turn and correlates only the accepted localId',async()=>{
  const f=await fixture();const send=f.hooks.send;
  f.hooks.send=async input=>{f.append({role:'user',content:{type:'text',text:input.text}},input.localId);f.event({t:'turn-start',localIds:['paws-other']},'other');f.event({t:'text',text:'wrong answer'},'other');f.event({t:'turn-end',status:'completed'},'other');return send(input);};
  expect((await f.execute('first')).text).toBe('answer');
 });
 it('worker exit preserves the accepted request and reconciles later without another send',async()=>{
  const f=await fixture();const control=new AbortController();let accepted='';
  f.hooks.send=async input=>{accepted=input.localId;f.append({role:'user',content:{type:'text',text:input.text}},input.localId);f.event({t:'turn-start',localIds:[input.localId]},input.localId);control.abort();};
  await expect(f.execute('first',undefined,control.signal)).rejects.toThrow('native-execution-pending');
  f.event({t:'text',text:'recovered answer'},accepted);f.event({t:'turn-end',status:'completed'},accepted);
  f.hooks.send=async()=>{throw Error('must not resend');};
  expect((await f.execute('first','session')).text).toBe('recovered answer');
 });
 it('cancels an unsubmitted request without touching a Paws execution',async()=>{const f=await fixture();f.setRunning(true);expect(await f.runtime.cancel(binding,'never-submitted','session')).toMatchObject({status:'cancelled'});expect(f.counts().sends).toBe(0);});
 it('reads Paws-side followups from native history and excludes private thinking',async()=>{const f=await fixture();await f.execute('first');f.append({role:'user',content:{type:'text',text:'from Paws'}},'paws');f.event({t:'text',text:'private',thinking:true});f.event({t:'text',text:'Paws reply'},'paws');const snapshot=await f.runtime.snapshot(binding,'session');expect(snapshot.messages.map(m=>m.text)).toEqual(['first','answer','from Paws','Paws reply']);expect(snapshot.messages.every(m=>m.id&&m.seq)).toBe(true);});
});

it('reports an online idle process as an idle conversation', async()=>{const f=await fixture();expect(await f.runtime.snapshot(binding,'session')).toMatchObject({active:false});f.setRunning(true);expect(await f.runtime.snapshot(binding,'session')).toMatchObject({active:true,phase:'generating'});});

it.each(['connect','get','historyPage','watch'] as const)('keeps an accepted request recovering when %s setup fails',async operation=>{
 const f=await fixture();const control=new AbortController();let localId='';let sends=0;
 f.hooks.send=async input=>{sends++;localId=input.localId;f.append({role:'user',content:{type:'text',text:input.text}},localId);f.event({t:'turn-start',localIds:[localId]},localId);control.abort();};
 await expect(f.execute('recover',undefined,control.signal)).rejects.toThrow('native-execution-pending');
 const original=f.hooks[operation];f.hooks[operation]=async()=>{throw Error('transient transport failure');};
 await expect(f.execute('recover','session')).rejects.toThrow('native-execution-pending');
 Object.assign(f.hooks,{[operation]:original});
 f.event({t:'text',text:'actual answer'},localId);f.event({t:'turn-end',status:'completed'},localId);
 expect((await f.execute('recover','session')).text).toBe('actual answer');expect(sends).toBe(1);
});
it('retains binding rejection even for an accepted request',async()=>{
 const f=await fixture();await f.execute('first');const get=f.hooks.get;f.hooks.get=async id=>({...await get(id),metadata:{machineId:'other'}});
 await expect(f.execute('first','session')).rejects.toThrow('permission-denied');
});
it('includes paginated canonical native users and deduplicates linked raw echoes only',async()=>{
 const f=await fixture();const native=(data:unknown)=>f.append({role:'session',content:{type:'session',data}});
 f.append({role:'user',content:{type:'text',text:'same question'}},'raw-one');
 native({id:'claude-user',claudeUuid:'uuid-user',role:'user',ev:{t:'text',text:'same question'}});
 f.event({t:'turn-start',localIds:['raw-one']},'claude-turn');f.event({t:'text',text:'first answer'},'claude-turn');
 native({id:'codex-user',turn:'local-turn',codexItemId:'native-item',role:'user',ev:{t:'text',text:'same question'}});
 f.event({t:'text',text:'native answer'},'local-turn');
 const cursors:number[]=[];f.hooks.historyPage=async(_id,{afterSeq})=>{cursors.push(afterSeq);const messages=f.messages.filter(message=>message.seq>afterSeq);return {messages:messages.slice(0,2),hasMore:messages.length>2};};
 const snapshot=await f.runtime.snapshot(binding,'session');
 expect(snapshot.messages.map(message=>message.text)).toEqual(['same question','first answer','same question','native answer']);expect(cursors.length).toBe(3);
});
it.each(['completed','failed','cancelled'] as const)('preserves native %s when cancellation arrives after the terminal event',async status=>{
 const f=await fixture();await f.execute('first');const terminal=f.messages.at(-1)!;
 (terminal.content as {content:{data:{ev:{status:string}}}}).content.data.ev.status=status;
 const result=await f.runtime.cancel(binding,'first','session');expect(result).toMatchObject({status,text:'answer',messages:[{role:'user',text:'first'}]});
});
it('reports submitted until the matching native turn actually starts',async()=>{
 const f=await fixture();f.hooks.send=async input=>{
  f.append({role:'user',content:{type:'text',text:input.text}},input.localId);
  setTimeout(()=>{expect(f.phases.at(-1)).toBe('submitted');f.event({t:'turn-start',localIds:[input.localId]},input.localId);expect(f.phases.at(-1)).toBe('generating');f.event({t:'text',text:'queued answer'},input.localId);f.event({t:'turn-end',status:'completed'},input.localId);},0);
 };
 expect((await f.execute('queued')).text).toBe('queued answer');
});
it('rehydrates native image file envelopes before their associated user text',async()=>{
 const f=await fixture();const data='data:image/png;base64,YQ==';
 f.append({role:'session',content:{type:'session',data:{role:'user',ev:{t:'file',ref:'sessions/session/attachments/image.enc',mimeType:'image/png',name:'image.png',size:1}}}},'photo:image:0');
 f.append({role:'user',content:{type:'text',text:'photo question'}},'photo');
 await expect(f.runtime.snapshot(binding,'session')).rejects.toThrow('protocol-incompatible');
 f.hooks.readImage=async(sessionId,ref,mimeType)=>{expect([sessionId,ref,mimeType]).toEqual(['session','sessions/session/attachments/image.enc','image/png']);return data;};
 const snapshot=await f.runtime.snapshot(binding,'session');expect(snapshot.messages).toEqual([{id:'photo',seq:2,role:'user',text:'photo question',images:[data]}]);
});

it('keeps the current submitted images in the returned turn transcript',async()=>{
 const f=await fixture(),images=['data:image/png;base64,YQ=='];
 const result=await f.runtime.execute(binding,{id:'image-turn',requestId:'image-turn',conversationId:'conversation',createdAt:0,messages:[{role:'user',text:'photo',images}]},{systemPrompt:'policy',attach:async()=>{}},new AbortController().signal,()=>{});
 expect(result.messages.at(-1)).toMatchObject({role:'user',text:'photo',images});
});

it('uses the durable user localId as transcript identity and falls back to the server id',()=>{
 const messages:NativeMessage[]=[{id:'server-row-1',seq:1,localId:'application:request-local-id',content:{role:'user',content:{type:'text',text:'same question'}}},{id:'server-row-2',seq:2,localId:null,content:{role:'user',content:{type:'text',text:'same question'}}}];
 expect(nativeTranscript(messages).map(message=>message.id)).toEqual(['application:request-local-id','server-row-2']);
});

it('carries approved legacy context and images in one first native submission only',async()=>{
 const f=await fixture(),send=f.hooks.send,submitted:Parameters<NativeSessionHooks['send']>[0][]=[];
 f.hooks.send=async input=>{submitted.push(input);return send(input);};
 const oldImage='data:image/png;base64,YQ==',newImage='data:image/jpeg;base64,Yg==';
 const messages=[{role:'user' as const,text:'old private question',images:[oldImage]},{role:'assistant' as const,text:'old private answer'},{role:'user' as const,text:'continue using the old answer',images:[newImage]}];
 const execute=(requestId:string,sessionId?:string)=>f.runtime.execute(binding,{id:requestId,requestId,conversationId:'conversation',createdAt:0,messages},{sessionId,systemPrompt:'policy',attach:async()=>{}},new AbortController().signal,()=>{});
 await execute('carry');
 expect(submitted).toHaveLength(1);
 expect(submitted[0].text).toContain(JSON.stringify(messages.map(({role,text})=>({role,text}))));
 expect(submitted[0].text).toContain('untrusted');
 expect(submitted[0].images?.map(image=>Buffer.from(image.bytes).toString())).toEqual(['a','b']);
 await execute('carry','session');expect(submitted).toHaveLength(1);
 await execute('next','session');expect(submitted).toHaveLength(2);
 expect(submitted[1].text).toBe('continue using the old answer');
 expect(submitted[1].images?.map(image=>Buffer.from(image.bytes).toString())).toEqual(['b']);
});
