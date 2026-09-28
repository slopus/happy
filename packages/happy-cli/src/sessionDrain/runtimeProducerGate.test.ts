import { describe, expect, it, vi } from 'vitest';
import { RuntimeProducerGate } from './runtimeProducerGate';
import { SessionDrain } from './sessionDrain';

function fixture() {
    const ports = { hasUndeliveredInput: vi.fn(() => false), canFreezeInbound: vi.fn(() => true),
        freezeInbound: vi.fn(() => true), stopLoop: vi.fn() };
    return { ports, gate: new RuntimeProducerGate(ports) };
}
describe('runtime producer shutdown gate', () => {
    it('seals ordinary cleanup admission and waits for real producer rejection', async () => {
        const { gate, ports } = fixture(); let reject!: (error: Error) => void;
        const task = gate.admit(() => new Promise<void>((_, fail) => { reject = fail; }), 'writer');
        const observed = task.catch(() => undefined);
        const pending = gate.closeAdmissionAndWait();
        expect(gate.isClosed()).toBe(true);
        await expect(gate.admit(async () => {})).rejects.toThrow('closed');
        expect(ports.freezeInbound).not.toHaveBeenCalled();
        expect(gate.hasLiveProducers()).toBe(true);
        reject(new Error('settled failure')); await observed; await pending;
        gate.loopExited(); expect(gate.hasLiveProducers()).toBe(false);
        await gate.closeAdmissionAndWait();
    });
    it('seals direct termination before an asynchronous abort can let a drain freeze', async () => {
        const { gate, ports } = fixture();
        gate.beginTermination();
        expect(gate.blocker()).toBe('frozen');
        await expect(gate.admit(async () => {})).rejects.toThrow('closed');
        expect(ports.freezeInbound).not.toHaveBeenCalled();
    });
    it('keeps a frozen runtime cleanup held until a confirmed drain releases it', async () => {
        const { gate } = fixture();
        gate.freeze(); gate.loopExited();
        let released = false;
        const held = gate.waitForShutdownDecision().then(decision => { released = decision === 'confirmed'; });
        await Promise.resolve();
        expect(released).toBe(false);
        gate.confirmShutdownStorage();
        await held;
        expect(released).toBe(true);
    });
    it('refuses queued input, in-flight admission and preparation without mutating ports', async () => {
        const { gate, ports } = fixture();
        ports.hasUndeliveredInput.mockReturnValue(true); expect(gate.blocker()).toBe('input-undelivered');
        ports.hasUndeliveredInput.mockReturnValue(false);
        let release!: () => void;
        const task = gate.admit(() => { expect(gate.blocker()).toBe('producer-busy'); return new Promise<void>(resolve => { release = resolve; }); });
        expect(gate.blocker()).toBe('producer-busy'); release(); await task;
        gate.beginPreparing(); expect(gate.blocker()).toBe('turn-preparing');
        gate.markDispatched(); expect(gate.blocker()).toBeNull();
        expect(ports.freezeInbound).not.toHaveBeenCalled(); expect(ports.stopLoop).not.toHaveBeenCalled();
    });
    it('waits for turn finally and loop completion and refuses all new producer work', async () => {
        const { gate } = fixture(); gate.beginPreparing(); gate.markDispatched(); gate.freeze();
        const work = vi.fn(async () => {}); await expect(gate.admit(work)).rejects.toThrow('closed'); expect(work).not.toHaveBeenCalled();
        let settled = false; const pending = gate.quiesce(new AbortController().signal).then(() => { settled = true; });
        gate.loopExited(); await Promise.resolve(); expect(settled).toBe(false);
        gate.endTurn(); await pending; expect(settled).toBe(true);
    });
    it('cancels only observation and retains the unfinished loop as live', async () => {
        const { gate } = fixture(); gate.freeze(); const controller = new AbortController();
        const pending = gate.quiesce(controller.signal); controller.abort();
        await expect(pending).rejects.toThrow('aborted'); expect(gate.hasLiveProducers()).toBe(true);
        gate.loopExited(); await gate.quiesce(new AbortController().signal);
    });
    it('retains an admitted writer after observation cancellation until its real completion', async () => {
        const { gate } = fixture(); let release!: () => void;
        const writer = gate.admit(() => new Promise<void>(resolve => { release = resolve; }), 'writer');
        expect(gate.blocker()).toBeNull(); gate.freeze(); gate.loopExited();
        const controller = new AbortController(); const pending = gate.quiesce(controller.signal); controller.abort();
        await expect(pending).rejects.toThrow('aborted'); expect(gate.hasLiveProducers()).toBe(true);
        release(); await writer; await gate.quiesce(new AbortController().signal);
        expect(gate.hasLiveProducers()).toBe(false);
    });
    it('removes rejected producers only when they actually settle', async () => {
        const { gate } = fixture();
        const task = gate.admit(async () => { throw new Error('fixture'); });
        expect(gate.blocker()).toBe('producer-busy'); await expect(task).rejects.toThrow('fixture');
        expect(gate.blocker()).toBeNull();
    });
    it('keeps admission closed when post-provider preflight changes or throws', async () => {
        for (const throws of [false, true]) {
            const { gate, ports } = fixture();
            expect(gate.blocker()).toBeNull();
            ports.hasUndeliveredInput.mockImplementation(() => { if (throws) throw new Error('fixture'); return true; });
            expect(() => gate.freeze()).toThrow(throws ? 'fixture' : 'precondition changed');
            await expect(gate.admit(async () => {})).rejects.toThrow('closed');
            expect(ports.freezeInbound).not.toHaveBeenCalled();
            expect(ports.stopLoop).not.toHaveBeenCalled();
        }
    });
    it('allows an admitted producer to perform its final write after freeze without readmission', async () => {
        const { gate } = fixture(); let release!: () => void; const write = vi.fn();
        const producer = gate.admit(async () => { await new Promise<void>(resolve => { release = resolve; }); write(); }, 'writer');
        gate.freeze(); gate.loopExited();
        const pending = gate.quiesce(new AbortController().signal);
        expect(write).not.toHaveBeenCalled(); release(); await producer; await pending;
        expect(write).toHaveBeenCalledOnce();
    });
    it('remains frozen on partial inbound failure', async () => {
        const { gate, ports } = fixture(); ports.freezeInbound.mockReturnValue(false);
        expect(() => gate.freeze()).toThrow('Inbound freeze refused');
        await expect(gate.admit(async () => {})).rejects.toThrow('closed');
        expect(ports.stopLoop).not.toHaveBeenCalled();
    });
    it('preflights runtime before provider mutation and waits for loop final writes before storage', async () => {
        const { gate, ports } = fixture();
        const provider = { freezeInputForShutdown: vi.fn(() => true), interruptTurn: vi.fn(async () => {}),
            endInputAndAwaitExit: vi.fn(async () => ({ exited: true, code: 0, signal: null })),
            waitForOutputDrain: vi.fn(async () => {}), cancelOutputDrain: vi.fn(), finishShutdownObservation: vi.fn() };
        const storage = { tracksShutdownStorage: true, flushForShutdown: vi.fn(async () => ({ stored: true as const, revision: 1 })), isStorageConfirmationCurrent: () => true };
        const drain = new SessionDrain('runtime-gate', provider, storage, async () => {}, gate);
        ports.hasUndeliveredInput.mockReturnValue(true);
        expect(await drain.drain(1000)).toMatchObject({ status: 'blocked', reason: 'input-undelivered' });
        expect(provider.freezeInputForShutdown).not.toHaveBeenCalled();
        ports.hasUndeliveredInput.mockReturnValue(false); gate.beginPreparing(); gate.markDispatched();
        const pending = drain.drain(1000);
        await vi.waitFor(() => expect(provider.waitForOutputDrain).toHaveBeenCalled());
        expect(storage.flushForShutdown).not.toHaveBeenCalled();
        gate.endTurn(); gate.loopExited();
        expect(await pending).toMatchObject({ stored: true, runtimeExited: false, jobEmpty: false });
        const receipt = await pending;
        let decision: string | undefined;
        void gate.waitForShutdownDecision().then(value => { decision = value; });
        await Promise.resolve();
        expect(decision).toBeUndefined();
        expect(() => drain.releaseRuntime({ ...receipt })).toThrow('not current');
        drain.releaseRuntime(receipt);
        expect(await gate.waitForShutdownDecision()).toBe('confirmed');
        expect(await drain.outcome(receipt)).toBe('confirmed');
    });
    it('keeps frozen cleanup held after a blocked provider exit', async () => {
        const { gate } = fixture();
        const provider = { freezeInputForShutdown: () => true, interruptTurn: async () => {},
            endInputAndAwaitExit: async () => ({ exited: true, code: 1, signal: null }),
            waitForOutputDrain: async () => {}, cancelOutputDrain: () => {}, finishShutdownObservation: () => {} };
        const storage = { tracksShutdownStorage: true, flushForShutdown: vi.fn(async () => ({ stored: true as const, revision: 1 })),
            isStorageConfirmationCurrent: () => true };
        const drain = new SessionDrain('blocked-exit', provider, storage, async () => {}, gate);
        const operation = drain.drain(1000);
        gate.loopExited();
        expect(await operation).toMatchObject({ status: 'blocked', reason: 'provider-exit-unclean' });
        expect(await gate.waitForShutdownDecision()).toBe('blocked');
        expect(await drain.outcome(await operation)).toBe('blocked');
        expect(storage.flushForShutdown).not.toHaveBeenCalled();
    });
});
