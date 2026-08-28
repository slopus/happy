import { describe, expect, it } from 'vitest';
import { projectKey, projectStarKey } from './projectPath';

describe('projectStarKey', () => {
    it('keys a plain checkout by its own path', () => {
        expect(projectStarKey('m1', '/Users/me/repo')).toBe(projectKey('m1', '/Users/me/repo'));
    });

    it('keys a worktree by its repo, so it inherits the repo star', () => {
        expect(projectStarKey('m1', '/Users/me/repo/.dev/worktree/feature-x'))
            .toBe(projectKey('m1', '/Users/me/repo'));
    });

    it('separates the same path on different machines', () => {
        expect(projectStarKey('m1', '/repo')).not.toBe(projectStarKey('m2', '/repo'));
    });
});
