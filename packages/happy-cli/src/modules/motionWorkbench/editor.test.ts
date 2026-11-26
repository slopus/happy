import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMotionEditor } from './editor';
import { publicStudioState } from './studioBundle';

const fixtures: string[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'paws-editor-'))); fixtures.push(root);
    const project = join(root, 'project'); await mkdir(project); await writeFile(join(project, 'mh.json'), '{"version":3,"projectType":"pro"}');
    return { root, project };
}
describe('editor lifecycle and host boundary', () => {
    it('preserves full authored documents while excluding native URLs and connected clients', () => {
        const document = { revision: 4, instances: { root: { values: { title: 'Keep all values' } } }, settings: { width: 1440 }, custom: ['preserved'] };
        const state = publicStudioState({ document, schema: { fonts: [] }, sourceAssets: [], projectEntry: '/native/private-entry', studioSessions: [{ client: 'private' }], styles: ['native-path'] });
        expect(state.document).toEqual(document); expect(state.styles).toEqual([]);
        expect(state.projectEntry).toBeUndefined(); expect(state.studioSessions).toBeUndefined();
    });
    it('rejects another workspace before launching any installed tool', async () => {
        const { root, project } = await fixture();
        const editor = createMotionEditor(project, { executable: '/does-not-exist/mh' });
        expect(await editor.open({ projectPath: root })).toMatchObject({ ok: false, error: { code: 'PROJECT_NOT_ALLOWED' } }); editor.dispose();
    });
    it('rejects browser-supplied endpoints and unowned resource bindings', async () => {
        const { root } = await fixture(); const editor = createMotionEditor(root);
        expect(await editor.open({ projectPath: '.', url: 'http://127.0.0.1:12345' })).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
        expect(await editor.state({ bindingId: '00000000-0000-4000-8000-000000000000' })).toMatchObject({ ok: false, error: { code: 'BINDING_NOT_FOUND' } });
        expect(await editor.resource({ bindingId: '00000000-0000-4000-8000-000000000000', resourceId: '../secret', offset: 0 })).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } }); editor.dispose();
    });
    it('cancels an opening owner before spawning the engine and acknowledges its release', async () => {
        const { root, project } = await fixture(); const editor = createMotionEditor(root, { executable: '/does-not-exist/mh' });
        const bindingId = '00000000-0000-4000-8000-000000000001';
        const opening = editor.open({ projectPath: project, bindingId });
        expect(await editor.close({ bindingId })).toEqual({ ok: true, value: { closed: true } });
        expect(await opening).toMatchObject({ ok: false, error: { code: 'BINDING_NOT_FOUND' } });
        expect(await editor.state({ bindingId })).toMatchObject({ ok: false, error: { code: 'BINDING_NOT_FOUND' } }); editor.dispose();
    });
});
