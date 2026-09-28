import { describe, expect, it, vi } from 'vitest';
import { RuntimeProducerGate } from '@/sessionDrain/runtimeProducerGate';
import { createProviderExitObserver } from '@/managed/managedProviderExitObserver';
import { ClaudeStandaloneDrain } from './claudeStandaloneDrain';

function gate() {
    return new RuntimeProducerGate({ hasUndeliveredInput: () => false, canFreezeInbound: () => true, freezeInbound: () => true, stopLoop: () => {} });
}
function launcher() {
    const observer = createProviderExitObserver();
    let held = false;
    return { observer, hold: (value: boolean) => { held = value; }, port: { requestEndInput: vi.fn(), cancelPendingPermissions: vi.fn(), generation: () => observer, hasHeldBackInput: () => held } };
}

describe('Claude standalone drain hooks', () => {
    it('is not ready until the launcher loop is attached, and stops being ready when the loop ends', () => {
        const drain = new ClaudeStandaloneDrain(gate());
        const deps = drain.providerDeps();
        expect(deps.ready()).toBe(false);
        drain.attachLauncher(launcher().port);
        expect(deps.ready()).toBe(true);
        drain.markLoopFinished();
        expect(deps.ready()).toBe(false);
        expect(deps.isLoopFinished()).toBe(true);
    });

    it('moves the gate through a turn and offers the query for interrupt only while a turn runs', async () => {
        const g = gate();
        const drain = new ClaudeStandaloneDrain(g);
        const deps = drain.providerDeps();
        const interrupt = vi.fn(async () => undefined);
        drain.setQuery({ interrupt });
        expect(drain.claimTurn()).toBe(true);
        expect(g.blocker()).toBe('turn-preparing');
        expect(deps.activeTurn()).toBeNull();
        drain.dispatched();
        expect(g.blocker()).toBeNull();
        await deps.activeTurn()?.interrupt();
        expect(interrupt).toHaveBeenCalledTimes(1);
        drain.turnEnded();
        expect(deps.activeTurn()).toBeNull();
        expect(drain.claimTurn()).toBe(true);
        drain.releaseClaim();
        expect(g.blocker()).toBeNull();
    });

    it('freezes by denying pending permission prompts, and ends input and reports the generation through the launcher', () => {
        const drain = new ClaudeStandaloneDrain(gate());
        const { observer, port } = launcher();
        drain.attachLauncher(port);
        const deps = drain.providerDeps();
        deps.freezeInput();
        expect(port.cancelPendingPermissions).toHaveBeenCalledTimes(1);
        deps.requestEndInput();
        expect(port.requestEndInput).toHaveBeenCalledTimes(1);
        expect(deps.generation()).toBe(observer);
    });

    it('keeps the last generation after the loop ends, so an unseen exit is never read as "no provider"', () => {
        const drain = new ClaudeStandaloneDrain(gate());
        const { observer, port } = launcher();
        drain.attachLauncher(port);
        drain.markLoopFinished();
        expect(drain.providerDeps().generation()).toBe(observer);
    });

    it('settles loopFinished once', async () => {
        const drain = new ClaudeStandaloneDrain(gate());
        drain.markLoopFinished(); drain.markLoopFinished();
        await expect(drain.providerDeps().loopFinished).resolves.toBeUndefined();
    });

    it('reports input the launcher held back outside the queue', () => {
        const drain = new ClaudeStandaloneDrain(gate());
        expect(drain.hasHeldBackInput()).toBe(false);
        const l = launcher();
        drain.attachLauncher(l.port);
        l.hold(true);
        expect(drain.hasHeldBackInput()).toBe(true);
    });
});
