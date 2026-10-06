import { afterEach, describe, expect, it, vi } from 'vitest';
import { installRpcPeerDiagnostics, withRpcPeerDiagnostics } from './rpcPeerDiagnostics';
const id = '12345678-1234-4123-8123-123456789abc';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });
function fixture(withRawMessage = false, advanceRawMessage?: () => void) {
 const log = vi.fn();
 const adapter: any = { uid: 'local', doPublish: vi.fn(async (_m: any) => '1-0'), onMessage: vi.fn((_m: any) => {}), close: vi.fn() };
 if (withRawMessage) adapter.onRawMessage = function (message: any, ...args: any[]) { advanceRawMessage?.(); return this.onMessage(message, ...args); };
 installRpcPeerDiagnostics(adapter, log);
 return {adapter, log};
}
describe('peer boundary diagnostics', () => {
 it('keeps diagnostics-off messages and return values unchanged', async () => {
  const {adapter,log}=fixture(); const message={type:7,data:{requestId:'req',opts:{rooms:['private']}}};
  expect(await withRpcPeerDiagnostics(id,()=>adapter.doPublish(message))).toBe('1-0');
  expect(message.data).not.toHaveProperty('rpcPeer'); expect(log).not.toHaveBeenCalled(); adapter.close();
 });

 it('records raw decode boundaries before response consumption', async () => {
  vi.stubEnv('HAPPY_RPC_PEER_DIAGNOSTICS','1');
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const {adapter,log}=fixture(true);
  await withRpcPeerDiagnostics(id,()=>adapter.doPublish({type:7,data:{requestId:'req'}}));
  now = 25;
  await adapter.onRawMessage({type:8,uid:'peer',data:{requestId:'req'}});
  const stages = log.mock.calls.map(([r])=>r.stage);
  expect(stages).toEqual(['request-publish-start','request-publish-done','response-decode-done','response-consume']);
  expect(log.mock.calls[2][0].elapsedMs).toBe(25);
  expect(log.mock.calls[3][0].elapsedMs).toBeGreaterThanOrEqual(log.mock.calls[2][0].elapsedMs);
  adapter.close();
 });
 it('correlates publish and response consumption without logging rooms or socket data', async () => {
  vi.stubEnv('HAPPY_RPC_PEER_DIAGNOSTICS','1');
  const {adapter,log}=fixture();
  await withRpcPeerDiagnostics(id,()=>adapter.doPublish({type:7,data:{requestId:'req',opts:{rooms:['private']}}}));
  adapter.onMessage({type:8,uid:'peer',data:{requestId:'req',sockets:[{id:'secret'}]}});
  expect(log.mock.calls.map(([r])=>r.stage)).toEqual(['request-publish-start','request-publish-done','response-consume']);
  expect(log.mock.calls.every(([r])=>r.rpcId===id && typeof r.lookupId==='string')).toBe(true);
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|secret|req"|peer"/); adapter.close();
 });
 it('preserves publish failures even if logging throws', async () => {
  vi.stubEnv('HAPPY_RPC_PEER_DIAGNOSTICS','1');const failure=new Error('publish failed');
  const adapter={uid:'local',doPublish:vi.fn(async(_message:any)=>{throw failure;}),onMessage:vi.fn(),close:vi.fn()};
  installRpcPeerDiagnostics(adapter,()=>{throw Error('observer');});
  await expect(withRpcPeerDiagnostics(id,()=>adapter.doPublish({type:7,data:{requestId:'req'}}))).rejects.toBe(failure);adapter.close();
 });
 it('rejects malformed metadata and clears observations on close', async () => {
  vi.stubEnv('HAPPY_RPC_PEER_DIAGNOSTICS','1');const {adapter,log}=fixture();
  adapter.onMessage({type:7,uid:'peer',data:{requestId:'bad',rpcPeer:{rpcId:'secret',lookupId:'secret'}}});
  expect(log).not.toHaveBeenCalled();
  await withRpcPeerDiagnostics(id,()=>adapter.doPublish({type:7,data:{requestId:'req'}}));
  adapter.close();log.mockClear();adapter.onMessage({type:8,uid:'peer',data:{requestId:'req'}});expect(log).not.toHaveBeenCalled();
 });
 it('propagates correlation through asynchronous peer responses and isolates concurrent requests', async () => {
  vi.stubEnv('HAPPY_RPC_PEER_DIAGNOSTICS','1');
  const caller=fixture(), peerLog=vi.fn();
  const peer={uid:'peer',doPublish:vi.fn(async (_m:any)=>'2-0'),onMessage:vi.fn(async (m:any)=>{
   await Promise.resolve(); await peer.doPublish({type:8,data:{requestId:m.data.requestId,sockets:[]}});
  }),close:vi.fn()};
  installRpcPeerDiagnostics(peer,peerLog);
  await Promise.all(['one','two'].map(key=>withRpcPeerDiagnostics(id,()=>caller.adapter.doPublish({type:7,data:{requestId:key}}))));
  const correlation={rpcId:id,lookupId:'22345678-1234-4123-8123-123456789abc'};
  await peer.onMessage({type:7,uid:'caller',data:{requestId:'peer-req',rpcPeer:correlation}});
  expect(peerLog.mock.calls.map(([r])=>r.stage)).toEqual(['request-consume','response-publish-start','response-publish-done']);
  expect(peerLog.mock.calls.every(([r])=>r.lookupId===correlation.lookupId)).toBe(true);
  expect(new Set(caller.log.mock.calls.map(([r])=>r.lookupId)).size).toBe(2);
  caller.adapter.close();peer.close();
 });

 it('records raw decode boundaries before peer request handling', async () => {
  vi.stubEnv('HAPPY_RPC_PEER_DIAGNOSTICS','1');
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const {adapter: caller,log: callerLog}=fixture(true), {adapter: peer,log: peerLog}=fixture(true,()=>{ now = 25; });
  await withRpcPeerDiagnostics(id,()=>caller.doPublish({type:7,data:{requestId:'req'}}));
  const lookupId = callerLog.mock.calls.find(([r])=>r.stage==='request-publish-start')![0].lookupId;
  await peer.onRawMessage({type:7,uid:'caller',data:{requestId:'req',rpcPeer:{rpcId:id,lookupId}}});
  expect(peerLog.mock.calls.map(([r])=>r.stage)).toEqual(['request-decode-done','request-consume']);
  expect(peerLog.mock.calls[0][0].elapsedMs).toBe(25);
  expect(peerLog.mock.calls[1][0].elapsedMs).toBeGreaterThanOrEqual(peerLog.mock.calls[0][0].elapsedMs);
  caller.close();peer.close();
 });
 it('bounds admission to ten observations per minute and expires stale response matching', async () => {
  vi.useFakeTimers();vi.stubEnv('HAPPY_RPC_PEER_DIAGNOSTICS','1');const {adapter,log}=fixture();
  for(let i=0;i<11;i++) await withRpcPeerDiagnostics(id,()=>adapter.doPublish({type:7,data:{requestId:String(i)}}));
  expect(log.mock.calls.filter(([r])=>r.stage==='request-publish-start')).toHaveLength(10);
  await vi.advanceTimersByTimeAsync(60_001);log.mockClear();
  adapter.onMessage({type:8,uid:'peer',data:{requestId:'0'}});expect(log).not.toHaveBeenCalled();
  await withRpcPeerDiagnostics(id,()=>adapter.doPublish({type:7,data:{requestId:'new'}}));
  expect(log.mock.calls.map(([r])=>r.stage)).toEqual(['request-publish-start','request-publish-done']);adapter.close();
 });
 it('does not mutate outgoing messages and suppresses duplicate diagnostic stages only', async () => {
  vi.stubEnv('HAPPY_RPC_PEER_DIAGNOSTICS','1');const {adapter,log}=fixture();
  const message=Object.freeze({type:7,data:Object.freeze({requestId:'req'})});
  await withRpcPeerDiagnostics(id,()=>adapter.doPublish(message));
  const response={type:8,uid:'peer',data:{requestId:'req'}};
  adapter.onMessage(response);adapter.onMessage(response);
  expect(log.mock.calls.filter(([r])=>r.stage==='response-consume')).toHaveLength(1);
  adapter.close();
 });

 it('leaves unsupported adapters untouched', () => {
  const adapter={close:vi.fn()};const original=adapter.close;
  installRpcPeerDiagnostics(adapter,vi.fn());expect(adapter.close).toBe(original);
 });
 it('does not add metadata without the native RPC opt-in context', async () => {
  vi.stubEnv('HAPPY_RPC_PEER_DIAGNOSTICS','1');const transport=vi.fn(async (_m:any)=>'1-0');
  const adapter={uid:'local',doPublish:transport,onMessage:vi.fn(),close:vi.fn()};const report=vi.fn();
  installRpcPeerDiagnostics(adapter,report);const message={type:7,data:{requestId:'req'}};
  await adapter.doPublish(message);expect(transport).toHaveBeenCalledWith(message);
  expect(transport.mock.calls[0][0]).toBe(message);expect(report).not.toHaveBeenCalled();adapter.close();
 });

});
