import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath, rename, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectGoalService, registerProjectGoalHandlers, type ProjectGoalDependencies, type ProjectSession } from './projectService';
import { ArtifactStore } from '../artifacts/store';
import * as parser from './parser';
import { GOAL_CANVAS_LIMITS, writeGoalDeliveryAgreement } from '@slopus/happy-wire';

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
    it('browses the whole selected goal while rejecting sibling archives and write attempts', async () => {
        const f = await fixture();
        const listed = await f.service.files({ featurePath: f.feature, path: f.feature }, 'list', true, true);
        expect(listed.success).toBe(true);
        if (!('entries' in listed)) throw new Error('Expected directory response');
        expect(listed.entries.map(entry => entry.name)).toContain('index.md');
        const file = await f.service.files({ featurePath: f.feature, path: join(f.feature, 'index.md') }, 'read', true, true);
        if (!('content' in file) || typeof file.content !== 'string') throw new Error('Expected file response');
        expect(Buffer.from(file.content, 'base64').toString()).toBe('# Feature');
        await expect(f.service.files({ featurePath: f.feature, path: join(f.root, 'p/index.md') }, 'read', true, true)).rejects.toThrow();
        await expect(f.service.files({ featurePath: f.feature, path: join(f.feature, 'index.md'), content: '' }, 'write', true, true)).rejects.toThrow('read-only');
        await f.put(join(f.root, 'outside.md'), 'private');
        await symlink(join(f.root, 'outside.md'), join(f.feature, 'escape.md'));
        await expect(f.service.files({ featurePath: f.feature, path: join(f.feature, 'escape.md') }, 'read', true, true)).rejects.toThrow();
        await symlink(join(f.root, 'outside.md'), join(f.taskDirectory, 'outside-final.md'));
        const source = await readFile(join(f.taskDirectory, 'index.md'), 'utf8');
        await f.put(join(f.taskDirectory, 'index.md'), writeGoalDeliveryAgreement(source, { expectedDeliverables: [], acceptanceCriteria: [], finalOutputs: [{ name: 'Unopenable final', target: 'outside-final.md' }] }));
        expect((await f.service.board(f.feature)).snapshot.tasks[0].artifacts.find(artifact => artifact.name === 'Unopenable final')).toMatchObject({ available: false, relation: 'output' });
    });
    it('persists delivery changes through the actual file API and does not accept final versions', async () => {
        const f = await fixture();
        const index = join(f.taskDirectory, 'index.md');
        const original = await readFile(index, 'utf8');
        await f.put(join(f.taskDirectory, '成果/报告 #1.md'), 'A real selected final');
        const content = writeGoalDeliveryAgreement(original, { expectedDeliverables: ['A selected report', '[Report](<成果/报告%20%231.md>)'], acceptanceCriteria: ['Open it'], finalOutputs: [{ name: '最终计划报告', target: '成果/报告 #1.md' }] });
        const saved = await f.service.files({ ...f.input, path: index, content: Buffer.from(content).toString('base64'), expectedHash: createHash('sha256').update(original).digest('hex') }, 'write');
        expect(saved.success).toBe(true);
        const task = (await f.service.board(f.feature)).snapshot.tasks[0];
        expect(task.expectedDeliverables).toEqual(['A selected report', '[Report](<成果/报告%20%231.md>)']);
        expect(task.acceptanceCriteria).toEqual(['Open it']);
        expect(task.artifacts.filter(artifact => artifact.relation === 'output')).toMatchObject([{ name: '最终计划报告', available: true, approval: { status: 'unreviewed' } }]);
        expect(task.artifacts.find(artifact => artifact.name === 'Report')?.relation).toBe('reference');
        expect(await readFile(index, 'utf8')).toContain('目标：Actual goal');
        const stale = await f.service.files({ ...f.input, path: index, content: Buffer.from('old write').toString('base64'), expectedHash: createHash('sha256').update(original).digest('hex') }, 'write');
        expect(stale.success).toBe(false);
        expect(await readFile(index, 'utf8')).toBe(content);
    });
    it('keeps feature read-only transfers separate from writable project scope transfers', async () => {
        const f = await fixture();
        const path = join(f.taskDirectory, 'large-feature.md');
        await f.put(path, 'x'.repeat(70 * 1024));
        const input = { featurePath: f.feature, path };
        const chunk = await f.service.files(input, 'read', true, true);
        if (!('revision' in chunk) || !('transferId' in chunk)) throw new Error('Expected a file transfer');
        const next = { ...input, offset: 65536, revision: chunk.revision, transferId: chunk.transferId };
        await expect(f.service.files(next, 'read', true)).rejects.toThrow('expired or changed');
        expect(await f.service.files(next, 'read', true, true)).toMatchObject({ success: true, offset: 65536 });
        await expect(f.service.files({ ...f.input, path }, 'read', true, true)).rejects.toThrow('read-only');
    });
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

it.each(['archived', 'archiveRequested'])('filters %s scope sessions before the 25-row limit', async lifecycleState => {
    const f = await fixture();
    for (let i = 0; i < 25; i++) f.history.push({ sessionId: `hidden-${i}`, title: 'Archived', directory: f.feature, updatedAt: 100 + i, executed: true, metadata: { path: f.feature, lifecycleState } } as ProjectSession);
    f.history.push({ sessionId: 'available', title: 'Available', directory: f.feature, updatedAt: 1, executed: false, metadata: { path: f.feature, lifecycleState: 'running' } } as ProjectSession);
    expect((await f.service.scopeHistory({ scopePath: f.feature })).sessions.map(session => session.sessionId)).toEqual(['available']);
});
it('archived source overrides a saved blank association without resetting execution history', async () => {
    const f = await fixture();
    await f.service.launch({ ...f.input, action: 'chat', agent: 'codex', requestId: 'blank-chat' });
    f.history.push({ sessionId: 'session-1', title: 'Archived', directory: f.taskDirectory, updatedAt: 10, executed: true, metadata: { path: f.taskDirectory, lifecycleState: 'archived' } } as ProjectSession);
    expect((await f.service.historyPage(f.input)).sessions).toEqual([]);
    expect((await f.service.board(f.feature)).snapshot.tasks[0].execution?.state).toBe('historical');
});


