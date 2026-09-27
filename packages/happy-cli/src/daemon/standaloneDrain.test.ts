import { afterEach, expect, it, vi } from 'vitest';
import { startDaemonControlServer } from './controlServer';
import { StandaloneDrain } from './standaloneDrain';

const stops: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(stops.splice(0).map(stop => stop())); vi.useRealTimers(); });
const complete = { stored: true, runtimeExited: true, jobEmpty: true };
function fixture(overrides: Partial<ConstructorParameters<typeof StandaloneDrain>[0]> = {}) {
  const freeze = vi.fn(async () => ({ launchIds: ['launch-1'], unresolved: false }));
  const drain = vi.fn(async () => complete);
  const backend = { instanceId: 'instance-1', targets: [{platform:'win32' as const,arch:'x64' as const,provider:'codex' as const,mode:'standard' as const}], freeze, drain, ...overrides };
  const control = new StandaloneDrain(backend);
  return { control, freeze: backend.freeze, drain: backend.drain };
}
const begin = { requestId: 'request-1', expectedInstanceId: 'instance-1', reason: 'app-quit' as const };
const settle = async () => { for(let i=0;i<12;i++) await Promise.resolve(); };
it('closes the launch gate synchronously; duplicate requests share the operation', async () => {
  const {control,freeze,drain}=fixture();
  const first=control.begin(begin);
  expect(freeze).toHaveBeenCalledTimes(1);
  expect(first.state).toBe('draining');
  expect(control.begin(begin).operationId).toBe(first.operationId);
  await settle();
  expect(control.status('instance-1',first.operationId).state).toBe('completed');
  expect(drain).toHaveBeenCalledTimes(1);
  expect(control.commit('instance-1',first.operationId)).toBe(true);
  expect(control.commit('instance-1',first.operationId)).toBe(false);
});
it.each(['stored','runtimeExited','jobEmpty'] as const)('requires %s evidence before completing',async field=>{
  const {control}=fixture({drain:async()=>({...complete,[field]:false})});
  control.begin(begin);await settle();
  expect(control.status('instance-1','request-1').state).toBe('blocked');
  expect(()=>control.commit('instance-1','request-1')).toThrow('drain-not-completed');
});
it('blocks unknown ownership even when the reported launch list is empty',async()=>{
  const {control,drain}=fixture({freeze:async()=>({launchIds:[],unresolved:true})});
  control.begin(begin);await settle();
  expect(control.status('instance-1','request-1').error).toBe('ownership-unresolved');
  expect(drain).not.toHaveBeenCalled();
});
it('rejects stale instance and conflicting replay without invoking the backend',()=>{
  const {control,freeze}=fixture();
  expect(()=>control.begin({...begin,expectedInstanceId:'old'})).toThrow('instance-mismatch');
  expect(freeze).not.toHaveBeenCalled();
  control.begin(begin);
  expect(()=>control.begin({...begin,reason:'update'})).toThrow('request-conflict');
});
it('does not restart a timed-out backend concurrently or accept its late success',async()=>{
  vi.useFakeTimers();let finish!:(result:typeof complete)=>void;
  const {control,drain}=fixture({timeoutMs:20,drain:vi.fn(()=>new Promise<typeof complete>(resolve=>{finish=resolve}))});
  control.begin(begin);await settle();await vi.advanceTimersByTimeAsync(20);
  expect(control.status('instance-1','request-1').error).toBe('deadline-exceeded');
  expect(control.status('instance-1','request-1').retryable).toBe(true);
  control.begin({...begin,requestId:'blocked-retry'});await settle();
  expect(control.status('instance-1','blocked-retry').state).toBe('blocked');
  expect(drain).toHaveBeenCalledTimes(1);
  finish(complete);await settle();
  expect(control.status('instance-1','request-1').state).toBe('blocked');
  control.begin({...begin,requestId:'retry'});await settle();
  expect(drain).toHaveBeenCalledTimes(2);
});
it('joins concurrent quit and update requests without opening another gate',()=>{
  const {control,freeze}=fixture({freeze:vi.fn(()=>new Promise<{launchIds:string[];unresolved:boolean}>(()=>{}))});
  control.begin(begin);
  expect(control.begin({...begin,requestId:'update-1',reason:'update'}).operationId).toBe('request-1');
  expect(freeze).toHaveBeenCalledTimes(1);
});
async function server(control?:StandaloneDrain, managedRuntime=false) {
  const shutdown=vi.fn();
  const api=await startDaemonControlServer({getChildren:()=>[],stopSession:()=>({stopped:false,reason:'not-found'}),spawnSession:async()=>({type:'error',errorMessage:'unused'}),requestShutdown:shutdown,onHappySessionWebhook:()=>{},portRegistry:{allocate:async()=>({port:30000,reused:false}),release:async()=>false,readAll:async()=>({})},standaloneDrain:control,managedRuntime});
  stops.push(api.stop);
  const post=(path:string,body:unknown={},authenticated=true)=>fetch(`http://127.0.0.1:${api.port}/standalone-drain/${path}`,{method:'POST',headers:{'Content-Type':'application/json',...(authenticated?{Authorization:`Bearer ${api.controlSecret}`}:{})},body:JSON.stringify(body)});
  return {post,shutdown,legacyStop:()=>fetch(`http://127.0.0.1:${api.port}/stop`,{method:'POST',headers:{Authorization:`Bearer ${api.controlSecret}`,'Content-Type':'application/json'},body:'{}'})};
}
it('uses real loopback auth and refuses unsupported runtimes',async()=>{
  const {post,shutdown}=await server();
  expect((await post('capabilities',{},false)).status).toBe(401);
  expect(await (await post('capabilities')).json()).toMatchObject({supported:false});
  expect((await post('begin',begin)).status).toBe(503);
  expect(shutdown).not.toHaveBeenCalled();
});
it('does not extend managed runtime authority',async()=>{
  const {control,freeze}=fixture();const {post}=await server(control,true);
  expect((await post('begin',begin)).status).toBe(403);
  expect(freeze).not.toHaveBeenCalled();
});
it('validates wire requests, exposes only bounded evidence, and commits once',async()=>{
  const {control}=fixture();const {post,shutdown}=await server(control);
  expect((await post('begin',{...begin,pid:123})).status).toBe(400);
  expect((await post('begin',{...begin,expectedInstanceId:'old'})).status).toBe(409);
  expect((await post('begin',begin)).status).toBe(200);await settle();
  const ref={expectedInstanceId:'instance-1',operationId:'request-1'};
  expect(await (await post('status',ref)).json()).toMatchObject({state:'completed'});
  expect((await post('commit',ref)).status).toBe(200);
  expect((await post('commit',ref)).status).toBe(200);
  await new Promise(resolve=>setTimeout(resolve,70));
  expect(shutdown).toHaveBeenCalledTimes(1);
});

