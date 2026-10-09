import { it, expect, vi } from 'vitest';
import { createAIServiceClient } from './client';
import { createNodePlatformTransport } from './nodePlatformTransport';
import { createMemoryServiceStorage } from './storage';
import { fixture, makeReceipt, binding } from './testFixtures';
it('rejects changed messages under an accepted request ID and never regenerates its encrypted envelope', async () => {
    const f = fixture(), storage = createMemoryServiceStorage(), client = createAIServiceClient({ appId: 'advisor', transport: createNodePlatformTransport({ appId: 'advisor', receipt: makeReceipt('platform-grant'), serverUrl: 'https://paws.test', storage, fetch: f.fetcher }) });
    await client.connections.authorize();
    await expect(client.turns.start({ binding, requestId: 'request', messages: [{ role: 'user', text: 'hello' }] })).rejects.toThrow();
    const envelope = await storage.get('outbox:binding:request');
    await expect(client.turns.start({ binding, requestId: 'request', messages: [{ role: 'user', text: 'changed' }] })).rejects.toMatchObject({ code: 'invalid-request' });
    expect(await storage.get('outbox:binding:request')).toEqual(envelope);
    expect(f.posts).toBe(1);
    client.dispose();
});
it('stops in-flight observation and removes its abort listener on disposal', async () => {
    const f = fixture(), client = createAIServiceClient({ appId: 'advisor', transport: createNodePlatformTransport({ appId: 'advisor', receipt: makeReceipt('platform-grant'), serverUrl: 'https://paws.test', storage: createMemoryServiceStorage(), fetch: f.fetcher }) });
    await client.connections.authorize();
    const signal = new AbortController();
    const removed = vi.spyOn(signal.signal, 'removeEventListener');
    let events = 0;
    const watching = client.turns.observe({ bindingId: 'binding', turnId: 'nonexistent', signal: signal.signal }, () => events++);
    client.dispose();
    await watching.done;
    expect(events).toBe(0);
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
});
it('bounds an observation even while its HTTP read is still in flight',async()=>{
 vi.useFakeTimers();let client:ReturnType<typeof createAIServiceClient>|undefined;
 try {
  const f=fixture();const fetcher:typeof fetch=async(url,init)=>{
   if(new URL(String(url)).pathname.endsWith('/turns/waiting'))return new Promise<Response>((_,reject)=>init?.signal?.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));
   return f.fetcher(url,init);
  };
  client=createAIServiceClient({appId:'advisor',transport:createNodePlatformTransport({appId:'advisor',receipt:makeReceipt('platform-grant'),serverUrl:'https://paws.test',storage:createMemoryServiceStorage(),fetch:fetcher})});await client.connections.authorize();
  const events:unknown[]=[];let settled=false;const watching=client.turns.observe({bindingId:'binding',turnId:'waiting',maxDurationMs:100},e=>events.push(e));void watching.done.then(()=>settled=true);
  await vi.advanceTimersByTimeAsync(100);expect(settled).toBe(true);expect(events).toMatchObject([{type:'error',error:{code:'observation-expired'}}]);expect(vi.getTimerCount()).toBe(0);
 }finally{client?.dispose();vi.useRealTimers();}
});

it.each([false,true])('observes without the fixed delay and falls back after a failed long poll (%s)',async(failWait)=>{
 vi.useFakeTimers();
 const {AIServiceClientError}=await import('./types');
 const record={id:'turn',conversationId:'binding',requestId:'request',binding,status:'running',actual:{modelId:null,reasoning:null},createdAt:1,startedAt:1,completedAt:null,error:null};
 const first={record,sequence:1,text:'a',messages:[],observationCursor:'a'.repeat(64)};
 const read=vi.fn().mockResolvedValueOnce(first);
 if(failWait)read.mockRejectedValueOnce(new AIServiceClientError('transport-error',true));
 read.mockResolvedValueOnce({...first,record:{...record,status:'completed'},observationCursor:'b'.repeat(64)});
 const transport={appId:'advisor',source:'platform',read,dispose:vi.fn()} as unknown as import('./types').AIServiceTransport;
 const client=createAIServiceClient({appId:'advisor',transport});
 try{
  const events:unknown[]=[];const subscription=client.turns.observe({bindingId:'binding',requestId:'request'},e=>events.push(e));await subscription.done;
  expect(read).toHaveBeenCalledTimes(failWait?3:2);expect(read.mock.calls[1][0]).toMatchObject({turnId:'turn',requestId:'request'});
  expect(read.mock.calls[1][1]).toMatchObject({waitForChange:'a'.repeat(64)});
  if(failWait)expect(read.mock.calls[2][1]).not.toHaveProperty('waitForChange');
  expect(events).toHaveLength(2);expect(vi.getTimerCount()).toBe(0);
 }finally{client.dispose();vi.useRealTimers();}
});
