import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink, truncate, rename, realpath, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { discoverRoots, readCatalog } from './catalog';
import { parseBoard } from './parser';
import { goalBoardTaskPrompt } from './taskPrompt';
import { createIndependentSessionLauncher } from '../../daemon/independentSessions';
import { registerGoalBoardHandlers, type GoalBoardOptions } from './registerGoalBoardHandlers';

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
async function fixture(initialBinding = false, overrides: Partial<GoalBoardOptions> = {}) {
    const home = await mkdtemp(join(tmpdir(), 'goal-board-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const projects = join(home, '.codex/skills/goal-first-ops/projects');
    const feature = join(projects, 'one/features/global');
    const sibling = join(projects, 'one/features/batch');
    async function put(path: string, text: string) { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, text); }
    await put(join(projects, 'one/index.md'), '# Project One');
    await put(join(projects, 'two/index.md'), '# Project Two');
    await put(join(projects, 'two/features/other/index.md'), '# Other');
    await put(join(feature, 'index.md'), '# All tasks\n[Global map](总任务地图.md)\n[Batch](../batch/index.md)\n[Actual report](result.md)');
    await put(join(sibling, 'index.md'), '# Batch\n[Tasks](任务安排.md)');
    const mapped: string[] = [];
    for (let n = 1; n <= 20; n++) {
        const folder = join(n <= 6 ? sibling : feature, `tasks/${n}-任务`);
        const rel = n <= 6 ? `../batch/tasks/${n}-任务` : `tasks/${n}-任务`;
        mapped.push(`| G${String(n).padStart(2, '0')} | [Task ${n}](${rel}/index.md) | [Prompt](${rel}/PROMPT.md) |`);
        await put(join(folder, 'index.md'), `${n === 20 ? '' : `---\nstatus: ${n === 1 ? 'running' : n === 2 ? 'done' : 'pending'}\n---\n`}# Task ${n}\n目标摘要：Goal ${n}\n## 下一步\nAsk user\n`);
        await put(join(folder, 'PROMPT.md'), '# Contract\n## 要解决的问题\nActual problem\n## 预期交付物\n- Expected report\n- Expected code\n');
    }
    await put(join(feature, '总任务地图.md'), '# Global map\n' + mapped.join('\n'));
    await put(join(feature, 'result.md'), '# Report original\n| G99 | [Historical example](tasks/report-example/index.md) |');
    await put(join(feature, 'tasks/report-example/index.md'), '---\nstatus: done\n---\n# Example in an unopened report');
    await put(join(feature, 'tasks/legacy/index.md'), '---\nstatus: done\n---\n# Old completed task');
    await put(join(sibling, '任务安排.md'), mapped.slice(0, 6).join('\n'));
    const taskDir = join(sibling, 'tasks/1-任务');
    await put(join(taskDir, 'index.md'), '---\nstatus: running\n---\n# Task 1\n目标摘要：Goal 1\n## 当前产物\n[中文 文稿](中文 文稿.md)：Actual report\n[Missing](missing.md)\n[PDF](report.pdf)\n[Audio](clip.mp3)\n## 相关参考\n[Old baseline](../../baseline.md)\n[Full contract](PROMPT.md)\n[Unsafe](escape.txt)\n[Absolute](/etc/passwd)\n');
    await put(join(taskDir, '中文 文稿.md'), '# Full original\n\nLong body');
    await put(join(taskDir, 'report.pdf'), '%PDF-1.7');
    await put(join(taskDir, 'clip.mp3'), 'ID3');
    await put(join(sibling, 'baseline.md'), 'Old work');
    await symlink('/etc/passwd', join(taskDir, 'escape.txt'));
    const handlers = new Map<string, (x: any) => Promise<any>>();
    const snapshots: any[] = [];
    const uploads: any[] = [];
    const starts: any[] = [];
    const controller = registerGoalBoardHandlers({ registerHandler: (name: string, fn: any) => handlers.set(name, fn), unregisterHandler: (name: string) => handlers.delete(name) }, home, {
        homeDirectory: home,
        initialFeaturePath: initialBinding ? feature : undefined,
        startTask: async (task: any, featurePath: string, requestId: string) => { starts.push({ task, featurePath, requestId }); return { success: true, sessionId: 'child', title: task.title }; },
        onSnapshot: (snapshot: any) => { snapshots.push(snapshot); },
        prepareAttachment: async (path: string, kind: string) => { uploads.push({ path, kind }); return { ref: 'ref', name: 'file', size: 5, kind: (kind === 'pdf' ? 'file' : kind) as 'file' | 'image' | 'audio' | 'video', mimeType: 'test/mime', encrypted: kind !== 'audio' }; },
        ...overrides,
    });
    cleanups.push(() => controller.dispose());
    const call = (name: string, input: any = {}) => handlers.get(name)!(input);
    return { home, projects, feature, sibling, taskDir, put, handlers, snapshots, uploads, starts, controller, call };
}

describe('Goal Board real filesystem', () => {
    it('catalogs two bounded projects and maps G01–G20 across features without contract aliases', async () => {
        const f = await fixture();
        const catalog = await f.call('goalBoardCatalog');
        expect(catalog.success).toBe(true);
        expect(catalog.goals).toHaveLength(3);
        const read = await f.call('goalBoardRead', { featurePath: f.feature });
        expect(read.success).toBe(true);
        expect(read.snapshot.tasks).toHaveLength(20);
        expect(read.snapshot.tasks.map((t: any) => t.code)).toEqual(Array.from({ length: 20 }, (_, i) => `G${String(i + 1).padStart(2, '0')}`));
        expect(read.snapshot.tasks[0]).toMatchObject({ status: 'running', goal: 'Goal 1', problem: 'Actual problem', expectedDeliverables: ['Expected report', 'Expected code'] });
        expect(read.snapshot.tasks[1].status).toBe('done');
        expect(read.snapshot.tasks[19].status).toBe('unknown');
        await f.call('goalBoardRead', { featurePath: f.feature });
        expect(f.snapshots).toHaveLength(1);
    });
    it('distinguishes outputs, missing originals, references and contracts and rejects escaped links', async () => {
        const f = await fixture();
        const { snapshot } = await f.call('goalBoardRead', { featurePath: f.feature });
        const task = snapshot.tasks[0];
        expect(task.artifacts.find((a: any) => a.name === '中文 文稿')).toMatchObject({ kind: 'text', available: true, relation: 'output' });
        expect(task.artifacts.find((a: any) => a.name === 'Missing')).toMatchObject({ available: false });
        expect(task.artifacts.find((a: any) => a.name === 'Old baseline').relation).toBe('reference');
        expect(task.artifacts.find((a: any) => a.name === 'Full contract').relation).toBe('reference');
        expect(task.artifacts.find((a: any) => a.name === 'Unsafe')).toMatchObject({ available: false });
        expect(task.artifacts.find((a: any) => a.name === 'Absolute')).toMatchObject({ available: false });
        expect(f.uploads).toHaveLength(0);
        const art = task.artifacts.find((a: any) => a.name === '中文 文稿');
        expect(await f.call('goalBoardArtifact', { featurePath: f.feature, taskId: task.id, artifactId: art.id })).toMatchObject({ success: true, kind: 'text', content: '# Full original\n\nLong body' });
        expect(await f.call('goalBoardArtifact', { featurePath: f.feature, taskId: task.id, artifactId: 'arbitrary' })).toMatchObject({ success: false });
        expect(await f.call('goalBoardRead', { featurePath: '/etc' })).toMatchObject({ success: false });
    });
    it('stats text/media bounds before reads or upload and prepares PDF/media only on demand', async () => {
        const f = await fixture();
        const { snapshot } = await f.call('goalBoardRead', { featurePath: f.feature });
        const task = snapshot.tasks[0];
        const request = (name: string) => f.call('goalBoardArtifact', { featurePath: f.feature, taskId: task.id, artifactId: task.artifacts.find((a: any) => a.name === name).id });
        expect(await request('PDF')).toMatchObject({ success: true, kind: 'attachment', attachment: { kind: 'file', encrypted: true } });
        expect(await request('Audio')).toMatchObject({ success: true, kind: 'attachment', attachment: { kind: 'audio' } });
        await truncate(join(f.taskDir, '中文 文稿.md'), 16 * 1024 * 1024 + 1);
        expect(await request('中文 文稿')).toMatchObject({ success: false });
        await truncate(join(f.taskDir, 'report.pdf'), 50 * 1024 * 1024 + 1);
        expect(await request('PDF')).toMatchObject({ success: false });
        expect(f.uploads).toHaveLength(2);
    });
    it.each([1920569, 4704647])('sends a %i-byte document through attachments without a large Socket.IO response', async (size) => {
        const f = await fixture();
        const original = '<!doctype html><h1>原文</h1>' + 'x'.repeat(size);
        await f.put(join(f.taskDir, 'report.html'), original);
        await f.put(join(f.taskDir, 'index.md'), '---\nstatus: done\n---\n# Task\n## 当前产物\n[Report](report.html)');
        const { snapshot } = await f.call('goalBoardRead', { featurePath: f.feature });
        const task = snapshot.tasks[0];
        const response = await f.call('goalBoardArtifact', { featurePath: f.feature, taskId: task.id, artifactId: task.artifacts[0].id });
        expect(response).toMatchObject({ success: true, kind: 'attachment' });
        expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(16 * 1024);
        expect(f.uploads).toHaveLength(1);
        expect(f.uploads[0].kind).toBe('text');
    });
    it('publishes real watcher changes once, blocks stale features and disposes watchers', async () => {
        const f = await fixture();
        const { snapshot } = await f.call('goalBoardRead', { featurePath: f.feature });
        const oldTask = snapshot.tasks[0];
        const event = new Promise<void>((resolve, reject) => {
            const deadline = setTimeout(() => reject(new Error('No fs.watch update')), 4000);
            const original = f.snapshots.push.bind(f.snapshots);
            f.snapshots.push = (...items: any[]) => { const result = original(...items); if (items.some(x => x.tasks[0].status === 'review')) { clearTimeout(deadline); resolve(); } return result; };
        });
        await f.put(join(f.taskDir, 'index.md'), '---\nstatus: review\n---\n# Updated\n目标摘要：Goal 1');
        await event;
        expect(f.snapshots.at(-1).tasks[0].status).toBe('review');
        await f.call('goalBoardRead', { featurePath: join(f.projects, 'two/features/other') });
        expect(await f.call('goalBoardArtifact', { featurePath: f.feature, taskId: oldTask.id, artifactId: oldTask.artifacts[0].id })).toMatchObject({ success: false });
        const count = f.snapshots.length;
        f.controller.dispose();
        await f.put(join(f.taskDir, 'index.md'), '# Later');
        await new Promise(resolve => setImmediate(resolve));
        expect(f.snapshots).toHaveLength(count);
        expect(f.handlers.size).toBe(0);
    });
    it('does not turn malformed YAML or missing status into completion', async () => {
        const f = await fixture();
        await f.put(join(f.taskDir, 'index.md'), '---\nstatus: [done\n---\n# Malformed');
        const { snapshot } = await f.call('goalBoardRead', { featurePath: f.feature });
        expect(snapshot.tasks[0].status).toBe('unknown');
        expect(snapshot.warnings.length).toBeGreaterThan(0);
        await f.put(join(f.taskDir, 'index.md'), '---\nstatus: done\nbroken yaml\n---\n# Invalid complete');
        const invalid = await f.call('goalBoardRead', { featurePath: f.feature });
        expect(invalid.snapshot.tasks[0].status).toBe('unknown');
    });
    it('accepts an installed skill symlink to an external authorized root and rejects a catalog escape', async () => {
        const f = await fixture();
        const install = join(f.home, '.codex/skills/goal-first-ops');
        const external = join(f.home, 'external-goal-root');
        await rename(install, external);
        await symlink(external, install);
        await symlink('/etc', join(external, 'projects/one/features/escape'));
        const catalog = await f.call('goalBoardCatalog');
        expect(catalog.goals).toHaveLength(3);
        const read = await f.call('goalBoardRead', { featurePath: f.feature });
        expect(read.success).toBe(true);
        expect(read.snapshot.featurePath.startsWith(await realpath(external))).toBe(true);
        expect(read.snapshot.tasks).toHaveLength(20);
    });
    it('launches only a selected authorized task and leaves its source status unchanged', async () => {
        const f = await fixture();
        const { snapshot } = await f.call('goalBoardRead', { featurePath: f.feature });
        const task = snapshot.tasks[0];
        expect(await f.call('goalBoardStartTask', { featurePath: f.feature, taskId: task.id, requestId: 'task-1' })).toMatchObject({ success: true, sessionId: 'child' });
        expect(f.starts).toHaveLength(1);
        expect(f.starts[0].task.status).toBe('running');
        expect(await f.call('goalBoardStartTask', { featurePath: f.feature, taskId: 'arbitrary', requestId: 'task-2' })).toMatchObject({ success: false });
        expect(f.starts).toHaveLength(1);
    });
    it('reuses the immutable initial launch payload after source changes and rejects another task or feature', async () => {
        const send = vi.fn(async (_child: any, _prompt: string, _localId: string) => {});
        send.mockRejectedValueOnce(new Error('temporary send failure'));
        const spawn = vi.fn(async () => ({ type: 'success' as const, sessionId: 'child' }));
        const launch = createIndependentSessionLauncher({
            findSession: id => ({ happySessionId: id, encryption: {} }) as any,
            readMetadata: async () => ({ path: '/project', flavor: 'codex' }) as any,
            grant: async () => 'grant', spawn, send,
        });
        const f = await fixture(false, { startTask: (task, featurePath, requestId) => launch('parent', {
            requestId, title: task.title.slice(0, 200), prompt: goalBoardTaskPrompt(task, featurePath), directory: featurePath,
        }) });
        await f.put(join(f.taskDir, 'index.md'), '---\nstatus: running\n---\n# Task\n## 下一步\nPrepare report');
        const initial = await f.call('goalBoardRead', { featurePath: f.feature });
        const input = { featurePath: initial.snapshot.featurePath, taskId: initial.snapshot.tasks[0].id, requestId: 'stable-id' };
        expect(await f.call('goalBoardStartTask', input)).toMatchObject({ success: false, sessionId: 'child', error: 'temporary send failure' });
        await f.put(join(f.taskDir, 'index.md'), '---\nstatus: review\n---\n# Changed task title\n目标摘要：Changed goal\n## 下一步\nReview new report');
        const changed = await f.call('goalBoardRead', { featurePath: f.feature });
        expect(changed.snapshot.tasks[0].nextStep).toBe('Review new report');
        expect(await f.call('goalBoardStartTask', input)).toMatchObject({ success: true, sessionId: 'child', title: 'Task' });
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledTimes(2);
        expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
        expect(send.mock.calls[1][1]).toContain('Prepare report');
        expect(send.mock.calls[1][1]).not.toContain('Review new report');
        expect(await f.call('goalBoardStartTask', { ...input, taskId: changed.snapshot.tasks[1].id })).toMatchObject({ success: false, error: expect.stringContaining('different task') });
        const sibling = await f.call('goalBoardRead', { featurePath: f.sibling });
        expect(await f.call('goalBoardStartTask', { ...input, featurePath: sibling.snapshot.featurePath })).toMatchObject({ success: false, error: expect.stringContaining('different task') });
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledTimes(2);
    });

    it('observes a mapped sibling task recreated after its deletion events settle', async () => {
        const f = await fixture();
        await f.put(join(f.taskDir, 'index.md'), '---\nstatus: running\n---\n# Task without artifacts');
        await f.call('goalBoardRead', { featurePath: f.feature });
        const nextMatching = (phase: string, predicate: (s: any) => boolean) => new Promise<void>((resolve, reject) => {
            const deadline = setTimeout(() => reject(new Error(`Missing task ${phase} fs.watch event`)), 4000);
            const push = f.snapshots.push.bind(f.snapshots);
            f.snapshots.push = (...items: any[]) => { const result = push(...items); if (items.some(predicate)) { clearTimeout(deadline); resolve(); } return result; };
        });
        const removed = nextMatching('removal', s => !s.tasks.some((t: any) => t.code === 'G01'));
        await rm(f.taskDir, { recursive: true });
        await removed;
        // A single event-drain delay prevents queued deletion events from masking a missing parent watcher.
        await new Promise(resolve => setTimeout(resolve, 250));
        const recreated = nextMatching('recreation', s => s.tasks.some((t: any) => t.code === 'G01' && t.status === 'review'));
        await f.put(join(f.taskDir, 'index.md'), '---\nstatus: review\n---\n# Recreated task');
        await recreated;
    });

    it('reports bounded document failures and never publishes an unchanged revision', async () => {
        const f = await fixture();
        const initial = await f.call('goalBoardRead', { featurePath: f.feature });
        await f.put(join(f.taskDir, 'index.md'), '---\nstatus: running\n---\n# Task 1\n目标摘要：Goal 1');
        await f.call('goalBoardRead', { featurePath: f.feature });
        const count = f.snapshots.length;
        await f.call('goalBoardRead', { featurePath: f.feature });
        expect(f.snapshots.length).toBe(count);
        await truncate(join(f.taskDir, 'index.md'), 256 * 1024 + 1);
        const limited = await f.call('goalBoardRead', { featurePath: f.feature });
        expect(limited.snapshot.tasks.length).toBeLessThan(initial.snapshot.tasks.length);
        expect(limited.snapshot.warnings.some((w: string) => w.includes('too large'))).toBe(true);
    });

    it('ignores an older in-flight selection and any read completed after disposal', async () => {
        const f = await fixture();
        const older = f.call('goalBoardRead', { featurePath: f.feature });
        const newer = f.call('goalBoardRead', { featurePath: join(f.projects, 'two/features/other') });
        expect(await older).toMatchObject({ success: false });
        const selected = await newer;
        expect(selected.success).toBe(true);
        expect(f.snapshots.every(x => x.featurePath === selected.snapshot.featurePath)).toBe(true);
        const pending = f.call('goalBoardRead', { featurePath: f.feature });
        const count = f.snapshots.length;
        f.controller.dispose();
        expect(await pending).toMatchObject({ success: false });
        expect(f.snapshots).toHaveLength(count);
    });
    it.skipIf(!process.env.GOAL_BOARD_REAL_FEATURE)('reads the explicitly requested installed feature without mutations', async () => {
        const start = performance.now();
        const entries = await readCatalog(await discoverRoots(process.cwd(), process.env.GOAL_BOARD_REAL_HOME));
        const selected = entries.find(entry => entry.featurePath === process.env.GOAL_BOARD_REAL_FEATURE);
        expect(selected).toBeDefined();
        const cold = await parseBoard(selected!);
        const coldMs = performance.now() - start;
        const warmStart = performance.now();
        const warm = await parseBoard(selected!);
        expect(warm.snapshot.revision).toBe(cold.snapshot.revision);
        expect(cold.snapshot.tasks.length).toBeGreaterThan(0);
        if (cold.snapshot.tasks.some(task => task.code)) expect(cold.snapshot.tasks.every(task => task.code)).toBe(true);
        console.log(JSON.stringify({ catalog: entries.length, tasks: cold.snapshot.tasks.length, statuses: cold.snapshot.tasks.reduce((counts, t) => ({ ...counts, [t.status]: (counts[t.status] || 0) + 1 }), {} as Record<string, number>), coldMs: Math.round(coldMs), warmMs: Math.round(performance.now() - warmStart), snapshotBytes: Buffer.byteLength(JSON.stringify(cold.snapshot)), warnings: cold.snapshot.warnings }));
    });

    it('restores an existing binding watcher before the board is explicitly opened', async () => {
        const f = await fixture(true);
        await new Promise<void>((resolve, reject) => {
            const deadline = setTimeout(() => reject(new Error('Persisted binding was not restored')), 4000);
            const finish = () => { clearTimeout(deadline); resolve(); };
            if (f.snapshots.length) { finish(); return; }
            const push = f.snapshots.push.bind(f.snapshots);
            f.snapshots.push = (...items: any[]) => { const result = push(...items); finish(); return result; };
        });
        expect(f.snapshots[0].tasks).toHaveLength(20);
        const task = f.snapshots[0].tasks[0];
        expect(await f.call('goalBoardArtifact', { featurePath: f.feature, taskId: task.id, artifactId: task.artifacts[0].id })).toMatchObject({ success: true, kind: 'text' });
    });

    it('rejects an 11MiB PDF before preparing any attachment', async () => {
        const f = await fixture();
        const { snapshot } = await f.call('goalBoardRead', { featurePath: f.feature });
        const task = snapshot.tasks[0];
        await truncate(join(f.taskDir, 'report.pdf'), 11 * 1024 * 1024);
        const response = await f.call('goalBoardArtifact', { featurePath: f.feature, taskId: task.id, artifactId: task.artifacts.find((a: any) => a.kind === 'pdf').id });
        expect(response).toMatchObject({ success: false });
        expect(f.uploads).toHaveLength(0);
    });
    it('pins original media bytes before any upload-descriptor await despite an outside symlink swap', async () => {
        let release!: () => void;
        let started!: () => void;
        const descriptorWait = new Promise<void>(resolve => { release = resolve; });
        const descriptorStarted = new Promise<void>(resolve => { started = resolve; });
        let uploadPath = '';
        let uploaded = '';
        let stagingMode = 0;
        let stagedFileMode = 0;
        const f = await fixture(false, { prepareAttachment: async (path) => {
            uploadPath = path;
            stagingMode = (await stat(join(path, '..'))).mode & 0o777;
            stagedFileMode = (await stat(path)).mode & 0o777;
            started();
            await descriptorWait;
            uploaded = await readFile(path, 'utf8');
            return { ref: 'ref', name: 'clip.mp3', size: uploaded.length, mimeType: 'audio/mpeg', kind: 'audio', encrypted: false };
        } });
        const { snapshot } = await f.call('goalBoardRead', { featurePath: f.feature });
        const task = snapshot.tasks[0];
        const request = f.call('goalBoardArtifact', { featurePath: f.feature, taskId: task.id, artifactId: task.artifacts.find((a: any) => a.kind === 'audio').id });
        await descriptorStarted;
        const privatePath = join(f.home, 'outside-private.mp3');
        await f.put(privatePath, 'PRIVATE ROOT BYTES');
        await rename(join(f.taskDir, 'clip.mp3'), join(f.taskDir, 'original.mp3'));
        await symlink(privatePath, join(f.taskDir, 'clip.mp3'));
        release();
        expect(await request).toMatchObject({ success: true });
        expect(uploaded).toBe('ID3');
        expect(stagingMode).toBe(0o700);
        expect(stagedFileMode).toBe(0o400);
        expect(basename(uploadPath)).toBe('clip.mp3');
        expect(uploadPath).not.toBe(join(f.taskDir, 'clip.mp3'));
        expect(await stat(uploadPath).then(() => true, () => false)).toBe(false);
    });
    it('keeps English references, expected and unlabeled files out of produced outputs', async () => {
        const f = await fixture();
        await f.put(join(f.taskDir, 'sample.md'), 'Input');
        await f.put(join(f.taskDir, 'produced.md'), 'Actual result');
        await f.put(join(f.taskDir, 'index.md'), '---\nstatus: pending\n---\n# English task\n[Unclassified](sample.md)\n## References\n[Input sample](sample.md)\n## Expected deliverables\n[Planned report](report.md)\n## Actual outputs\n[Produced report](produced.md)');
        const { snapshot } = await f.call('goalBoardRead', { featurePath: f.feature });
        const task = snapshot.tasks[0];
        expect(task.artifacts.find((a: any) => a.name === 'Unclassified').relation).toBe('reference');
        expect(task.artifacts.find((a: any) => a.name === 'Planned report')).toMatchObject({ relation: 'reference', available: false });
        expect(task.artifacts.find((a: any) => a.name === 'Produced report')).toMatchObject({ relation: 'output', available: true });
    });
    it.each(['最终产物', '交付产物', '最终交付', 'Final deliverables'])('recognizes two approved documents under %s without promoting process records', async (heading) => {
        const f = await fixture();
        await f.put(join(f.taskDir, 'report.html'), '<h1>Video breakdown</h1>');
        await f.put(join(f.taskDir, 'tutorial.html'), '<h1>Developer tutorial</h1>');
        await f.put(join(f.taskDir, 'process.md'), 'Approval and iteration history');
        await f.put(join(f.taskDir, 'index.md'), `---\nstatus: done\n---\n# Completed documentation\n## ${heading}\n1. [视频拆解报告](report.html)\n2. [开发者复现教程](tutorial.html)\n## 归档与过程\n[Process record](process.md)\n[Full contract](PROMPT.md)`);
        const { snapshot } = await f.call('goalBoardRead', { featurePath: f.feature });
        const task = snapshot.tasks[0];
        expect(task.status).toBe('done');
        expect(task.artifacts.filter((a: any) => a.relation === 'output')).toEqual([
            expect.objectContaining({ name: '视频拆解报告', available: true, kind: 'text' }),
            expect.objectContaining({ name: '开发者复现教程', available: true, kind: 'text' }),
        ]);
        expect(task.artifacts.find((a: any) => a.name === 'Process record').relation).toBe('reference');
        expect(task.artifacts.find((a: any) => a.name === 'Full contract').relation).toBe('reference');
    });
    it.each(['预期交付', '参考资料', '历史产物'])('keeps nested final deliverables under %s as references', async (heading) => {
        const f = await fixture();
        await f.put(join(f.taskDir, 'report.html'), '<h1>Reference</h1>');
        await f.put(join(f.taskDir, 'index.md'), `---\nstatus: done\n---\n# Task\n## ${heading}\n### 最终产物\n[Report](report.html)`);
        const { snapshot } = await f.call('goalBoardRead', { featurePath: f.feature });
        expect(snapshot.tasks[0].artifacts[0]).toMatchObject({ relation: 'reference', available: true });
    });
    it('shows explicitly produced commits as deliverables while keeping reference commits separate', async () => {
        const f = await fixture();
        await f.put(join(f.taskDir, 'index.md'), '---\nstatus: review\n---\n# Code delivery\n## References\n[Baseline](https://github.com/example/repo/commit/abc123)\n## Actual outputs\n[Code change](https://github.com/example/repo/commit/def456)');
        const { snapshot } = await f.call('goalBoardRead', { featurePath: f.feature });
        expect(snapshot.tasks[0].artifacts.find((a: any) => a.name === 'Baseline')).toMatchObject({ kind: 'commit', relation: 'reference' });
        expect(snapshot.tasks[0].artifacts.find((a: any) => a.name === 'Code change')).toMatchObject({ kind: 'commit', relation: 'output', available: true });
    });

    it.each(['Historical material', 'References', 'Expected deliverables'])('inherits %s context through nested Outputs headings', async (parent) => {
        const f = await fixture();
        await f.put(join(f.taskDir, 'old.md'), 'Previous material');
        await f.put(join(f.taskDir, 'fresh.md'), 'Current result');
        await f.put(join(f.taskDir, 'index.md'), `---
status: pending
---
# Task
## ${parent}
### Outputs
[Report](old.md)
## Actual outputs
[Current report](fresh.md)`);
        const { snapshot } = await f.call('goalBoardRead', { featurePath: f.feature });
        expect(snapshot.tasks[0].artifacts.find((a: any) => a.name === 'Report')).toMatchObject({ relation: 'reference', available: true });
        expect(snapshot.tasks[0].artifacts.find((a: any) => a.name === 'Current report')).toMatchObject({ relation: 'output', available: true });
    });

    it('observes missing nested artifact creation and rebinds an atomically replaced artifact directory', async () => {
        const f = await fixture();
        await mkdir(join(f.taskDir, 'reports'));
        await f.put(join(f.taskDir, 'index.md'), '---\nstatus: running\n---\n# Nested report\n## Actual outputs\n[Output](reports/out.md)');
        const { snapshot } = await f.call('goalBoardRead', { featurePath: f.feature });
        expect(snapshot.tasks[0].artifacts[0].available).toBe(false);
        const nextMatching = (predicate: (s: any) => boolean) => new Promise<void>((resolve, reject) => {
            const deadline = setTimeout(() => reject(new Error('Missing artifact fs.watch event')), 4000);
            const push = f.snapshots.push.bind(f.snapshots);
            f.snapshots.push = (...items: any[]) => { const result = push(...items); if (items.some(predicate)) { clearTimeout(deadline); resolve(); } return result; };
        });
        const created = nextMatching(s => s.tasks[0].artifacts[0].available);
        await f.put(join(f.taskDir, 'reports/out.md'), 'First');
        await created;
        const replaced = nextMatching(s => s.tasks[0].artifacts[0].size === 11);
        await mkdir(join(f.taskDir, 'replacement'));
        await f.put(join(f.taskDir, 'replacement/out.md'), 'Replacement');
        await rename(join(f.taskDir, 'reports'), join(f.taskDir, 'reports-old'));
        await rename(join(f.taskDir, 'replacement'), join(f.taskDir, 'reports'));
        await replaced;
        const changed = nextMatching(s => s.tasks[0].artifacts[0].size === 20);
        await f.put(join(f.taskDir, 'reports/out.md'), 'Changed after rebind');
        await changed;
    });

    it('removes private staged bytes when the existing uploader fails', async () => {
        let staged = '';
        const f = await fixture(false, { prepareAttachment: async path => { staged = path; throw new Error('Upload rejected'); } });
        const { snapshot } = await f.call('goalBoardRead', { featurePath: f.feature });
        const task = snapshot.tasks[0];
        const result = await f.call('goalBoardArtifact', { featurePath: f.feature, taskId: task.id, artifactId: task.artifacts.find((a: any) => a.kind === 'pdf').id });
        expect(result).toMatchObject({ success: false, error: 'Upload rejected' });
        expect(staged).not.toBe('');
        expect(await stat(staged).then(() => true, () => false)).toBe(false);
    });

});