it('prevents the legacy daemon stop endpoint from bypassing a configured drain',async()=>{
  const {control}=fixture();const {legacyStop,shutdown}=await server(control);
  expect((await legacyStop()).status).toBe(409);
  await new Promise(resolve=>setTimeout(resolve,70));
  expect(shutdown).not.toHaveBeenCalled();
});
it('does not complete after the monotonic budget passed before the timer could run',async()=>{
  const clock=vi.spyOn(performance,'now').mockReturnValue(0);
  try {
    const {control}=fixture({timeoutMs:20,freeze:async()=>{clock.mockReturnValue(21);return {launchIds:[],unresolved:false}}});
    control.begin(begin);await settle();
    expect(control.status('instance-1','request-1').error).toBe('deadline-exceeded');
  } finally {clock.mockRestore()}
});

it('exposes explicit tested targets without allowing callers to mutate them',()=>{
  const {control}=fixture();const caps=control.capabilities();
  caps.targets[0].arch='arm64';
  expect(control.capabilities().targets).toEqual([{platform:'win32',arch:'x64',provider:'codex',mode:'standard'}]);
  expect(()=>fixture({targets:[]})).toThrow();
});
it('bounds replay storage without evicting and re-executing an old request',()=>{
  const {control,freeze}=fixture({freeze:vi.fn(()=>new Promise<{launchIds:string[];unresolved:boolean}>(()=>{}))});
  for(let i=0;i<128;i++)control.begin({...begin,requestId:`request-${i}`});
  expect(()=>control.begin({...begin,requestId:'overflow'})).toThrow('request-capacity-exceeded');
  expect(control.begin({...begin,requestId:'request-0'}).operationId).toBe('request-0');
  expect(freeze).toHaveBeenCalledTimes(1);
});
it('allows an explicit retry after a settled failure and preserves the old verdict',async()=>{
  const drain=vi.fn().mockRejectedValueOnce(new Error('secret must not escape')).mockResolvedValue(complete);
  const {control}=fixture({drain});
  control.begin(begin);await settle();
  expect(control.status('instance-1','request-1')).toMatchObject({state:'blocked',error:'drain-unverified',retryable:true});
  control.begin({...begin,requestId:'retry'});await settle();
  expect(control.status('instance-1','retry').state).toBe('completed');
  expect(control.status('instance-1','request-1').state).toBe('blocked');
  expect(()=>control.commit('instance-1','request-1')).toThrow('drain-not-completed');
});

