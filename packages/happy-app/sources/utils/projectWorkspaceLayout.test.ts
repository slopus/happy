import { describe, expect, it } from 'vitest';
import { shouldShowWorktreeDivider } from './projectWorkspaceLayout';

describe('project workspace layout', () => {
    it('labels a named worktree even when filtering makes it the first visible workspace', () => {
        expect(shouldShowWorktreeDivider('feature/checkout')).toBe(true);
    });

    it('does not add a redundant label for the implicit primary workspace', () => {
        expect(shouldShowWorktreeDivider(null)).toBe(false);
    });
});
