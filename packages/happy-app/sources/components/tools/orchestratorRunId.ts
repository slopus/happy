import { ToolCall } from '@/sync/typesMessage';

function parseToolResult(result: unknown): any {
    let text: string | null = null;

    if (Array.isArray(result)) {
        const first = result[0];
        if (first && typeof first === 'object' && 'text' in first && typeof first.text === 'string') {
            text = first.text;
        }
    } else if (typeof result === 'string') {
        text = result;
    }

    if (!text) return result;

    try {
        return JSON.parse(text);
    } catch {
        return result;
    }
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

export function extractOrchestratorSubmitRunId(tool: ToolCall): string | null {
    if (!tool.name.includes('orchestrator_submit')) {
        return null;
    }

    const parsed = parseToolResult(tool.result);
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
