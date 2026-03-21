import { ToolCall } from '@/sync/typesMessage';

type ShouldShowOrchestratorSubmitActivityIndicatorArgs = {
    toolName: string;
    toolState: ToolCall['state'];
    hasSessionId: boolean;
    runningTaskCount: number;
    noStatus: boolean;
};

export function shouldShowOrchestratorSubmitActivityIndicator(
    args: ShouldShowOrchestratorSubmitActivityIndicatorArgs,
): boolean {
    return (
        args.toolName.includes('orchestrator_submit') &&
        args.toolState === 'completed' &&
        args.hasSessionId &&
        args.runningTaskCount > 0 &&
        !args.noStatus
    );
}
