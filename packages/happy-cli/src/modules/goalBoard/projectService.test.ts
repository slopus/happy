import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath, rename, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectGoalService, type ProjectGoalDependencies, type ProjectSession } from './projectService';
import { ArtifactStore } from '../artifacts/store';
import * as parser from './parser';

vi.mock('node:fs', async (original) => {
    const fs = await original<typeof import('node:fs')>();
    return { ...fs, watch: vi.fn(fs.watch) };
});

const cleanups: Array<() => void | Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(overrides: Partial<ProjectGoalDependencies> = {}) {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'goal-project-test-')));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const root = join(home, '.codex/skills/goal-first-ops/projects');
    const feature = join(root, 'p/features/f');
    const taskDirectory = join(feature, 'tasks/a');
    const put = async (path: string, content: string | Buffer) => { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, content); };
    await put(join(root, 'p/index.md'), '# Project');
    await put(join(root, 'empty/index.md'), '# Empty project');
    await put(join(root, 'direct/index.md'), '# Direct project');
    await put(join(root, 'direct/tasks/a/index.md'), '---\nstatus: pending\n---\n# Direct Task');
    await put(join(feature, 'index.md'), '# Feature');
    await put(join(taskDirectory, 'index.md'), '---\nstatus: pending\n---\n# Task\n目标：Actual goal\n## 验收标准\n- Open the real deliverable\n## 最终交付\n[Report](report.md)');
    await put(join(taskDirectory, 'PROMPT.md'), '# Task prompt\n## 预期交付物\n- A real report');
    await put(join(taskDirectory, 'report.md'), '# Version one');
    const history: ProjectSession[] = [];
    let count = 0;
    const deps: ProjectGoalDependencies = { homeDirectory: home, workingDirectory: home, storageDirectory: join(home, 'state'),
        observe: false,
        history: vi.fn(async () => history), spawn: vi.fn(async () => ({ type: 'success' as const, sessionId: `session-${++count}` })),
        send: vi.fn(async () => {}), changed: vi.fn(), ...overrides };
    const make = () => { const service = createProjectGoalService(deps); cleanups.push(() => service.dispose()); return service; };
    const service = make();
    const task = (await service.board(feature)).snapshot.tasks[0];
    const input = { featurePath: feature, taskId: task.id };
    return { home, root, feature, taskDirectory, put, deps, history, service, task, input, make };
}

