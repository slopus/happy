import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMotionWorkbenchHandlers, normalizeMotionHarnessSnapshot, resolveMotionProject } from './bridge';

const fixtures: string[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function setup() {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'paws-motion-'))); fixtures.push(base);
    const root = join(base, 'workspace'), project = join(root, '影片 project'), outside = join(base, 'outside');
    await mkdir(project, { recursive: true }); await mkdir(outside);
    for (const directory of [project, outside]) await writeFile(join(directory, 'mh.json'), JSON.stringify({ version: 3, projectType: 'pro', runtimeVersion: 1, entry: 'src/project.ts' }));
    return { root, project, outside };
}
const native = (project: string) => ({
    revision: 31, buildId: 'build-a', markers: [{ id: 'm1', label: '抬起卡片', requestVersion: 2, timeSpace: 'project', start: 2.5 }],
    markerSnapshot: { project, version: 'version-a', pendingCount: 1, complete: true },
});

describe('session-bound motion project', () => {
    it('lists and registers named projects over the session interface without starting the engine or widening the root', async () => {
        const { root, project, outside } = await setup();
        await writeFile(join(project, 'document.json'), JSON.stringify({ title: 'Paws 宣传片' }));
        const handlers = createMotionWorkbenchHandlers(root, '/does-not-exist/mh', join(root, '.private-index'));
        expect(await handlers.list({ root: outside })).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
        expect(await handlers.list({})).toMatchObject({ ok: true, value: { truncated: false, projects: [{ projectPath: project, title: 'Paws 宣传片' }] } });
        expect(await handlers.register({ projectPath: project })).toMatchObject({ ok: true, value: { projectPath: project } });
        expect(await handlers.register({ projectPath: outside })).toMatchObject({ ok: false, error: { code: 'PROJECT_NOT_ALLOWED' } });
    });
    it('resolves an existing Unicode project inside the workspace', async () => {
        const { root, project } = await setup();
        expect(await resolveMotionProject(root, '影片 project')).toBe(project);
        expect(await resolveMotionProject(root, project)).toBe(project);
    });
    it('rejects a sibling, traversal and a symlink escape before launching the engine', async () => {
        const { root, outside } = await setup();
        await symlink(outside, join(root, 'escape'));
        const handlers = createMotionWorkbenchHandlers(root, '/does-not-exist/mh');
        for (const projectPath of [outside, '../outside', 'escape']) {
            expect(await handlers.inspect({ projectPath })).toMatchObject({ ok: false, error: { code: 'PROJECT_NOT_ALLOWED' } });
        }
    });
    it('rejects symlinked, oversized and unsupported configuration files', async () => {
        const { root, project, outside } = await setup();
        await rm(join(project, 'mh.json')); await symlink(join(outside, 'mh.json'), join(project, 'mh.json'));
        await expect(resolveMotionProject(root, project)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
        await rm(join(project, 'mh.json')); await writeFile(join(project, 'mh.json'), ' '.repeat(65537));
        await expect(resolveMotionProject(root, project)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
        await writeFile(join(project, 'mh.json'), '{"version":3,"projectType":"unsupported"}');
        await expect(resolveMotionProject(root, project)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    });
    it('reports a missing engine without attempting installation or changing the project', async () => {
        const { root, project } = await setup();
        expect(await createMotionWorkbenchHandlers(root, '/does-not-exist/mh').inspect({ projectPath: project }))
            .toMatchObject({ ok: false, error: { code: 'ENGINE_UNAVAILABLE' } });
        expect(await resolveMotionProject(root, project)).toBe(project);
    });
    it('allows only one in-flight request and releases it after failure', async () => {
        const { root, project } = await setup();
        const handlers = createMotionWorkbenchHandlers(root, '/does-not-exist/mh');
        const pending = handlers.inspect({ projectPath: project });
        expect(await handlers.inspect({ projectPath: project })).toMatchObject({ ok: false, error: { code: 'BUSY' } });
        await pending;
        expect(await handlers.inspect({ projectPath: project })).toMatchObject({ ok: false, error: { code: 'ENGINE_UNAVAILABLE' } });
    });
    it('rejects malformed or URL-based input', async () => {
        const { root } = await setup();
        const handlers = createMotionWorkbenchHandlers(root, '/does-not-exist/mh');
        expect(await handlers.inspect({ projectPath: '.', url: 'http://127.0.0.1:58724' }))
            .toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
        expect(await handlers.prepareReview({ projectPath: '.' })).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    });
});

describe('native marker snapshot boundary', () => {
    it('binds exact native versions and retains spatial and attachment fields', () => {
        const data = native('/work/project');
        const marker = { ...data.markers[0], anchor: { x: 10, y: 20 }, attachments: [{ $asset: 'asset-a', kind: 'image' }] };
        const snapshot = normalizeMotionHarnessSnapshot('/work/project', { ...data, markers: [marker] });
        expect(snapshot).toMatchObject({ documentRevision: 31, buildId: 'build-a', markerVersion: 'version-a', markers: [marker] });
    });
    it('changes the fingerprint when document, build, instruction or project changes', () => {
        const base = normalizeMotionHarnessSnapshot('/work/project', native('/work/project'));
        for (const change of [{ revision: 32 }, { buildId: 'build-b' }, { markerSnapshot: { ...native('/work/project').markerSnapshot, version: 'version-b' } }, { markers: [{ ...base.markers[0], notes: 'new instruction' }] }]) {
            expect(normalizeMotionHarnessSnapshot('/work/project', { ...native('/work/project'), ...change }).snapshotHash).not.toBe(base.snapshotHash);
        }
        expect(normalizeMotionHarnessSnapshot('/work/other', native('/work/other')).projectId).not.toBe(base.projectId);
    });
    it('ignores object-key order when fingerprinting a native result', () => {
        const data = native('/work/project');
        expect(normalizeMotionHarnessSnapshot('/work/project', data).snapshotHash)
            .toBe(normalizeMotionHarnessSnapshot('/work/project', { ...data, markers: [{ requestVersion: 2, start: 2.5, timeSpace: 'project', label: '抬起卡片', id: 'm1' }] }).snapshotHash);
    });
    it('rejects wrong-project, incomplete, unversioned and duplicate snapshots', () => {
        const data = native('/work/project');
        for (const change of [
            { markerSnapshot: { ...data.markerSnapshot, project: '/private' } },
            { markerSnapshot: { ...data.markerSnapshot, complete: false } },
            { markers: [{ id: 'm1', label: 'no instruction version' }] },
            { markers: [data.markers[0], data.markers[0]] },
        ]) expect(() => normalizeMotionHarnessSnapshot('/work/project', { ...data, ...change })).toThrow('complete, versioned');
    });
    it('rejects oversized native context rather than forwarding it to the session', () => {
        const data = native('/work/project');
        expect(() => normalizeMotionHarnessSnapshot('/work/project', { ...data, extra: 'a'.repeat(1024 * 1024) })).toThrow('complete, versioned');
    });
});
