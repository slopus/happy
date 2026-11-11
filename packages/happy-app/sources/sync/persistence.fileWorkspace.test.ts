import { afterEach, describe, expect, it } from 'vitest';
import { loadFileWorkspaceReference, saveFileWorkspaceReference, loadFileWorkspaceUI, saveFileWorkspaceUI } from './persistence';
const scope = 'workspace-reference-test';
afterEach(() => { saveFileWorkspaceReference(scope, null); saveFileWorkspaceReference(scope + '-other', null); });
describe('pending workspace file context storage', () => {
    it('distinguishes the old default from a manual split and preserves an explicit choice at the default width', () => {
        saveFileWorkspaceUI(scope, { tabs: [], active: null, open: false, width: 430 });
        expect(loadFileWorkspaceUI(scope).widthCustomized).toBe(false);
        saveFileWorkspaceUI(scope, { tabs: [], active: null, open: false, width: 600 });
        expect(loadFileWorkspaceUI(scope).widthCustomized).toBe(true);
        saveFileWorkspaceUI(scope, { tabs: [], active: null, open: false, width: 430, widthCustomized: true });
        expect(loadFileWorkspaceUI(scope).widthCustomized).toBe(true);
    });
    it('restores a user split wider than 800px after reload', () => {
        saveFileWorkspaceUI(scope, { tabs: [], active: null, open: false, width: 1250 });
        expect(loadFileWorkspaceUI(scope).width).toBe(1250);
    });
    it('round-trips the original hash and quote in its own scope and clears after removal', () => {
        const reference = { path: '/work/docs/方案.md', hash: 'a'.repeat(64), quote: '选中的原文' };
        saveFileWorkspaceReference(scope, reference);
        expect(loadFileWorkspaceReference(scope)).toEqual(reference);
        expect(loadFileWorkspaceReference(scope + '-other')).toBeNull();
        saveFileWorkspaceReference(scope, null);
        expect(loadFileWorkspaceReference(scope)).toBeNull();
    });
    it.each([
        { path: '', hash: 'a'.repeat(64) },
        { path: '/work/plan.md', hash: 'not-a-file-hash' },
        { path: '/work/plan.md', hash: 'a'.repeat(64), quote: 'x'.repeat(4001) },
    ])('rejects malformed cached context: %j', reference => {
        saveFileWorkspaceReference(scope, reference);
        expect(loadFileWorkspaceReference(scope)).toBeNull();
    });
});
