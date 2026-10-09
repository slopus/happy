import { it, expect, vi } from 'vitest';
import { createAIServiceClient } from './client';
import { createNodePlatformTransport } from './nodePlatformTransport';
import { createPlatformServiceHandler } from './nodePlatformHandler';
import { createBrowserPlatformTransport } from './platformTransport';
import { createMemoryServiceStorage } from './storage';
import { binding, fixture, makeReceipt } from './testFixtures';
it('requires host login and conversation ownership before every upstream bridge action', async () => {
    const upstream = fixture(), node = createAIServiceClient({ appId: 'advisor', transport: createNodePlatformTransport({ appId: 'advisor', receipt: makeReceipt('platform-grant'), serverUrl: 'https://paws.test', storage: createMemoryServiceStorage(), fetch: upstream.fetcher }) });
    const handler = createPlatformServiceHandler(node, { authorize: async (operation, context: {
            user: string;
        }) => context.user === 'owner' && (!operation.bindingId || operation.bindingId === 'binding'), registerConversation: async () => { }, resolveBinding: async () => binding });
    const denied = await handler({ method: 'GET', path: '/bindings/binding/turns/turn' }, { user: 'other' });
    expect(denied.status).toBe(403);
    expect(upstream.requests).toHaveLength(0);
    const smuggled = await handler({ method: 'POST', path: '/bindings/binding/turns', body: { requestId: 'request', messages: [{ role: 'user', text: 'hello' }], subject: 'owner' } }, { user: 'other' });
    expect(smuggled.status).not.toBe(200);
    expect(upstream.requests).toHaveLength(0);
    const bridgeFetch: typeof fetch = async (url, init) => { const requestUrl = new URL(String(url)); expect(requestUrl.origin).toBe('https://app.test'); expect(new Headers(init?.headers).has('authorization')).toBe(false); expect(init?.credentials).toBe('same-origin'); const result = await handler({ method: init?.method ?? 'GET', path: requestUrl.pathname.replace('/api/ai', ''), body: init?.body ? JSON.parse(String(init.body)) : undefined, signal: init?.signal ?? undefined }, { user: 'owner' }); return Response.json(result.body, { status: result.status, headers: result.headers }); };
    const browser = createAIServiceClient({ appId: 'advisor', transport: createBrowserPlatformTransport({ appId: 'advisor', baseUrl: '/api/ai', origin: 'https://app.test', storage: createMemoryServiceStorage(), fetch: bridgeFetch }) });
    const connection = await browser.connections.authorize();
    expect(Object.keys(connection)).not.toContain('messageKey');
    const bound = await browser.conversations.create();
    expect(bound).toEqual(binding);
    await expect(browser.turns.start({ binding: bound, requestId: 'request', messages: [{ role: 'user', text: 'hello' }] })).rejects.toMatchObject({ code: 'transport-error', requestId: 'request' });
    const restored = await browser.turns.start({ binding: bound, requestId: 'request', messages: [{ role: 'user', text: 'hello' }] });
    expect(restored.record.id).toBe('turn');
    expect(upstream.posts).toBe(1);
    expect((await browser.turns.read({ bindingId: 'binding', turnId: 'turn' })).text).toBe('answer');
    browser.dispose();
    node.dispose();
});
it('refuses a cross-origin application bridge', () => expect(() => createBrowserPlatformTransport({ appId: 'advisor', baseUrl: 'https://foreign.test', origin: 'https://app.test', storage: createMemoryServiceStorage() })).toThrow());

it('rejects a caller-supplied foreign origin when an actual page location exists', () => {
    vi.stubGlobal('location', { origin: 'https://actual-app.test' });
    try {
        expect(() => createBrowserPlatformTransport({ appId: 'advisor', origin: 'https://foreign.test', baseUrl: 'https://foreign.test/api/ai', storage: createMemoryServiceStorage() })).toThrowError(expect.objectContaining({ code: 'permission-denied' }));
        const transport = createBrowserPlatformTransport({ appId: 'advisor', baseUrl: '/api/ai', storage: createMemoryServiceStorage() });
        transport.dispose();
    } finally { vi.unstubAllGlobals(); }
});

it('forwards change cursors through the browser bridge and rechecks host ownership after waiting', async () => {
 const upstream=fixture(), cursor='a'.repeat(64); let allowed=true;
 const fetcher:typeof fetch=async(url,init)=>{
  const response=await upstream.fetcher(url,init), request=new URL(String(url));
  if(!request.pathname.endsWith('/turns/turn'))return response;
  expect(request.searchParams.get('observe')).toBe('1');
  if(request.searchParams.has('after')){expect(request.searchParams.get('after')).toBe(cursor);allowed=false;}
  return Response.json({...await response.json(),observationCursor:cursor});
 };
 const node=createAIServiceClient({appId:'advisor',transport:createNodePlatformTransport({appId:'advisor',receipt:makeReceipt('platform-grant'),serverUrl:'https://paws.test',storage:createMemoryServiceStorage(),fetch:fetcher})});
 const handler=createPlatformServiceHandler(node,{authorize:async()=>allowed,registerConversation:async()=>{},resolveBinding:async()=>binding});
 const bridgeFetch:typeof fetch=async(url,init)=>{
  const result=await handler({method:init?.method??'GET',path:new URL(String(url)).pathname.replace('/api/ai',''),body:init?.body?JSON.parse(String(init.body)):undefined,signal:init?.signal??undefined},{});
  return Response.json(result.body,{status:result.status});
 };
 const browser=createBrowserPlatformTransport({appId:'advisor',baseUrl:'/api/ai',origin:'https://app.test',storage:createMemoryServiceStorage(),fetch:bridgeFetch});
 try{
  await browser.authorize();await expect(browser.start({binding,requestId:'request',messages:[{role:'user',text:'hello'}]})).rejects.toThrow();
  expect((await browser.read({bindingId:'binding',turnId:'turn'})).observationCursor).toBe(cursor);
  await expect(browser.read({bindingId:'binding',turnId:'turn'},{waitForChange:cursor})).rejects.toMatchObject({code:'permission-denied',retryable:false});
 }finally{browser.dispose();node.dispose();}
});
