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
   if(String(url).endsWith('/turns/waiting'))return new Promise<Response>((_,reject)=>init?.signal?.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));
   return f.fetcher(url,init);
  };
  client=createAIServiceClient({appId:'advisor',transport:createNodePlatformTransport({appId:'advisor',receipt:makeReceipt('platform-grant'),serverUrl:'https://paws.test',storage:createMemoryServiceStorage(),fetch:fetcher})});await client.connections.authorize();
  const events:unknown[]=[];let settled=false;const watching=client.turns.observe({bindingId:'binding',turnId:'waiting',maxDurationMs:100},e=>events.push(e));void watching.done.then(()=>settled=true);
  await vi.advanceTimersByTimeAsync(100);expect(settled).toBe(true);expect(events).toMatchObject([{type:'error',error:{code:'observation-expired'}}]);expect(vi.getTimerCount()).toBe(0);
 }finally{client?.dispose();vi.useRealTimers();}
});
