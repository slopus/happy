import { z } from 'zod';
import type { Metadata, PermissionMode } from '@/api/types';
import { resolveDelegationModel } from '@/daemon/delegationModel';
import type { Model, ReasoningEffort } from './codexAppServerTypes';
import { isRemoteCodexPermissionMode } from './executionPolicy';
import { isReasoningEffort } from './reasoningEffort';

const requestSchema = z.object({
    model: z.string().trim().min(1).max(256).optional(),
    effort: z.string().trim().min(1).max(100).optional(),
    permissionMode: z.string().refine(isRemoteCodexPermissionMode, 'Unsupported Codex permission mode'),
}).strict();

export type PreparedCodexDelegation = { model: string; effort?: ReasoningEffort; permissionMode: PermissionMode };
export type CodexDelegationState = {
    metadata: Pick<Metadata, 'delegatedTask' | 'application' | 'lifecycleState' | 'currentModelCode' | 'currentThoughtLevelCode'> | null;
    applicationBound: boolean;
    thinking: boolean;
    pending: boolean;
    queueSize: number;
    pendingUserInputs: boolean;
    activeRootTurnId: string | null;
    shouldExit: boolean;
};

function resolveNativeEffort(requested: string, model: Model): ReasoningEffort {
    const normalized = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const label = normalized(requested);
    if (!label) throw new Error(`Reasoning effort is unavailable for this Codex model: ${requested}`);
    const exact = model.supportedReasoningEfforts.filter(option => option.reasoningEffort === requested);
    const matches = exact.length ? exact : model.supportedReasoningEfforts.filter(option =>
        normalized(option.reasoningEffort) === label || normalized(option.description) === label);
    const efforts = [...new Set(matches.map(option => option.reasoningEffort))];
    if (efforts.length === 1 && isReasoningEffort(efforts[0])) return efforts[0];
    throw new Error(efforts.length > 1 ? `Reasoning effort is ambiguous: ${requested}` : `Reasoning effort is unavailable for this Codex model: ${requested}`);
}

/** One startup event, never a status-query loop. Failure is observed even without callers. */
export function createCodexDelegationPreparation(deps: {
    state(): CodexDelegationState;
    catalog(): Model[] | null;
    apply(configuration: PreparedCodexDelegation, assertIdle: () => void): Promise<void>;
}) {
    let readyResolve!: () => void;
    let readyReject!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    void ready.catch(() => {});
    let preparing = false;
    function assertOwned() {
        const state = deps.state();
        if (!state.metadata?.delegatedTask) throw new Error('Only a delegated task worker can prepare delegation');
        if (state.applicationBound || state.metadata.application) throw new Error('Application-bound sessions cannot prepare delegation');
        if (state.shouldExit || ['archived', 'archiveRequested'].includes(state.metadata.lifecycleState ?? '')) throw new Error('Delegated worker is stopping or archived');
        return state;
    }
    function assertIdle() {
        const state = assertOwned();
        if (state.thinking || state.pending || state.queueSize > 0 || state.pendingUserInputs || state.activeRootTurnId) {
            throw new Error('Delegated worker must be idle before changing its model');
        }
    }
    return {
        ready: () => readyResolve(),
        fail: (error: unknown) => readyReject(error),
        async prepare(input: unknown): Promise<{ model: string; effort?: ReasoningEffort }> {
            const request = requestSchema.parse(input);
            assertOwned();
            await ready;
            if (preparing) throw new Error('A delegated model preparation is already in progress');
            preparing = true;
            try {
                assertIdle();
                const models = deps.catalog()?.filter(model => !model.hidden) ?? [];
                if (!models.length) throw new Error('The native Codex model catalog is unavailable');
                // Readiness follows native thread startup, which publishes these actual settings.
                const current = deps.state().metadata;
                const currentModel = current?.currentModelCode;
                if (request.model === undefined && (!currentModel || !models.some(model => model.model === currentModel))) {
                    throw new Error('The current native Codex model is unavailable');
                }
                const selected = resolveDelegationModel(request.model ?? currentModel!, models.map(model => ({
                    code: model.model, name: model.displayName || model.model,
                    efforts: model.supportedReasoningEfforts.map(option => option.reasoningEffort),
                })));
                const model = models.find(model => model.model === selected.code)!;
                const effort = request.effort === undefined
                    ? (model.model === currentModel ? current?.currentThoughtLevelCode ?? model.defaultReasoningEffort : model.defaultReasoningEffort)
                    : resolveNativeEffort(request.effort, model);
                if (!isReasoningEffort(effort) || !model.supportedReasoningEfforts.some(option => option.reasoningEffort === effort)) {
                    throw new Error(`Reasoning effort is unavailable for this Codex model: ${effort}`);
                }
                await deps.apply({ model: model.model, effort, permissionMode: request.permissionMode as PermissionMode }, assertIdle);
                assertIdle();
                return { model: model.model, effort };
            } finally { preparing = false; }
        },
    };
}

/** Exact queued input removal takes precedence over an unrelated active root. */
export function createCodexDelegationAbortHandler(deps: {
    binding(): { taskId: string } | undefined;
    removeQueued(localId: string): boolean;
    acknowledgeQueued(localId: string): void;
    currentRootTurnId(): string | null;
    isCurrentRootTurnInput(turnId: string, localId: string): boolean;
    abortStrict(): Promise<void>;
}) {
    return async (input: { expectedTurnId?: string; localId?: string }) => {
        const binding = deps.binding();
        if (!binding || typeof input?.localId !== 'string' || !input.localId.startsWith(`delegation:${binding.taskId}:`)) {
            throw new Error('Delegated task does not own this session input');
        }
        if (deps.removeQueued(input.localId)) {
            deps.acknowledgeQueued(input.localId);
            return { queuedCancelled: true };
        }
        const current = deps.currentRootTurnId();
        if (!current || input.expectedTurnId !== current || !deps.isCurrentRootTurnInput(current, input.localId)) {
            throw new Error('Delegated input is not queued or bound to the current root turn');
        }
        await deps.abortStrict();
        return { queuedCancelled: false };
    };
}
