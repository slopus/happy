import { expect, it } from 'vitest';
import { createAIServiceClient } from './client';
import { createNodePlatformTransport } from './nodePlatformTransport';
import { createBrowserPlatformTransport } from './platformTransport';
import { createPlatformServiceHandler } from './nodePlatformHandler';
import { createMemoryServiceStorage } from './storage';
import { binding, fixture, makeReceipt } from './testFixtures';
import { validateOverrides } from './scopedTransport';
const receipt = makeReceipt('platform-grant'), target = receipt.scope.targets[0];
const configuration = { service: { id: 'service', ownerId: 'owner', name: 'AI', enabled: true, revision: 1 }, allowModelOverride: true, allowReasoningOverride: true, defaults: { ...target, modelId: null, reasoning: { mode: 'default' } }, targets: [{ target, machineName: 'My Mac', accountName: 'Main' }], permissions: ['chat'] };
const catalog = {execution:{permissionModes:['chat-only'],serviceTiers:['default']}, ...target, protocol: 'ai-services/1', observedAt: Date.now(), availability: 'online', completeness: 'complete', models: [], defaultModelId: null };
function setup(mismatch = false) {
 const base = fixture(), calls: any[] = [];
 const node = createAIServiceClient({ appId: 'advisor', transport: createNodePlatformTransport({ appId: 'advisor', receipt, serverUrl: 'https://paws.test', storage: createMemoryServiceStorage(), fetch: async (url, init) => {
  const path = new URL(String(url)).pathname; calls.push({ path, body: init?.body && JSON.parse(String(init.body)) });
  if (path.endsWith('/configuration')) return Response.json(mismatch ? {...configuration, targets: [{ ...configuration.targets[0], target: {...target, machineId: 'foreign'} }]} : configuration);
  if (path.endsWith('/capabilities')) return Response.json({catalog: mismatch ? {...catalog, machineId:'foreign'} : catalog});
  return base.fetcher(url, init);
 } }) });
 const handler = createPlatformServiceHandler(node, { authorize: async () => true, registerConversation: async()=>{}, resolveBinding: async()=>binding });
 const browser = createAIServiceClient({ appId:'advisor', transport:createBrowserPlatformTransport({appId:'advisor', baseUrl:'/ai',origin:'https://app.test',storage:createMemoryServiceStorage(),fetch:async(url,init)=>{
  expect(new Headers(init?.headers).has('authorization')).toBe(false);
  const response=await handler({method:init?.method??'GET',path:new URL(String(url)).pathname.replace('/ai',''),body:init?.body?JSON.parse(String(init.body)):undefined},{});
  return Response.json(response.body,{status:response.status});
 }})});
 return {node,browser,calls,handler};
}
it('uses the same scoped directory and target capabilities through the platform bridge',async()=>{
 const {node,browser,calls}=setup(); await browser.connections.authorize();
 expect(await browser.services.configuration()).toEqual(configuration);
 expect(await browser.capabilities.read({target})).toEqual(catalog);
 expect(calls.find(x=>x.path.endsWith('/capabilities')).body).toEqual({target,executionPresets:true});
 browser.dispose();node.dispose();
});
it('rejects directory and capability targets outside the grant scope',async()=>{
 const {node,browser}=setup(true);await browser.connections.authorize();
 await expect(browser.services.configuration()).rejects.toMatchObject({code:'context-mismatch'});
 await expect(browser.capabilities.read({target})).rejects.toMatchObject({code:'context-mismatch'});
 browser.dispose();node.dispose();
});
it('validates all execution settings and refuses raw runtime parameters',()=>{
 const value={target,permissionMode:'yolo',serviceTier:'fast',permissions:['chat','tools']};
 expect(validateOverrides(value as any)).toEqual(value);
 expect(()=>validateOverrides({...value,serviceTier:'priority'} as any)).toThrow();
 expect(()=>validateOverrides({...value,cwd:'/tmp'} as any)).toThrow();
});

it('keeps capability reads from an already open legacy platform page compatible',async()=>{
 const {node,handler}=setup();await node.connections.authorize();
 const old=await handler({method:'POST',path:'/capabilities',body:{}},{});
 expect(old.status).toBe(200);expect((old.body as any).catalog).not.toHaveProperty('execution');
 const next=await handler({method:'POST',path:'/capabilities',body:{executionPresets:true}},{});
 expect((next.body as any).catalog.execution).toEqual(catalog.execution);node.dispose();
});