describe('project Goal workspace', () => {
    it('reads the selected real scope index and counts only that archive, without following symlinks', async () => {
        const f = await fixture();
        await f.put(join(f.feature, 'index.md'), '# Feature\n## 目标\nA real feature goal');
        await f.put(join(f.root, 'p/features/sibling/index.md'), '# Sibling\n目标：Keep separate');
        await symlink(join(f.root, 'p/features/sibling'), join(f.feature, 'sibling-link'));
        const result = await f.service.overview({ scopePath: f.feature });
        expect(result.overview).toMatchObject({ scopePath: f.feature, indexPath: join(f.feature, 'index.md'), title: 'Feature', goal: 'A real feature goal', fileCount: 4, countComplete: true });
        expect((await f.service.overview({ scopePath: join(f.root, 'p') })).overview.fileCount).toBe(6);
        await expect(f.service.overview({ scopePath: f.home })).rejects.toThrow('outside');
        expect(f.deps.spawn).not.toHaveBeenCalled(); expect(f.deps.send).not.toHaveBeenCalled();
    });
    it('shares scoped files while rejecting sibling archives, symlink escapes and scope/task confusion', async () => {
        const f = await fixture();
        const input = { featurePath: f.feature, path: join(f.feature, 'index.md') };
        expect(await f.service.files(input, 'read', true)).toMatchObject({ success: true, size: 9 });
        await expect(f.service.files(input, 'read')).rejects.toThrow();
        const largePath = join(f.taskDirectory, 'large.md');
        await f.put(largePath, 'x'.repeat(70 * 1024));
        const chunk = await f.service.files({ ...f.input, path: largePath }, 'read', true);
        if (!('revision' in chunk) || !('transferId' in chunk)) throw new Error('Expected a file transfer');
        await expect(f.service.files({ ...f.input, path: largePath, offset: 65536, revision: chunk.revision, transferId: chunk.transferId }, 'read')).rejects.toThrow('expired or changed');
        await expect(f.service.files({ ...input, path: join(f.root, 'p/index.md') }, 'read', true)).rejects.toThrow();
        await symlink(join(f.root, 'p/index.md'), join(f.feature, 'escape.md'));
        await expect(f.service.files({ ...input, path: join(f.feature, 'escape.md') }, 'read', true)).rejects.toThrow();
    });
    it('an explicit sibling binding overrides a coincidentally matching Task directory', async () => {
        const f = await fixture();
        f.history.push({ sessionId: 'sibling', title: 'Sibling', directory: f.taskDirectory, updatedAt: 1, executed: false,
            metadata: { path: f.taskDirectory, goalBoard: { featurePath: f.feature, taskId: 'another-task' } } as any });
        expect((await f.service.historyPage(f.input)).sessions).toEqual([]);
    });
    it('global history keeps exact scope discussions and excludes explicit Task associations', async () => {
        const f = await fixture();
        for (const [sessionId, directory, goalBoard] of [
            ['scope', f.feature, undefined], ['other', f.taskDirectory, undefined],
            ['task', f.feature, { featurePath: f.feature, taskId: f.task.id }],
        ] as const) f.history.push({ sessionId, directory, title: sessionId, updatedAt: 1, executed: false, metadata: { path: directory, goalBoard } as any });
        expect((await f.service.scopeHistory({ scopePath: f.feature })).sessions.map(session => session.sessionId)).toEqual(['scope']);
        const input = { scopePath: f.feature, requestId: 'scope-chat', agent: 'codex' };
        expect(await f.service.author(input)).toEqual(await f.service.author(input));
        expect(f.deps.spawn).toHaveBeenCalledTimes(1); expect(f.deps.send).not.toHaveBeenCalled();
    });
    it('reads fresh files without subscribing when directory observation is disabled', async () => {
        vi.mocked(watch).mockClear();
        const f = await fixture({ observe: false });
        await f.service.projects();
        await f.put(join(f.taskDirectory, 'index.md'), '---\nstatus: done\n---\n# Updated task');
        expect((await f.service.board(f.feature)).snapshot.tasks[0]).toMatchObject({ title: 'Updated task', status: 'done' });
        f.service.dispose();
        expect(watch).not.toHaveBeenCalled();
    });
    it.skipIf(process.platform !== 'darwin')('defaults to explicit refresh on macOS without opening native watchers', async () => {
        vi.mocked(watch).mockClear();
        const f = await fixture({ observe: undefined });
        await f.service.projects();
        await f.service.board(f.feature);
        f.service.dispose();
        expect(watch).not.toHaveBeenCalled();
    });
    it('keeps project/feature/direct-task layers and empty indexed projects', async () => {
        const f = await fixture();
        const result = await f.service.projects();
        expect(result.projects.map(project => project.title)).toEqual(['Direct project', 'Empty project', 'Project']);
        expect(result.projects[0].direct?.featurePath).toBe(join(f.root, 'direct'));
        expect(result.projects[1].direct?.featurePath).toBe(join(f.root, 'empty'));
        expect((await f.service.board(result.projects[1].direct!.featurePath)).snapshot.tasks).toEqual([]);
        expect(result.projects[2].features.map(feature => feature.featurePath)).toEqual([f.feature]);
        expect(f.task.acceptanceCriteria).toEqual(['Open the real deliverable']);
    });
    it('keeps sibling feature Tasks and intermediate outputs out of the selected final-delivery board', async () => {
        const f = await fixture();
        const other = join(f.root, 'p/features/other');
        await f.put(join(f.feature, 'index.md'), '# Feature\n[Related project](../other/index.md)');
        await f.put(join(other, 'index.md'), '# Other\n[Task](tasks/other/index.md)');
        await f.put(join(other, 'tasks/other/index.md'), '---\nstatus: pending\n---\n# Unrelated task');
        await f.put(join(f.taskDirectory, 'debug.log'), 'intermediate');
        await f.put(join(f.taskDirectory, 'index.md'), '---\nstatus: pending\n---\n# Task\n## 阶段产物\n[Debug](debug.log)\n## 最终交付\n[Final](report.md)');
        const board = await f.service.board(f.feature);
        expect(board.snapshot.tasks.map(task => task.title)).toEqual(['Task']);
        expect(board.snapshot.tasks[0].artifacts.filter(artifact => artifact.relation === 'output').map(artifact => artifact.name)).toEqual(['Final']);
        const otherTask = (await f.service.board(other)).snapshot.tasks[0];
        await expect(f.service.files({ featurePath: f.feature, taskId: otherTask.id, path: otherTask.indexPath }, 'read')).rejects.toThrow('not in this feature');
    });
    it('new conversations remain empty and do not consume first execution', async () => {
        const f = await fixture();
        const input = { ...f.input, requestId: 'discussion', action: 'chat' as const, agent: 'codex' as const };
        const first = await f.service.launch(input);
        expect(await f.service.launch(input)).toEqual(first);
        expect(f.deps.spawn).toHaveBeenCalledTimes(1);
        expect(f.deps.spawn).toHaveBeenCalledWith(expect.objectContaining({ directory: f.taskDirectory }));
        expect(f.deps.send).not.toHaveBeenCalled();
        const board = await f.make().board(f.feature);
        expect(board.snapshot.tasks[0].execution?.state).toBe('never');
        expect(board.sessions).toEqual({});
        expect((await f.service.historyPage(f.input)).sessions).toHaveLength(1);
    });
    it('concurrent clicks and daemon restart submit the initial prompt only once', async () => {
        const f = await fixture();
        const input = { ...f.input, requestId: 'run-a', action: 'execute' as const, agent: 'codex' as const };
        const values = await Promise.all([f.service.launch(input), f.make().launch({ ...input, requestId: 'run-b' })]);
        expect(values.filter(value => value.type === 'success').length).toBeGreaterThanOrEqual(1);
        expect(f.deps.spawn).toHaveBeenCalledTimes(1);
        expect(f.deps.send).toHaveBeenCalledTimes(1);
        expect(f.deps.send).toHaveBeenCalledWith(expect.any(String), expect.stringContaining(join(f.taskDirectory, 'PROMPT.md')), expect.any(String));
        expect(await f.make().launch({ ...input, requestId: 'run-c' })).toMatchObject({ type: 'success' });
        expect(f.deps.send).toHaveBeenCalledTimes(1);
        expect((await f.make().board(f.feature)).snapshot.tasks[0].execution?.state).toBe('submitted');
    });
    it('unknown delivery never re-submits after a failed response or restart', async () => {
        const send = vi.fn(async () => { throw new Error('connection lost after send'); });
        const f = await fixture({ send });
        const input = { ...f.input, requestId: 'run-a', action: 'execute' as const, agent: 'codex' as const };
        expect(await f.service.launch(input)).toMatchObject({ type: 'error' });
        expect((await f.make().board(f.feature)).snapshot.tasks[0].execution?.state).toBe('uncertain');
        await f.make().launch({ ...input, requestId: 'different' });
        expect(send).toHaveBeenCalledTimes(1);
        expect(f.deps.spawn).toHaveBeenCalledTimes(1);
    });
    it('actual old executions block first launch while blank discussions do not', async () => {
        const f = await fixture();
        const session = { sessionId: 'old', title: 'Old conversation', directory: f.taskDirectory, updatedAt: 1, executed: false, metadata: { path: f.taskDirectory } } as ProjectSession;
        f.history.push(session);
        expect((await f.service.board(f.feature)).snapshot.tasks[0].execution?.state).toBe('never');
        session.executed = true;
        expect((await f.service.board(f.feature)).snapshot.tasks[0].execution?.state).toBe('historical');
        expect(await f.service.launch({ ...f.input, requestId: 'run', action: 'execute', agent: 'codex' })).toMatchObject({ type: 'error' });
        expect(f.deps.spawn).not.toHaveBeenCalled();
        f.history.splice(0);
        expect((await f.make().board(f.feature)).snapshot.tasks[0].execution?.state).toBe('historical');
    });
    it('acceptance binds the bytes and a changed final file invalidates it', async () => {
        const f = await fixture();
        const output = (await f.service.board(f.feature)).snapshot.tasks[0].artifacts.find(artifact => artifact.relation === 'output')!;
        const expectedHash = createHash('sha256').update('# Version one').digest('hex');
        await f.service.approve({ ...f.input, artifactId: output.id, expectedRevision: output.revision, expectedHash });
        expect(f.deps.changed).toHaveBeenCalled();
        expect((await f.make().board(f.feature)).snapshot.tasks[0].artifacts[0].approval?.status).toBe('accepted');
        await f.put(join(f.taskDirectory, 'report.md'), '# Version two');
        expect((await f.service.board(f.feature)).snapshot.tasks[0].artifacts[0].approval?.status).toBe('changed');
        await expect(f.service.approve({ ...f.input, artifactId: output.id, expectedRevision: output.revision, expectedHash })).rejects.toThrow('changed');
    });
    it('file chunks are bounded and cannot escape the Task archive through paths or symlinks', async () => {
        const f = await fixture();
        await f.put(join(f.taskDirectory, 'large.txt'), Buffer.alloc(180000, 'a'));
        const first = await f.service.files({ ...f.input, path: join(f.taskDirectory, 'large.txt') }, 'read') as any;
        expect(Buffer.from(first.content, 'base64')).toHaveLength(64 * 1024);
        expect(first.size).toBe(180000);
        await f.put(join(f.taskDirectory, 'large.txt'), Buffer.alloc(180001, 'b'));
        await expect(f.service.files({ ...f.input, path: join(f.taskDirectory, 'large.txt'), transferId: first.transferId, revision: first.revision, offset: 65536 }, 'read')).rejects.toThrow('changed');
        await f.put(join(f.feature, 'private.md'), 'outside this task');
        await symlink(join(f.feature, 'private.md'), join(f.taskDirectory, 'escape.md'));
        await expect(f.service.files({ ...f.input, path: join(f.taskDirectory, 'escape.md') }, 'read')).rejects.toThrow('escapes');
        await expect(f.service.files({ ...f.input, path: join(f.feature, 'private.md') }, 'read')).rejects.toThrow('escapes');
        await expect(f.service.board('/etc')).rejects.toThrow('outside');
    });
    it('paginates every Task conversation without enlarging the board frame', async () => {
        const f = await fixture();
        for (let i = 0; i < 67; i++) f.history.push({ sessionId: `s-${String(i).padStart(3, '0')}`, title: 'Conversation ' + 'x'.repeat(1500), directory: f.taskDirectory, updatedAt: i, executed: false, metadata: { path: f.taskDirectory } } as ProjectSession);
        const board = await f.service.board(f.feature);
        expect(Buffer.byteLength(JSON.stringify(board))).toBeLessThan(64 * 1024);
        const found: string[] = []; let cursor;
        do {
            const page = await f.service.historyPage({ ...f.input, cursor });
            expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(90 * 1024);
            found.push(...page.sessions.map(session => session.sessionId)); cursor = page.nextCursor;
        } while (cursor);
        expect(new Set(found).size).toBe(67);
        expect(found[0]).toBe('s-066');
    });
    it('transfers a large archive after one Task authorization instead of reparsing for every chunk', async () => {
        const f = await fixture();
        for (let i = 0; i < 12; i++) await f.put(join(f.feature, `tasks/other-${i}/index.md`), '---\nstatus: pending\n---\n# Other');
        const bytes = Buffer.alloc(1024 * 1024 + 43000, 'x');
        await f.put(join(f.taskDirectory, 'large.bin'), bytes);
        const parse = vi.spyOn(parser, 'parseBoard');
        try {
            let offset = 0, revision, transferId;
            const chunks: Buffer[] = [];
            do {
                const result = await f.service.files({ ...f.input, path: join(f.taskDirectory, 'large.bin'), offset, revision, transferId }, 'read') as any;
                const chunk = Buffer.from(result.content, 'base64'); chunks.push(chunk); offset += chunk.length; revision = result.revision; transferId = result.transferId;
                expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(90 * 1024);
            } while (offset < bytes.length);
            expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
            expect(parse).toHaveBeenCalledTimes(1);
        } finally { parse.mockRestore(); }
    });
    it('accepts an explicitly opened final link and invalidates acceptance for a new link', async () => {
        const f = await fixture();
        await f.put(join(f.taskDirectory, 'index.md'), '---\nstatus: pending\n---\n# Task\n## 最终交付\n[PR](https://github.com/example/project/commit/abcdef123)');
        const artifact = (await f.service.board(f.feature)).snapshot.tasks[0].artifacts[0];
        await f.service.approve({ ...f.input, artifactId: artifact.id, expectedRevision: artifact.revision });
        expect((await f.make().board(f.feature)).snapshot.tasks[0].artifacts[0].approval?.status).toBe('accepted');
        await f.put(join(f.taskDirectory, 'index.md'), '---\nstatus: pending\n---\n# Task\n## 最终交付\n[PR](https://github.com/example/project/commit/def456)');
        expect((await f.service.board(f.feature)).snapshot.tasks[0].artifacts[0].approval?.status).toBe('unreviewed');
    });
    it('archive saves share the artifact writer lease and preserve manual versions', async () => {
        const f = await fixture();
        const store = new ArtifactStore({ storage: join(f.home, 'artifact-store'), accountScope: 'a'.repeat(64), inventory: async () => [] });
        f.deps.getArtifactStore = async () => store;
        const artifact = await store.register({ root: f.taskDirectory, entryPath: 'report.md', managedPaths: ['report.md'], operationId: 'register' });
        await store.beginTurn({ directory: f.taskDirectory, sessionId: 'writer', runId: 'active', prompt: 'Edit' });
        const input = { ...f.input, path: join(f.taskDirectory, 'report.md'), content: Buffer.from('# Manual').toString('base64'), expectedHash: createHash('sha256').update('# Version one').digest('hex') };
        expect(await f.service.files(input, 'write')).toMatchObject({ success: false, code: 'WRITER_ACTIVE' });
        expect(await readFile(input.path, 'utf8')).toBe('# Version one');
        await store.finishTurn('active', 'completed');
        expect(await f.service.files(input, 'write')).toMatchObject({ success: true });
        expect((await store.versions({ workspaceId: artifact.workspaceId, artifactId: artifact.id })).versions[0].source).toBe('manual');
    });
    // The macOS production path deliberately uses explicit refresh because
    // native FSEvents close can block the process, beyond Vitest's timeout.
    it.skipIf(process.platform === 'darwin')('rebinds archive watchers after replacing an output directory', async () => {
        const f = await fixture({ observe: true });
        await f.put(join(f.taskDirectory, 'out/result.md'), 'One');
        await f.put(join(f.taskDirectory, 'index.md'), '---\nstatus: pending\n---\n# Task\n## 最终交付\n[Final](out/result.md)');
        await f.service.board(f.feature);
        await f.put(join(f.taskDirectory, 'replacement/result.md'), 'Two');
        await rename(join(f.taskDirectory, 'out'), join(f.taskDirectory, 'old-out'));
        await rename(join(f.taskDirectory, 'replacement'), join(f.taskDirectory, 'out'));
        await f.service.board(f.feature);
        vi.mocked(f.deps.changed).mockClear();
        await f.put(join(f.taskDirectory, 'out/result.md'), 'Three');
        await vi.waitFor(() => expect(f.deps.changed).toHaveBeenCalled(), { timeout: 5000 });
    });
});
