import { describe, expect, it } from 'vitest';
import { FileWorkspaceController } from './controller';
const root = '/workspace/project';
function setup() {
    const files = new Map([['/workspace/project/docs/计划.md', '# Plan'], ['/workspace/project/demo/index.html', '<h1>Hi</h1>']]);
    const writes: unknown[] = [];
    const controller = new FileWorkspaceController({
        root,
        read: async path => { if (!files.has(path)) throw new Error('missing'); return { content: files.get(path)!, hash: 'hash:' + files.get(path) }; },
        write: async (path, content, expectedHash) => {
            writes.push({ path, content, expectedHash });
            if (expectedHash !== 'hash:' + files.get(path)) throw new Error('conflict');
            files.set(path, content); return { hash: 'hash:' + content };
        },
    });
    return { controller, files, writes };
}
describe('file workspace real document state', () => {
    it('opens relative and absolute references as one tab, with a real loaded baseline', async () => {
        const { controller } = setup();
        await controller.open('docs/计划.md'); await controller.open('/workspace/project/docs/计划.md');
        expect(controller.getSnapshot().tabs).toEqual(['/workspace/project/docs/计划.md']);
        expect(controller.getSnapshot().documents['/workspace/project/docs/计划.md']).toMatchObject({ content: '# Plan', draft: '# Plan', hash: 'hash:# Plan', phase: 'ready' });
    });
    it('keeps each draft across tab changes and refuses silent dirty closure', async () => {
        const { controller } = setup();
        await controller.open('docs/计划.md'); controller.edit('/workspace/project/docs/计划.md', '# Changed');
        await controller.open('demo/index.html'); await controller.open('docs/计划.md');
        expect(controller.getSnapshot().documents['/workspace/project/docs/计划.md'].draft).toBe('# Changed');
        expect(controller.close('/workspace/project/docs/计划.md')).toBe(false);
        expect(controller.getSnapshot().tabs).toHaveLength(2);
    });
    it('saves to the exact file with its read hash and retains newer edits while the save is in flight', async () => {
        const { controller, files, writes } = setup();
        await controller.open('docs/计划.md'); controller.edit('/workspace/project/docs/计划.md', '# Saved');
        const saving = controller.save('/workspace/project/docs/计划.md');
        controller.edit('/workspace/project/docs/计划.md', '# Newer'); await saving;
        expect(writes).toEqual([{ path: '/workspace/project/docs/计划.md', content: '# Saved', expectedHash: 'hash:# Plan' }]);
        expect(files.get('/workspace/project/docs/计划.md')).toBe('# Saved');
        expect(controller.getSnapshot().documents['/workspace/project/docs/计划.md']).toMatchObject({ content: '# Saved', draft: '# Newer', hash: 'hash:# Saved' });
    });
    it('preserves the dirty draft when refresh sees an external change or saving conflicts', async () => {
        const { controller, files } = setup();
        await controller.open('docs/计划.md'); controller.edit('/workspace/project/docs/计划.md', '# My draft');
        files.set('/workspace/project/docs/计划.md', '# Agent edit'); await controller.refresh('/workspace/project/docs/计划.md');
        expect(controller.getSnapshot().documents['/workspace/project/docs/计划.md']).toMatchObject({ draft: '# My draft', conflict: true });
        expect(await controller.save('/workspace/project/docs/计划.md')).toBe(false);
        expect(files.get('/workspace/project/docs/计划.md')).toBe('# Agent edit');
    });
    it('does not resurrect a closed file from a late read or publish results after disposal', async () => {
        let resolve!: (value: { content: string; hash: string }) => void;
        const controller = new FileWorkspaceController({ root, read: () => new Promise(r => { resolve = r; }), write: async () => ({ hash: 'h' }) });
        const loading = controller.open('late.md'); controller.close('/workspace/project/late.md', true);
        resolve({ content: 'late', hash: 'h' }); await loading;
        expect(controller.getSnapshot().tabs).toEqual([]);
        controller.dispose(); await controller.open('another.md');
        expect(controller.getSnapshot().tabs).toEqual([]);
    });
    it('never allows a failed initial read to be saved and keeps the error visible', async () => {
        const { controller, writes } = setup(); await controller.open('missing.md');
        controller.edit('/workspace/project/missing.md', 'overwrite?');
        expect(await controller.save('/workspace/project/missing.md')).toBe(false);
        expect(writes).toEqual([]);
        expect(controller.getSnapshot().documents['/workspace/project/missing.md']).toMatchObject({ phase: 'error', error: 'missing' });
    });
});