it('rejects a malformed ownership snapshot rather than treating it as an empty success',async()=>{
  const {control}=fixture({freeze:async()=>({launchIds:[]}) as never});
  control.begin(begin);await settle();
  expect(control.status('instance-1','request-1')).toMatchObject({state:'blocked',error:'invalid-launch-snapshot'});
});

it('retries other launches without duplicating an uncooperative timed-out launch',async()=>{
  vi.useFakeTimers();let finish!:(result:typeof complete)=>void;let second=false;
  const drain=vi.fn((launchId:string)=>launchId==='hung'
    ?new Promise<typeof complete>(resolve=>{finish=resolve}) :Promise.resolve(complete));
  const {control}=fixture({timeoutMs:20,freeze:async()=>({launchIds:second?['hung','new']:['hung'],unresolved:false}),drain});
  control.begin(begin);await settle();await vi.advanceTimersByTimeAsync(20);
  expect(control.status('instance-1','request-1').launches).toEqual([{launchId:'hung',state:'unknown'}]);
  second=true;control.begin({...begin,requestId:'retry'});await settle();
  expect(drain.mock.calls.map(([id])=>id)).toEqual(['hung','new']);
  expect(control.status('instance-1','retry')).toMatchObject({state:'blocked',retryable:true,
    launches:[{launchId:'hung',state:'unknown'},{launchId:'new',state:'exited'}]});
  finish(complete);await settle();
  expect(control.status('instance-1','request-1').state).toBe('blocked');
  expect(control.status('instance-1','retry').state).toBe('blocked');
});
it('aborts a hung freeze and settles observation without calling freeze concurrently',async()=>{
  vi.useFakeTimers();let signal:AbortSignal|undefined;
  const freeze=vi.fn((input?:AbortSignal)=>{signal=input;return new Promise<{launchIds:string[];unresolved:boolean}>(()=>{})});
  const {control,drain}=fixture({timeoutMs:20,freeze});
  control.begin(begin);await settle();await vi.advanceTimersByTimeAsync(20);
  expect(signal?.aborted).toBe(true);
  expect(control.status('instance-1','request-1')).toMatchObject({state:'blocked',retryable:true});
  control.begin({...begin,requestId:'retry'});await settle();
  expect(freeze).toHaveBeenCalledTimes(1);expect(drain).not.toHaveBeenCalled();
  expect(control.status('instance-1','retry')).toMatchObject({state:'blocked',error:'freeze-still-running'});
});
it('limits actual backend concurrency across timed-out operations',async()=>{
  vi.useFakeTimers();let release!:(result:typeof complete)=>void;
  const held=new Promise<typeof complete>(resolve=>{release=resolve});
  const drain=vi.fn(()=>held);
  const {control}=fixture({timeoutMs:20,freeze:async()=>({launchIds:['a','b','c','d','e'],unresolved:false}),drain});
  control.begin(begin);await settle();expect(drain).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(20);
  control.begin({...begin,requestId:'retry'});await settle();
  expect(drain).toHaveBeenCalledTimes(4);
  expect(control.status('instance-1','retry').state).toBe('blocked');
  release(complete);await settle();
  control.begin({...begin,requestId:'retry-2'});await settle();
  expect(control.status('instance-1','retry-2').state).toBe('completed');
});

