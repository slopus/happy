import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configuration } from '@/configuration';

export type ToolTraceProtocol = 'acp' | 'codex' | 'cloud' | 'claude';

export type ToolTraceDirection = 'outbound' | 'inbound';

export type ToolTraceEventV1 = {
    v: 1;
    ts: number;
    direction: ToolTraceDirection;
    sessionId: string;
    protocol: ToolTraceProtocol;
    provider?: string;
    kind: string;
    payload: unknown;
    localId?: string;
};

export class ToolTraceWriter {
    private readonly filePath: string;

    constructor(params: { filePath: string }) {
        this.filePath = params.filePath;
        mkdirSync(dirname(this.filePath), { recursive: true });
    }

    record(event: ToolTraceEventV1): void {
        appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, 'utf8');
    }
}

function isTruthyEnv(value: string | undefined): boolean {
    if (!value) return false;
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function resolveToolTraceFilePath(): string {
    const fileFromEnv =
        process.env.HAPPY_STACKS_TOOL_TRACE_FILE ??
        process.env.HAPPY_LOCAL_TOOL_TRACE_FILE ??
        process.env.HAPPY_TOOL_TRACE_FILE;
    if (typeof fileFromEnv === 'string' && fileFromEnv.length > 0) return fileFromEnv;

    const dirFromEnv =
        process.env.HAPPY_STACKS_TOOL_TRACE_DIR ??
        process.env.HAPPY_LOCAL_TOOL_TRACE_DIR ??
        process.env.HAPPY_TOOL_TRACE_DIR;
    const dir =
        typeof dirFromEnv === 'string' && dirFromEnv.length > 0
            ? dirFromEnv
            : join(configuration.happyHomeDir, 'tool-traces');

    if (cachedDefaultTraceFilePath && cachedDefaultTraceDir === dir) return cachedDefaultTraceFilePath;

    const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
    cachedDefaultTraceDir = dir;
    cachedDefaultTraceFilePath = join(dir, `${stamp}-pid-${process.pid}.jsonl`);
    return cachedDefaultTraceFilePath;
}

function isToolTraceEnabled(): boolean {
    return (
        isTruthyEnv(process.env.HAPPY_STACKS_TOOL_TRACE) ||
        isTruthyEnv(process.env.HAPPY_LOCAL_TOOL_TRACE) ||
        isTruthyEnv(process.env.HAPPY_TOOL_TRACE)
    );
}

let cachedWriter: ToolTraceWriter | null = null;
let cachedFilePath: string | null = null;
let cachedDefaultTraceFilePath: string | null = null;
let cachedDefaultTraceDir: string | null = null;

export function recordToolTraceEvent(params: Omit<ToolTraceEventV1, 'v' | 'ts'> & { ts?: number }): void {
    if (!isToolTraceEnabled()) return;

    const filePath = resolveToolTraceFilePath();
    if (!cachedWriter || cachedFilePath !== filePath) {
        cachedFilePath = filePath;
        cachedWriter = new ToolTraceWriter({ filePath });
    }

    cachedWriter.record({
        v: 1,
        ts: typeof params.ts === 'number' ? params.ts : Date.now(),
        direction: params.direction,
        sessionId: params.sessionId,
        protocol: params.protocol,
        provider: params.provider,
        kind: params.kind,
        payload: params.payload,
        localId: params.localId,
    });
}

export function __resetToolTraceForTests(): void {
    cachedWriter = null;
    cachedFilePath = null;
    cachedDefaultTraceFilePath = null;
    cachedDefaultTraceDir = null;
}
