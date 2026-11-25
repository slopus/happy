import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Model } from './codexAppServerTypes';
import { createCodexDelegationAbortHandler, createCodexDelegationPreparation, type CodexDelegationState } from './codexDelegationRpc';

const model = (code = 'gpt-observed', name = 'Observed Sol'): Model => ({ id: code, model: code, displayName: name,
    description: '', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }, { reasoningEffort: 'high', description: '' }],
    defaultReasoningEffort: 'medium', isDefault: true });
const request = { model: 'Sol', effort: 'high', permissionMode: 'read-only' };

describe('Codex delegated worker preparation', () => {
    let state: CodexDelegationState;
    let catalog: Model[] | null;
    let apply: ReturnType<typeof vi.fn>;
    beforeEach(() => {
        state = { metadata: { delegatedTask: { taskId: 'task', parentSessionId: 'parent' } }, applicationBound: false,
            thinking: false, pending: false, queueSize: 0, pendingUserInputs: false, activeRootTurnId: null, shouldExit: false };
        catalog = [model()]; apply = vi.fn(async () => {});
    });
    const prepare = () => createCodexDelegationPreparation({ state: () => state, catalog: () => catalog, apply });

    it('waits for the actual startup event and resolves only after the metadata acknowledgement', async () => {
        let acknowledge!: () => void;
        const metadataAck = new Promise<void>(resolve => { acknowledge = resolve; });
        apply.mockImplementation(async (_configuration, assertIdle) => { assertIdle(); await metadataAck; });
        const runtime = prepare();
        let resolved = false;
        const pending = runtime.prepare(request).then(result => { resolved = true; return result; });
        await Promise.resolve();
        expect(apply).not.toHaveBeenCalled();
        runtime.ready();
        await Promise.resolve();
        expect(apply).toHaveBeenCalledWith({ model: 'gpt-observed', effort: 'high', permissionMode: 'read-only' }, expect.any(Function));
        expect(resolved).toBe(false);
        acknowledge();
        expect(await pending).toEqual({ model: 'gpt-observed', effort: 'high' });
    });

    it('observes startup failure without callers and reports the same failure to late prepare requests', async () => {
        const runtime = prepare();
        const failure = new Error('Native thread failed to start');
        runtime.fail(failure);
        await expect(runtime.prepare(request)).rejects.toBe(failure);
        expect(apply).not.toHaveBeenCalled();
    });

    it('uses the actual startup model and current effort when both overrides are omitted', async () => {
        catalog = [model(), { ...model('gpt-configured', 'Configured Model'), isDefault: false }];
        const runtime = prepare();
        const pending = runtime.prepare({ permissionMode: 'read-only' });
        await Promise.resolve();
        expect(apply).not.toHaveBeenCalled();
        state.metadata = { ...state.metadata!, currentModelCode: 'gpt-configured', currentThoughtLevelCode: 'high' };
        runtime.ready();
        expect(await pending).toEqual({ model: 'gpt-configured', effort: 'high' });
        expect(apply).toHaveBeenCalledExactlyOnceWith({ model: 'gpt-configured', effort: 'high', permissionMode: 'read-only' }, expect.any(Function));
    });

    it('uses the selected native model default after a model switch instead of another model effort', async () => {
        state.metadata = { ...state.metadata!, currentModelCode: 'gpt-parent', currentThoughtLevelCode: 'ultra' };
        catalog = [model(), { ...model('gpt-parent', 'Parent'), supportedReasoningEfforts: [{ reasoningEffort: 'ultra', description: '' }], defaultReasoningEffort: 'ultra' }];
        const runtime = prepare(); runtime.ready();
        expect(await runtime.prepare({ model: 'Sol', permissionMode: 'read-only' })).toEqual({ model: 'gpt-observed', effort: 'medium' });
    });

    it('uses an advertised native default when the current model has no explicit current effort', async () => {
        state.metadata = { ...state.metadata!, currentModelCode: 'gpt-observed' };
        const runtime = prepare(); runtime.ready();
        expect(await runtime.prepare({ permissionMode: 'read-only' })).toEqual({ model: 'gpt-observed', effort: 'medium' });
    });

    it('never guesses a current model from the catalog default or an unobserved metadata label', async () => {
        const runtime = prepare(); runtime.ready();
        await expect(runtime.prepare({ permissionMode: 'read-only' })).rejects.toThrow('current native Codex model is unavailable');
        state.metadata = { ...state.metadata!, currentModelCode: 'Observed Sol' };
        await expect(runtime.prepare({ permissionMode: 'read-only' })).rejects.toThrow('current native Codex model is unavailable');
        expect(apply).not.toHaveBeenCalled();
    });

    it('resolves only unique observed effort codes or descriptions for the actual model', async () => {
        state.metadata = { ...state.metadata!, currentModelCode: 'gpt-observed' };
        catalog = [{ ...model(), supportedReasoningEfforts: [
            { reasoningEffort: 'medium', description: 'Balanced reasoning' }, { reasoningEffort: 'high', description: 'Deep reasoning' },
        ] }];
        const runtime = prepare(); runtime.ready();
        expect(await runtime.prepare({ effort: 'High', permissionMode: 'read-only' })).toEqual({ model: 'gpt-observed', effort: 'high' });
        expect(await runtime.prepare({ effort: 'Balanced Reasoning', permissionMode: 'read-only' })).toEqual({ model: 'gpt-observed', effort: 'medium' });
        apply.mockClear();
        catalog[0].supportedReasoningEfforts[1].description = 'Balanced reasoning';
        await expect(runtime.prepare({ effort: 'Balanced reasoning', permissionMode: 'read-only' })).rejects.toThrow('effort is ambiguous');
        await expect(runtime.prepare({ effort: 'ultra', permissionMode: 'read-only' })).rejects.toThrow('effort is unavailable');
        state.metadata.currentThoughtLevelCode = 'ultra';
        await expect(runtime.prepare({ permissionMode: 'read-only' })).rejects.toThrow('effort is unavailable');
        expect(apply).not.toHaveBeenCalled();
    });

    it('rejects an ambiguous native model label before applying any configuration', async () => {
        catalog = [model(), model('gpt-other', 'Other Sol')];
        const runtime = prepare(); runtime.ready();
        await expect(runtime.prepare(request)).rejects.toThrow('ambiguous');
        expect(apply).not.toHaveBeenCalled();
    });

    it.each([
        ['thinking', true], ['pending', true], ['queueSize', 1], ['pendingUserInputs', true], ['activeRootTurnId', 'unrelated-root'], ['shouldExit', true],
    ] as const)('rejects configuration while %s is present', async (key, value) => {
        const runtime = prepare(); runtime.ready();
        (state as any)[key] = value;
        await expect(runtime.prepare(request)).rejects.toThrow(/idle|stopping/);
        expect(apply).not.toHaveBeenCalled();
    });

    it('rejects ordinary, application-bound, and archived sessions', async () => {
        const runtime = prepare(); runtime.ready();
        state.metadata = {};
        await expect(runtime.prepare(request)).rejects.toThrow('Only a delegated');
        state.metadata = { delegatedTask: { taskId: 'task', parentSessionId: 'parent' }, application: { appId: 'app', bindingId: 'binding' } };
        await expect(runtime.prepare(request)).rejects.toThrow('Application-bound');
        delete state.metadata.application;
        state.metadata.lifecycleState = 'archiveRequested';
        await expect(runtime.prepare(request)).rejects.toThrow('stopping or archived');
        expect(apply).not.toHaveBeenCalled();
    });

    it('uses only native non-hidden models and their actually supported efforts', async () => {
        const runtime = prepare(); runtime.ready();
        catalog = null;
        await expect(runtime.prepare(request)).rejects.toThrow('catalog is unavailable');
        catalog = [{ ...model(), hidden: true }];
        await expect(runtime.prepare(request)).rejects.toThrow('catalog is unavailable');
        catalog = [model()];
        await expect(runtime.prepare({ ...request, model: 'Invented model' })).rejects.toThrow('unavailable');
        await expect(runtime.prepare({ ...request, effort: 'ultra' })).rejects.toThrow('effort is unavailable');
        catalog = [{ ...model(), supportedReasoningEfforts: [{ reasoningEffort: 'high', description: '' }] }];
        await expect(runtime.prepare({ ...request, effort: '!!!' })).rejects.toThrow('effort is unavailable');
        catalog = [model()];
        await expect(runtime.prepare({ ...request, permissionMode: 'not-a-mode' })).rejects.toThrow();
        expect(apply).not.toHaveBeenCalled();
        expect(await runtime.prepare({ model: 'gpt-observed', permissionMode: 'read-only' })).toEqual({ model: 'gpt-observed', effort: 'medium' });
    });

    it('rechecks pending input after startup and after an in-flight metadata write', async () => {
        const runtime = prepare();
        const startupPending = runtime.prepare(request);
        state.pendingUserInputs = true;
        runtime.ready();
        await expect(startupPending).rejects.toThrow('idle');
        state.pendingUserInputs = false;
        apply.mockImplementation(async () => { state.pendingUserInputs = true; });
        await expect(runtime.prepare(request)).rejects.toThrow('idle');
    });

    it('does not acknowledge concurrent preparations or failed metadata writes', async () => {
        let rejectWrite!: (error: Error) => void;
        apply.mockImplementation(() => new Promise<void>((_resolve, reject) => { rejectWrite = reject; }));
        const runtime = prepare(); runtime.ready();
        const pending = runtime.prepare(request);
        await Promise.resolve();
        await expect(runtime.prepare(request)).rejects.toThrow('already in progress');
        const failure = new Error('Metadata CAS failed');
        rejectWrite(failure);
        await expect(pending).rejects.toBe(failure);
    });
});

