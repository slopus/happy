import { recordToolTraceEvent } from '@/agent/tools/trace/toolTrace';
import type { RawJSONLines } from '@/backends/claude/types';

export function isToolTraceEnabled(): boolean {
    return (
        ['1', 'true', 'yes', 'on'].includes((process.env.HAPPY_STACKS_TOOL_TRACE ?? '').toLowerCase()) ||
        ['1', 'true', 'yes', 'on'].includes((process.env.HAPPY_LOCAL_TOOL_TRACE ?? '').toLowerCase()) ||
        ['1', 'true', 'yes', 'on'].includes((process.env.HAPPY_TOOL_TRACE ?? '').toLowerCase())
    );
}

export function recordClaudeToolTraceEvents(opts: { sessionId: string; body: RawJSONLines }): void {
    const redactClaudeToolPayload = (value: unknown, key?: string): unknown => {
        const REDACT_KEYS = new Set([
            'content',
            'text',
            'old_string',
            'new_string',
            'oldContent',
            'newContent',
        ]);

        if (typeof value === 'string') {
            if (key && REDACT_KEYS.has(key)) return `[redacted ${value.length} chars]`;
            if (value.length <= 1_000) return value;
            return `${value.slice(0, 1_000)}…(truncated ${value.length - 1_000} chars)`;
        }

        if (typeof value !== 'object' || value === null) return value;

        if (Array.isArray(value)) {
            const sliced = value.slice(0, 50).map((v) => redactClaudeToolPayload(v));
            if (value.length <= 50) return sliced;
            return [...sliced, `…(truncated ${value.length - 50} items)`];
        }

        const entries = Object.entries(value as Record<string, unknown>);
        const out: Record<string, unknown> = {};
        const sliced = entries.slice(0, 200);
        for (const [k, v] of sliced) out[k] = redactClaudeToolPayload(v, k);
        if (entries.length > 200) out._truncatedKeys = entries.length - 200;
        return out;
    };

    // Claude tool calls/results are embedded inside message.content[] (tool_use/tool_result).
    // Record only tool blocks (never user text).
    //
    // Note: tool_result blocks can appear in either assistant or user messages depending on Claude
    // control mode and SDK message routing. We key off the presence of structured blocks, not role.
    const contentBlocks = (opts.body as any)?.message?.content;
    if (Array.isArray(contentBlocks)) {
        for (const block of contentBlocks) {
            if (!block || typeof block !== 'object') continue;
            const type = (block as any)?.type;
            if (type === 'tool_use') {
                const id = (block as any)?.id;
                const name = (block as any)?.name;
                if (typeof id !== 'string' || typeof name !== 'string') continue;
                recordToolTraceEvent({
                    direction: 'outbound',
                    sessionId: opts.sessionId,
                    protocol: 'claude',
                    provider: 'claude',
                    kind: 'tool-call',
                    payload: {
                        type: 'tool_use',
                        id,
                        name,
                        input: redactClaudeToolPayload((block as any)?.input),
                    },
                });
            } else if (type === 'tool_result') {
                const toolUseId = (block as any)?.tool_use_id;
                if (typeof toolUseId !== 'string') continue;
                recordToolTraceEvent({
                    direction: 'outbound',
                    sessionId: opts.sessionId,
                    protocol: 'claude',
                    provider: 'claude',
                    kind: 'tool-result',
                    payload: {
                        type: 'tool_result',
                        tool_use_id: toolUseId,
                        content: redactClaudeToolPayload((block as any)?.content, 'content'),
                    },
                });
            }
        }
    }
}

export function recordCodexToolTraceEventIfNeeded(opts: { sessionId: string; body: any }): void {
    if (opts.body?.type !== 'tool-call' && opts.body?.type !== 'tool-call-result') return;

    recordToolTraceEvent({
        direction: 'outbound',
        sessionId: opts.sessionId,
        protocol: 'codex',
        provider: 'codex',
        kind: opts.body.type,
        payload: opts.body,
    });
}

export function recordAcpToolTraceEventIfNeeded(opts: {
    sessionId: string;
    provider: string;
    body: any;
    localId?: string;
}): void {
    if (
        opts.body?.type !== 'tool-call' &&
        opts.body?.type !== 'tool-result' &&
        opts.body?.type !== 'permission-request' &&
        opts.body?.type !== 'file-edit' &&
        opts.body?.type !== 'terminal-output'
    ) {
        return;
    }

    recordToolTraceEvent({
        direction: 'outbound',
        sessionId: opts.sessionId,
        protocol: 'acp',
        provider: opts.provider,
        kind: opts.body.type,
        payload: opts.body,
        localId: opts.localId,
    });
}