it('cannot hide an in-flight launch by returning an empty retry snapshot',async()=>{
  vi.useFakeTimers();let finish!:(result:typeof complete)=>void;
  const freeze=vi.fn().mockResolvedValueOnce({launchIds:['hung'],unresolved:false}).mockResolvedValue({launchIds:[],unresolved:false});
  const drain=vi.fn(()=>new Promise<typeof complete>(resolve=>{finish=resolve}));
  const {control}=fixture({timeoutMs:20,freeze,drain});
  control.begin(begin);await settle();await vi.advanceTimersByTimeAsync(20);
  control.begin({...begin,requestId:'retry'});await settle();
  expect(control.status('instance-1','retry')).toMatchObject({state:'blocked',launches:[{launchId:'hung',state:'unknown'}]});
  expect(()=>control.commit('instance-1','retry')).toThrow('drain-not-completed');
  expect(drain).toHaveBeenCalledTimes(1);finish(complete);await settle();
});
it('releases a late freeze without changing its timed-out verdict',async()=>{
  vi.useFakeTimers();let finish!:(value:{launchIds:string[];unresolved:boolean})=>void;
  const freeze=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve})).mockResolvedValue({launchIds:[],unresolved:false});
  const {control}=fixture({timeoutMs:20,freeze});
  control.begin(begin);await settle();await vi.advanceTimersByTimeAsync(20);
  finish({launchIds:[],unresolved:false});await settle();
  expect(control.status('instance-1','request-1').state).toBe('blocked');
  control.begin({...begin,requestId:'retry'});await settle();
  expect(control.status('instance-1','retry').state).toBe('completed');
  expect(freeze).toHaveBeenCalledTimes(2);
});

it('allows explicit ownership rechecks but bounds replay capacity',async()=>{
  const {control}=fixture({freeze:async()=>({launchIds:[],unresolved:true})});
  control.begin(begin);await settle();
  expect(control.status('instance-1','request-1').retryable).toBe(true);
  const transient=fixture({drain:async()=>{throw new Error('transient')}}).control;
  for(let i=0;i<128;i++){transient.begin({...begin,requestId:`retry-${i}`});await settle();}
  expect(transient.status('instance-1','retry-127').retryable).toBe(false);
});
it('uses remaining worker slots to process every new launch while one old launch hangs',async()=>{
  vi.useFakeTimers();let second=false;let finish!:(value:typeof complete)=>void;
  const drain=vi.fn((launchId:string)=>launchId==='hung'?new Promise<typeof complete>(resolve=>{finish=resolve}):Promise.resolve(complete));
  const {control}=fixture({timeoutMs:20,freeze:async()=>({launchIds:second?['hung','a','b','c','d']:['hung'],unresolved:false}),drain});
  control.begin(begin);await settle();await vi.advanceTimersByTimeAsync(20);
  second=true;control.begin({...begin,requestId:'retry'});await settle();
  expect(drain.mock.calls.map(([id])=>id)).toEqual(['hung','a','b','c','d']);
  finish(complete);await settle();
});