describe('stable task ownership', () => {
    async function stable() {
        const f = await fixture();
        const index = join(f.taskDirectory, 'index.md');
        await f.put(index, (await readFile(index, 'utf8')).replace('status: pending', 'status: pending\ntask_id: GFT-abcdefgh'));
        return f;
    }
    it('uses the archive ID and keeps a conversation and launch receipt after a task moves to another feature', async () => {
        const f = await stable();
        const task = (await f.service.board(f.feature)).snapshot.tasks[0];
        expect(task.id).toBe('GFT-abcdefgh');
        const input = { ...f.input, taskId: task.id, action: 'chat', agent: 'codex', requestId: 'same-request' };
        expect(await f.service.launch(input)).toMatchObject({ sessionId: 'session-1' });
        const old = { sessionId: 'session-1', path: f.taskDirectory };
        expect(await f.service.resolveWorkspace(old)).toMatchObject({ workspace: { taskId: task.id, featurePath: f.feature } });
        const next = join(f.root, 'new-project/features/moved');
        await f.put(join(f.root, 'new-project/index.md'), '# New project');
        await f.put(join(next, 'index.md'), '# Moved feature');
        await mkdir(join(next, 'tasks'), { recursive: true });
        await rename(f.taskDirectory, join(next, 'tasks/renamed'));
        const service = f.make(); // Also survives daemon restart, without a compatibility symlink.
        expect(await service.resolveWorkspace(old)).toMatchObject({ workspace: { projectPath: join(f.root, 'new-project'), featurePath: next, taskId: task.id } });
        expect(await service.launch({ ...input, featurePath: next })).toMatchObject({ sessionId: 'session-1' });
        expect((await service.historyPage({ featurePath: next, taskId: task.id })).sessions).toMatchObject([{ sessionId: 'session-1', directory: join(next, 'tasks/renamed') }]);
        expect(f.deps.spawn).toHaveBeenCalledTimes(1);
    });
    it('recovers a legacy symlink and old path hash, but rejects duplicate stable IDs and removed tasks', async () => {
        const f = await stable();
        const legacyId = parser.digest(join(f.taskDirectory, 'index.md'));
        const next = join(f.feature, 'tasks/renamed');
        await rename(f.taskDirectory, next); await symlink(next, f.taskDirectory);
        const old = { sessionId: 'legacy', path: f.taskDirectory, goalBoard: { featurePath: f.feature, taskId: legacyId } };
        expect(await f.service.resolveWorkspace(old)).toMatchObject({ workspace: { taskId: 'GFT-abcdefgh' } });
        await f.put(join(f.feature, 'tasks/copy/index.md'), '---\ntask_id: GFT-abcdefgh\n---\n# Duplicate');
        expect(await f.service.resolveWorkspace(old)).toMatchObject({ workspace: null });
        await rm(join(f.feature, 'tasks/copy'), { recursive: true });
        await rm(next, { recursive: true });
        expect(await f.service.resolveWorkspace(old)).toMatchObject({ workspace: null });
    });
    it('never guesses ownership from a title, an outside symlink or stale explicit ID', async () => {
        const f = await stable();
        await f.service.board(f.feature);
        expect(await f.service.resolveWorkspace({ sessionId: 'outside', path: f.home })).toMatchObject({ workspace: null });
        expect(await f.service.resolveWorkspace({ sessionId: 'stale', path: f.taskDirectory, goalBoard: { featurePath: f.feature, taskId: 'GFT-deleted1' } })).toMatchObject({ workspace: null });
    });
});

it('stores bindings through a symlinked storage root without treating its lexical alias as an escape', async () => {
    const f = await fixture();
    await f.put(join(f.taskDirectory, 'index.md'), '---\ntask_id: GFT-abcdefgh\n---\n# Stable');
    await mkdir(join(f.home, 'state'), { recursive: true });
    const alias = join(f.home, 'state-alias'); await symlink(join(f.home, 'state'), alias);
    const service = createProjectGoalService({ ...f.deps, storageDirectory: alias });
    cleanups.push(() => service.dispose());
    expect(await service.resolveWorkspace({ sessionId: 'alias', path: f.taskDirectory })).toMatchObject({ workspace: { taskId: 'GFT-abcdefgh' } });
});

it('gives a legacy task a persistent archive ID before launching its first linked conversation', async () => {
    const f = await fixture();
    const oldId = f.task.id;
    expect(await f.service.launch({ ...f.input, action: 'chat', agent: 'codex', requestId: 'legacy-id' })).toMatchObject({ sessionId: 'session-1' });
    const task = (await f.service.board(f.feature)).snapshot.tasks[0];
    expect(task.id).toMatch(/^GFT-[a-z0-9]{8}$/);
    expect(task.legacyIds).toContain(oldId);
    expect(await readFile(join(f.taskDirectory, 'index.md'), 'utf8')).toContain(`task_id: ${task.id}`);
    expect(await f.service.launch({ featurePath: f.feature, taskId: oldId, action: 'chat', agent: 'codex', requestId: 'legacy-id' })).toMatchObject({ sessionId: 'session-1' });
    expect(f.deps.spawn).toHaveBeenCalledTimes(1);
});

it('does not mistake a third copy for unique after a feature hides its own duplicate IDs', async () => {
    const f = await fixture();
    for (const path of ['tasks/a', 'tasks/b']) await f.put(join(f.feature, path, 'index.md'), '---\ntask_id: GFT-abcdefgh\n---\n# Duplicate');
    const other = join(f.root, 'p/features/other');
    await f.put(join(other, 'index.md'), '# Other');
    await f.put(join(other, 'tasks/c/index.md'), '---\ntask_id: GFT-abcdefgh\n---\n# Third');
    expect(await f.service.resolveWorkspace({ sessionId: 'third', path: join(other, 'tasks/c'), goalBoard: { featurePath: other, taskId: 'GFT-abcdefgh' } })).toMatchObject({ workspace: null });
    await expect(f.service.historyPage({ featurePath: other, taskId: parser.digest(join(other, 'tasks/c/index.md')) })).rejects.toThrow();
});
it('does not transfer a former task history or path-keyed execution receipt to a new task reusing the directory', async () => {
    const f = await fixture();
    await f.put(join(f.taskDirectory, 'index.md'), '---\ntask_id: GFT-aaaaaaaa\nstatus: pending\n---\n# Original');
    await f.service.board(f.feature);
    await f.put(join(f.home, 'state', parser.digest(f.taskDirectory), 'execution.json'), JSON.stringify({ requestId: 'old', directory: f.taskDirectory, state: 'submitted', sessionId: 'old-session', createdAt: 1 }));
    await rename(f.taskDirectory, join(f.feature, 'tasks/moved'));
    await f.put(join(f.taskDirectory, 'index.md'), '---\ntask_id: GFT-bbbbbbbb\nstatus: pending\n---\n# Replacement');
    f.history.push({ sessionId: 'old-session', directory: f.taskDirectory, title: 'Original', executed: true, updatedAt: 1, metadata: { path: f.taskDirectory } as any });
    const board = await f.service.board(f.feature);
    const replacement = board.snapshot.tasks.find(task => task.id === 'GFT-bbbbbbbb')!;
    expect(replacement.execution?.state).toBe('never');
    expect((await f.service.historyPage({ featurePath: f.feature, taskId: replacement.id })).sessions).toEqual([]);
    expect(await f.service.resolveWorkspace({ sessionId: 'unbound', path: f.taskDirectory })).toMatchObject({ workspace: null });
    await expect(f.service.historyPage({ featurePath: f.feature, taskId: parser.digest(join(f.taskDirectory, 'index.md')) })).rejects.toThrow();
});

it('keeps an already bound session with its original task when the old path is reused', async () => {
    const f = await fixture();
    await f.put(join(f.taskDirectory, 'index.md'), '---\ntask_id: GFT-aaaaaaaa\nstatus: pending\n---\n# Original');
    await f.service.resolveWorkspace({ sessionId: 'bound', path: f.taskDirectory });
    await rename(f.taskDirectory, join(f.feature, 'tasks/moved'));
    await f.put(join(f.taskDirectory, 'index.md'), '---\ntask_id: GFT-bbbbbbbb\nstatus: pending\n---\n# Replacement');
    f.history.push({ sessionId: 'bound', directory: f.taskDirectory, title: 'Original', executed: true, updatedAt: 1, metadata: { path: f.taskDirectory } as any });
    await f.service.board(f.feature);
    expect((await f.service.historyPage({ featurePath: f.feature, taskId: 'GFT-aaaaaaaa' })).sessions.map(session => session.sessionId)).toEqual(['bound']);
    expect((await f.service.historyPage({ featurePath: f.feature, taskId: 'GFT-bbbbbbbb' })).sessions).toEqual([]);
});

