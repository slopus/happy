import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { classifyNativeReceipt, StandaloneLaunchFailure, StandaloneSessionOwner, type NativeReceipt } from './standaloneSessionOwner';

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }
afterEach(() => vi.useRealTimers());
const budget = { remainingMs: () => 30000 };
const signal = () => new AbortController().signal;
async function fixture() {
  const intents = new Set<string>();
  const journal = {
    reserve: vi.fn(async (_instance: string, id: string) => { intents.add(id); }),
    snapshot: vi.fn(async () => ({ launchIds: [...intents], unresolved: false })),
    complete: vi.fn(async (_instance: string, id: string) => { intents.delete(id); }),
    end: vi.fn(async (_instance: string, id: string) => { intents.delete(id); }),
    notLaunched: vi.fn(async (_instance: string, id: string) => { intents.delete(id); }),
    rollback: vi.fn(async (_instance: string, id: string) => { intents.delete(id); }),
    terminate: vi.fn(async (_instance: string, id: string) => { intents.delete(id); }),
    pendingRecords: vi.fn(async () => ({ records: [...intents].map(launchId => ({ instanceId: 'instance', launchId })), unresolved: false })),
  };
  const exits = new Map<string, ReturnType<typeof deferred<any>>>();
  const control = { reserve: vi.fn((launchId: string) => ({ version: 1 as const, launchId, instanceId: 'instance', port: 1234, secret: '0'.repeat(64) })),
    drain: vi.fn(async () => ({ stored: true, releaseAcknowledged: true })), forget: vi.fn(), close: vi.fn(async () => {}) };
  const launch = vi.fn(async (input: { launchId: string; instanceId: string; env: NodeJS.ProcessEnv }) => {
    expect(intents.has(input.launchId)).toBe(true);
    expect(JSON.parse(input.env.HAPPY_STANDALONE_LAUNCH_V1!).launchId).toBe(input.launchId);
    const exit = deferred<any>(); exits.set(input.launchId, exit);
    return { pid: 100 + exits.size, childProcess: {} as ChildProcess, resume: vi.fn(), terminate: vi.fn(async () => {}), exit: exit.promise };
  });
  const hasUnboundChildren = vi.fn(() => false);
  const onRetired = vi.fn();
  const options = { onRetired, instanceId: 'instance', journal, control, launch, hasUnboundChildren, isNoProcessError: (error: unknown) => error === 'no-process' };
  const owner = await StandaloneSessionOwner.open(options);
  const input = { args: ['codex'], cwd: '/tmp', env: {} };
  const end = (launchId: string, changes = {}) => exits.get(launchId)!.resolve({ launchId, instanceId: 'instance',
    launched: true, resumed: true, rootExit: 0, jobEmpty: true, forced: false, nativeError: 0, ownerTerminated: false, ...changes });
  return { owner, options, journal, control, launch, input, end, exits, intents, hasUnboundChildren, onRetired };
}

