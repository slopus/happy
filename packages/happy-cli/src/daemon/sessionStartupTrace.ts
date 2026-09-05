import { logger } from '@/ui/logger';

const STARTUP_TRACE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type DaemonStartupTraceContext = {
    traceId: string;
    startedAt: number;
    machineId?: string;
};

type DaemonStartupStage = 'daemon.spawn.child_started' | 'daemon.spawn.webhook_received';
export type StartupTraceWriter = (label: string, event: Record<string, unknown>) => void;

const defaultWriter: StartupTraceWriter = (label, event) => logger.debug(label, event);

export function validStartupTraceId(value: unknown): string | undefined {
    return typeof value === 'string' && STARTUP_TRACE_ID_RE.test(value) ? value : undefined;
}

export function createDaemonStartupTraceContext(
    options: { traceId?: unknown; machineId?: unknown },
    now: () => number = Date.now,
): DaemonStartupTraceContext | undefined {
    const traceId = validStartupTraceId(options.traceId);
    if (!traceId) return undefined;
    return {
        traceId,
        startedAt: now(),
        ...(typeof options.machineId === 'string' && options.machineId.length > 0
            ? { machineId: options.machineId }
            : {}),
    };
}

export function buildSessionWorkerEnvironment(
    baseEnv: NodeJS.ProcessEnv,
    callerEnv: Record<string, string | undefined>,
    traceId?: unknown,
): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = { ...baseEnv, ...callerEnv };
    delete environment.HAPPY_SESSION_STARTUP_TRACE_ID;
    const validatedTraceId = validStartupTraceId(traceId);
    if (validatedTraceId) environment.HAPPY_SESSION_STARTUP_TRACE_ID = validatedTraceId;
    return environment;
}

export function logDaemonStartupStage(
    trace: DaemonStartupTraceContext | undefined,
    stage: DaemonStartupStage,
    options: { outcome: 'success' | 'error'; sessionId?: string; errorCode?: string },
    write: StartupTraceWriter = defaultWriter,
    now: () => number = Date.now,
): void {
    if (!trace) return;
    try {
        const timestamp = now();
        write('[SESSION STARTUP]', {
            traceId: trace.traceId,
            stage,
            timestamp,
            duration: timestamp - trace.startedAt,
            outcome: options.outcome,
            ...(options.sessionId ? { sessionId: options.sessionId } : {}),
            ...(trace.machineId ? { machineId: trace.machineId } : {}),
            ...(options.errorCode ? { errorCode: options.errorCode } : {}),
        });
    } catch {
        // Startup telemetry is best-effort and must never affect daemon control flow.
    }
}

export class DaemonStartupTraceRegistry {
    private readonly traces = new Map<number, DaemonStartupTraceContext>();

    constructor(
        private readonly write: StartupTraceWriter = defaultWriter,
        private readonly now: () => number = Date.now,
    ) {}

    get size(): number {
        return this.traces.size;
    }

    associate(pid: number, trace: DaemonStartupTraceContext): void {
        this.traces.set(pid, trace);
    }

    webhookReceived(pid: number, sessionId: string): boolean {
        const trace = this.traces.get(pid);
        if (!trace || typeof sessionId !== 'string' || sessionId.trim().length === 0) return false;
        this.traces.delete(pid);
        logDaemonStartupStage(
            trace,
            'daemon.spawn.webhook_received',
            { outcome: 'success', sessionId },
            this.write,
            this.now,
        );
        return true;
    }

    delete(pid: number): void {
        this.traces.delete(pid);
    }
}