it('rejects a stale hash when a former stable task directory is reused by an unlabelled task', async () => {
    const f = await fixture();
    await f.put(join(f.taskDirectory, 'index.md'), '---\ntask_id: GFT-aaaaaaaa\n---\n# Original');
    await f.service.board(f.feature);
    await rename(f.taskDirectory, join(f.feature, 'tasks/moved'));
    await f.put(join(f.taskDirectory, 'index.md'), '# Unlabelled replacement');
    await expect(f.service.historyPage(f.input)).rejects.toThrow();
    await expect(f.service.files({ ...f.input, path: join(f.taskDirectory, 'index.md') }, 'read')).rejects.toThrow();
    await expect(f.service.launch({ ...f.input, action: 'execute', agent: 'codex', requestId: 'stale' })).rejects.toThrow();
    expect(f.deps.spawn).not.toHaveBeenCalled();
});

describe('project conversation navigation', () => {
    it('returns exact totals beyond 25 with scope-global and task conversations in the same feature group', async () => {
        const f = await fixture(); const projectPath = join(f.root, 'p');
        for (let i = 0; i < 31; i++) f.history.push({ sessionId: `task-${i}`, title: `Task ${i}`, directory: f.taskDirectory, updatedAt: i,
            executed: true, metadata: { path: f.taskDirectory, goalBoard: { featurePath: f.feature, taskId: f.task.id } } as any });
        f.history.push({ sessionId: 'project-global', title: 'Project global', directory: projectPath, updatedAt: 50, executed: false, metadata: { path: projectPath } as any });
        f.history.push({ sessionId: 'feature-global', title: 'Feature global', directory: f.feature, updatedAt: 99, executed: false, metadata: { path: f.feature, goalBoard: { featurePath: f.feature } } as any });
        f.history.push({ sessionId: 'archived', title: 'Archived', directory: f.feature, updatedAt: 200, executed: false, metadata: { path: f.feature, lifecycleState: 'archived' } as any });
        f.history.push({ sessionId: 'outside', title: 'Outside', directory: f.home, updatedAt: 200, executed: false, metadata: { path: f.home } as any });
        vi.mocked(f.deps.history).mockClear();
        const result = await f.service.conversations({ projectPath });
        expect(result.groups.map(group => [group.scopePath, group.total])).toEqual([[projectPath, 1], [f.feature, 32]]);
        const group = result.groups[1]; expect(group.sessions).toHaveLength(25);
        expect(group.sessions[0]).toMatchObject({ sessionId: 'feature-global' });
        expect(group.sessions[1]).toMatchObject({ taskId: f.task.id, sessionId: 'task-30' });
        expect(group.sessions[1]).not.toHaveProperty('metadata');
        expect(f.deps.history).toHaveBeenCalledTimes(1);
        expect(f.deps.history).toHaveBeenCalledWith(projectPath, expect.any(Array), { headersOnly: true });
        const next = await f.service.conversations({ projectPath, scopePath: f.feature, cursor: group.nextCursor });
        expect(next.groups).toHaveLength(1); expect(next.groups[0].total).toBe(32); expect(next.groups[0].sessions).toHaveLength(7); expect(next.groups[0].nextCursor).toBeUndefined();
        expect(new Set([...group.sessions, ...next.groups[0].sessions].map(session => session.sessionId)).size).toBe(32);
    });
    it('includes empty groups and rejects a feature or sibling group masquerading as the requested project', async () => {
        const f = await fixture(); await f.put(join(f.root, 'p/features/empty/index.md'), '# Empty feature');
        const result = await f.service.conversations({ projectPath: join(f.root, 'p') });
        expect(result.groups).toHaveLength(3); expect(result.groups.every(group => group.total === 0 && group.sessions.length === 0)).toBe(true);
        await expect(f.service.conversations({ projectPath: f.feature })).rejects.toThrow('authorized');
        await expect(f.service.conversations({ projectPath: join(f.root, 'p'), scopePath: join(f.root, 'empty') })).rejects.toThrow('outside this project');
        await expect(f.service.conversations({ projectPath: join(f.root, 'p'), cursor: { updatedAt: 1, sessionId: 'x' } })).rejects.toThrow('pagination');
    });
    it('keeps exact totals while byte-bounding large titles and independently pages the remainder', async () => {
        const f = await fixture();
        for (let i = 0; i < 50; i++) f.history.push({ sessionId: `large-${i}`, title: '标题'.repeat(1024), directory: f.feature, updatedAt: i, executed: true, metadata: { path: f.feature } as any });
        const group = (await f.service.conversations({ projectPath: join(f.root, 'p') })).groups.find(group => group.scopePath === f.feature)!;
        expect(group.total).toBe(50); expect(group.sessions.length).toBeGreaterThan(0); expect(group.sessions.length).toBeLessThan(25);
        expect(Buffer.byteLength(JSON.stringify(group.sessions))).toBeLessThan(64 * 1024); expect(group.nextCursor).toBeDefined();
    });
    it('does not misreport a failed complete history read as zero conversations', async () => {
        const f = await fixture(); vi.mocked(f.deps.history).mockRejectedValue(new Error('Complete session history unavailable'));
        await expect(f.service.conversations({ projectPath: join(f.root, 'p') })).rejects.toThrow('Complete session history');
    });
    it('keeps a moved stable task with its current feature and rejects stale explicit identities', async () => {
        const f = await fixture(); await f.put(join(f.taskDirectory, 'index.md'), '---\ntask_id: GFT-abcdefgh\n---\n# Stable');
        await f.service.resolveWorkspace({ sessionId: 'bound', path: f.taskDirectory });
        const next = join(f.root, 'p/features/moved'); await f.put(join(next, 'index.md'), '# Moved feature'); await mkdir(join(next, 'tasks'), { recursive: true }); await rename(f.taskDirectory, join(next, 'tasks/task'));
        f.history.push({ sessionId: 'bound', title: 'Stable', directory: f.taskDirectory, updatedAt: 1, executed: true, metadata: { path: f.taskDirectory, goalBoard: { featurePath: f.feature, taskId: 'GFT-abcdefgh' } } as any });
        f.history.push({ sessionId: 'stale', title: 'Stale', directory: join(next, 'tasks/task'), updatedAt: 1, executed: true, metadata: { path: join(next, 'tasks/task'), goalBoard: { featurePath: next, taskId: 'GFT-missing1' } } as any });
        const groups = (await f.service.conversations({ projectPath: join(f.root, 'p') })).groups;
        expect(groups.find(group => group.scopePath === f.feature)?.total).toBe(0);
        expect(groups.find(group => group.scopePath === next)?.sessions).toMatchObject([{ sessionId: 'bound', taskId: 'GFT-abcdefgh', directory: join(next, 'tasks/task') }]);
    });
    it('excludes ambiguous duplicate task identities rather than using a matching directory', async () => {
        const f = await fixture(); for (const dir of ['tasks/a', 'tasks/copy']) await f.put(join(f.feature, dir, 'index.md'), '---\ntask_id: GFT-abcdefgh\n---\n# Duplicate');
        f.history.push({ sessionId: 'ambiguous', title: 'Duplicate', directory: f.taskDirectory, updatedAt: 1, executed: true, metadata: { path: f.taskDirectory, goalBoard: { featurePath: f.feature, taskId: 'GFT-abcdefgh' } } as any });
        expect((await f.service.conversations({ projectPath: join(f.root, 'p') })).groups.every(group => group.total === 0)).toBe(true);
    });
});

