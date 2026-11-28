import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConversationPreparation } from './conversationPreparation';

const request = { rootSessionId: 'root', sourceSessionId: 'source', requestId: '00000000-0000-4000-8000-000000000010',
    expectedWorkerPid: process.pid, contextId: '00000000-0000-4000-8000-000000000011', contextSha256: 'a'.repeat(64),
    model: 'native-model', effort: 'high', permissionMode: 'default' };
const metadata = () => ({ hostPid: process.pid, flavor: 'antigravity', parentSessionId: request.sourceSessionId,
    crossAgentRequestId: request.requestId, conversationRootSessionId: request.rootSessionId,
    continuationOfSessionId: request.sourceSessionId, portableContext: { id: request.contextId, sha256: request.contextSha256 } });

describe('conversation candidate preparation ownership', () => {
    afterEach(() => vi.useRealTimers());
    it('binds readiness and configuration to the exact candidate without delegated-task ownership', async () => {
        const current = metadata(); let acknowledge!: () => void;
        const ack = new Promise<void>(resolve => { acknowledge = resolve; });
        const prepare = vi.fn(async (_input, assertCurrent) => { assertCurrent(); await ack; assertCurrent(); return { model: 'native-model', effort: 'high', permissionMode: 'default' }; });
        const handler = createConversationPreparation({ agent: 'antigravity', sessionId: () => 'target', metadata: () => current as any, prepare });
        let resolved = false; const pending = handler(request).then(result => { resolved = true; return result; });
        expect(prepare).toHaveBeenCalledOnce(); expect(resolved).toBe(false);
        acknowledge(); expect(await pending).toMatchObject({ ready: true, sessionId: 'target', hostPid: process.pid, requestId: request.requestId });
    });
    it.each(['hostPid', 'parentSessionId', 'crossAgentRequestId', 'conversationRootSessionId', 'continuationOfSessionId', 'context'])('rejects a mismatched %s before native preparation', async key => {
        const current: any = metadata();
        if (key === 'context') current.portableContext.sha256 = 'b'.repeat(64);
        else current[key] = key === 'hostPid' ? process.pid + 1 : 'foreign';
        const prepare = vi.fn();
        const handler = createConversationPreparation({ agent: 'antigravity', sessionId: () => 'target', metadata: () => current, prepare });
        await expect(handler(request)).rejects.toThrow(/changed|binding|context/); expect(prepare).not.toHaveBeenCalled();
    });
    it('does not acknowledge a worker replaced during configuration', async () => {
        const current = metadata();
        const handler = createConversationPreparation({ agent: 'antigravity', sessionId: () => 'target', metadata: () => current as any,
            prepare: async () => { current.hostPid++; return { model: 'native-model', permissionMode: 'default' }; } });
        await expect(handler(request)).rejects.toThrow(/changed|binding/);
    });
    it('never upgrades an unconfirmed permission policy in its receipt', async () => {
        const handler = createConversationPreparation({ agent: 'antigravity', sessionId: () => 'target', metadata: () => metadata() as any,
            prepare: async () => ({ model: 'native-model', permissionMode: 'bypassPermissions' }) });
        await expect(handler(request)).rejects.toThrow(/permission|configuration/);
    });
    it('bounds native startup and invalidates late configuration acknowledgements without querying status', async () => {
        vi.useFakeTimers();
        let assertLate!: () => void;
        const prepare = vi.fn(async (_input, assertCurrent) => {
            assertLate = assertCurrent;
            return new Promise<never>(() => {});
        });
        const handler = createConversationPreparation({ agent: 'antigravity', sessionId: () => 'target', metadata: () => metadata() as any, prepare });
        const result = handler(request);
        const rejected = expect(result).rejects.toThrow(/Timed out/);
        await vi.advanceTimersByTimeAsync(70_000);
        await rejected;
        expect(() => assertLate()).toThrow(/Timed out/);
        expect(prepare).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });
});