describe('restored drafts and path scope', () => {
    it('restores a draft against the last baseline and marks external changes without discarding it', async () => {
        const { controller, files } = setup();
        files.set('/workspace/project/docs/计划.md', '# External');
        await controller.open('docs/计划.md');
        controller.restoreDraft('/workspace/project/docs/计划.md', { draft: '# Unsaved', hash: 'hash:# Plan' });
        expect(controller.getSnapshot().documents['/workspace/project/docs/计划.md']).toMatchObject({ draft: '# Unsaved', content: '# External', conflict: true });
        expect(await controller.save('/workspace/project/docs/计划.md')).toBe(false);
    });
    it('never opens outside the session root', async () => {
        const { controller } = setup();
        await controller.open('../private.md');
        expect(controller.getSnapshot().tabs).toEqual([]);
    });
});

describe('reviewed draft data protection', () => {
    it('preserves the original draft baseline through repeated conflict restorations', async () => {
        const first = setup(); first.files.set('/workspace/project/docs/计划.md', '# External');
        await first.controller.open('docs/计划.md'); first.controller.restoreDraft('/workspace/project/docs/计划.md', { draft: '# My old draft', hash: 'hash:# Plan' });
        const exported = first.controller.exportDrafts();
        expect(exported['/workspace/project/docs/计划.md'].hash).toBe('hash:# Plan');
        const second = setup(); second.files.set('/workspace/project/docs/计划.md', '# External');
        await second.controller.open('docs/计划.md'); second.controller.restoreDraft('/workspace/project/docs/计划.md', exported['/workspace/project/docs/计划.md']);
        await second.controller.refresh('/workspace/project/docs/计划.md');
        expect(second.controller.getSnapshot().documents['/workspace/project/docs/计划.md'].conflict).toBe(true);
        expect(await second.controller.save('/workspace/project/docs/计划.md')).toBe(false);
    });
    it('protects the only cached draft even if its machine file cannot be read', async () => {
        const { controller } = setup(); await controller.open('missing.md');
        controller.restoreDraft('/workspace/project/missing.md', { draft: '# Only copy', hash: 'old' });
        expect(controller.close('/workspace/project/missing.md')).toBe(false);
        expect(controller.exportDrafts()['/workspace/project/missing.md'].draft).toBe('# Only copy');
        expect(controller.close('/workspace/project/missing.md', true)).toBe(true);
        expect(controller.exportDrafts()).toEqual({});
    });
    it('retains typing entered after a confirmed discard-refresh was started', async () => {
        let read: ((value: { content: string; hash: string }) => void) | undefined;
        let initial = true;
        const controller = new FileWorkspaceController({ root, read: async () => { if (initial) return { content: '# Old', hash: 'old' }; return new Promise(resolve => { read = resolve; }); }, write: async () => ({ hash: 'saved' }) });
        await controller.open('plan.md'); controller.edit(root + '/plan.md', '# Discarded'); initial = false;
        const refreshed = controller.refresh(root + '/plan.md', true);
        controller.edit(root + '/plan.md', '# New typing');
        read!({ content: '# Remote', hash: 'remote' }); await refreshed;
        expect(controller.getSnapshot().documents[root + '/plan.md']).toMatchObject({ draft: '# New typing', conflict: true });
    });
});
