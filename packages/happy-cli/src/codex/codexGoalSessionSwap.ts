import type { AgentState, Metadata } from '@/api/types';
import type { CodexGoalProjection } from './codexGoalStatus';
import { shouldApplyCodexGoalStatusV2 } from './codexGoalStatus';

type GoalActionRpcHandler = (params: Record<string, unknown>) => Promise<{ ok: true }>;

type CodexSessionSwapTarget = {
    updateAgentState: (handler: (currentState: AgentState) => AgentState) => void;
    updateMetadata: (handler: (currentMetadata: Metadata) => Metadata) => void;
    rpcHandlerManager: {
        registerHandler: (method: string, handler: GoalActionRpcHandler) => void;
    };
};

export function syncCodexSessionAfterSwap(opts: {
    session: CodexSessionSwapTarget;
    projection?: CodexGoalProjection;
    goalActionRpcHandler?: GoalActionRpcHandler;
    threadId: string | null;
}): void {
    if (opts.projection) {
        const projection = opts.projection;
        opts.session.updateAgentState((currentState) => {
            if (!shouldApplyCodexGoalStatusV2(currentState.agentGoalStatusV2, projection.detailed)) {
                return currentState;
            }
            return {
                ...currentState,
                agentGoalStatus: projection.legacy,
                agentGoalStatusV2: projection.detailed,
            };
        });
    }

    if (opts.goalActionRpcHandler) {
        opts.session.rpcHandlerManager.registerHandler('goal-action', opts.goalActionRpcHandler);
    }

    opts.session.updateMetadata((currentMetadata) => {
        if (opts.threadId) {
            return { ...currentMetadata, codexThreadId: opts.threadId };
        }
        const nextMetadata = { ...currentMetadata };
        delete nextMetadata.codexThreadId;
        return nextMetadata;
    });
}
