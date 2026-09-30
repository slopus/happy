import type { Session } from './storageTypes';
import type { SpawnSessionResult } from './ops';

/** 旧执行进程失败后，先恢复原会话再交付新消息；并发发送共用一次恢复。 */
export class FailedCodexSessionRecovery {
    private attempts = new Map<string, { owner: object; key: string; pending: Promise<void> }>();

    async ensure(session: Session | undefined, owner: object, resume: () => Promise<SpawnSessionResult>): Promise<void> {
        const metadata = session?.metadata;
        const turn = session?.agentState?.turnStatus;
        if (!session || metadata?.flavor !== 'codex' || !metadata.codexAccountProfileId
            || !metadata.codexThreadId || !turn || turn.status === 'running') return;
        if (turn.status !== 'failed' && (metadata.capabilities?.codexCredentialRecovery === true || !metadata.hostPid)) return;
        const key = `${metadata.hostPid ?? ''}:${turn.status}:${turn.turnId ?? ''}:${turn.updatedAt}`;
        const current = this.attempts.get(session.id);
        if (current?.owner === owner && current.key === key) return current.pending;
        const pending = (async () => {
            const result = await resume();
            if (result.type !== 'success') throw new Error(result.type === 'error' ? result.errorMessage : 'session-recovery-unavailable');
            if (result.sessionId !== session.id) throw new Error('session-recovery-id-changed');
        })();
        const attempt = { owner, key, pending };
        this.attempts.set(session.id, attempt);
        try { await pending; } catch (error) {
            if (this.attempts.get(session.id) === attempt) this.attempts.delete(session.id);
            throw error;
        }
    }
}
