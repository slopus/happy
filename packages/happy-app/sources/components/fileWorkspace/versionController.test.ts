import { describe, it, expect, vi } from 'vitest';
import { VersionController } from './versionController';
const artifact = { id: 'a', workspaceId: 'w', name: 'Doc', kind: 'markdown', entryPath: 'doc.md', managedPaths: ['doc.md'], currentVersionId: 'v3' };
const read = (id = 'v3', text = id) => ({ artifact, entryContent: text, manifest: { entryPath: 'doc.md', files: [{ path: 'doc.md', sha256: 'a'.repeat(64), size: 2, mode: 420, mime: 'text/markdown' }], digest: 'b'.repeat(64) }, readRef: { kind: 'version', versionId: id }, workingRevision: 'b'.repeat(64), workingState: 'clean' });
function setup(extra: Record<string, any> = {}) {
 const rpc = vi.fn(async (method: string, data: any) => {
  if (extra[method]) return extra[method](data);
  if (method === 'artifactCapabilities') return {protocol:2};
  if (method === 'artifactCatalog') return [{ root: '/project', workspaceId: 'w', artifacts: [artifact] }];
  if (method === 'artifactRead') return read(data.versionId);
  if (method === 'artifactVersions') return { versions: [1,2,3].map(n => ({ id: 'v'+n, sequence:n })), currentVersionId:'v3' };
  if (method === 'artifactRestore') return { version: {id:'v4'}, workingRevision:'c'.repeat(64) };
 });
 const c = new VersionController('/project', rpc as any); return { c, rpc };
}
const deferred = () => { let resolve!: (v:any)=>void; const promise=new Promise<any>(r=>resolve=r); return {promise,resolve}; };
describe('history state isolation', () => {
 it('only attaches a current artifact to the matching displayed file baseline', async () => {
  const {c}=setup();
  expect(c.currentForHash('/project/doc.md','a'.repeat(64))).toBeNull();
  await c.current('/project/doc.md');
  expect(c.currentForHash('/project/doc.md','a'.repeat(64))?.entryContent).toBe('v3');
  expect(c.currentForHash('/project/doc.md','c'.repeat(64))).toBeNull();
  expect(c.currentForHash('/project/doc.md',null)).toBeNull();
 });
 it('invalidates a cached preview while refreshing dependencies and after a failed refresh', async () => {
  let offline=false;
  const {c}=setup({artifactRead:()=>{if(offline)throw new Error('offline');return read();}});
  await c.current('/project/doc.md');
  offline=true;
  const refresh=c.current('/project/doc.md');
  const rejected=expect(refresh).rejects.toThrow('offline');
  expect(c.currentForHash('/project/doc.md','a'.repeat(64))).toBeNull();
  await rejected;
  expect(c.currentForHash('/project/doc.md','a'.repeat(64))).toBeNull();
 });
 it('waits for the in-flight version baseline before checking a freshly displayed file hash', async () => {
  const pending=deferred();
  let reads=0;
  const updated={...read(),manifest:{...read().manifest,files:[{...read().manifest.files[0],sha256:'c'.repeat(64)}]}};
  const {c,rpc}=setup({artifactRead:()=>++reads===1?read():reads===2?pending.promise:updated,artifactSave:()=>({version:{id:'v4'}})});
  await c.current('/project/doc.md');
  const refresh=c.current('/project/doc.md');
  const saving=c.save('/project/doc.md','new draft','c'.repeat(64));
  const result=expect(saving).resolves.toHaveProperty('hash');
  await Promise.resolve();
  expect(rpc.mock.calls.some(([method])=>method==='artifactSave')).toBe(false);
  pending.resolve(updated);
  await refresh;
  await result;
  expect(rpc.mock.calls.filter(([method])=>method==='artifactSave')).toHaveLength(1);
 });
 it('lets a newer completed read unblock saving before an older request finishes', async () => {
  const old=deferred(),newest=deferred();
  let reads=0;
  const {c,rpc}=setup({artifactRead:()=>++reads===1?read():reads===2?old.promise:reads===3?newest.promise:read(),artifactSave:()=>({version:{id:'v4'}})});
  await c.current('/project/doc.md');
  const first=c.current('/project/doc.md');
  let saved=false;
  const saving=c.save('/project/doc.md','draft','a'.repeat(64)).then(()=>{saved=true;});
  const second=c.current('/project/doc.md');
  newest.resolve(read());
  await second;
  try {
   await vi.waitFor(()=>expect(saved).toBe(true),{timeout:200});
   expect(rpc.mock.calls.filter(([method])=>method==='artifactSave')).toHaveLength(1);
  } finally {
   old.resolve(read());
   await first;
   await saving;
  }
 });
 it('settles an in-flight current read on disposal without publishing or self-resolution', async () => {
  const pending=deferred();
  const {c}=setup({artifactRead:()=>pending.promise});
  await c.discover('/project/doc.md');
  const request=c.current('/project/doc.md');
  c.dispose();
  pending.resolve(read());
  await expect(request).resolves.toBeNull();
  expect(c.state('/project/doc.md').current).toBeNull();
 });
 it('discovers managed entry and reads current without selecting history', async () => { const {c}=setup(); await c.current('/project/doc.md'); expect(c.state('/project/doc.md').current?.entryContent).toBe('v3'); expect(c.state('/project/doc.md').selectedId).toBeNull(); });
 it('ignores late history responses, disables restore during loading', async () => {
  const one=deferred(), two=deferred(); const {c}=setup({artifactRead:({versionId}:any)=>versionId==='v1'?one.promise:versionId==='v2'?two.promise:read()});
  await c.current('/project/doc.md'); const a=c.select('/project/doc.md','v1'); const b=c.select('/project/doc.md','v2');
  expect(c.canRestore('/project/doc.md')).toBe(false); one.resolve(read('v1')); await a; expect(c.state('/project/doc.md').preview).toBeNull();
  two.resolve(read('v2')); await b; expect(c.state('/project/doc.md').preview?.entryContent).toBe('v2'); expect(c.state('/project/doc.md').current?.entryContent).toBe('v3');
 });
 it('restores only loaded noncurrent selection, retains operation id without duplicate submit', async () => {
  const done=deferred(); const {c,rpc}=setup({artifactRestore:()=>done.promise}); await c.current('/project/doc.md'); await c.select('/project/doc.md','v1');
  const a=c.restore('/project/doc.md'); await c.restore('/project/doc.md'); await vi.waitFor(()=>expect(rpc.mock.calls.filter(([m])=>m==='artifactRestore')).toHaveLength(1));
  done.resolve({version:{id:'v4'},workingRevision:'c'.repeat(64)}); expect(await a).toBe(true); expect(c.state('/project/doc.md').pending).toBeNull();
 });
 it('keeps uncertain restore inspectable and never silently retries', async () => {
  const {c,rpc}=setup({artifactRestore:()=>{throw new Error('offline')},artifactOperation:()=>({status:'pending',actions:[],observedRevision:'b'.repeat(64),states:[]})});
  await c.current('/project/doc.md'); await c.select('/project/doc.md','v1'); expect(await c.restore('/project/doc.md')).toBe(false);
  const id=c.state('/project/doc.md').pending?.operationId; expect(id).toBeTruthy(); await c.inspect('/project/doc.md'); await c.restore('/project/doc.md');
  expect(c.state('/project/doc.md').pending?.operationId).toBe(id); expect(rpc.mock.calls.filter(([m])=>m==='artifactRestore')).toHaveLength(1);
 });
 it('uses frozen manifest reader and refuses missing historical resources', async () => {
  const {c,rpc}=setup(); await c.current('/project/doc.md'); const r=c.reader(c.state('/project/doc.md').current!);
  await expect(r('/project/missing.png')).rejects.toThrow(); expect(rpc.mock.calls.some(([m])=>m==='artifactResourceRead')).toBe(false);
 });
 it('conflict does not create an uncertain operation and current version cannot restore', async () => {
  const {c}=setup({artifactRestore:()=>{throw Object.assign(new Error('changed'),{detail:{code:'CONFLICT'}})}}); await c.current('/project/doc.md'); await c.select('/project/doc.md','v3'); expect(c.canRestore('/project/doc.md')).toBe(false); await c.select('/project/doc.md','v1'); await c.restore('/project/doc.md'); expect(c.state('/project/doc.md').pending).toBeNull(); expect(c.state('/project/doc.md').error).toBeTruthy();
 });
});

