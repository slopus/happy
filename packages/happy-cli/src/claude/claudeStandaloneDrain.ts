import type { RuntimeProducerGate } from '@/sessionDrain/runtimeProducerGate';
import type { ProviderExitObserver } from '@/managed/managedProviderExitObserver';
import type { ClaudeDrainDeps } from './claudeDrainProvider';

/** What the Claude remote launcher's message loop offers the drain once it runs. */
export type ClaudeLauncherDrainPort = {
    /** Graceful stop: end the SDK input at the next turn boundary. */
    requestEndInput: () => void;
    /** Rejects permission prompts still waiting, so a turn cannot hang on one. */
    cancelPendingPermissions: () => void;
    /** The current provider generation's exit observer; `null` before any SDK process started. */
    generation: () => ProviderExitObserver | null;
    /** A batch the loop took off the queue but held back for the next generation (mode change). */
    hasHeldBackInput: () => boolean;
};

/**
 * Joins `runClaude` (which owns the runtime gate and the launch control) and the
 * remote launcher (which owns the message loop) for one standalone Windows launch
 * (Desktop specs/windows-build-support W0-5c).
 */
export class ClaudeStandaloneDrain {
    private launcher: ClaudeLauncherDrainPort | null = null;
    private query: { interrupt: () => Promise<unknown> } | null = null;
    private turnRunning = false;
    private finished = false;
    private settleLoop!: () => void;
    private readonly loopFinished = new Promise<void>((resolve) => { this.settleLoop = resolve; });

    constructor(readonly gate: RuntimeProducerGate) {}

    /** The launcher's loop may start again (a relaunch); the latest one answers. */
    attachLauncher(port: ClaudeLauncherDrainPort): void { this.launcher = port; }

    /** The SDK query of the current generation, or `null` once it is gone. */
    setQuery(query: { interrupt: () => Promise<unknown> } | null): void { this.query = query; }

    /** A batch is being taken for a turn; refused once input is closed. */
    claimTurn(): boolean { return this.gate.tryBeginPreparing(); }
    /** The batch was handed to the SDK. */
    dispatched(): void {
        // A kill may have closed input after the claim; the kill path ends this turn anyway.
        if (!this.gate.isClosed()) this.gate.markDispatched();
        this.turnRunning = true;
    }
    /** The turn's result arrived, or its generation ended. */
    turnEnded(): void { this.turnRunning = false; this.gate.endTurn(); }
    /** A claimed batch was held back (mode change) instead of dispatched. */
    releaseClaim(): void { if (!this.turnRunning) this.gate.endTurn(); }

    /** Input the launcher holds outside the queue; the drain refuses while there is any. */
    hasHeldBackInput(): boolean { return this.launcher?.hasHeldBackInput() ?? false; }

    /** After the loop's last write. */
    markLoopFinished(): void {
        if (this.finished) return;
        this.finished = true;
        this.settleLoop();
    }

    providerDeps(): Omit<ClaudeDrainDeps, 'wait' | 'now'> {
        return {
            ready: () => this.launcher !== null && !this.finished,
            freezeInput: () => { this.launcher?.cancelPendingPermissions(); },
            activeTurn: () => (this.turnRunning ? this.query : null),
            requestEndInput: () => { this.launcher?.requestEndInput(); },
            // The launcher stays reachable after its loop ends: the last generation's
            // exit must still be read from it, never mistaken for "no provider".
            generation: () => this.launcher?.generation() ?? null,
            loopFinished: this.loopFinished,
            isLoopFinished: () => this.finished,
        };
    }
}