it('never transfers unbound reused-path history or conflicting explicit bindings into replacement tasks', async () => {
    const f = await fixture();
    await f.put(join(f.taskDirectory, 'index.md'), '---\ntask_id: GFT-aaaaaaaa\n---\n# Original');
    await f.service.resolveWorkspace({ sessionId: 'original-bound', path: f.taskDirectory });
    await f.service.resolveWorkspace({ sessionId: 'conflict', path: f.taskDirectory });
    const moved = join(f.feature, 'tasks/moved');
    await rename(f.taskDirectory, moved);
    await f.put(join(f.taskDirectory, 'index.md'), '---\ntask_id: GFT-bbbbbbbb\n---\n# Replacement');
    for (const sessionId of ['original-bound', 'unbound-old', 'conflict']) f.history.push({ sessionId, title: sessionId, directory: f.taskDirectory, updatedAt: 1, executed: true,
        metadata: { path: f.taskDirectory, ...(sessionId === 'conflict' ? { goalBoard: { featurePath: f.feature, taskId: 'GFT-bbbbbbbb' } } : {}) } as any });
    const group = (await f.service.conversations({ projectPath: join(f.root, 'p') })).groups.find(group => group.scopePath === f.feature)!;
    expect(group.total).toBe(1);
    expect(group.sessions).toMatchObject([{ sessionId: 'original-bound', taskId: 'GFT-aaaaaaaa', directory: moved }]);
});

it('refuses aggregate totals when a board explicitly reports truncated tasks, while legacy board reads remain available', async () => {
    const f = await fixture(); const original = parser.parseBoard;
    const spy = vi.spyOn(parser, 'parseBoard').mockImplementation(async (...args) => {
        const parsed = await original(...args); parsed.snapshot.warnings.push('Snapshot size limit reached; board is truncated'); return parsed;
    });
    try {
        await expect(f.service.conversations({ projectPath: join(f.root, 'p') })).rejects.toThrow('Task catalog is incomplete');
        expect((await f.service.board(f.feature)).snapshot.tasks).toHaveLength(1);
    } finally { spy.mockRestore(); }
});
it('refuses silent task-directory truncation in aggregate reads', async () => {
    const f = await fixture(); await Promise.all(Array.from({ length: 200 }, (_, i) => mkdir(join(f.feature, 'tasks', `extra-${i}`), { recursive: true })));
    await expect(f.service.conversations({ projectPath: join(f.root, 'p') })).rejects.toThrow('Task directory limit reached');
});
it('refuses aggregate totals when feature directory discovery would silently truncate', async () => {
    const f = await fixture(); await Promise.all(Array.from({ length: 100 }, (_, i) => mkdir(join(f.root, 'p/features', `extra-${i}`), { recursive: true })));
    await expect(f.service.conversations({ projectPath: join(f.root, 'p') })).rejects.toThrow('Feature directory limit reached');
});

it('does not let stale task links in another project block complete selected-project totals', async () => {
    const f = await fixture();
    await f.put(join(f.root, 'other/index.md'), '# Other project');
    await f.put(join(f.root, 'other/features/broken/index.md'), '# Unrelated feature\n[Missing task](tasks/missing/index.md)');
    f.history.push({ sessionId: 'selected', title: 'Selected', directory: f.feature, updatedAt: 1, executed: false, metadata: { path: f.feature } as any });
    const result = await f.service.conversations({ projectPath: join(f.root, 'p') });
    expect(result.groups.find(group => group.scopePath === f.feature)?.total).toBe(1);
    await expect(f.service.conversations({ projectPath: join(f.root, 'other') })).rejects.toThrow('Task catalog is incomplete');
});
it('still refuses actual catalog truncation in another project because duplicate identity checks would be incomplete', async () => {
    const f = await fixture();
    await f.put(join(f.root, 'other/index.md'), '# Other project');
    await f.put(join(f.root, 'other/features/large/index.md'), '# Other feature');
    const original = parser.parseBoard;
    const spy = vi.spyOn(parser, 'parseBoard').mockImplementation(async (...args) => {
        const parsed = await original(...args);
        if (args[0].projectPath === join(f.root, 'other')) parsed.snapshot.warnings.push('Task limit reached; board is truncated');
        return parsed;
    });
    try { await expect(f.service.conversations({ projectPath: join(f.root, 'p') })).rejects.toThrow('Task catalog is incomplete'); }
    finally { spy.mockRestore(); }
});

it('passes compact owner header candidates only into this read without persisting them', async () => {
    const f = await fixture(); const projectPath = join(f.root, 'p');
    const candidates = [{ sessionId: 'owned', metadataVersion: 2, directory: f.feature, title: 'Owned', featurePath: f.feature }];
    vi.mocked(f.deps.history).mockClear();
    await f.service.conversations({ projectPath, candidates, catalogFingerprint: 'a'.repeat(64) });
    expect(f.deps.history).toHaveBeenLastCalledWith(projectPath, expect.any(Array), { headersOnly: true, headerCandidates: candidates, catalogFingerprint: 'a'.repeat(64) });
    await f.service.conversations({ projectPath });
    expect(f.deps.history).toHaveBeenLastCalledWith(projectPath, expect.any(Array), { headersOnly: true });
});
it('bounds candidate count and serialized request bytes before reading account history', async () => {
    const f = await fixture(); const projectPath = join(f.root, 'p');
    vi.mocked(f.deps.history).mockClear();
    const candidate = { sessionId: 's', metadataVersion: 1, directory: '/x', title: 'x' };
    await expect(f.service.conversations({ projectPath, candidates: Array.from({ length: 20001 }, (_, i) => ({ ...candidate, sessionId: `${i}` })) })).rejects.toThrow();
    await expect(f.service.conversations({ projectPath, candidates: Array.from({ length: 1100 }, (_, i) => ({ ...candidate, sessionId: `${i}`, title: 'x'.repeat(2048) })) })).rejects.toThrow('byte limit');
    expect(f.deps.history).not.toHaveBeenCalled();
});

it('requires the complete account catalog fingerprint when owner candidates are supplied', async () => {
    const f = await fixture();
    await expect(f.service.conversations({ projectPath: join(f.root, 'p'), candidates: [] })).rejects.toThrow('fingerprint is required');
    await expect(f.service.conversations({ projectPath: join(f.root, 'p'), candidates: [], catalogFingerprint: 'invalid' })).rejects.toThrow();
});
it('preserves available lifecycle in newer aggregate history after a restore',async()=>{
 const f=await fixture();const projectPath=join(f.root,'p');
 f.history.push({sessionId:'restored',directory:projectPath,title:'Restored',updatedAt:20,executed:true,metadata:{path:projectPath,machineId:'m',lifecycleState:'available'}} as ProjectSession);
 const result=await f.service.conversations({projectPath});expect(result.groups[0].sessions[0]).toMatchObject({sessionId:'restored',lifecycleState:'available'});
});

