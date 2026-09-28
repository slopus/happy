import { describe, expect, it, vi } from 'vitest';
import { createAcpDrainProvider, type AcpDrainDeps } from './acpDrainProvider';
import type { ObservedSdkExit } from '@/managed/managedProviderExitObserver';

function fixture(overrides: Partial<AcpDrainDeps> = {}) {
  let observed: ObservedSdkExit | null = null;
  let started = true;
  let loopDone = false;
  let finishLoop!: () => void;
  const loopFinished = new Promise<void>((resolve) => { finishLoop = () => { loopDone = true; resolve(); }; });
  let clock = 0;
  const deps: AcpDrainDeps = {
    ready: () => true,
    freezeInput: vi.fn(),
    activeTurn: () => null,
    requestEndInput: vi.fn(),
    processStarted: () => started,
    processExit: () => observed,
    loopFinished,
    isLoopFinished: () => loopDone,
    now: () => clock,
    wait: async (ms: number) => { clock += ms; },
    ...overrides,
  };
  return {
    provider: createAcpDrainProvider(deps),
    deps,
    exit: (value: ObservedSdkExit) => { observed = value; },
    neverStarted: () => { started = false; },
    finishLoop,
  };
}

describe('ACP drain provider', () => {
  it('refuses to freeze a runtime that is not ready, and freezes input only once', () => {
    expect(fixture({ ready: () => false }).provider.freezeInputForShutdown()).toBe(false);
    const f = fixture();
    expect(f.provider.freezeInputForShutdown()).toBe(true);
    expect(f.deps.freezeInput).toHaveBeenCalledTimes(1);
    expect(f.provider.freezeInputForShutdown()).toBe(false);
  });

  it('cancels a running turn through the agent, and does nothing when idle', async () => {
    const interrupt = vi.fn(async () => undefined);
    await fixture({ activeTurn: () => ({ interrupt }) }).provider.interruptTurn();
    expect(interrupt).toHaveBeenCalledTimes(1);
    await expect(fixture().provider.interruptTurn()).resolves.toBeUndefined();
  });

  it('closes the agent input and reports the exit the backend saw', async () => {
    const f = fixture();
    const left = f.provider.endInputAndAwaitExit(5_000);
    f.exit({ code: 0, signal: null, forced: false });
    await expect(left).resolves.toEqual({ exited: true, code: 0, signal: null });
    expect(f.deps.requestEndInput).toHaveBeenCalledTimes(1);
  });

  it('reports a failed or killed agent as it was, never as clean', async () => {
    const failed = fixture();
    failed.exit({ code: 1, signal: null, forced: false });
    await expect(failed.provider.endInputAndAwaitExit(5_000)).resolves.toEqual({ exited: true, code: 1, signal: null });
    const killed = fixture();
    killed.exit({ code: 0, signal: null, forced: true });
    await expect(killed.provider.endInputAndAwaitExit(5_000)).resolves.toEqual({ exited: true, code: 0, signal: 'forced' });
  });

  it('counts a runtime that never started its agent as exited only once its loop is over', async () => {
    const f = fixture(); f.neverStarted();
    await expect(f.provider.endInputAndAwaitExit(1_000)).resolves.toEqual({ exited: false, code: null, signal: null });
    f.finishLoop();
    await expect(f.provider.endInputAndAwaitExit(1_000)).resolves.toEqual({ exited: true, code: 0, signal: null });
  });

  it('does not claim an exit it did not see before the budget ran out, or after an abort', async () => {
    await expect(fixture().provider.endInputAndAwaitExit(1_000)).resolves.toEqual({ exited: false, code: null, signal: null });
    const controller = new AbortController(); controller.abort();
    await expect(fixture().provider.endInputAndAwaitExit(5_000, controller.signal)).resolves.toEqual({ exited: false, code: null, signal: null });
  });

  it('waits for the runner loop to finish its writes before output counts as drained', async () => {
    const f = fixture();
    let drained = false;
    const done = f.provider.waitForOutputDrain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    f.finishLoop();
    await done;
    expect(drained).toBe(true);
  });
});