describe('StandaloneSessionOwner', () => {
  it('reserves before spawn, closes admission synchronously, and fans out beyond four workers', async () => {
    const f = await fixture();
    const launches = await Promise.all(Array.from({ length: 5 }, () => f.owner.prepare(f.input)));
    const freeze = f.owner.freeze(signal(), budget);
    expect(f.owner.acceptingLaunches).toBe(false);
    expect(f.control.drain).toHaveBeenCalledTimes(5);
    await expect(f.owner.prepare(f.input)).rejects.toThrow('gate closed');
    expect((await freeze).launchIds).toHaveLength(5);
    for (const launch of launches) f.end(launch.launchId);
    for (const launch of launches) expect(await f.owner.drain(launch.launchId, signal(), budget)).toEqual({ stored: true, runtimeExited: true, jobEmpty: true });
    expect(f.journal.complete).toHaveBeenCalledTimes(5);
    expect(f.journal.end).not.toHaveBeenCalled();
    expect(f.control.forget).toHaveBeenCalledTimes(5);
    expect(f.onRetired).toHaveBeenCalledTimes(5);
    expect(f.owner.unresolvedLaunchCount).toBe(0);
  });
  it('includes an in-flight reservation without allowing a late launch to escape freeze', async () => {
    const f = await fixture(); const reservation = deferred<void>();
    f.journal.reserve.mockImplementationOnce(async (_instance, id) => { await reservation.promise; f.intents.add(id); });
    const preparing = f.owner.prepare(f.input);
    expect(f.owner.unresolvedLaunchCount).toBe(1);
    const frozen = f.owner.freeze(signal(), budget);
    reservation.resolve();
    const launch = await preparing;
    expect((await frozen).launchIds).toContain(launch.launchId);
    expect(f.control.drain).toHaveBeenCalledWith(launch.launchId, expect.any(AbortSignal), budget);
    f.end(launch.launchId);
    expect((await f.owner.drain(launch.launchId, signal(), budget)).stored).toBe(true);
  });
  it('does not promote an ordinary exit to a storage acknowledgement, but retires it for a later retry', async () => {
    const f = await fixture(); const launch = await f.owner.prepare(f.input);
    f.control.drain.mockResolvedValue({ stored: false, releaseAcknowledged: false });
    await f.owner.freeze(signal(), budget); f.end(launch.launchId);
    expect(await f.owner.drain(launch.launchId, signal(), budget)).toEqual({ stored: false, runtimeExited: true, jobEmpty: true });
    expect(f.journal.end).toHaveBeenCalledOnce(); expect(f.journal.complete).not.toHaveBeenCalled();
    expect(await f.owner.freeze(signal(), budget)).toEqual({ launchIds: [], unresolved: false });
  });
  it.each([{ rootExit: 2 }, { forced: true }, { resumed: false }, { nativeError: 5 }])('rejects stored completion for an unclean native outcome %j', async changes => {
    const f = await fixture(); const launch = await f.owner.prepare(f.input);
    await f.owner.freeze(signal(), budget); f.end(launch.launchId, changes);
    expect((await f.owner.drain(launch.launchId, signal(), budget)).stored).toBe(false);
    expect(f.journal.complete).not.toHaveBeenCalled();
  });
  it('keeps mismatched native identity unresolved and never forgets its channel', async () => {
    const f = await fixture(); const launch = await f.owner.prepare(f.input);
    await f.owner.freeze(signal(), budget); f.end(launch.launchId, { instanceId: 'other' });
    expect((await f.owner.drain(launch.launchId, signal(), budget)).stored).toBe(false);
    expect(f.journal.end).not.toHaveBeenCalled(); expect(f.control.forget).not.toHaveBeenCalled();
  });
  it('requires durable completion before reporting success or forgetting ownership', async () => {
    const f = await fixture(); const launch = await f.owner.prepare(f.input);
    f.journal.complete.mockRejectedValueOnce(new Error('disk full'));
    await f.owner.freeze(signal(), budget); f.end(launch.launchId);
    expect((await f.owner.drain(launch.launchId, signal(), budget)).stored).toBe(false);
    expect(f.control.forget).not.toHaveBeenCalled();
  });
  it('retires only a proven no-process startup failure', async () => {
    const f = await fixture(); f.launch.mockRejectedValueOnce('no-process');
    await expect(f.owner.prepare(f.input)).rejects.toBe('no-process');
    expect(f.journal.notLaunched).toHaveBeenCalledOnce(); expect(f.control.forget).toHaveBeenCalledOnce();
    f.launch.mockRejectedValueOnce(new Error('unknown'));
    await expect(f.owner.prepare(f.input)).rejects.toThrow('unknown');
    expect(f.journal.notLaunched).toHaveBeenCalledOnce();
    expect((await f.owner.freeze(signal(), budget)).launchIds).toHaveLength(1);
  });
  it('does not adopt pending startup intents and blocks unbound live children', async () => {
    const f = await fixture(); f.intents.add('old-launch');
    const restarted = await StandaloneSessionOwner.open(f.options);
    expect(restarted.unresolvedLaunchCount).toBe(1);
    await expect(restarted.prepare(f.input)).rejects.toThrow('gate closed');
    expect((await restarted.freeze(signal(), budget)).unresolved).toBe(true);
    f.intents.clear(); f.hasUnboundChildren.mockReturnValue(true);
    expect((await f.owner.freeze(signal(), budget)).unresolved).toBe(true);
  });
  it('close shuts only the channel and does not claim a native exit', async () => {
    const f = await fixture(); await f.owner.prepare(f.input); await f.owner.close();
    expect(f.control.close).toHaveBeenCalledOnce(); expect(f.journal.end).not.toHaveBeenCalled();
    expect(f.owner.acceptingLaunches).toBe(false);
  });
  it('stops only an owned root through storage drain without closing global admission', async () => {
    const f = await fixture(); const launch = await f.owner.prepare(f.input);
    expect((await f.owner.stopRoot(99999)).stored).toBe(false);
    expect(f.control.drain).not.toHaveBeenCalled();
    const stopping = f.owner.stopRoot(launch.pid);
    expect(f.control.drain).toHaveBeenCalledOnce();
    expect(f.owner.acceptingLaunches).toBe(true);
    f.end(launch.launchId);
    expect(await stopping).toEqual({ stored: true, runtimeExited: true, jobEmpty: true });
    expect(f.owner.launchIdForRoot(launch.pid)).toBeUndefined();
  });
  it('joins a global freeze attempt when stopping an owned root', async () => {
    const f = await fixture(); const launch = await f.owner.prepare(f.input);
    await f.owner.freeze(signal(), budget);
    const stopping = f.owner.stopRoot(launch.pid);
    expect(f.control.drain).toHaveBeenCalledOnce();
    f.end(launch.launchId);
    expect((await stopping).stored).toBe(true);
  });

  it('retires a control reservation failure as no process without invoking the launcher', async () => {
    const f = await fixture(); f.control.reserve.mockImplementationOnce(() => { throw new Error('capacity'); });
    await expect(f.owner.prepare(f.input)).rejects.toThrow('capacity');
    expect(f.launch).not.toHaveBeenCalled(); expect(f.journal.notLaunched).toHaveBeenCalledOnce();
    expect(f.owner.unresolvedLaunchCount).toBe(0);
  });
  it('retires a journal reservation failure that wrote no intent and keeps admission open', async () => {
    const f = await fixture(); f.journal.reserve.mockRejectedValueOnce(new Error('Standalone journal ACL protection failed'));
    await expect(f.owner.prepare(f.input)).rejects.toThrow('ACL protection failed');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.launch).not.toHaveBeenCalled(); expect(f.journal.notLaunched).not.toHaveBeenCalled();
    expect(f.owner.unresolvedLaunchCount).toBe(0); expect(f.owner.acceptingLaunches).toBe(true);
    await expect(f.owner.prepare(f.input)).resolves.toMatchObject({ pid: 101 });
  });
  it('keeps an intent left behind by a failed journal reservation unresolved', async () => {
    const f = await fixture();
    f.journal.reserve.mockImplementationOnce(async (_instance: string, id: string) => { f.intents.add(id); throw new Error('Journal readback mismatch'); });
    await expect(f.owner.prepare(f.input)).rejects.toThrow('readback mismatch');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.journal.notLaunched).not.toHaveBeenCalled(); expect(f.intents.size).toBe(1);
    expect(f.owner.unresolvedLaunchCount).toBe(1); expect(f.owner.acceptingLaunches).toBe(false);
    expect((await f.owner.freeze(signal(), budget)).unresolved).toBe(true);
  });
  it('records a forced suspended-root rollback separately even when freeze races failed readiness', async () => {
    const f = await fixture(); const release = deferred<void>();
    f.launch.mockImplementationOnce(async input => {
      await release.promise;
      throw new StandaloneLaunchFailure({ instanceId: input.instanceId, launchId: input.launchId,
        launched: true, resumed: false, forced: true, rootExit: 125, jobEmpty: true, nativeError: 995, ownerTerminated: false });
    });
    const preparing = f.owner.prepare(f.input); const rejected = expect(preparing).rejects.toBeInstanceOf(StandaloneLaunchFailure);
    const freezing = f.owner.freeze(signal(), budget); release.resolve();
    await rejected; const snapshot = await freezing;
    expect(snapshot.unresolved).toBe(false);
    expect(f.journal.rollback).toHaveBeenCalledOnce(); expect(f.journal.notLaunched).not.toHaveBeenCalled();
    expect(f.journal.complete).not.toHaveBeenCalled(); expect(f.owner.unresolvedLaunchCount).toBe(0);
    expect((await f.owner.drain(snapshot.launchIds[0], signal(), budget)).stored).toBe(false);
  });
  it('retains ownership if rollback persistence fails', async () => {
    const f = await fixture(); f.journal.rollback.mockRejectedValueOnce(new Error('disk full'));
    f.launch.mockImplementationOnce(async input => { throw new StandaloneLaunchFailure({ instanceId: input.instanceId,
      launchId: input.launchId, launched: true, resumed: false, forced: true, rootExit: 125, jobEmpty: true, nativeError: 995, ownerTerminated: false }); });
    await expect(f.owner.prepare(f.input)).rejects.toThrow('disk full');
    expect(f.owner.unresolvedLaunchCount).toBe(1); expect(f.control.forget).not.toHaveBeenCalled();
  });

  it('reconciles a later old-generation receipt without another restart or freezing admission', async () => {
    vi.useFakeTimers();
    const f = await fixture(); f.intents.add('old');
    f.journal.pendingRecords.mockImplementation(async () => ({ records: [...f.intents].map(launchId => ({ instanceId: 'old-instance', launchId })), unresolved: false }));
    const readReceipt = vi.fn<(_: { instanceId: string; launchId: string }) => Promise<NativeReceipt | null>>(async () => null);
    const owner = await StandaloneSessionOwner.open({ ...f.options, readReceipt });
    expect(owner.acceptingLaunches).toBe(false);
    readReceipt.mockResolvedValue({ instanceId: 'old-instance', launchId: 'old', launched: true,
      resumed: true, forced: false, rootExit: 0, jobEmpty: true, nativeError: 5, ownerTerminated: false });
    await vi.advanceTimersByTimeAsync(5000);
    expect(owner.acceptingLaunches).toBe(true); expect(owner.unresolvedLaunchCount).toBe(0);
    expect(f.journal.end).toHaveBeenCalledWith('old-instance', 'old', { runtimeExited: true, jobEmpty: true, rootExit: 0 });
    expect(f.journal.complete).not.toHaveBeenCalled();
    const reads = readReceipt.mock.calls.length; await vi.advanceTimersByTimeAsync(10000);
    expect(readReceipt).toHaveBeenCalledTimes(reads); await owner.close();
  });
  it('recovers a failed current observation from durable evidence without a stored upgrade', async () => {
    vi.useFakeTimers(); const f = await fixture();
    const readReceipt = vi.fn<(_: { instanceId: string; launchId: string }) => Promise<NativeReceipt | null>>(async () => null);
    const owner = await StandaloneSessionOwner.open({ ...f.options, readReceipt });
    const launch = await owner.prepare(f.input);
    f.exits.get(launch.launchId)!.reject(new Error('stdout lost'));
    await vi.advanceTimersByTimeAsync(0);
    expect(owner.acceptingLaunches).toBe(false);
    readReceipt.mockResolvedValue({ instanceId: 'instance', launchId: launch.launchId, launched: true,
      resumed: true, forced: false, rootExit: 0, jobEmpty: true, nativeError: 0, ownerTerminated: false });
    await vi.advanceTimersByTimeAsync(5000);
    expect(owner.acceptingLaunches).toBe(true); expect(owner.unresolvedLaunchCount).toBe(0);
    expect(f.journal.end).toHaveBeenCalledOnce(); expect(f.journal.complete).not.toHaveBeenCalled();
    expect(f.onRetired).toHaveBeenCalledWith(launch.pid, launch.launchId);
    await owner.close();
  });
  it('does not let recovery preempt a healthy current observer awaiting stored confirmation', async () => {
    const f = await fixture(); const proof = deferred<{ stored: boolean; releaseAcknowledged: boolean }>();
    f.control.drain.mockReturnValue(proof.promise);
    const readReceipt = vi.fn(async () => null);
    const owner = await StandaloneSessionOwner.open({ ...f.options, readReceipt });
    const launch = await owner.prepare(f.input); await owner.freeze(signal(), budget);
    f.end(launch.launchId); await owner.freeze(signal(), budget);
    expect(readReceipt).not.toHaveBeenCalled(); expect(f.journal.end).not.toHaveBeenCalled();
    proof.resolve({ stored: true, releaseAcknowledged: true });
    expect((await owner.drain(launch.launchId, signal(), budget)).stored).toBe(true);
    await owner.close();
  });
  it('bounds a stuck recovery read by the drain budget and preserves pending work', async () => {
    vi.useFakeTimers(); const f = await fixture();
    const owner = await StandaloneSessionOwner.open({ ...f.options, readReceipt: async () => new Promise(() => {}) });
    f.intents.add('missing');
    const freezing = owner.freeze(signal(), { remainingMs: () => 20 });
    await vi.advanceTimersByTimeAsync(20);
    expect((await freezing).unresolved).toBe(true); expect(f.intents.has('missing')).toBe(true);
    await owner.close();
  });
  it('classifies an empty Job with native observation errors as ended, never stored', async () => {
    const f = await fixture(); const launch = await f.owner.prepare(f.input);
    await f.owner.freeze(signal(), budget); f.end(launch.launchId, { nativeError: 5 });
    expect((await f.owner.drain(launch.launchId, signal(), budget)).stored).toBe(false);
    expect(f.journal.end).toHaveBeenCalledOnce(); expect(f.journal.complete).not.toHaveBeenCalled();
    expect(classifyNativeReceipt({ instanceId: 'instance', launchId: launch.launchId, launched: true,
      resumed: true, forced: false, rootExit: 0, jobEmpty: false, nativeError: 5, ownerTerminated: false })).toBeNull();
  });
  it('allows explicit owned Job termination only after freeze and records it separately', async () => {
    const f = await fixture(); const launch = await f.owner.prepare(f.input);
    expect(f.owner.canTerminate(launch.launchId)).toBe(false);
    await expect(f.owner.resolveTermination(launch.launchId)).rejects.toThrow('unavailable');
    expect(launch.terminate).not.toHaveBeenCalled();
    await f.owner.freeze(signal(), budget);
    expect(f.owner.canTerminate(launch.launchId)).toBe(true);
    const terminating = f.owner.resolveTermination(launch.launchId);
    f.end(launch.launchId, { ownerTerminated: true, rootExit: 125 });
    await terminating;
    expect(f.owner.canTerminate(launch.launchId)).toBe(false);
    expect(launch.terminate).toHaveBeenCalledOnce(); expect(f.journal.terminate).toHaveBeenCalledOnce();
    expect(f.journal.complete).not.toHaveBeenCalled(); expect(f.journal.end).not.toHaveBeenCalled();
    expect((await f.owner.drain(launch.launchId, signal(), budget)).stored).toBe(false);
  });

  it('backs off unchanged recovery to 60 seconds and scans once when no outcome was written', async () => {
    vi.useFakeTimers(); const f = await fixture(); f.intents.add('old');
    const readReceipt = vi.fn(async () => null);
    const owner = await StandaloneSessionOwner.open({ ...f.options, readReceipt });
    f.journal.pendingRecords.mockClear();
    await vi.advanceTimersByTimeAsync(5000); expect(f.journal.pendingRecords).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9999); expect(f.journal.pendingRecords).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(f.journal.pendingRecords).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20000); expect(f.journal.pendingRecords).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(40000); expect(f.journal.pendingRecords).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(59999); expect(f.journal.pendingRecords).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1); expect(f.journal.pendingRecords).toHaveBeenCalledTimes(5);
    await owner.close(); await vi.advanceTimersByTimeAsync(120000);
    expect(f.journal.pendingRecords).toHaveBeenCalledTimes(5);
  });
  it('classifies a proven no-process receipt even if no Job was created', () => {
    expect(classifyNativeReceipt({ instanceId: 'instance', launchId: 'missing', launched: false,
      resumed: false, rootExit: null, jobEmpty: false, forced: false, ownerTerminated: false, nativeError: 2 })).toEqual({ kind: 'not-launched' });
  });

  it('does not claim a new stop for an unowned or frozen-refused root', async () => {
    const f = await fixture(); const launch = await f.owner.prepare(f.input);
    expect(f.owner.canDrainRoot(9999)).toBe(false); expect(f.owner.canDrainRoot(launch.pid)).toBe(true);
    f.control.drain.mockResolvedValue({ stored: false, releaseAcknowledged: false });
    await f.owner.freeze(signal(), budget);
    expect(f.owner.canDrainRoot(launch.pid)).toBe(false);
    expect((await f.owner.stopRoot(launch.pid)).stored).toBe(false);
    expect(f.control.drain).toHaveBeenCalledOnce();
    await f.owner.close();
  });

});
