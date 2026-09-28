import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeProducerGate } from './runtimeProducerGate';
import { SessionDrain } from './sessionDrain';

function fixture() {
    const order: string[] = [];
    const provider = {
        freezeInputForShutdown: vi.fn(() => { order.push('freeze'); return true; }),
        interruptTurn: vi.fn(async () => { order.push('interrupt'); }),
        endInputAndAwaitExit: vi.fn(async (_ms: number, _signal?: AbortSignal) => { order.push('eof'); return { exited: true, code: 0, signal: null as string | null }; }),
        waitForOutputDrain: vi.fn(async () => { order.push('output'); }),
        cancelOutputDrain: vi.fn(),
        finishShutdownObservation: vi.fn(),
    };
    const proof = Object.freeze({ stored: true as const, revision: 1 });
    const storage = { tracksShutdownStorage: true,
        flushForShutdown: vi.fn(async (_ms: number, _signal?: AbortSignal) => { order.push('storage'); return proof; }),
        isStorageConfirmationCurrent: vi.fn(() => true),
    };
    const quiesce = vi.fn(async (_signal: AbortSignal) => { order.push('producers'); });
    const drain = new SessionDrain('launch-1', provider, storage, quiesce);
    return { drain, provider, storage, quiesce, order };
}
function runtimeFixture() {
    const f = fixture();
    const gate = new RuntimeProducerGate({ hasUndeliveredInput: () => false,
        canFreezeInbound: () => true, freezeInbound: () => true, stopLoop: () => {} });
    const drain = new SessionDrain('runtime-release', f.provider, f.storage, f.quiesce, gate);
    return { ...f, gate, drain };
}
afterEach(() => vi.useRealTimers());
describe('SessionDrain', () => {
    it('binds mutation-free refusal outcomes to their receipt across retries', async () => {
        const f = runtimeFixture();
        f.provider.freezeInputForShutdown.mockReturnValueOnce(false);
        const refused = await f.drain.drain(1000);
        expect(refused).toMatchObject({ ownership: 'none', stored: false });
        const pending = f.drain.drain(1000); f.gate.loopExited();
        const acquired = await pending;
        expect(acquired).toMatchObject({ ownership: 'held', stored: true });
        expect(await f.drain.outcome(refused)).toBe('none');
        await expect(f.drain.outcome({ ...refused })).rejects.toThrow('not issued');
        f.drain.releaseRuntime(acquired);
        expect(await f.drain.outcome(acquired)).toBe('confirmed');
    });
    it('fails runtime admission closed when provider freeze ownership is unknown', async () => {
        const f = runtimeFixture();
        f.provider.freezeInputForShutdown.mockImplementationOnce(() => { throw new Error('partial mutation'); });
        const receipt = await f.drain.drain(1000);
        expect(receipt).toMatchObject({ ownership: 'unknown', reason: 'freeze-failed' });
        expect(await f.drain.outcome(receipt)).toBe('blocked');
        expect(f.gate.isFrozen()).toBe(true);
        expect(await f.gate.waitForShutdownDecision()).toBe('blocked');
        await expect(f.gate.admit(async () => {})).rejects.toThrow('closed');
        expect(await f.drain.drain(1000)).toBe(receipt);
    });
    it('freezes synchronously, joins one budget and keeps provider exit separate from runtime/Job evidence', async () => {
        const f = fixture();
        const pending = f.drain.drain(1000);
        expect(f.order).toEqual(['freeze']);
        expect(f.drain.drain(30000)).toBe(pending);
        const receipt = await pending;
        expect(receipt).toMatchObject({ status: 'provider-drained', providerExited: true, outputDrained: true, stored: true, runtimeExited: false, jobEmpty: false });
        expect(f.order.indexOf('storage')).toBeGreaterThan(f.order.indexOf('output'));
        expect(f.storage.flushForShutdown).toHaveBeenCalledOnce();
        expect(f.drain.isCurrent(receipt)).toBe(true);
        expect(f.drain.isCurrent({ ...receipt })).toBe(false);
        f.storage.isStorageConfirmationCurrent.mockReturnValue(false);
        expect(f.drain.isCurrent(receipt)).toBe(false);
    });
    it('returns a blocked receipt when observation cleanup throws after storage proof', async () => {
        const f = fixture();
        f.provider.finishShutdownObservation.mockImplementationOnce(() => { throw new Error('observer cleanup failed'); });
        const receipt = await f.drain.drain(1000);
        expect(receipt).toMatchObject({ status: 'blocked', reason: 'observation-cleanup-failed', stored: false,
            providerExited: true, outputDrained: true, exitObserved: true, exitCode: 0 });
        expect(f.drain.isCurrent(receipt)).toBe(false);
        expect(await f.drain.drain(1000)).toBe(receipt);
        expect(f.provider.freezeInputForShutdown).toHaveBeenCalledOnce();
    });
    it('keeps the first failure when observation cleanup also throws', async () => {
        const f = fixture();
        f.provider.endInputAndAwaitExit.mockResolvedValueOnce({ exited: true, code: 1, signal: null });
        f.provider.finishShutdownObservation.mockImplementationOnce(() => { throw new Error('observer cleanup failed'); });
        const receipt = await f.drain.drain(1000);
        expect(receipt).toMatchObject({ status: 'blocked', reason: 'provider-exit-unclean',
            stored: false, providerExited: false, exitObserved: true, exitCode: 1 });
        expect(f.provider.finishShutdownObservation).toHaveBeenCalledOnce();
        expect(f.provider.freezeInputForShutdown).toHaveBeenCalledOnce();
        expect(await f.drain.drain(1000)).toBe(receipt);
    });
    it('blocks when observation cleanup makes the captured proof stale', async () => {
        const f = fixture(); let current = true;
        f.storage.isStorageConfirmationCurrent.mockImplementation(() => current);
        f.provider.finishShutdownObservation.mockImplementationOnce(() => { current = false; });
        const receipt = await f.drain.drain(1000);
        expect(receipt).toMatchObject({ status: 'blocked', reason: 'stale-storage-proof', stored: false });
        expect(f.drain.isCurrent(receipt)).toBe(false);
    });
    it('blocks the runtime when its proof goes stale before release', async () => {
        const f = runtimeFixture();
        const operation = f.drain.drain(1000); f.gate.loopExited();
        const receipt = await operation;
        f.storage.isStorageConfirmationCurrent.mockReturnValue(false);
        expect(() => f.drain.releaseRuntime(receipt)).toThrow('not current');
        expect(await f.gate.waitForShutdownDecision()).toBe('blocked');
    });
    it('blocks the runtime when proof revalidation throws before release', async () => {
        const f = runtimeFixture();
        const operation = f.drain.drain(1000); f.gate.loopExited();
        const receipt = await operation;
        f.storage.isStorageConfirmationCurrent.mockImplementation(() => { throw new Error('proof unavailable'); });
        expect(() => f.drain.releaseRuntime(receipt)).toThrow('not current');
        expect(await f.gate.waitForShutdownDecision()).toBe('blocked');
    });
    it('blocks a successful receipt whose owner never releases it before the deadline', async () => {
        vi.useFakeTimers();
        const f = runtimeFixture();
        const operation = f.drain.drain(100); f.gate.loopExited();
        const receipt = await operation;
        expect(receipt.stored).toBe(true);
        await vi.advanceTimersByTimeAsync(10_001);
        expect(await f.gate.waitForShutdownDecision()).toBe('blocked');
        expect(f.drain.isCurrent(receipt)).toBe(false);
    });
    it('allows reply delivery after a proof completed near the observation deadline', async () => {
        vi.useFakeTimers();
        const f = runtimeFixture();
        f.quiesce.mockImplementation(() => new Promise(resolve => setTimeout(resolve, 95)));
        const operation = f.drain.drain(100); f.gate.loopExited();
        await vi.advanceTimersByTimeAsync(95);
        const receipt = await operation;
        expect(receipt.stored).toBe(true);
        await vi.advanceTimersByTimeAsync(10);
        f.drain.releaseRuntime(receipt);
        expect(await f.gate.waitForShutdownDecision()).toBe('confirmed');
    });
    it('does not produce storage proof while another producer is still active', async () => {
        const f = fixture(); let release!: () => void;
        f.quiesce.mockImplementation(() => new Promise(resolve => { release = resolve; }));
        const pending = f.drain.drain(1000);
        await vi.waitFor(() => expect(f.provider.waitForOutputDrain).toHaveBeenCalled());
        expect(f.storage.flushForShutdown).not.toHaveBeenCalled();
        release(); expect((await pending).stored).toBe(true);
    });
    it('uses one deadline and rejects late success from an uncooperative source', async () => {
        vi.useFakeTimers(); const f = fixture(); let release!: () => void;
        f.provider.waitForOutputDrain.mockImplementation(() => new Promise(resolve => { release = resolve; }));
        const pending = f.drain.drain(100);
        await vi.advanceTimersByTimeAsync(101);
        const receipt = await pending;
        expect(receipt).toMatchObject({ status: 'blocked', reason: 'deadline', stored: false });
        expect(f.provider.cancelOutputDrain).toHaveBeenCalledOnce();
        release(); await Promise.resolve();
        expect(f.storage.flushForShutdown).not.toHaveBeenCalled();
        expect(f.drain.isCurrent(receipt)).toBe(false);
    });
    it('cancels observations without a force-kill or a successful receipt', async () => {
        const f = fixture(); const controller = new AbortController();
        f.provider.interruptTurn.mockImplementation(() => new Promise(() => {}));
        const pending = f.drain.drain(1000, controller.signal); controller.abort();
        expect(await pending).toMatchObject({ status: 'blocked', reason: 'aborted', stored: false });
        expect(f.provider.cancelOutputDrain).toHaveBeenCalledOnce();
    });
    it('refuses unsupported observation before signalling the provider', async () => {
        const f = fixture(); f.provider.freezeInputForShutdown.mockReturnValue(false);
        expect(await f.drain.drain(1000)).toMatchObject({ status: 'blocked', reason: 'unsupported' });
        expect(f.provider.interruptTurn).not.toHaveBeenCalled();
    });
    it('allows a fresh attempt after a refusal that never acquired freeze ownership', async () => {
        const f = fixture(); f.provider.freezeInputForShutdown.mockReturnValueOnce(false);
        expect(await f.drain.drain(1000)).toMatchObject({ reason: 'unsupported', stored: false });
        expect(f.quiesce).not.toHaveBeenCalled();
        expect(await f.drain.drain(1000)).toMatchObject({ status: 'provider-drained', stored: true });
        expect(f.provider.freezeInputForShutdown).toHaveBeenCalledTimes(2);
    });
    it('allows a fresh budget after a pre-aborted request without a freeze', async () => {
        const f = fixture(); const controller = new AbortController(); controller.abort();
        expect(await f.drain.drain(100, controller.signal)).toMatchObject({ reason: 'aborted' });
        expect(await f.drain.drain(1000)).toMatchObject({ status: 'provider-drained', stored: true });
        expect(f.provider.freezeInputForShutdown).toHaveBeenCalledOnce();
    });
    it('does not retry a throwing freeze whose side effects are unknown', async () => {
        const f = fixture(); f.provider.freezeInputForShutdown.mockImplementationOnce(() => { throw new Error('partial mutation'); });
        const first = f.drain.drain(1000);
        expect(await first).toMatchObject({ reason: 'freeze-failed' });
        expect(f.drain.drain(1000)).toBe(first);
        expect(f.provider.freezeInputForShutdown).toHaveBeenCalledOnce();
    });
    it('joins the same operation when provider freeze reenters drain', async () => {
        const f = fixture(); let nested: ReturnType<SessionDrain['drain']> | undefined;
        f.provider.freezeInputForShutdown.mockImplementationOnce(() => { nested = f.drain.drain(50); return true; });
        const first = f.drain.drain(1000);
        expect(nested).toBe(first);
        expect(await first).toMatchObject({ stored: true });
        expect(f.provider.freezeInputForShutdown).toHaveBeenCalledOnce();
    });
    it('closes runtime admission when provider freeze changes the input precondition', async () => {
        const f = fixture(); let queued = false;
        const runtime = new RuntimeProducerGate({ hasUndeliveredInput: () => queued, canFreezeInbound: () => true,
            freezeInbound: () => true, stopLoop: vi.fn() });
        f.provider.freezeInputForShutdown.mockImplementationOnce(() => { queued = true; return true; });
        const drain = new SessionDrain('recheck', f.provider, f.storage, f.quiesce, runtime);
        const first = drain.drain(1000);
        expect(await first).toMatchObject({ reason: 'freeze-failed', stored: false });
        expect(drain.drain(1000)).toBe(first);
        expect(f.provider.finishShutdownObservation).toHaveBeenCalledOnce();
        expect(f.storage.flushForShutdown).not.toHaveBeenCalled();
        await expect(runtime.admit(async () => {})).rejects.toThrow('closed');
    });
    it('caches a partial composite freeze and releases provider observation without storing', async () => {
        const f = fixture(); const stopLoop = vi.fn();
        const runtime = new RuntimeProducerGate({ hasUndeliveredInput: () => false, canFreezeInbound: () => true,
            freezeInbound: () => false, stopLoop });
        const drain = new SessionDrain('partial', f.provider, f.storage, f.quiesce, runtime);
        const first = drain.drain(1000);
        expect(await first).toMatchObject({ status: 'blocked', reason: 'freeze-failed', stored: false });
        expect(drain.drain(1000)).toBe(first);
        expect(f.provider.freezeInputForShutdown).toHaveBeenCalledOnce();
        expect(f.provider.finishShutdownObservation).toHaveBeenCalledOnce();
        expect(f.storage.flushForShutdown).not.toHaveBeenCalled(); expect(stopLoop).not.toHaveBeenCalled();
        await expect(runtime.admit(async () => {})).rejects.toThrow('closed');
    });
    it('does not confuse a nonzero provider exit with graceful completion', async () => {
        const f = fixture(); f.provider.endInputAndAwaitExit.mockResolvedValue({ exited: true, code: 2, signal: null });
        expect(await f.drain.drain(1000)).toMatchObject({ status: 'blocked', providerExited: false, stored: false, exitObserved: true, exitCode: 2, exitSignal: null });
        expect(f.storage.flushForShutdown).not.toHaveBeenCalled();
    });
    it('passes only the remaining budget to final storage confirmation', async () => {
        vi.useFakeTimers(); const f = fixture();
        f.provider.interruptTurn.mockImplementation(() => new Promise(resolve => setTimeout(resolve, 60)));
        const pending = f.drain.drain(100);
        await vi.advanceTimersByTimeAsync(60); await pending;
        expect(f.storage.flushForShutdown.mock.calls[0][0]).toBeLessThanOrEqual(40);
    });
    it('does not run producers or signal a pre-aborted launch', async () => {
        const f = fixture(); const controller = new AbortController(); controller.abort();
        expect(await f.drain.drain(100, controller.signal)).toMatchObject({ reason: 'aborted', stored: false });
        expect(f.provider.freezeInputForShutdown).not.toHaveBeenCalled();
        expect(f.quiesce).not.toHaveBeenCalled();
    });
    it('preserves an observed exit when the output reader fails', async () => {
        const f = fixture(); f.provider.waitForOutputDrain.mockRejectedValue(new Error('broken output'));
        expect(await f.drain.drain(1000)).toMatchObject({ status: 'blocked', stored: false, exitObserved: true, exitCode: 0, exitSignal: null });
    });
    it('retains an observed exit even when the clock expires before its continuation runs', async () => {
        const f = fixture(); let now = 0; const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
        try {
            f.provider.endInputAndAwaitExit.mockImplementation(async () => { now = 101; return { exited: true, code: 0, signal: null }; });
            expect(await f.drain.drain(100)).toMatchObject({ status: 'blocked', stored: false, reason: 'deadline', exitObserved: true, exitCode: 0 });
        } finally { clock.mockRestore(); }
    });
    it('rechecks proof after storage completion', async () => {
        const f = fixture(); f.storage.isStorageConfirmationCurrent.mockReturnValue(false);
        expect(await f.drain.drain(1000)).toMatchObject({ status: 'blocked', stored: false });
    });
});
