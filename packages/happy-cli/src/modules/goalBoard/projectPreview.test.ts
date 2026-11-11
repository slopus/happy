import { describe, expect, it, vi } from 'vitest';
import { mergeProjectPreviewHistory, registerProjectGoalPreviewChat, registerProjectGoalPreviewApproval } from './projectPreview';

describe('opt-in preview empty conversations', () => {
    it('does not let an earlier-page candidate erase the local continuation', () => {
        const local = { sessionId: 'a', title: 'Chat', directory: '/archive/task', updatedAt: 100, executed: false };
        const nextCursor = { sessionId: 'a', updatedAt: 100 };
        expect(mergeProjectPreviewHistory({ sessions: [local], nextCursor }, [{ ...local, updatedAt: 200 }], { sessionId: 'b', updatedAt: 150 })).toEqual({
            success: true, sessions: [local], nextCursor,
        });
    });
    it('does not skip unread local history when its byte-limited page is shorter than the row limit', () => {
        const local = { sessionId: 'local', title: 'Chat', directory: '/archive/task', updatedAt: 100, executed: false };
        const candidate = { ...local, sessionId: 'old-candidate', updatedAt: 10 };
        expect(mergeProjectPreviewHistory({ sessions: [local], nextCursor: { sessionId: 'local', updatedAt: 100 } }, [candidate])).toEqual({
            success: true, sessions: [local], nextCursor: { sessionId: 'local', updatedAt: 100 },
        });
    });
    it('preserves the next page when local associations exceed one page without account candidates', () => {
        const sessions = Array.from({ length: 25 }, (_, i) => ({ sessionId: `local-${i}`, title: 'Chat', directory: '/archive/task', updatedAt: 100 - i, executed: false }));
        const nextCursor = { sessionId: 'local-24', updatedAt: 76 };
        const first = mergeProjectPreviewHistory({ sessions, nextCursor }, []);
        expect(first.sessions).toHaveLength(25);
        expect(first.nextCursor).toEqual(nextCursor);
        const last = { ...sessions[0], sessionId: 'local-25', updatedAt: 75 };
        expect(mergeProjectPreviewHistory({ sessions: [last] }, [sessions[0]], nextCursor)).toEqual({ success: true, sessions: [last] });
    });
    it('only registers an empty-chat endpoint and rejects execution and injected prompts', async () => {
        const launch = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'empty-chat' });
        const registerHandler = vi.fn();
        registerProjectGoalPreviewChat({ registerHandler }, { launch });
        expect(registerHandler).toHaveBeenCalledTimes(1);
        const [method, handler] = registerHandler.mock.calls[0];
        expect(method).toBe('previewGoalTaskLaunch');
        const input = { featurePath: '/archive', taskId: 'task', requestId: 'request', agent: 'codex', action: 'chat' };
        expect(() => handler({ ...input, action: 'execute' })).toThrow();
        expect(() => handler({ ...input, prompt: 'run the task' })).toThrow();
        expect(launch).not.toHaveBeenCalled();
        await expect(handler(input)).resolves.toMatchObject({ sessionId: 'empty-chat' });
        expect(launch).toHaveBeenCalledExactlyOnceWith(input);
    });
});

describe('opt-in preview deliverable confirmation', () => {
    it('registers only confirmation and delegates exact versions to the canonical service', async () => {
        const approve = vi.fn().mockResolvedValue({ success: true });
        const registerHandler = vi.fn();
        registerProjectGoalPreviewApproval({ registerHandler }, { approve });
        expect(registerHandler).toHaveBeenCalledTimes(1);
        const [method, handler] = registerHandler.mock.calls[0];
        expect(method).toBe('previewGoalTaskApprove');
        const input = { featurePath: '/archive', taskId: 'task', artifactId: 'output', expectedRevision: 'a'.repeat(24), expectedHash: 'b'.repeat(64) };
        for (const extra of [{ prompt: 'execute' }, { status: 'done' }, { action: 'execute' }, { content: 'overwrite' }]) {
            expect(() => handler({ ...input, ...extra })).toThrow();
        }
        expect(() => handler({ ...input, expectedRevision: 'stale' })).toThrow();
        expect(() => handler({ ...input, expectedHash: 'bad' })).toThrow();
        expect(approve).not.toHaveBeenCalled();
        await expect(handler(input)).resolves.toEqual({ success: true });
        expect(approve).toHaveBeenCalledExactlyOnceWith(input);
    });
});