it('authorizes catalog snapshot projects before delegating and forwards the same snapshot to final history reads', async () => {
    const f = await fixture(); const projectPath = join(f.root, 'p');
    const conversationCatalog = vi.fn(async (path: string) => ({ projectPath: path, snapshotId: 'snapshot', catalogFingerprint: 'a'.repeat(64), total: 0, sessions: [], nextCursor: null, hasNext: false, expiresAt: 999999 }));
    const disposeConversationCatalog = vi.fn();
    const service = createProjectGoalService({ ...f.deps, conversationCatalog, disposeConversationCatalog });
    try {
        await expect(service.conversationCatalog({ projectPath: f.feature })).rejects.toThrow('authorized');
        expect(conversationCatalog).not.toHaveBeenCalled();
        expect((await service.conversationCatalog({ projectPath })).snapshotId).toBe('snapshot');
        await service.conversations({ projectPath, candidates: [], catalogFingerprint: 'a'.repeat(64), catalogSnapshotId: 'snapshot' });
        expect(f.deps.history).toHaveBeenLastCalledWith(projectPath, expect.any(Array), { headersOnly: true, headerCandidates: [], catalogFingerprint: 'a'.repeat(64), snapshotId: 'snapshot' });
        await expect(service.conversations({ projectPath, catalogSnapshotId: 'snapshot', catalogFingerprint: 'a'.repeat(64) })).rejects.toThrow('complete owner candidates');
    } finally { service.dispose(); }
    expect(disposeConversationCatalog).toHaveBeenCalledTimes(1);
});

it('authorizes and forwards catalog manifest and bounded deduplicated ciphertext selections', async () => {
    const f = await fixture(), projectPath = join(f.root, 'p');
    const conversationCatalog = vi.fn(async (path: string) => ({ projectPath: path, snapshotId: 'snapshot', catalogFingerprint: 'a'.repeat(64), total: 0, sessions: [], nextCursor: null, hasNext: false, expiresAt: 999999 }));
    const service = createProjectGoalService({ ...f.deps, conversationCatalog });
    try {
        await expect(service.conversationCatalog({ projectPath: f.feature, format: 'manifest' })).rejects.toThrow('authorized');
        expect(conversationCatalog).not.toHaveBeenCalled();
        await service.conversationCatalog({ projectPath, format: 'manifest' });
        expect(conversationCatalog).toHaveBeenLastCalledWith(projectPath, { snapshotId: undefined, cursor: undefined, format: 'manifest', sessionIds: undefined });
        await service.conversationCatalog({ projectPath, snapshotId: 'snapshot', cursor: '1', sessionIds: ['a', 'b', 'a'] });
        expect(conversationCatalog).toHaveBeenLastCalledWith(projectPath, { snapshotId: 'snapshot', cursor: '1', format: undefined, sessionIds: ['a', 'b'] });
        for (const extra of [
            { sessionIds: ['a'] },
            { snapshotId: 'snapshot', sessionIds: ['a'], format: 'manifest' },
            { snapshotId: 'snapshot', sessionIds: Array.from({ length: 201 }, () => 'a') },
        ]) await expect(service.conversationCatalog({ projectPath, ...extra })).rejects.toThrow();
        expect(conversationCatalog).toHaveBeenCalledTimes(2);
    } finally { service.dispose(); }
});

it('authorizes and bounds explicit snapshot index evidence before forwarding it', async () => {
    const f = await fixture(), projectPath = join(f.root, 'p'), conversationIndex = vi.fn(async () => ({ success: true as const }));
    const service = createProjectGoalService({ ...f.deps, conversationIndex });
    const input = { projectPath, snapshotId: 'snapshot', catalogFingerprint: 'a'.repeat(64), entries: [{ id: 'one', metadataVersion: 1, candidate: null }] };
    try {
        await expect(service.conversationIndex({ ...input, projectPath: f.feature })).rejects.toThrow('authorized');
        expect(conversationIndex).not.toHaveBeenCalled();
        await expect(service.conversationIndex(input)).resolves.toEqual({ success: true });
        expect(conversationIndex).toHaveBeenCalledExactlyOnceWith(projectPath, { snapshotId: input.snapshotId, catalogFingerprint: input.catalogFingerprint, entries: input.entries });
        for (const entries of [
            Array.from({ length: 201 }, (_, i) => ({ id: String(i), metadataVersion: 1, candidate: null })),
            [{ id: 'one', metadataVersion: 1, candidate: null }, { id: 'one', metadataVersion: 1, candidate: null }],
            [{ id: 'one', metadataVersion: 1 }],
            Array.from({ length: 30 }, (_, i) => ({ id: String(i), metadataVersion: 1, candidate: { sessionId: String(i), metadataVersion: 1, directory: '/' + 'a'.repeat(8000), title: 'Large' } })),
        ]) await expect(service.conversationIndex({ ...input, entries })).rejects.toThrow();
        expect(conversationIndex).toHaveBeenCalledTimes(1);
    } finally { service.dispose(); }
});

describe('catalog snapshot release', () => {
    it('authorizes and canonicalizes the project before delegating release', async () => {
        const released: Array<[string, string]> = [];
        const f = await fixture({ releaseConversationCatalog: async (projectPath, snapshotId) => { released.push([projectPath, snapshotId]); return true; } });
        const projectPath = join(f.root, 'p'), alias = join(f.home, 'project-alias');
        await symlink(projectPath, alias);
        await expect(f.service.conversationCatalogRelease({ projectPath: f.feature, snapshotId: 'owned' })).rejects.toThrow('authorized');
        expect(released).toEqual([]);
        expect(await f.service.conversationCatalogRelease({ projectPath: alias, snapshotId: 'owned' })).toEqual({ success: true, released: true });
        expect(released).toEqual([[projectPath, 'owned']]);
    });
    it('returns an idempotent false result without disclosing unavailable tokens', async () => {
        const f = await fixture({ releaseConversationCatalog: async () => false });
        expect(await f.service.conversationCatalogRelease({ projectPath: join(f.root, 'p'), snapshotId: 'unknown-or-foreign' })).toEqual({ success: true, released: false });
    });
    it.each([undefined, '', 'x'.repeat(129)])('rejects a missing or malformed snapshot token (%s)', async snapshotId => {
        const releaseConversationCatalog = vi.fn(async () => true);
        const f = await fixture({ releaseConversationCatalog });
        await expect(f.service.conversationCatalogRelease({ projectPath: join(f.root, 'p'), snapshotId })).rejects.toThrow();
        expect(releaseConversationCatalog).not.toHaveBeenCalled();
    });
    it('reports unsupported release for an older runtime', async () => {
        const f = await fixture();
        await expect(f.service.conversationCatalogRelease({ projectPath: join(f.root, 'p'), snapshotId: 'owned' })).rejects.toThrow(/unsupported.*update/i);
    });
    it('does not dispatch release after the workspace closes during authorization', async () => {
        const releaseConversationCatalog = vi.fn(async () => true);
        const f = await fixture({ releaseConversationCatalog });
        const pending = f.service.conversationCatalogRelease({ projectPath: join(f.root, 'p'), snapshotId: 'owned' });
        f.service.dispose();
        await expect(pending).rejects.toThrow('closed');
        expect(releaseConversationCatalog).not.toHaveBeenCalled();
        await expect(f.service.conversationCatalogRelease({ projectPath: join(f.root, 'p'), snapshotId: 'owned' })).rejects.toThrow('closed');
    });
    it('rejects a result from an async release after the workspace closes', async () => {
        let begin!: () => void, finish!: (released: boolean) => void;
        const entered = new Promise<void>(resolve => { begin = resolve; });
        const result = new Promise<boolean>(resolve => { finish = resolve; });
        const f = await fixture({ releaseConversationCatalog: () => { begin(); return result; } });
        const pending = f.service.conversationCatalogRelease({ projectPath: join(f.root, 'p'), snapshotId: 'owned' });
        await entered; f.service.dispose(); finish(true);
        await expect(pending).rejects.toThrow('closed');
    });
    it('registers the release RPC with the same project authorization and error envelope', async () => {
        const f = await fixture({ releaseConversationCatalog: async () => true });
        const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
        const service = registerProjectGoalHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, f.deps);
        cleanups.push(() => service.dispose());
        const release = handlers.get('goalProjectConversationCatalogRelease');
        expect(release).toBeTypeOf('function');
        expect(await release!({ projectPath: join(f.root, 'p'), snapshotId: 'owned' })).toEqual({ success: true, released: true });
        expect(await release!({ projectPath: f.feature, snapshotId: 'owned' })).toMatchObject({ success: false, error: expect.stringContaining('authorized') });
    });
});

