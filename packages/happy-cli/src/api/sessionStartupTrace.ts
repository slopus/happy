import { logger } from '@/ui/logger';

const SESSION_STARTUP_TRACE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type StartupTraceWriter = (label: string, event: Record<string, unknown>) => void;

const defaultWriter: StartupTraceWriter = (label, event) => logger.debug(label, event);

function runtimeSessionId(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export class WorkerSessionStartupLifecycle {
    private readonly traceId: string | undefined;
    private boundSessionId: string | undefined;
    private socketReadyLogged = false;

    constructor(
        traceId: unknown,
        private readonly write: StartupTraceWriter = defaultWriter,
        private readonly now: () => number = Date.now,
    ) {
        this.traceId = typeof traceId === 'string' && SESSION_STARTUP_TRACE_ID_RE.test(traceId)
            ? traceId
            : undefined;
    }

    bindCreatedSession(sessionId: unknown, machineId?: string): boolean {
        const validSessionId = runtimeSessionId(sessionId);
        if (!this.traceId || !validSessionId) return false;
        if (this.boundSessionId) return this.boundSessionId === validSessionId;

        this.boundSessionId = validSessionId;
        this.log({
            traceId: this.traceId,
            stage: 'worker.session.created',
            timestamp: this.now(),
            outcome: 'success',
            sessionId: validSessionId,
            ...(machineId ? { machineId } : {}),
        });
        return true;
    }

    socketReady(sessionId: unknown, machineId?: string): boolean {
        const validSessionId = runtimeSessionId(sessionId);
        if (
            !this.traceId
            || !validSessionId
            || validSessionId !== this.boundSessionId
            || this.socketReadyLogged
        ) return false;

        this.socketReadyLogged = true;
        this.log({
            traceId: this.traceId,
            stage: 'worker.socket.ready',
            timestamp: this.now(),
            outcome: 'success',
            sessionId: validSessionId,
            ...(machineId ? { machineId } : {}),
        });
        return true;
    }

    private log(event: Record<string, unknown>): void {
        try {
            this.write('[SESSION STARTUP]', event);
        } catch {
            // Startup telemetry is best-effort and must never affect worker control flow.
        }
    }
}
