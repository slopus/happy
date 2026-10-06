import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { parseRpcLatencyRequest } from '@slopus/happy-wire';

type Correlation = { rpcId: string; lookupId: string };
type Observation = Correlation & { at: number; stages: Set<string> };
type Message = { type: number; uid?: string; data?: { requestId?: string; rpcPeer?: Correlation; [key: string]: unknown } };
type Adapter = { uid: string; doPublish: (message: any) => Promise<string>; onMessage: (message: any, ...args: any[]) => any; onRawMessage?: (message: any, ...args: any[]) => any; close: () => void };
const scope = new AsyncLocalStorage<Correlation>();
const enabled = () => process.env.HAPPY_RPC_PEER_DIAGNOSTICS === '1';
const validId = (id: unknown) => !!parseRpcLatencyRequest({ version: 1, id });

// Called only after the existing native RPC diagnostic opt-in/rate gate.
export function withRpcPeerDiagnostics<T>(id: string | undefined, operation: () => T): T {
    if (!enabled() || !validId(id)) return operation();
    let correlation: Correlation;
    try { correlation = { rpcId: id!, lookupId: randomUUID() }; }
    catch { return operation(); }
    return scope.run(correlation, operation);
}

/** Internal Redis-stream metadata only; never authorization or a routing decision. */
export function installRpcPeerDiagnostics(target: object, report: (row: Correlation & { stage: string; elapsedMs: number }) => void): void {
    // Pinned redis-streams-adapter 0.2.3 exposes these protected hooks at runtime.
    const adapter = target as Adapter;
    if (typeof adapter.doPublish !== 'function' || typeof adapter.onMessage !== 'function' || typeof adapter.close !== 'function') return;
    const observations = new Map<string, Observation>();
    let windowStart = performance.now(), count = 0, closed = false;
    const publish = adapter.doPublish.bind(adapter), consume = adapter.onMessage.bind(adapter), rawMessage = typeof adapter.onRawMessage === 'function' ? adapter.onRawMessage.bind(adapter) : undefined, close = adapter.close.bind(adapter);
    let rawStartedAt: number | undefined;
    const prune = () => { const now = performance.now(); for (const [key, value] of observations) if (now - value.at >= 60_000) observations.delete(key); };
    // No timer when diagnostics are unused; bounded entries expire on next use or close.
    const remember = (key: string, correlation: Correlation, startedAt?: number): Observation | undefined => {
        prune();
        const known = observations.get(key);
        if (known) return known.rpcId === correlation.rpcId && known.lookupId === correlation.lookupId ? known : undefined;
        const now = performance.now();
        if (now - windowStart >= 60_000) { windowStart = now; count = 0; }
        if (observations.size >= 50 || count >= 10) return;
        count++;
        const entry = { rpcId: correlation.rpcId, lookupId: correlation.lookupId, at: startedAt ?? now, stages: new Set<string>() };
        observations.set(key, entry);
        return entry;
    };
    const emit = (entry: Observation, stage: string) => {
        if (closed || !enabled() || performance.now() - entry.at >= 60_000 || entry.stages.has(stage)) return;
        entry.stages.add(stage);
        try { report({ rpcId: entry.rpcId, lookupId: entry.lookupId, stage, elapsedMs: Math.max(0, performance.now() - entry.at) }); } catch { /* Diagnostics cannot break the bus. */ }
    };
    adapter.doPublish = (message: Message) => {
        if (closed || !enabled()) return publish(message);
        const correlation = scope.getStore(), key = message.data?.requestId;
        if (!correlation || typeof key !== 'string' || key.length > 100 || ![7, 8].includes(message.type)) return publish(message);
        const entry = remember(key, correlation);
        if (!entry) return publish(message);
        const stage = message.type === 7 ? 'request-publish' : 'response-publish';
        const outgoing = { ...message, data: { ...message.data, rpcPeer: { rpcId: entry.rpcId, lookupId: entry.lookupId } } };
        emit(entry, `${stage}-start`);
        try {
            return publish(outgoing).then(value => { emit(entry, `${stage}-done`); return value; }, error => { emit(entry, `${stage}-failed`); throw error; });
        } catch (error) { emit(entry, `${stage}-failed`); throw error; }
    };
    adapter.onMessage = (message: Message, ...args: any[]) => {
        if (closed || !enabled() || message.uid === adapter.uid) return consume(message, ...args);
        prune();
        const key = message.data?.requestId;
        if (typeof key !== 'string' || key.length > 100) return consume(message, ...args);
        if (message.type === 8) {
            const entry = observations.get(key);
            if (entry) {
                if (rawStartedAt !== undefined) emit(entry, 'response-decode-done');
                emit(entry, 'response-consume');
            }
            return consume(message, ...args);
        }
        const correlation = message.data?.rpcPeer;
        if (message.type !== 7 || !correlation || !validId(correlation.rpcId) || !validId(correlation.lookupId)) return consume(message, ...args);
        const entry = remember(key, correlation, rawStartedAt);
        if (!entry) return consume(message, ...args);
        if (rawStartedAt !== undefined) emit(entry, 'request-decode-done');
        emit(entry, 'request-consume');
        // The adapter's async local fetch and response publish retain this scope.
        return scope.run({ rpcId: entry.rpcId, lookupId: entry.lookupId }, () => consume(message, ...args));
    };
    if (rawMessage) {
        adapter.onRawMessage = (message: any, ...args: any[]) => {
            if (closed || !enabled()) return rawMessage(message, ...args);
            const previous = rawStartedAt;
            try {
                try { rawStartedAt = performance.now(); } catch { return rawMessage(message, ...args); }
                return rawMessage(message, ...args);
            } finally {
                rawStartedAt = previous;
            }
        };
    }
    adapter.close = () => { closed = true; observations.clear(); close(); };
}