it('retains the committed operation when post-restore refresh fails; no stale current is exposed', async () => {
 let failed=false; const {c}=setup({artifactRestore:()=>{failed=true;return {version:{id:'v4'},workingRevision:'c'.repeat(64)};},artifactRead:(data:any)=>{if(failed)throw new Error('offline');return read(data.versionId);}});
 await c.current('/project/doc.md');await c.select('/project/doc.md','v1'); expect(await c.restore('/project/doc.md')).toBe(false);expect(c.state('/project/doc.md').current).toBeNull();expect(c.state('/project/doc.md').pending).toBeTruthy();
});
it('adopts pending server operations discovered after reopening', async () => {
 const {c}=setup({artifactRead:()=>({...read(),workingState:'recovery-required',pendingOperationId:'server-op'})});await c.load('/project/doc.md');expect(c.state('/project/doc.md').pending?.operationId).toBe('server-op');
});
it('refreshes after explicit rollback instead of reporting the failed transaction as recovery failure', async()=>{
 const {c}=setup({artifactRestore:()=>{throw Object.assign(new Error('partial'),{detail:{code:'PARTIAL_COMMIT'}})},artifactOperation:()=>({status:'pending',actions:['rollback'],observedRevision:'b'.repeat(64),states:[]}),artifactResolveOperation:()=>({status:'failed'})});
 await c.current('/project/doc.md');await c.select('/project/doc.md','v1');await c.restore('/project/doc.md');await c.inspect('/project/doc.md');expect(await c.resolve('/project/doc.md','rollback')).toBe(true);expect(c.state('/project/doc.md').pending).toBeNull();expect(c.state('/project/doc.md').error).toBeNull();
});
it('follows the terminal capture recovery identity on an explicit status check', async()=>{
 const {c}=setup({artifactRead:()=>({...read(),workingState:'recovery-required',pendingOperationId:'terminal'}),artifactOperation:({operationId}:any)=>operationId==='terminal'?{status:'pending',pendingOperationId:'capture',actions:[],observedRevision:'b'.repeat(64),states:[]}:{status:'pending',actions:['rollback'],observedRevision:'b'.repeat(64),states:[]}});
 await c.load('/project/doc.md');await c.inspect('/project/doc.md');expect(c.state('/project/doc.md').pending?.operationId).toBe('capture');expect(c.state('/project/doc.md').operation?.actions).toEqual(['rollback']);
});
it('returns the saved bytes hash even when another writer wins the following current read',async()=>{
 let changed=false;const {c}=setup({artifactSave:()=>{changed=true;return {version:{id:'v4'},workingRevision:'c'.repeat(64)};},artifactRead:()=>read(changed?'v5':'v3')});await c.current('/project/doc.md');
 const result=await c.save('/project/doc.md','my saved bytes','a'.repeat(64));const {createHash}=await import('node:crypto');expect(result.hash).toBe(createHash('sha256').update('my saved bytes').digest('hex'));
});
it('returns the newest accepted current read to both editor and history consumers', async()=>{
 const one=deferred(),two=deferred();let n=0;const {c}=setup({artifactRead:()=>++n===1?one.promise:two.promise});await c.discover('/project/doc.md');
 const first=c.current('/project/doc.md'),second=c.current('/project/doc.md');two.resolve(read('v5'));await second;one.resolve(read('v3'));expect((await first)?.entryContent).toBe('v5');
});
it('normalizes a trailing slash root for entry discovery',async()=>{const {rpc}=setup();const c=new VersionController('/project/',rpc as any);expect((await c.discover('/project/doc.md'))?.id).toBe('a');});
it('does not erase a newly observed recovery after a successful restore',async()=>{
 let restored=false;const {c}=setup({artifactRestore:()=>{restored=true;return {version:{id:'v4'},workingRevision:'c'.repeat(64)};},artifactRead:(d:any)=>restored?{...read(),workingState:'recovery-required',pendingOperationId:'new-recovery'}:read(d.versionId)});
 await c.current('/project/doc.md');await c.select('/project/doc.md','v1');await c.restore('/project/doc.md');expect(c.state('/project/doc.md').pending?.operationId).toBe('new-recovery');
});

