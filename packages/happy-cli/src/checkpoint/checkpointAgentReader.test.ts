import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { SandboxConfigSchema } from '@/persistence';
import { createCheckpointAgentReader } from './checkpointAgentReader';
import { CHECKPOINT_SPAWN_CONTEXT_ENV_KEY } from './checkpointSpawnContext';
import { CheckpointStore, resolveCheckpointStoreLayout } from './checkpointStore';
import { CheckpointProtectionStateStore } from './checkpointProtectionState';
const git = promisify(execFile);
describe('agent checkpoint reads in its own session', () => {
    let root: string, projectPath: string, checkpointRoot: string, checkpointId: string;
    const binding = { sessionId: 'session', projectId: 'project', worktreeId: 'worktree' };
    const settings = SandboxConfigSchema.parse({ checkpointProtection: { secretPatterns: ['.env*'], maxFiles: 100, maxFileBytes: 1024, maxTotalBytes: 4096 } });
    beforeEach(async () => {
        root = await realpath(await mkdtemp(join(tmpdir(), 'checkpoint-agent-')));
        projectPath = join(root, 'project'); checkpointRoot = join(root, 'history');
        await mkdir(projectPath); await writeFile(join(projectPath, 'file.txt'), 'recorded\n');
        checkpointId = (await new CheckpointStore(checkpointRoot).snapshotTurn({ ...binding, projectPath, operationId: 'turn',
            excludedPatterns: ['.env*'], workTree: { maxFileBytes: 10 * 1024 * 1024, record: 'before' } })).checkpointId;
        await writeFile(join(projectPath, 'file.txt'), 'current\n');
    });
    afterEach(async () => { await rm(root, { recursive: true, force: true }); });
    function reader(overrides: Partial<Parameters<typeof createCheckpointAgentReader>[0]> = {}) {
        return createCheckpointAgentReader({ ...binding, provider: 'codex', platform: 'darwin', projectPath, sandboxConfig: settings,
            env: { [CHECKPOINT_SPAWN_CONTEXT_ENV_KEY]: JSON.stringify({ schemaVersion: 1, projectId: binding.projectId,
                worktreeId: binding.worktreeId, checkpointRoot }) }, ...overrides });
    }
    async function refs() {
        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        return (await git('git', [`--git-dir=${layout.gitDirectory}`, 'for-each-ref', '--format=%(refname) %(objectname)'])).stdout;
    }
    it('discovers active history, previews and compares without recording or restoring', async () => {
        const api = reader(); const before = await refs();
        expect(await api.status()).toMatchObject({ schemaVersion: 1, supported: true, enabled: true, mode: 'local-history' });
        expect(await api.guidance()).toContain('checkpoint_diff');
        expect(await api.query('list', {})).toMatchObject({ checkpoints: [{ checkpointId }], total: 1, nextOffset: null });
        expect(await api.query('preview', { checkpointId })).toMatchObject({ entries: [{ path: 'file.txt', action: 'skip', reason: 'user-modified' }] });
        const diff = await api.query('diff', { checkpointId, path: 'file.txt' });
        expect(diff).toMatchObject({ status: 'text', direction: 'current-to-checkpoint', truncated: false });
        expect(diff.diff).toContain('-current\n+recorded');
        expect(await readFile(join(projectPath, 'file.txt'), 'utf8')).toBe('current\n'); expect(await refs()).toBe(before);
    });
    it.each([
        [{ sandboxConfig: undefined }, 'disabled'], [{ platform: 'win32' as const }, 'unsupported-platform'],
        [{ provider: 'gemini' as const }, 'unsupported-provider'], [{ env: {} }, 'session-context-unavailable'],
    ])('reports inactive capability without active guidance: %s', async (overrides, reason) => {
        const api = reader(overrides); expect(await api.status()).toMatchObject({ enabled: false, reason });
        expect(await api.guidance()).toBe(''); await expect(api.query('list', {})).rejects.toThrow('CHECKPOINT_UNAVAILABLE');
    });
    it('rechecks persisted disable and unreadable state', async () => {
        const api = reader(); expect((await api.status()).enabled).toBe(true);
        const state = new CheckpointProtectionStateStore(checkpointRoot);
        await state.reportPending({ ...binding, projectPath, operationId: 'turn', source: 'policy-drift', excluded: [] });
        await state.resolveDecision({ ...binding, projectPath, operationId: 'turn', decision: 'disable-protection' });
        expect(await api.status()).toMatchObject({ enabled: false, reason: 'disabled' });
        await expect(api.query('diff', { checkpointId, path: 'file.txt' })).rejects.toThrow('CHECKPOINT_UNAVAILABLE');
        const layout = resolveCheckpointStoreLayout({ checkpointRoot, ...binding });
        await writeFile(join(layout.gitDirectory, 'protection', `${layout.refName.split('/').pop()}.json`), '{bad');
        expect(await api.status()).toMatchObject({ enabled: false, reason: 'state-unavailable' }); expect(await api.guidance()).toBe('');
    });
    it('rejects identity overrides, mutations, other records and unsafe/excluded/symlink paths', async () => {
        const api = reader();
        const other = (await new CheckpointStore(checkpointRoot).snapshotTurn({ ...binding, sessionId: 'other', projectPath, operationId: 'other' })).checkpointId;
        await expect(api.query('list', { sessionId: 'other' })).rejects.toThrow();
        await expect(api.query('execute' as never, { checkpointId })).rejects.toThrow();
        await expect(api.query('preview', { checkpointId: other })).rejects.toThrow();
        for (const path of ['../outside', '/outside', '.env.local']) await expect(api.query('diff', { checkpointId, path })).rejects.toThrow();
        await rm(join(projectPath, 'file.txt')); await writeFile(join(root, 'outside'), 'private');
        await symlink(join(root, 'outside'), join(projectPath, 'file.txt'));
        await expect(api.query('diff', { checkpointId, path: 'file.txt' })).rejects.toThrow();
    });
    it('retains the launcher project binding when its input object changes', async () => {
        const input = { provider: 'codex' as const, platform: 'darwin' as const, projectPath, sessionId: binding.sessionId,
            sandboxConfig: settings, env: { [CHECKPOINT_SPAWN_CONTEXT_ENV_KEY]: JSON.stringify({ schemaVersion: 1, projectId: binding.projectId,
                worktreeId: binding.worktreeId, checkpointRoot }) } };
        const api = createCheckpointAgentReader(input);
        expect((await api.status()).enabled).toBe(true);
        input.projectPath = join(root, 'unrelated'); input.sessionId = 'other'; input.env[CHECKPOINT_SPAWN_CONTEXT_ENV_KEY] = '{}';
        expect(await api.query('diff', { checkpointId, path: 'file.txt' })).toMatchObject({ diff: expect.stringContaining('-current\n+recorded') });
    });
    it('serves actual Git history through MCP discovery and calls without exposing identity or mutation tools', async () => {
        const before = await refs();
        const server = await startHappyServer({ hasTitle: () => true } as ApiSessionClient, { checkpointReader: reader() });
        async function request(method: string, params: Record<string, unknown>) {
            const response = await fetch(server.url, { method: 'POST', headers: {
                'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
            }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
            expect(response.status).toBe(200);
            const raw = await response.text();
            expect(raw).not.toContain(checkpointRoot); expect(raw).not.toContain(projectPath);
            return JSON.parse(raw.startsWith('event:') ? raw.slice(raw.indexOf('data: ') + 6) : raw).result;
        }
        try {
            const listed = await request('tools/list', {});
            expect(listed.tools.filter((tool: { name: string }) => tool.name.startsWith('checkpoint_')).map((tool: { name: string }) => tool.name).sort())
                .toEqual(['checkpoint_diff', 'checkpoint_list', 'checkpoint_preview', 'checkpoint_status']);
            for (const [name, args, expected] of [
                ['status', {}, { enabled: true }], ['list', {}, { checkpoints: [{ checkpointId }] }],
                ['preview', { checkpointId }, { entries: [{ path: 'file.txt' }] }],
                ['diff', { checkpointId, path: 'file.txt' }, { status: 'text', diff: expect.stringContaining('-current\n+recorded') }],
            ] as const) {
                const result = await request('tools/call', { name: `checkpoint_${name}`, arguments: args });
                expect(result.isError).not.toBe(true); expect(JSON.parse(result.content[0].text)).toMatchObject(expected);
            }
            const state = new CheckpointProtectionStateStore(checkpointRoot);
            await state.reportPending({ ...binding, projectPath, operationId: 'disable', source: 'policy-drift', excluded: [] });
            await state.resolveDecision({ ...binding, projectPath, operationId: 'disable', decision: 'disable-protection' });
            const refused = await request('tools/call', { name: 'checkpoint_diff', arguments: { checkpointId, path: 'file.txt' } });
            expect(refused).toMatchObject({ isError: true, content: [{ text: 'CHECKPOINT_UNAVAILABLE' }] });
            expect(await readFile(join(projectPath, 'file.txt'), 'utf8')).toBe('current\n'); expect(await refs()).toBe(before);
        } finally { server.stop(); }
    });
    it('bounds a single Unicode line at a valid UTF-8 boundary and rejects out-of-range pages', async () => {
        await writeFile(join(projectPath, 'file.txt'), '😀'.repeat(30000));
        const api = reader();
        const diff = await api.query('diff', { checkpointId, path: 'file.txt' });
        expect(diff.truncated).toBe(true); expect(diff.diff).not.toContain('�');
        expect(Buffer.byteLength(diff.diff)).toBeLessThanOrEqual(65536);
        for (const params of [{ limit: 51 }, { offset: -1 }, { checkpointRoot }, { projectPath }]) {
            await expect(api.query('list', params)).rejects.toThrow();
        }
        await expect(api.query('preview', { checkpointId, limit: 101 })).rejects.toThrow();
    });
    it('paginates history/preview and explicitly bounds long diff', async () => {
        await writeFile(join(projectPath, 'file.txt'), Array.from({ length: 3000 }, (_, i) => `line ${i} ${'x'.repeat(150)}`).join('\n'));
        const api = reader(); const diff = await api.query('diff', { checkpointId, path: 'file.txt' });
        expect(diff.truncated).toBe(true); expect(diff.diff.split('\n').length).toBeLessThanOrEqual(500);
        expect(Buffer.byteLength(diff.diff)).toBeLessThanOrEqual(65536);
        for (let i = 0; i < 3; i++) {
            await writeFile(join(projectPath, 'file.txt'), `version ${i}`);
            await new CheckpointStore(checkpointRoot).snapshotTurn({ ...binding, projectPath, operationId: `later-${i}`, workTree: { maxFileBytes: 10 * 1024 * 1024, record: 'after' } });
        }
        const first = await api.query('list', { limit: 2 }); expect(first.checkpoints).toHaveLength(2); expect(first.nextOffset).toBe(2);
        const second = await api.query('list', { limit: 2, offset: first.nextOffset }); expect(second.checkpoints).toHaveLength(2); expect(second.nextOffset).toBeNull();
        expect(second.checkpoints.map((item: { checkpointId: string }) => item.checkpointId)).not.toContain(first.checkpoints[0].checkpointId);
        for (let i = 0; i < 3; i++) await writeFile(join(projectPath, `added-${i}.txt`), 'new');
        const selected = (await new CheckpointStore(checkpointRoot).snapshotTurn({ ...binding, projectPath, operationId: 'preview-base', workTree: { maxFileBytes: 10 * 1024 * 1024, record: 'before' } })).checkpointId;
        for (let i = 0; i < 3; i++) await writeFile(join(projectPath, `added-${i}.txt`), 'edited');
        const preview = await api.query('preview', { checkpointId: selected, limit: 2 }); expect(preview.entries).toHaveLength(2); expect(preview.nextOffset).toBe(2);
        expect(preview.restoreRequiresUserConfirmation).toBe(true); expect((await api.query('preview', { checkpointId: selected, offset: 2 })).entries.length).toBeGreaterThan(0);
    });
});
