import { ToolCall } from '@/sync/typesMessage';

type ShouldShowOrchestratorSubmitActivityIndicatorArgs = {
    toolName: string;
    toolState: ToolCall['state'];
    hasSessionId: boolean;
    noStatus: boolean;
    isMatchingOrchestratorSubmitRunId: boolean;
};

export function shouldShowOrchestratorSubmitActivityIndicator(
    args: ShouldShowOrchestratorSubmitActivityIndicatorArgs,
): boolean {
    return (
        args.toolName.includes('orchestrator_submit') &&
        args.toolState === 'completed' &&
        args.hasSessionId &&
        args.isMatchingOrchestratorSubmitRunId &&
        !args.noStatus
    );
}