it('does not dispatch a delayed restore after its workspace owner was disposed',async()=>{const {c,rpc}=setup();await c.current('/project/doc.md');await c.select('/project/doc.md','v1');c.dispose();expect(c.canRestore('/project/doc.md')).toBe(false);expect(await c.restore('/project/doc.md')).toBe(false);expect(rpc.mock.calls.some(([m])=>m==='artifactRestore')).toBe(false);});
it('allows restoring the marked current snapshot when working files have external unsnapshotted changes',async()=>{const {c}=setup({artifactRead:(d:any)=>({...read(d.versionId),workingState:d.versionId?'clean':'dirty'})});await c.current('/project/doc.md');await c.select('/project/doc.md','v3');expect(c.canRestore('/project/doc.md')).toBe(true);});
it('retries an unaccepted registration only after a fresh check and explicit action, with identical operation and paths',async()=>{
 let online=false;const calls:any[]=[];const rpc=vi.fn(async(method:string,input:any)=>{
  if(method==='artifactCapabilities')return {protocol:2};
  if(method==='artifactCatalog')return [];
  if(method==='artifactRegister'){calls.push(input);if(!online)throw Object.assign(new Error('offline'),{detail:{code:'UNAVAILABLE'}});return artifact;}
  if(method==='artifactRead')return read();if(method==='artifactVersions')return {versions:[],currentVersionId:'v3'};
 });
 const c=new VersionController('/project',rpc as any);await c.register('/project/doc.md',['doc.md','image.png']);expect(c.state('/project/doc.md').pending?.operationId).toBeTruthy();online=true;
 await c.inspect('/project/doc.md');expect(calls).toHaveLength(1);expect(await c.retryRegistration('/project/doc.md')).toBe(true);
 expect(calls).toHaveLength(2);expect(calls[1]).toEqual(calls[0]);expect(c.state('/project/doc.md').pending).toBeNull();
});
it('pins the full revision while a restore confirmation is open',async()=>{
 let revision='b'.repeat(64);const {c,rpc}=setup({artifactRead:(d:any)=>({...read(d.versionId),workingRevision:revision})});await c.current('/project/doc.md');await c.select('/project/doc.md','v1');const confirmed=c.prepareRestore('/project/doc.md');
 revision='c'.repeat(64);await c.current('/project/doc.md');expect(await c.restore('/project/doc.md',confirmed!)).toBe(false);expect(c.state('/project/doc.md').error).toBe('CONFLICT');expect(rpc.mock.calls.some(([m])=>m==='artifactRestore')).toBe(false);
});
it('refuses a legacy catalog that ignores root filtering instead of binding the first workspace',async()=>{
 const a={...artifact,id:'a-A',workspaceId:'w-A',entryPath:'index.html'};const b={...artifact,id:'a-B',workspaceId:'w-B',entryPath:'index.html'};
 const rpc=vi.fn(async(method:string)=>method==='artifactCapabilities'?{protocol:1}:method==='artifactCatalog'?[{root:'/A',workspaceId:'w-A',artifacts:[a]},{root:'/B',workspaceId:'w-B',artifacts:[b]}]:{...read(),artifact:a});
 const c=new VersionController('/B',rpc as any);await expect(c.current('/B/index.html')).rejects.toThrow();expect(c.state('/B/index.html').artifact).toBeNull();expect(rpc.mock.calls.some(([m])=>m==='artifactRead'||m==='artifactSave')).toBe(false);
});
it('does not pin an operation after a definite server refusal before acceptance',async()=>{
 const {c}=setup({artifactRestore:()=>{throw Object.assign(new Error('upgrade worker'),{detail:{code:'UNAVAILABLE'},uncertain:false})}});await c.current('/project/doc.md');await c.select('/project/doc.md','v1');await c.restore('/project/doc.md');expect(c.state('/project/doc.md').pending).toBeNull();
});
it('refuses a daemon protocol downgrade after a history panel was already loaded, without pinning an undispatched mutation',async()=>{
 let protocol=2;const {c,rpc}=setup({artifactCapabilities:()=>({protocol})});await c.current('/project/doc.md');await c.select('/project/doc.md','v1');protocol=1;
 expect(await c.restore('/project/doc.md')).toBe(false);expect(rpc.mock.calls.some(([method])=>method==='artifactRestore')).toBe(false);expect(c.state('/project/doc.md').pending).toBeNull();
});
it('does not persist an undispatched mutation if its owner is disposed during the capability preflight',async()=>{
 const capability=deferred();let checking=false,saved:any={};const {rpc}=setup({artifactCapabilities:()=>checking?capability.promise:{protocol:2}});
 const c=new VersionController('/project',rpc as any,()=>true,{},p=>{saved=JSON.parse(JSON.stringify(p));});await c.current('/project/doc.md');await c.select('/project/doc.md','v1');checking=true;
 const restoring=c.restore('/project/doc.md');c.dispose();capability.resolve({protocol:2});expect(await restoring).toBe(false);
 expect(saved).toEqual({});expect(rpc.mock.calls.some(([method])=>method==='artifactRestore')).toBe(false);
});
it('allows an explicit same-ID retry after a transport-unknown restore is confirmed absent',async()=>{
 let online=false;const requests:any[]=[];const {c}=setup({artifactRestore:(input:any)=>{requests.push(input);if(!online)throw new Error('transport');return {version:{id:'v4'},workingRevision:'c'.repeat(64)};},artifactOperation:()=>{throw Object.assign(new Error('not found'),{detail:{code:'NOT_FOUND'},uncertain:false});}});
 await c.current('/project/doc.md');await c.select('/project/doc.md','v1');await c.restore('/project/doc.md');online=true;await c.inspect('/project/doc.md');expect(requests).toHaveLength(1);expect(await c.retryOperation('/project/doc.md')).toBe(true);expect(requests[1]).toEqual(requests[0]);expect(c.state('/project/doc.md').pending).toBeNull();
});
it('retains a partial recovery resolution across refresh and remount, using the newly confirmed observation',async()=>{
 let saved:any={},revision='b'.repeat(64);const resolutions:any[]=[];
 const {rpc}=setup({artifactRead:()=>({...read(),workingState:'recovery-required',pendingOperationId:'capture-C'}),artifactOperation:()=>({status:'pending',actions:['rollback'],observedRevision:revision,states:[]}),artifactResolveOperation:(input:any)=>{resolutions.push(input);if(resolutions.length===1)throw Object.assign(new Error('partial rollback'),{detail:{code:'INTERNAL'}});return {status:'committed'};}});
 let c=new VersionController('/project',rpc as any,()=>true,{},p=>{saved=JSON.parse(JSON.stringify(p));});
 await c.load('/project/doc.md');await c.inspect('/project/doc.md');await c.resolve('/project/doc.md','rollback');c.dispose();
 c=new VersionController('/project',rpc as any,()=>true,saved);revision='c'.repeat(64);
 await c.load('/project/doc.md');await c.inspect('/project/doc.md');await c.resolve('/project/doc.md','rollback');
 expect(resolutions).toHaveLength(2);expect(resolutions[1].resolutionId).toBe(resolutions[0].resolutionId);expect(resolutions[1].expectedObservedRevision).toBe(revision);
});
