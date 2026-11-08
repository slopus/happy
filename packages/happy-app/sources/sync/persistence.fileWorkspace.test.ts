import { afterEach, describe, expect, it } from 'vitest';
import { loadFileWorkspaceReference, saveFileWorkspaceReference } from './persistence';
const scope = 'workspace-reference-test';
afterEach(() => { saveFileWorkspaceReference(scope, null); saveFileWorkspaceReference(scope + '-other', null); });
describe('pending workspace file context storage', () => {
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