describe('project canvas RPC', () => {
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1sAAAAASUVORK5CYII=', 'base64');
    const jpeg = Buffer.from(
        '/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYzLjEuMTAxAP/bAEMACAQEBAQEBQUFBQUFBgYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgI'
        + 'CAkJCgoKDAwLCw4ODhERFP/EAEsAAQEAAAAAAAAAAAAAAAAAAAAHAQEAAAAAAAAAAAAAAAAAAAAAEAEAAAAAAAAAAAAAAAAAAAAAEQEAAAAAAAAAAAAAAAAAAAAA'
        + '/8AAEQgAAgACAwEiAAIRAAMRAP/aAAwDAQACEQMRAD8Av4AP/9k=', 'base64',
    );

    function sceneEnvelope(...records: Array<{ id: string; typeName: string } & Record<string, unknown>>) {
        return {
            version: 1,
            schema: { schemaVersion: 2, sequences: {} },
            removed: [],
            store: {
                'document:document': { id: 'document:document', typeName: 'document', gridSize: 10, name: '', meta: {} },
                'page:page': { id: 'page:page', typeName: 'page', name: 'Page 1', index: 'a1', meta: {} },
                'user:canvas-guest': { id: 'user:canvas-guest', typeName: 'user', name: '', color: '#39B178', imageUrl: '', meta: {} },
                ...Object.fromEntries(records.map(record => [record.id, record])),
            },
        };
    }

    function sceneImage(assetId: string, shapeId = 'shape:one', meta: Record<string, unknown> = {}) {
        return {
            image: {
                id: assetId, type: 'image', typeName: 'asset', meta: {},
                props: { src: null as string | null, name: 'Raster', w: 100, h: 100, isAnimated: false, mimeType: 'image/jpeg' },
            },
            shape: {
                id: shapeId, type: 'image', typeName: 'shape', meta,
                x: 222, y: 333, rotation: 0, index: 'a1', parentId: 'page:page', isLocked: false, opacity: 1,
                props: { assetId, w: 100, h: 100, playing: true, url: '', crop: null, flipX: false, flipY: false, altText: '' },
            },
        };
    }

    it('isolates projects and persists deduplicated image bytes and revised placements across service instances', async () => {
        const f = await fixture();
        const projectPath = join(f.root, 'p');
        const empty = await f.service.canvas.get({ projectPath });
        expect(empty.canvas).toMatchObject({ revision: 0, assets: [] });
        const upload = { projectPath, name: 'Jackie.png', mimeType: 'image/png', base64: image.toString('base64') };
        const [first, second] = await Promise.all([f.service.canvas.import(upload), f.service.canvas.import(upload)]);
        if (!('canvas' in first) || !('canvas' in second)) throw new Error('Expected completed imports');
        expect(first.canvas).toEqual(second.canvas);
        expect(first.canvas.assets).toHaveLength(1);
        const [asset] = first.canvas.assets;
        expect(asset.versionId).toBe(createHash('sha256').update(image).digest('hex'));
        const attempts = await Promise.allSettled([
            f.service.canvas.layout({ projectPath, revision: first.canvas.revision, placements: [{ id: asset.id, x: 314, y: 159 }] }),
            f.service.canvas.layout({ projectPath, revision: first.canvas.revision, placements: [{ id: asset.id, x: 26, y: 53 }] }),
        ]);
        expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(attempts.find(result => result.status === 'rejected')).toMatchObject({ reason: expect.objectContaining({ message: expect.stringContaining('changed') }) });

        const restored = f.make().canvas;
        const latest = (await restored.get({ projectPath })).canvas;
        expect(latest).toMatchObject({ id: empty.canvas.id, revision: 2 });
        expect([[314, 159], [26, 53]]).toContainEqual([latest.assets[0].x, latest.assets[0].y]);
        const bytes = await restored.asset({ projectPath, assetId: asset.id, versionId: asset.versionId, offset: 0 });
        expect(bytes).toMatchObject({ size: image.length, nextOffset: null });
        expect(Buffer.from(bytes.base64, 'base64')).toEqual(image);
        const siblingProject = join(f.root, 'empty');
        expect((await restored.get({ projectPath: siblingProject })).canvas).toMatchObject({ revision: 0, assets: [] });
        await expect(restored.asset({ projectPath: siblingProject, assetId: asset.id, versionId: asset.versionId, offset: 0 })).rejects.toThrow('unavailable in this project');
        await expect(restored.get({ projectPath: f.feature })).rejects.toThrow('authorized Goal catalog');
        await expect(restored.import({ ...upload, mimeType: 'image/gif' })).rejects.toThrow('image format');
    });

    it('registers the canvas machine RPCs and assembles, retries, and serves image chunks', async () => {
        const f = await fixture();
        const handlers = new Map<string, (input: unknown) => Promise<any>>();
        const service = registerProjectGoalHandlers({ registerHandler: (name, handler) => handlers.set(name, handler) }, f.deps);
        cleanups.push(() => service.dispose());
        const projectPath = join(f.root, 'p');
        const largeImage = Buffer.concat([image, Buffer.alloc(70 * 1024, 7)]);
        const metadata = { projectPath, name: 'Large.png', mimeType: 'image/png', totalSize: largeImage.length, uploadId: '6e8c137b-f59d-4512-9c60-6caa7af25096' };
        const upload = handlers.get('goalProjectCanvasImport')!;
        const first = { ...metadata, offset: 0, base64: largeImage.subarray(0, 60 * 1024).toString('base64') };
        const last = { ...metadata, offset: 60 * 1024, base64: largeImage.subarray(60 * 1024).toString('base64') };
        expect(await upload(last)).toMatchObject({ success: false });
        expect(await upload(first)).toEqual({ success: true, nextOffset: last.offset });
        expect(await upload(first)).toEqual({ success: true, nextOffset: last.offset });
        const saved = await upload(last);
        expect(saved).toMatchObject({ success: true, canvas: { revision: 1 } });
        expect(await upload(last)).toEqual(saved);

        const asset = saved.canvas.assets[0];
        const read = handlers.get('goalProjectCanvasAsset')!;
        const lead = await read({ projectPath, assetId: asset.id, versionId: asset.versionId, offset: 0 });
        expect(lead).toMatchObject({ success: true, nextOffset: 64 * 1024 });
        const tail = await read({ projectPath, assetId: asset.id, versionId: asset.versionId, offset: lead.nextOffset });
        expect(tail).toMatchObject({ success: true, nextOffset: null });
        expect(Buffer.concat([Buffer.from(lead.base64, 'base64'), Buffer.from(tail.base64, 'base64')])).toEqual(largeImage);
        expect(await handlers.get('goalProjectCanvasGet')!({ projectPath })).toEqual(saved);
        expect(await handlers.get('goalProjectCanvasLayout')!({ projectPath, revision: 1, placements: [{ id: asset.id, x: 75, y: 120 }] }))
            .toMatchObject({ success: true, canvas: { revision: 2, assets: [{ x: 75, y: 120 }] } });
    });

    it('preserves original image versions and layout while storing one bounded JPEG preview per asset', async () => {
        const f = await fixture();
        const handlers = new Map<string, (input: unknown) => Promise<any>>();
        const service = registerProjectGoalHandlers({ registerHandler: (name, handler) => handlers.set(name, handler) }, f.deps);
        cleanups.push(() => service.dispose());
        const projectPath = join(f.root, 'p');
        const original = await service.canvas.import({ projectPath, name: 'Jackie.png', mimeType: 'image/png', base64: image.toString('base64') });
        if (!('canvas' in original)) throw new Error('Expected a completed image import');
        const asset = original.canvas.assets[0];
        const request = { projectPath, assetId: asset.id, versionId: asset.versionId };
        const preview = handlers.get('goalProjectCanvasPreview')!;
        const putPreview = handlers.get('goalProjectCanvasPutPreview')!;
        const base64 = jpeg.toString('base64');
        const upload = { ...request, base64 };
        expect(asset.preview).toBeUndefined();
        expect(await preview(request)).toMatchObject({ success: false });
        expect(await putPreview({ ...request, projectPath: join(f.root, 'empty'), base64 })).toMatchObject({ success: false });
        expect(await putPreview({ ...request, base64: image.toString('base64') })).toMatchObject({ success: false });
        expect(await putPreview({ ...request, base64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64') })).toMatchObject({ success: false });

        const oversized = Buffer.alloc(GOAL_CANVAS_LIMITS.previewBytes + 1).toString('base64');
        expect(await putPreview({ ...request, base64: oversized })).toMatchObject({ success: false });
        const wide = Buffer.from(jpeg);
        const frame = wide.indexOf(Buffer.from([0xff, 0xc0]));
        wide.writeUInt16BE(GOAL_CANVAS_LIMITS.previewMaxSide + 1, frame + 7);
        expect(await putPreview({ ...request, base64: wide.toString('base64') })).toMatchObject({ success: false });

        const saved = await putPreview(upload);
        const previewMeta = { versionId: createHash('sha256').update(jpeg).digest('hex'), size: jpeg.length };
        expect(saved).toMatchObject({ success: true, canvas: { revision: 2, assets: [{ ...asset, preview: previewMeta }] } });
        expect(await preview(request)).toEqual({ success: true, base64, size: jpeg.length });

        // A different valid JPEG for the same asset must not replace the first preview.
        const anotherJpeg = Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xfe, 0, 3, 65]), jpeg.subarray(2)]);
        const [retried, layout] = await Promise.all([
            putPreview({ ...request, base64: anotherJpeg.toString('base64') }),
            service.canvas.layout({ projectPath, revision: saved.canvas.revision, placements: [{ id: asset.id, x: 777, y: 222 }] }),
        ]);
        expect(retried).toMatchObject({ success: true, canvas: { assets: [{ preview: previewMeta }] } });
        expect(layout.canvas).toMatchObject({ revision: 3, assets: [{ ...asset, x: 777, y: 222, preview: previewMeta }] });

        const reopened = f.make().canvas;
        expect(await reopened.preview(request)).toEqual({ success: true, base64, size: jpeg.length });
        expect(await reopened.asset({ ...request, offset: 0 })).toEqual({
            success: true, base64: image.toString('base64'), size: image.length, nextOffset: null,
        });
        const previewPath = join(f.deps.storageDirectory, 'project-canvases', layout.canvas.id, 'previews', asset.versionId);
        const corrupted = Buffer.from(jpeg);
        corrupted[7] ^= 1;
        await writeFile(previewPath, corrupted);
        await expect(reopened.preview(request)).rejects.toThrow('preview bytes changed');
        expect(await reopened.putPreview(upload)).toMatchObject({ canvas: { revision: 4, assets: [{ x: 777, y: 222, preview: previewMeta }] } });
        expect(await reopened.preview(request)).toEqual({ success: true, base64, size: jpeg.length });
    });

    it('atomically saves categorized image changes and full canvas documents with independent scene revisions', async () => {
        const f = await fixture();
        const projectPath = join(f.root, 'p');
        const canvas = f.service.canvas;
        const imported = await canvas.import({ projectPath, name: 'Jackie.png', mimeType: 'image/png', base64: image.toString('base64') });
        if (!('canvas' in imported)) throw new Error('Expected a completed image import');
        const asset = imported.canvas.assets[0];
        const category = { id: 'category-characters', name: '人物' };
        const update = await canvas.mutate({
            projectPath, revision: imported.canvas.revision,
            changes: [
                { type: 'upsert-category', ...category },
                { type: 'update-asset', assetId: asset.id, name: '三视图.png', categoryId: category.id, x: 100, y: 70 },
            ],
        });
        expect(update.canvas).toMatchObject({
            revision: 2, categories: [category],
            assets: [{ id: asset.id, versionId: asset.versionId, categoryId: category.id, name: '三视图.png', x: 100, y: 70 }],
        });
        const galleryId = `${asset.id}-${asset.versionId}`;
        const scene = sceneImage(`asset:ig-${galleryId}`, `shape:ig-${galleryId}`, { galleryId });
        scene.image.props.mimeType = 'image/png';
        const document = JSON.stringify(sceneEnvelope(scene.image, scene.shape));
        const saved = await canvas.saveScene({ projectPath, revision: 0, document, placements: [{ id: asset.id, x: 222, y: 333 }] });
        expect(saved.canvas).toMatchObject({ revision: 3, scene: { revision: 1, document }, assets: [{ x: 222, y: 333 }] });
        await expect(canvas.saveScene({ projectPath, revision: 0, document })).rejects.toThrow('Canvas scene was modified');
        const unsafeAsset = { ...scene.image, props: { ...scene.image.props, src: `data:image/png;base64,${image.toString('base64')}` } };
        await expect(canvas.saveScene({ projectPath, revision: 1, document: JSON.stringify(sceneEnvelope(unsafeAsset, scene.shape)) })).rejects.toThrow('persistent asset references');
        await expect(canvas.saveScene({ projectPath, revision: 1, document: '[]' })).rejects.toThrow('JSON object');
        const oversized = JSON.stringify({ label: '字'.repeat(Math.floor(GOAL_CANVAS_LIMITS.sceneBytes / 2)) });
        await expect(canvas.saveScene({ projectPath, revision: 1, document: oversized })).rejects.toThrow('scene is too large');
        await expect(canvas.mutate({ projectPath, revision: 3, changes: [
            { type: 'delete-category', id: category.id },
            { type: 'update-asset', assetId: asset.id, categoryId: 'unknown' },
        ] })).rejects.toThrow('category is unavailable');
        const reopened = f.make().canvas;
        expect(await reopened.get({ projectPath })).toEqual(saved);
        const uncategorized = await reopened.mutate({
            projectPath, revision: 3, changes: [{ type: 'delete-category', id: category.id }],
        });
        expect(uncategorized.canvas).toMatchObject({ revision: 4, scene: { revision: 1, document }, assets: [{ x: 222, y: 333 }] });
        expect(uncategorized.canvas.categories).toBeUndefined();
        expect(uncategorized.canvas.assets[0].categoryId).toBeUndefined();
        expect(await reopened.mutate({ projectPath, revision: 4, changes: [{ type: 'remove-asset', assetId: asset.id }] }))
            .toMatchObject({ canvas: { revision: 5, assets: [], scene: { revision: 1, document } } });
        await expect(reopened.asset({ projectPath, assetId: asset.id, versionId: asset.versionId, offset: 0 })).rejects.toThrow('unavailable in this project');
    });

    it('keeps the last readable scene when a malformed or unsupported replacement is submitted', async () => {
        const f = await fixture();
        const projectPath = join(f.root, 'p');
        const canvas = f.service.canvas;
        const source = sceneImage('asset:legacy');
        source.image.props.src = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
        const scene = sceneEnvelope(source.image, source.shape);
        scene.schema.sequences = { 'com.tldraw.store': 5, 'com.tldraw.shape.image': 5, 'com.tldraw.shape.group': 0 };
        const document = JSON.stringify(scene);
        const saved = await canvas.saveScene({ projectPath, revision: 0, document });
        expect(saved.canvas).toMatchObject({ revision: 1, scene: { revision: 1, document } });

        const { ['page:page']: _page, ...withoutPage } = scene.store;
        const futureScene = { ...scene, schema: { ...scene.schema, sequences: { 'com.tldraw.shape.image': 6 } } };
        const rejected = [
            [{}, 'Invalid project canvas document'],
            [{ ...scene, store: withoutPage }, 'missing its document or pages'],
            [{ ...scene, schema: { schemaVersion: 2, sequences: { 'com.tldraw.store': -1 } } }, 'Invalid project canvas schema'],
            [{ ...scene, schema: { ...scene.schema, sequences: { 'com.tldraw.future': 1 } } }, 'Invalid project canvas schema'],
            [futureScene, 'Invalid project canvas schema'],
            [sceneEnvelope({ id: 'instance:session', typeName: 'instance', meta: {} }), 'Invalid project canvas record'],
            [sceneEnvelope({ ...scene.store['user:canvas-guest'], imageUrl: 'https://example.test/avatar.png' }), 'Invalid project canvas user record'],
            [sceneEnvelope(source.shape), 'Missing asset in project canvas shape'],
            [sceneEnvelope(source.image, { ...source.shape, type: 'unknown' }), 'Unsupported project canvas shape type'],
            [sceneEnvelope(source.image, { ...source.shape, parentId: source.shape.id }), 'shape ancestry'],
            [sceneEnvelope(source.image, { ...source.shape, parentId: 'page:missing' }), 'Missing parent'],
            [sceneEnvelope(source.image, source.shape, {
                id: 'binding:arrow', type: 'arrow', typeName: 'binding', fromId: source.shape.id, toId: 'shape:missing',
                props: {}, meta: {},
            }), 'Missing shape in project canvas binding'],
            [sceneEnvelope(source.image, source.shape, {
                id: 'binding:unknown', type: 'unknown', typeName: 'binding', fromId: source.shape.id, toId: source.shape.id,
                props: {}, meta: {},
            }), 'Unsupported project canvas binding type'],
            [sceneEnvelope({ ...source.image, props: { ...source.image.props, src: 'https://example.test/image.jpg' } }, source.shape), 'persistent asset references'],
            [sceneEnvelope(source.image, { ...source.shape, props: { ...source.shape.props, richText: {
                type: 'doc', content: [{ type: 'image', attrs: { src: 'https://example.test/tracker' } }],
            } } }), 'persistent asset references'],
        ] as const;
        for (const [invalid, message] of rejected) {
            await expect(canvas.saveScene({ projectPath, revision: 1, document: JSON.stringify(invalid) })).rejects.toThrow(message);
        }
        await expect(canvas.commitBundle({
            projectPath, revision: saved.canvas.revision, bundleId: 'cf82c940-d251-4e90-a71d-a9a06cc4cc69',
            bundle: { categories: [], assets: [], document: JSON.stringify(futureScene) },
        })).rejects.toThrow('Invalid project canvas schema');
        expect(await f.make().canvas.get({ projectPath })).toEqual(saved);
    });

    it('stages verified bundle images without publishing a partial import and safely replays a completed commit', async () => {
        const f = await fixture();
        const handlers = new Map<string, (input: unknown) => Promise<any>>();
        const service = registerProjectGoalHandlers({ registerHandler: (name, handler) => handlers.set(name, handler) }, f.deps);
        cleanups.push(() => service.dispose());
        const projectPath = join(f.root, 'p');
        const bundleId = '93ad3b1f-1276-4526-8a75-3ac42c0bae94';
        const stage = handlers.get('goalProjectCanvasStageBundleAsset')!;
        const install = handlers.get('goalProjectCanvasCommitBundle')!;
        const category = { id: 'category-references', name: '参考素材' };
        const assets = [image, jpeg].map((bytes, i) => {
            const versionId = createHash('sha256').update(bytes).digest('hex');
            return {
                id: 'asset-' + versionId, versionId, size: bytes.length, name: i ? '侧视.jpg' : '正视.png',
                mimeType: i ? 'image/jpeg' : 'image/png', x: i * 240, y: 32, categoryId: category.id,
            };
        });
        const input = { projectPath, bundleId, revision: 0, bundle: { categories: [category], assets, document: JSON.stringify(sceneEnvelope()) } };
        const original = await service.canvas.get({ projectPath });
        const [front, side] = assets;
        const frontUpload = { projectPath, bundleId, versionId: front.versionId, mimeType: front.mimeType, totalSize: front.size, offset: 0, base64: image.toString('base64') };
        expect(await stage({ ...frontUpload, versionId: 'f'.repeat(64) })).toMatchObject({ success: false });
        expect(await stage(frontUpload)).toEqual({ success: true, nextOffset: null });
        expect(await stage(frontUpload)).toEqual({ success: true, nextOffset: null });
        expect(await install({ ...input, projectPath: join(f.root, 'empty') })).toMatchObject({ success: false });
        expect(await install(input)).toMatchObject({ success: false, error: expect.stringContaining('not been fully staged') });
        expect(await service.canvas.get({ projectPath })).toEqual(original);
        await expect(readFile(join(f.deps.storageDirectory, 'project-canvases', original.canvas.id, 'assets', front.versionId)))
            .rejects.toMatchObject({ code: 'ENOENT' });

        const sideOffset = 70;
        const sideUpload = { projectPath, bundleId, versionId: side.versionId, mimeType: side.mimeType, totalSize: side.size };
        const first = { ...sideUpload, offset: 0, base64: jpeg.subarray(0, sideOffset).toString('base64') };
        const last = { ...sideUpload, offset: sideOffset, base64: jpeg.subarray(sideOffset).toString('base64') };
        expect(await stage(last)).toMatchObject({ success: false });
        expect(await stage(first)).toEqual({ success: true, nextOffset: sideOffset });
        expect(await stage(first)).toEqual({ success: true, nextOffset: sideOffset });
        expect(await stage(last)).toEqual({ success: true, nextOffset: null });
        const saved = await install(input);
        expect(saved).toMatchObject({ success: true, canvas: { revision: 1, categories: [category], assets,
            scene: { revision: 1, document: input.bundle.document },
        } });
        expect(await install(input)).toEqual(saved);
        const reopened = f.make().canvas;
        expect(await reopened.get({ projectPath })).toEqual(saved);
        expect(await reopened.asset({ projectPath, assetId: side.id, versionId: side.versionId, offset: 0 }))
            .toMatchObject({ base64: jpeg.toString('base64'), nextOffset: null });
    });
});
