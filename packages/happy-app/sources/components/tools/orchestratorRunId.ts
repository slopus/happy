import { ToolCall } from '@/sync/typesMessage';
import { parseMcpResult } from './parseMcpResult';

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

export function extractOrchestratorSubmitRunId(tool: ToolCall): string | null {
    if (!tool.name.includes('orchestrator_submit')) {
        return null;
    }

    const parsed = parseMcpResult(tool.result);
    const obj = parsed && typeof parsed === 'object' ? parsed as Record<string, any> : null;

    return (
        asString(obj?.runId)
        ?? asString(obj?.data?.runId)
        ?? asString(obj?.run?.runId)
        ?? asString(obj?.data?.run?.runId)
        ?? asString(obj?.submit?.runId)
        ?? asString(obj?.blocking?.run?.runId)
        ?? null
    );
}
