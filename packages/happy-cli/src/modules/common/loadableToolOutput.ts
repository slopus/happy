import { saveToolOutputRecord } from './toolOutputStore';

export type ToolOutputAgent = 'claude' | 'codex' | 'gemini';
export type ToolResultKind = 'command' | 'structured' | 'text';

interface CreateLoadableToolOutputOptions {
    sessionId: string;
    callId: string;
    toolName: string;
    agent: ToolOutputAgent;
    result: unknown;
    kind: ToolResultKind;
    summary?: Record<string, unknown>;
    persist?: boolean;
}

interface SummarizeBashToolOutputOptions {
    sessionId: string;
    callId: string;
    toolName: 'CodexBash' | 'GeminiBash';
    agent: 'codex' | 'gemini';
    result: unknown;
    persist?: boolean;
}

export function createLoadableToolOutput(options: CreateLoadableToolOutputOptions): Record<string, unknown> {
    if (options.persist !== false) {
        saveToolOutputRecord(options.sessionId, {
            callId: options.callId,
            toolName: options.toolName,
            agent: options.agent,
            result: options.result,
            timestamp: Date.now(),
        });
    }

    return {
        ...(options.summary || {}),
        _outputTrimmed: true,
        _callId: options.callId,
        _toolResultKind: options.kind,
    };
}

export function summarizeBashToolOutput(options: SummarizeBashToolOutputOptions): Record<string, unknown> {
    const result = options.result as Record<string, unknown> | null;
    return createLoadableToolOutput({
        sessionId: options.sessionId,
        callId: options.callId,
        toolName: options.toolName,
        agent: options.agent,
        result: options.result,
        kind: 'command',
        persist: options.persist,
        summary: {
            exit_code: typeof result?.exit_code === 'number' ? result.exit_code : 0,
        },
    });
}
