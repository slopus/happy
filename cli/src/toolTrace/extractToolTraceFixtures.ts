import type { ToolTraceEventV1 } from './toolTrace';

export type ToolTraceFixturesV1 = {
    v: 1;
    generatedAt: number;
    examples: Record<string, ToolTraceEventV1[]>;
};

function isRecordableKind(kind: string): boolean {
    return (
        kind === 'tool-call' ||
        kind === 'tool-result' ||
        kind === 'tool-call-result' ||
        kind === 'permission-request' ||
        kind === 'file-edit' ||
        kind === 'terminal-output'
    );
}

function getToolNameForKey(event: ToolTraceEventV1): string | null {
    if (event.kind === 'tool-call') {
        const payload = event.payload as any;
        const name = payload?.name;
        return typeof name === 'string' && name.length > 0 ? name : null;
    }
    if (event.kind === 'permission-request') {
        const payload = event.payload as any;
        const toolName = payload?.toolName;
        return typeof toolName === 'string' && toolName.length > 0 ? toolName : null;
    }
    return null;
}

function truncateDeep(value: unknown, opts?: { maxString?: number; maxArray?: number; maxObjectKeys?: number }): unknown {
    const maxString = opts?.maxString ?? 2_000;
    const maxArray = opts?.maxArray ?? 50;
    const maxObjectKeys = opts?.maxObjectKeys ?? 200;

    if (typeof value === 'string') {
        if (value.length <= maxString) return value;
        return `${value.slice(0, maxString)}…(truncated ${value.length - maxString} chars)`;
    }

    if (typeof value !== 'object' || value === null) return value;

    if (Array.isArray(value)) {
        const sliced = value.slice(0, maxArray).map((v) => truncateDeep(v, opts));
        if (value.length <= maxArray) return sliced;
        return [...sliced, `…(truncated ${value.length - maxArray} items)`];
    }

    const entries = Object.entries(value as Record<string, unknown>);
    const sliced = entries.slice(0, maxObjectKeys);
    const out: Record<string, unknown> = {};
    for (const [k, v] of sliced) out[k] = truncateDeep(v, opts);
    if (entries.length > maxObjectKeys) out._truncatedKeys = entries.length - maxObjectKeys;
    return out;
}

function sanitizeEventForFixture(event: ToolTraceEventV1): ToolTraceEventV1 {
    return {
        ...event,
        payload: truncateDeep(event.payload),
    };
}

export function extractToolTraceFixturesFromJsonlLines(lines: string[]): ToolTraceFixturesV1 {
    const examples: Record<string, ToolTraceEventV1[]> = {};

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;

        let parsed: unknown;
        try {
            parsed = JSON.parse(trimmed);
        } catch {
            continue;
        }

        const event = parsed as Partial<ToolTraceEventV1>;
        if (event?.v !== 1) continue;
        if (typeof event.kind !== 'string' || typeof event.protocol !== 'string') continue;
        if (!isRecordableKind(event.kind)) continue;

        const provider = typeof event.provider === 'string' && event.provider.length > 0 ? event.provider : 'unknown';
        const baseKey = `${event.protocol}/${provider}/${event.kind}`;
        const toolName = getToolNameForKey(event as ToolTraceEventV1);
        const key = toolName ? `${baseKey}/${toolName}` : baseKey;

        const current = examples[key] ?? [];
        if (current.length >= 3) continue;
        current.push(sanitizeEventForFixture(event as ToolTraceEventV1));
        examples[key] = current;
    }

    return {
        v: 1,
        generatedAt: Date.now(),
        examples,
    };
}