it('marks unattempted launches unknown when all backend slots remain occupied',async()=>{
  vi.useFakeTimers();let second=false;const finishes:Array<(value:typeof complete)=>void>=[];
  const {control}=fixture({timeoutMs:20,freeze:async()=>({launchIds:second?['a','b','c','d','new']:['a','b','c','d'],unresolved:false}),
    drain:()=>new Promise<typeof complete>(resolve=>finishes.push(resolve))});
  control.begin(begin);await settle();await vi.advanceTimersByTimeAsync(20);
  second=true;control.begin({...begin,requestId:'retry'});await settle();
  expect(control.status('instance-1','retry').launches.every(entry=>entry.state==='unknown')).toBe(true);
  for(const finish of finishes)finish(complete);await settle();
});

it('passes the shrinking operation budget to later launch waves', async () => {
  vi.useFakeTimers();
  const budgets: number[] = [];
  let release!: () => void;
  const first = new Promise<void>(resolve => { release = resolve; });
  const { control } = fixture({
    timeoutMs: 30000,
    freeze: async () => ({ launchIds: ['a', 'b', 'c', 'd', 'e'], unresolved: false }),
    drain: async (_id, _signal, budget) => {
      budgets.push(budget.remainingMs());
      if (budgets.length <= 4) await first;
      return complete;
    },
  });
  control.begin(begin);
  await settle();
  expect(budgets).toEqual([30000, 30000, 30000, 30000]);
  await vi.advanceTimersByTimeAsync(12000);
  release(); await settle();
  expect(budgets).toEqual([30000, 30000, 30000, 30000, 18000]);
  expect(control.status('instance-1', 'request-1').state).toBe('completed');
});

it('shares the same deadline with freeze fanout and evidence collection', async () => {
  vi.useFakeTimers();
  let freezeBudget!: { remainingMs(): number };
  const { control } = fixture({
    freeze: async (_signal, budget) => {
      freezeBudget = budget;
      expect(budget.remainingMs()).toBe(30000);
      return { launchIds: ['a'], unresolved: false };
    },
    drain: async (_id, _signal, budget) => {
      expect(budget).toBe(freezeBudget);
      return complete;
    },
  });
  control.begin(begin); await settle();
  expect(control.status('instance-1', 'request-1').state).toBe('completed');
});

it('only allows explicit termination of a current blocked launch and never upgrades its drain', async () => {
  const terminate = vi.fn(async () => {});
  const { control } = fixture({ drain: async () => ({ stored: false, runtimeExited: false, jobEmpty: false }),
    canTerminate: () => true, terminate });
  control.begin(begin); await settle();
  const status = control.status('instance-1', 'request-1');
  expect(status.state).toBe('blocked');
  const launch = status.launches[0].launchId;
  await expect(control.terminate('wrong', 'request-1', launch)).rejects.toThrow('instance-mismatch');
  await expect(control.terminate('instance-1', 'request-1', 'other')).rejects.toThrow('termination-not-available');
  expect(terminate).not.toHaveBeenCalled();
  await control.terminate('instance-1', 'request-1', launch);
  expect(terminate).toHaveBeenCalledWith(launch);
  expect(control.status('instance-1', 'request-1').state).toBe('blocked');
  expect(() => control.commit('instance-1', 'request-1')).toThrow('drain-not-completed');
});
it('exposes unresolved launch identities for diagnosis without allowing a commit', async () => {
  const { control } = fixture({ freeze: async () => ({ launchIds: ['old-owner'], unresolved: true }) });
  control.begin(begin); await settle();
  expect(control.status('instance-1', 'request-1')).toMatchObject({ state: 'blocked', error: 'ownership-unresolved',
    launches: [{ launchId: 'old-owner', state: 'unknown' }] });
});
