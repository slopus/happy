import { describe, expect, it, vi } from 'vitest';
import type { Session } from './storageTypes';
import { FailedCodexSessionRecovery } from './failedCodexSessionRecovery';

const session = (updatedAt = 1) => ({ id: 'original', metadata: { flavor: 'codex', machineId: 'machine', hostPid: 1234,
    codexThreadId: 'original-thread', codexAccountProfileId: 'original-account', capabilities: { codexCredentialRecovery: true } },
    agentState: { turnStatus: { status: 'failed', updatedAt, turnId: 'turn' } },
}) as Session;

describe('failed account session recovery before delivery', () => {
    it('holds concurrent messages until one original-session resume completes', async () => {
        let finish!: (result: { type: 'success'; sessionId: string }) => void;
        const resume = vi.fn(() => new Promise<{ type: 'success'; sessionId: string }>(resolve => { finish = resolve; }));
        const recovery = new FailedCodexSessionRecovery();
        const owner = {};
        const deliver = vi.fn();
        const send = async () => { await recovery.ensure(session(), owner, resume); deliver(); };
        const first = send(); const second = send();
        expect(resume).toHaveBeenCalledTimes(1);
        expect(deliver).not.toHaveBeenCalled();
        finish({ type: 'success', sessionId: 'original' });
        await Promise.all([first, second]);
        expect(deliver).toHaveBeenCalledTimes(2);
        await send();
        expect(resume).toHaveBeenCalledTimes(1);
        await recovery.ensure(session(2), owner, vi.fn(async () => ({ type: 'success' as const, sessionId: 'original' })));
    });

    it('preserves the unsent message on failure and permits a later recovery attempt', async () => {
        const recovery = new FailedCodexSessionRecovery(); const owner = {};
        const resume = vi.fn(async () => ({ type: 'error' as const, errorMessage: 'account needs authorization' }));
        const deliver = vi.fn();
        await expect((async () => { await recovery.ensure(session(), owner, resume); deliver(); })()).rejects.toThrow('authorization');
        expect(deliver).not.toHaveBeenCalled();
        await expect(recovery.ensure(session(), owner, async () => ({ type: 'success', sessionId: 'original' }))).resolves.toBeUndefined();
    });

    it('rejects a replacement conversation and rechecks after account runtime changes', async () => {
        const recovery = new FailedCodexSessionRecovery();
        await expect(recovery.ensure(session(), {}, async () => ({ type: 'success', sessionId: 'new' }))).rejects.toThrow('id-changed');
        const resume = vi.fn(async () => ({ type: 'success' as const, sessionId: 'original' }));
        await recovery.ensure(session(), {}, resume); await recovery.ensure(session(), {}, resume);
        expect(resume).toHaveBeenCalledTimes(2);
    });

    it.each(['completed', 'cancelled'])('upgrades an idle legacy %s worker before the first new message', async status => {
        const value = session(); value.agentState!.turnStatus!.status = status as 'completed';
        value.metadata!.capabilities = {};
        const resume = vi.fn(async () => ({ type: 'success' as const, sessionId: 'original' }));
        await new FailedCodexSessionRecovery().ensure(value, {}, resume);
        expect(resume).toHaveBeenCalledTimes(1);
    });

    it.each(['running', 'completed', 'cancelled'])('keeps a %s worker running', async status => {
        const value = session(); value.agentState!.turnStatus!.status = status as 'running';
        const resume = vi.fn(); await new FailedCodexSessionRecovery().ensure(value, {}, resume);
        expect(resume).not.toHaveBeenCalled();
    });
});
