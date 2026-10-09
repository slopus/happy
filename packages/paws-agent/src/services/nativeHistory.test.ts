import { deflateSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { it, expect } from 'vitest';
import { createAIServiceClient } from './client';
import { createBrowserPlatformTransport } from './platformTransport';
import { createNodePlatformTransport } from './nodePlatformTransport';
import { createPlatformServiceHandler } from './nodePlatformHandler';
import { createMemoryServiceStorage } from './storage';
import { binding, fixture, makeReceipt, encrypt } from './testFixtures';
import { validateConversationSnapshot, validateHistoryMessages, validateMessages } from './scopedTransport';

it('preserves twelve carried native images in one history message while keeping request image limits',()=>{
 const images=Array.from({length:12},()=> 'data:image/png;base64,YQ==');
 expect(validateHistoryMessages([{role:'user',text:'carried context',images}])[0].images).toEqual(images);
 expect(()=>validateHistoryMessages([{role:'user',text:'too many',images:[...images,images[0]]}])).toThrow('context-mismatch');
 expect(()=>validateMessages([{role:'user',text:'ordinary input',images:images.slice(0,5)}])).toThrow('invalid-request');
});

it('marks absent worker history as partial across initial phases, heartbeats and the browser bridge',async()=>{
 const upstream=fixture();let phase=0;
 const transport=createNodePlatformTransport({appId:'advisor',receipt:makeReceipt('platform-grant'),serverUrl:'https://paws.test',storage:createMemoryServiceStorage(),fetch:async(url,init)=>{
  const response=await upstream.fetcher(url,init);if(!new URL(String(url)).pathname.endsWith('/turns/turn'))return response;
  const row=await response.json();row.record.sessionId='native';row.record.status='running';row.record.startedAt=2;row.record.completedAt=null;row.record.phase=phase?'generating':'resuming';row.sequence=phase;
  row.output=phase?encrypt({protocol:'ai-services/1',grantId:'grant',appId:'advisor',serviceId:'service',bindingId:'binding',requestId:'request',turnId:'turn',direction:'output',sequence:phase,text:'partial'}):null;
  return Response.json(row);
 }});
 await transport.authorize();await expect(transport.start({binding,requestId:'request',messages:[{role:'user',text:'hello'}]})).rejects.toMatchObject({code:'transport-error'});
 const initial=await transport.read({bindingId:'binding',turnId:'turn'});expect(initial).toMatchObject({historyComplete:false,text:'',messages:[{role:'user',text:'hello'}]});
 phase=1;const heartbeat=await transport.read({bindingId:'binding',turnId:'turn'});expect(heartbeat).toMatchObject({historyComplete:false,text:'partial',messages:[{role:'user',text:'hello'}]});
 const browser=createBrowserPlatformTransport({appId:'advisor',baseUrl:'/api/ai',origin:'https://app.test',storage:createMemoryServiceStorage(),fetch:async url=>String(url).endsWith('/connection')?Response.json({id:'grant',source:'platform',appId:'advisor',serviceId:'service',expiresAt:null}):Response.json(heartbeat)});
 await browser.authorize();expect(await browser.read({bindingId:'binding',turnId:'turn'})).toMatchObject({historyComplete:false,text:'partial'});
 browser.dispose();transport.dispose();
});

it('reads fresh native Paws followups through grant-encrypted, binding-scoped history', async () => {
 const upstream=fixture(); let serial=0,wrong=false;
 const messages=[{id:'1',seq:1,role:'user',text:'hello'},{id:'2',seq:2,role:'assistant',text:'answer'}];
 const transport=createNodePlatformTransport({appId:'advisor',receipt:makeReceipt('platform-grant'),serverUrl:'https://paws.test',storage:createMemoryServiceStorage(),fetch:async (url,init)=>{
  if(!String(url).endsWith('/session')) return upstream.fetcher(url,init);
  const requestId=String(++serial);
  return Response.json({sessionId:'native',requestId,ciphertext:encrypt({protocol:'ai-services/1',direction:'session-history',grantId:'grant',appId:'advisor',serviceId:'service',bindingId:wrong?'foreign':'binding',sessionId:'native',requestId,messages,active:false})});
 }});
 const client=createAIServiceClient({appId:'advisor',transport});await client.connections.authorize();
 expect((await client.conversations.read('binding')).messages).toEqual(messages);
 messages.push({id:'3',seq:3,role:'user',text:'Question from Paws'},{id:'4',seq:4,role:'assistant',text:'Paws response'});
 expect((await client.conversations.read('binding')).messages).toEqual(messages);
 wrong=true;await expect(client.conversations.read('binding')).rejects.toMatchObject({code:'context-mismatch'});
 client.dispose();
});
it('uses native output history instead of stale submitted input', async () => {
 const upstream=fixture();
 const transport=createNodePlatformTransport({appId:'advisor',receipt:makeReceipt('platform-grant'),serverUrl:'https://paws.test',storage:createMemoryServiceStorage(),fetch:async (url,init)=>{
  const response=await upstream.fetcher(url,init);
  if(!new URL(String(url)).pathname.endsWith('/turns/turn')) return response;
  const row=await response.json();
  row.output=encrypt({protocol:'ai-services/1',grantId:'grant',appId:'advisor',serviceId:'service',bindingId:'binding',requestId:'request',turnId:'turn',direction:'output',sequence:1,text:'answer',messages:[{id:'paws',seq:4,role:'user',text:'Paws followup'}]});
  return Response.json(row);
 }});
 await transport.authorize();
 await expect(transport.start({binding,requestId:'request',messages:[{role:'user',text:'hello'}]})).rejects.toMatchObject({code:'transport-error'});
 expect((await transport.read({bindingId:'binding',turnId:'turn'})).messages).toEqual([{id:'paws',seq:4,role:'user',text:'Paws followup'}]);
 transport.dispose();
});
it('checks host ownership before native history and refuses malformed history', async () => {
 const client=createAIServiceClient({appId:'advisor',transport:createNodePlatformTransport({appId:'advisor',receipt:makeReceipt('platform-grant'),serverUrl:'https://paws.test',storage:createMemoryServiceStorage(),fetch:fixture().fetcher})});
 const handler=createPlatformServiceHandler(client,{authorize:async ()=>false,registerConversation:async()=>{},resolveBinding:async()=>binding});
 expect((await handler({method:'GET',path:'/bindings/binding/session'},{})).status).toBe(403);
 for(const value of [{sessionId:null,messages:[{role:'user',text:'invalid'}],active:false},{sessionId:'native',messages:[],active:'false'},{sessionId:'native',messages:[],active:false,phase:'imaginary'}]) expect(()=>validateConversationSnapshot(value)).toThrow();
 client.dispose();
});

it('preserves pending pre-attachment work without fabricating native history', async () => {
 const upstream=fixture();
 const transport=createNodePlatformTransport({appId:'advisor',receipt:makeReceipt('platform-grant'),serverUrl:'https://paws.test',storage:createMemoryServiceStorage(),fetch:async (url,init)=>String(url).endsWith('/session') ? Response.json({sessionId:null,requestId:null,ciphertext:null,active:true,phase:'preparing'}) : upstream.fetcher(url,init)});
 await transport.authorize();
 expect(await transport.readConversation!('binding')).toEqual({sessionId:null,messages:[],active:true,phase:'preparing'});
 transport.dispose();
});

function screenshotFixture():string {
 const chunk=(type:string,data:Buffer)=>{const body=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;for(const byte of body){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}const length=Buffer.alloc(4),checksum=Buffer.alloc(4);length.writeUInt32BE(data.length);checksum.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([length,body,checksum]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(512,0);header.writeUInt32BE(512,4);header[8]=8;header[9]=2;
 const scanlines=Buffer.alloc((512*3+1)*512);for(let row=0;row<512;row++)randomBytes(512*3).copy(scanlines,row*(512*3+1)+1);
 return 'data:image/png;base64,'+Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(scanlines)),chunk('IEND',Buffer.alloc(0))]).toString('base64');
}
it('round-trips an encrypted screenshot above the legacy cap and surfaces explicit oversize markers', async () => {
 const upstream=fixture(),image=screenshotFixture();let marker=false;
 const transport=createNodePlatformTransport({appId:'advisor',receipt:makeReceipt('platform-grant'),serverUrl:'https://paws.test',storage:createMemoryServiceStorage(),fetch:async (url,init)=>{
  const context={protocol:'ai-services/1',grantId:'grant',appId:'advisor',serviceId:'service',bindingId:'binding'};
  if(String(url).endsWith('/session')) return Response.json({sessionId:'native',requestId:'history',ciphertext:encrypt({...context,sessionId:'native',requestId:'history',direction:'session-history',active:false,messages:[],snapshotError:'snapshot-too-large'})});
  const response=await upstream.fetcher(url,init);
  if(!new URL(String(url)).pathname.endsWith('/turns/turn')) return response;
  const row=await response.json();row.record.sessionId='native';row.sequence=marker?2:1;
  row.output=encrypt({...context,requestId:'request',turnId:'turn',direction:'output',sequence:row.sequence,text:'Native answer',...(marker?{snapshotError:'snapshot-too-large',messages:[]}:{messages:[{role:'user',text:'Screenshot',images:[image]}]})});
  if(!marker) expect(row.output.length).toBeGreaterThan(1024*1024);
  return Response.json(row);
 }});
 await transport.authorize();
 await expect(transport.start({binding,requestId:'request',messages:[{role:'user',text:'hello'}]})).rejects.toMatchObject({code:'transport-error'});
 expect((await transport.read({bindingId:'binding',turnId:'turn'})).messages[0].images).toEqual([image]);
 marker=true;
 expect(await transport.read({bindingId:'binding',turnId:'turn'})).toMatchObject({record:{status:'completed',sessionId:'native'},text:'Native answer',messages:[],snapshotError:'snapshot-too-large'});
 await expect(transport.readConversation!('binding')).rejects.toMatchObject({code:'snapshot-too-large',retryable:false});
 transport.dispose();
});

it('keeps snapshot markers and size errors across the same-origin browser bridge',async()=>{
 const transport=createBrowserPlatformTransport({appId:'advisor',baseUrl:'/api/ai',origin:'https://app.test',storage:createMemoryServiceStorage(),fetch:async url=>{
  if(String(url).endsWith('/connection')) return Response.json({id:'grant',source:'platform',appId:'advisor',serviceId:'service',expiresAt:null});
  if(String(url).endsWith('/session')) return Response.json({error:{code:'snapshot-too-large',retryable:false}},{status:409});
  return Response.json({record:{id:'turn',conversationId:'binding',requestId:'request',binding,status:'completed',sessionId:'native',actual:{modelId:null,reasoning:null},createdAt:1,startedAt:1,completedAt:2,error:null},sequence:1,text:'Native answer',messages:[],snapshotError:'snapshot-too-large'});
 }});
 await transport.authorize();
 expect(await transport.read({bindingId:'binding',turnId:'turn'})).toMatchObject({record:{status:'completed'},text:'Native answer',messages:[],snapshotError:'snapshot-too-large'});
 await expect(transport.readConversation!('binding')).rejects.toMatchObject({code:'snapshot-too-large',retryable:false});
 transport.dispose();
});
