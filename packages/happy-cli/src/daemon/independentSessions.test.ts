import { describe, expect, it, vi } from 'vitest';
import { createIndependentSessionLauncher, independentTaskSchema, independentTaskMessage } from './independentSessions';
import { resolveRemoteClaudePermissionMode } from '@/claude/utils/permissionMode';
import type { TrackedSession } from './types';

const task = { requestId: 'task-1', title: 'Audit', prompt: 'Read only' };
function setup() {
    const metadata = { path: '/project', flavor: 'codex', currentOperatingModeCode: 'read-only', currentModelCode: 'gpt-test', currentThoughtLevelCode: 'high', codexAccountProfileId: 'account' };
    const parent = { happySessionId: 'parent', encryption: {}, happySessionMetadataFromLocalWebhook: metadata } as TrackedSession;
    const child = { happySessionId: 'child', encryption: {} } as TrackedSession;
    const deps = { findSession: vi.fn((id: string) => id === 'parent' ? parent : child),
        readMetadata: vi.fn(async () => metadata as any),
        grant: vi.fn(async () => 'grant'), spawn: vi.fn(async () => ({ type: 'success' as const, sessionId: 'child' })),
        send: vi.fn(async (_session: TrackedSession, _prompt: string, _localId: string, _permissionMode?: string, _appendSystemPrompt?: string) => {}) };
    return { deps, launch: createIndependentSessionLauncher(deps), metadata };
}
describe('independent sessions', () => {
    it('creates independent history with same account/model and preserves read-only mode', async () => {
        const { deps, launch } = setup();
        expect(await launch('parent', task)).toMatchObject({ success: true, sessionId: 'child' });
        expect(deps.grant).toHaveBeenCalledWith('parent');
        expect(deps.spawn).toHaveBeenCalledWith({ directory: '/project', agent: 'codex', parentSessionId: 'parent', codexSessionGrant: 'grant', expectedCodexAccountProfileId: 'account', model: 'gpt-test', effort: 'high', approvedNewDirectoryCreation: false });
        expect(deps.send).toHaveBeenCalledWith(expect.anything(), 'Audit\n\nRead only', 'independent:task-1', 'read-only', undefined);
    });
    it('deduplicates concurrent/repeated requests and rejects changed payload', async () => {
        const { deps, launch } = setup();
        await Promise.all([launch('parent', task), launch('parent', task)]);
        await launch('parent', task);
        expect(deps.spawn).toHaveBeenCalledTimes(1);
        expect(deps.send).toHaveBeenCalledTimes(1);
        expect(await launch('parent', { ...task, prompt: 'different' })).toMatchObject({ success: false });
    });
    it('retries delivery with the existing child and same message identity', async () => {
        const { deps, launch } = setup();
        deps.send.mockRejectedValueOnce(new Error('offline'));
        expect(await launch('parent', task)).toMatchObject({ success: false, sessionId: 'child' });
        expect(await launch('parent', task)).toMatchObject({ success: true, sessionId: 'child' });
        expect(deps.spawn).toHaveBeenCalledTimes(1);
        expect(deps.send.mock.calls[0]).toEqual(deps.send.mock.calls[1]);
    });
    it('uses read-only when parent permission is unknown', async () => {
        const { deps, launch, metadata } = setup();
        metadata.currentOperatingModeCode = 'unknown';
        await launch('parent', task);
        expect(deps.send.mock.calls[0][3]).toBe('read-only');
    });
    it.each([{ application: { appId: 'app', bindingId: 'binding' } }, { sandbox: { enabled: true } }])('does not bypass restricted parent policy', async restriction => {
        const { deps, launch, metadata } = setup();
        Object.assign(metadata, restriction);
        expect(await launch('parent', task)).toMatchObject({ success: false });
        expect(deps.spawn).not.toHaveBeenCalled();
    });
    it('validates absolute directory and nonempty task', () => {
        expect(independentTaskSchema.safeParse({ ...task, directory: '../bad' }).success).toBe(false);
        expect(independentTaskSchema.safeParse({ ...task, prompt: ' ' }).success).toBe(false);
    });
    it('passes effective runtime permissions and custom instructions to the child', async () => {
        const { deps, launch } = setup();
        await launch('parent', task, { permissionMode: 'plan', appendSystemPrompt: 'Never edit files' });
        expect(deps.send).toHaveBeenCalledWith(expect.anything(), expect.any(String), 'independent:task-1', 'plan', 'Never edit files');
    });
    it('starts two tasks concurrently as distinct requests', async () => {
        const { deps, launch } = setup();
        deps.spawn.mockResolvedValueOnce({ type: 'success', sessionId: 'child-a' }).mockResolvedValueOnce({ type: 'success', sessionId: 'child-b' });
        const results = await Promise.all([launch('parent', task), launch('parent', { ...task, requestId: 'task-2', title: 'UI' })]);
        expect(results.map(r => r.sessionId)).toEqual(['child-a', 'child-b']);
        expect(deps.spawn).toHaveBeenCalledTimes(2);
        expect(deps.send).toHaveBeenCalledTimes(2);
    });

    it('explicitly downgrades a newly started Claude child from yolo to the parent default', () => {
        const message = independentTaskMessage('Review', 'default', 'Custom rule');
        expect(resolveRemoteClaudePermissionMode('yolo', message.meta.permissionMode as 'default', false, message.meta.permissionModeExplicit)).toBe('default');
        expect(message.meta.appendSystemPrompt).toBe('Custom rule');
    });

});