describe('Codex delegated input cancellation', () => {
    const setup = () => {
        const dependencies = { binding: () => ({ taskId: 'task' }), removeQueued: vi.fn(() => false), acknowledgeQueued: vi.fn(),
            currentRootTurnId: vi.fn(() => 'root'), isCurrentRootTurnInput: vi.fn(() => true), abortStrict: vi.fn(async () => {}) };
        return { ...dependencies, handle: createCodexDelegationAbortHandler(dependencies) };
    };
    const localId = 'delegation:task:version-1';
    it('removes and acknowledges the exact queued message even when another root is active', async () => {
        const runtime = setup(); runtime.removeQueued.mockReturnValue(true);
        expect(await runtime.handle({ localId })).toEqual({ queuedCancelled: true });
        expect(runtime.acknowledgeQueued).toHaveBeenCalledExactlyOnceWith(localId);
        expect(runtime.currentRootTurnId).not.toHaveBeenCalled();
        expect(runtime.abortStrict).not.toHaveBeenCalled();
    });
    it('refuses another task, a changed root, and a local input not bound to that root', async () => {
        const runtime = setup();
        await expect(runtime.handle({ localId: 'delegation:other:1', expectedTurnId: 'root' })).rejects.toThrow('does not own');
        await expect(runtime.handle({ localId, expectedTurnId: 'old-root' })).rejects.toThrow('not queued or bound');
        runtime.isCurrentRootTurnInput.mockReturnValue(false);
        await expect(runtime.handle({ localId, expectedTurnId: 'root' })).rejects.toThrow('not queued or bound');
        expect(runtime.abortStrict).not.toHaveBeenCalled();
    });
    it('returns a native interruption failure instead of acknowledging cancellation', async () => {
        const runtime = setup(); const failure = new Error('Native interrupt failed');
        runtime.abortStrict.mockRejectedValue(failure);
        await expect(runtime.handle({ localId, expectedTurnId: 'root' })).rejects.toBe(failure);
        expect(runtime.isCurrentRootTurnInput).toHaveBeenCalledWith('root', localId);
        expect(runtime.acknowledgeQueued).not.toHaveBeenCalled();
    });
});
