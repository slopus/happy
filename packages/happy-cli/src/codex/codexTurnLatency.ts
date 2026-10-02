import type { CollectedBatch, QueueLatencyTrace } from '@/utils/MessageQueue2';

export type CodexLatencyStage = 'auth' | 'checkpoint' | 'mcp-sync' | 'thread-resume' | 'thread-start' | 'mcp-recovery' | 'mcp-status' | 'images' | 'lesson-recall' | 'lesson-proposal';
export type CodexLatencyPhase = 'received' | 'preparing' | 'submitted' | 'text' | 'completed' | 'failed' | 'cancelled' | 'control';
export type CodexTurnLatencyProgress = {
    version: 1; type: 'turn-latency-progress'; id: string;
    attribution: 'exclusive' | 'coalesced'; inputCount: number;
    queueMs: number | null; sdkSubmitMs: number | null; firstSdkTextMs: number | null;
    firstActivityMs: number | null; elapsedMs: number | null; phase: CodexLatencyPhase;
    preparation: Array<{ stage: CodexLatencyStage; startedMs: number | null; durationMs: number | null; outcome: 'pending' | 'resolved' | 'rejected' }>;
    droppedSpans: number; clockFailures: number;
    sequence: number;
};
type Recorder = {
    measure: <T>(stage: CodexLatencyStage, action: () => T | Promise<T>) => Promise<T>;
    steered: () => void; submitted: () => void; activity: () => void; text: (text: string) => void;
    finish: (phase: 'completed' | 'failed' | 'cancelled' | 'control') => void;
};
export type CodexTurnLatencyDiagnostic = {
    version: 1; type: 'turn-latency'; id: string;
    attribution: 'exclusive' | 'coalesced'; inputCount: number;
    queueMs: number; sdkSubmitMs: number; firstSdkTextMs: number | null; outcome: 'text' | 'no-text';
};

export function captureCodexLatencyTrace(
    marker: { id: string } | undefined,
    emit: (diagnostic: CodexTurnLatencyProgress) => void,
    now: () => number = () => performance.now(),
): QueueLatencyTrace | undefined {
    if (!marker) return undefined;
    let receivedAt: number;
    try { receivedAt = now(); if (!Number.isFinite(receivedAt)) return undefined; }
    catch { return undefined; /* A diagnostic clock never rejects the input. */ }
    try {
        emit({
            version: 1, type: 'turn-latency-progress', id: marker.id,
            attribution: 'exclusive', inputCount: 1, phase: 'received', sequence: 0,
            queueMs: null, sdkSubmitMs: null, firstActivityMs: null, firstSdkTextMs: null,
            elapsedMs: 0, preparation: [], droppedSpans: 0, clockFailures: 0,
        });
    } catch { /* A dropped receipt cannot block queueing the user message. */ }
    return { id: marker.id, receivedAt };
}

export function createCodexTurnLatency(
    batch: Pick<CollectedBatch<unknown>, 'inputCount' | 'latencyTraces'>,
    emit: (diagnostic: CodexTurnLatencyProgress | CodexTurnLatencyDiagnostic) => void,
    now: () => number = () => performance.now(),
): Recorder | null {
    if (batch.latencyTraces.length === 0) return null;
    let clockFailures = 0;
    const clock = (): number | null => {
        try { const value = now(); if (Number.isFinite(value)) return value; } catch { /* Diagnostics are optional. */ }
        clockFailures++;
        return null;
    };
    const elapsed = (start: number | null, end: number | null): number | null =>
        start === null || end === null || end < start || end - start > 600_000 ? null : end - start;
    const send = (frame: CodexTurnLatencyProgress | CodexTurnLatencyDiagnostic) => {
        try { emit(frame); } catch { /* Never change the provider's result or exception. */ }
    };
    const dequeuedAt = clock();
    const traces = batch.latencyTraces.slice(0, 10);
    const preparation: Array<{ stage: CodexLatencyStage; startedAt: number | null; durationMs: number | null; outcome: 'pending' | 'resolved' | 'rejected' }> = [];
    let phase: CodexLatencyPhase = 'preparing';
    let submittedAt: number | null = null;
    let activityAt: number | null = null;
    let textAt: number | null = null;
    let submitted = false;
    let activitySeen = false;
    let textSeen = false;
    let closed = false;
    let droppedSpans = 0;
    let sequence = 0;
    let inputCount = batch.inputCount;
    const progress = () => {
        const at = clock();
        sequence++;
        for (const trace of traces) send({
            version: 1, type: 'turn-latency-progress', id: trace.id,
            attribution: inputCount === 1 ? 'exclusive' : 'coalesced', inputCount,
            queueMs: elapsed(trace.receivedAt, dequeuedAt), sdkSubmitMs: elapsed(trace.receivedAt, submittedAt),
            firstActivityMs: elapsed(trace.receivedAt, activityAt), firstSdkTextMs: elapsed(trace.receivedAt, textAt),
            elapsedMs: elapsed(trace.receivedAt, at), phase,
            preparation: preparation.map(span => ({
                stage: span.stage, startedMs: elapsed(trace.receivedAt, span.startedAt),
                durationMs: span.durationMs, outcome: span.outcome,
            })),
            droppedSpans, clockFailures, sequence,
        });
    };
    progress();
    return {
        async measure<T>(stage: CodexLatencyStage, action: () => T | Promise<T>): Promise<T> {
            if (closed) return action();
            const start = clock();
            const span = { stage, startedAt: start, durationMs: null as number | null, outcome: 'pending' as 'pending' | 'resolved' | 'rejected' };
            if (preparation.length < 32) preparation.push(span);
            else droppedSpans++;
            progress();
            try { const result = await action(); span.outcome = 'resolved'; return result; }
            catch (error) { span.outcome = 'rejected'; throw error; }
            finally { span.durationMs = elapsed(start, clock()); if (!closed) progress(); }
        },
        steered() {
            if (closed) return;
            inputCount = Math.min(100, inputCount + 1);
            progress();
        },
        submitted() {
            if (closed || submitted) return;
            submitted = true; submittedAt = clock(); phase = 'submitted'; progress();
        },
        activity() {
            if (closed || !submitted || activitySeen) return;
            activitySeen = true; activityAt = clock(); progress();
        },
        text(text: string) {
            if (closed || !submitted || textSeen || !text.trim()) return;
            textSeen = true; textAt = clock();
            if (!activitySeen) { activitySeen = true; activityAt = textAt; }
            phase = 'text';
            // The provider event's ordinary preview must own the writable
            // socket first. Our volatile diagnostic may be dropped instead.
            queueMicrotask(() => { if (!closed) progress(); });
        },
        finish(terminal) {
            if (closed) return;
            phase = terminal; progress(); closed = true;
            if (terminal !== 'completed') return;
            for (const trace of traces) {
                const queueMs = elapsed(trace.receivedAt, dequeuedAt);
                const sdkSubmitMs = elapsed(trace.receivedAt, submittedAt);
                if (queueMs === null || sdkSubmitMs === null) continue;
                send({
                    version: 1, type: 'turn-latency', id: trace.id,
                    attribution: inputCount === 1 ? 'exclusive' : 'coalesced', inputCount,
                    queueMs, sdkSubmitMs, firstSdkTextMs: elapsed(trace.receivedAt, textAt), outcome: textSeen ? 'text' : 'no-text',
                });
            }
        },
    };
}
