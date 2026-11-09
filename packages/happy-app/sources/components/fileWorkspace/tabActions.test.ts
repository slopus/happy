import { describe, expect, it } from 'vitest';
import { FileWorkspaceController } from './controller';
import { tabCloseTargets } from './tabActions';

const tabs = ['/work/a.md', '/work/b.md', '/work/c.md'];
describe('tab context actions', () => {
    it('uses the clicked tab as the boundary, regardless of the active tab', () => {
        expect(tabCloseTargets(tabs, tabs[1], 'left')).toEqual([tabs[0]]);
        expect(tabCloseTargets(tabs, tabs[1], 'right')).toEqual([tabs[2]]);
        expect(tabCloseTargets(tabs, tabs[1], 'others')).toEqual([tabs[0], tabs[2]]);
        expect(tabCloseTargets(tabs, tabs[1], 'all')).toEqual(tabs);
        expect(tabCloseTargets(tabs, tabs[0], 'left')).toEqual([]);
        expect(tabCloseTargets(tabs, '/closed.md', 'all')).toEqual([]);
    });
    it('does not partially close a group containing unsaved work', async () => {
        const controller = new FileWorkspaceController({ root: '/work', read: async () => ({ content: 'base', hash: 'h' }), write: async () => ({ hash: 'saved' }) });
        for (const path of tabs) await controller.open(path);
        controller.edit(tabs[1], 'unsaved');
        expect(controller.closeMany(tabs)).toBe(false);
        expect(controller.getSnapshot().tabs).toEqual(tabs);
        expect(controller.getSnapshot().documents[tabs[1]].draft).toBe('unsaved');
        expect(controller.closeMany(tabs, true)).toBe(true);
        expect(controller.getSnapshot()).toMatchObject({ tabs: [], active: null, open: false });
    });
    it('protects cached drafts and in-flight saves even during a group close', async () => {
        let finish!: (value: { hash: string }) => void;
        const controller = new FileWorkspaceController({ root: '/work', read: async () => ({ content: 'base', hash: 'h' }), write: () => new Promise(resolve => { finish = resolve; }) });
        for (const path of tabs) await controller.open(path);
        controller.restoreDraft(tabs[1], { draft: 'cached', hash: 'old' });
        expect(controller.closeMany(tabs)).toBe(false);
        controller.edit(tabs[0], 'saving');
        const saving = controller.save(tabs[0]);
        expect(controller.closeMany(tabs, true)).toBe(false);
        expect(controller.getSnapshot().tabs).toEqual(tabs);
        finish({ hash: 'saved' }); await saving;
        expect(controller.closeMany([tabs[0], tabs[2]])).toBe(true);
        expect(controller.getSnapshot().active).toBe(tabs[1]);
    });
});
