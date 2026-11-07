import { describe, it, expect } from 'vitest';
import { getParentPath, joinChild, canGoUp, resolveBack } from './folderBrowserNav';

describe('getParentPath', () => {
    it('drops the last segment', () => {
        expect(getParentPath('/Users/j/projects/demo')).toBe('/Users/j/projects');
    });
    it('handles a trailing slash', () => {
        expect(getParentPath('/Users/j/demo/')).toBe('/Users/j');
    });
    it('caps at filesystem root', () => {
        expect(getParentPath('/Users')).toBe('/');
        expect(getParentPath('/')).toBe('/');
    });
});

describe('joinChild', () => {
    it('joins a child name', () => {
        expect(joinChild('/Users/j', 'demo')).toBe('/Users/j/demo');
    });
    it('normalizes a trailing slash', () => {
        expect(joinChild('/Users/j/', 'demo')).toBe('/Users/j/demo');
    });
});

describe('canGoUp', () => {
    it('is false at home', () => {
        expect(canGoUp('/Users/j', '/Users/j', '/Users/j/projects/demo')).toBe(false);
    });
    it('is true below home', () => {
        expect(canGoUp('/Users/j/projects', '/Users/j', '/Users/j/projects/demo')).toBe(true);
    });
    it('stops at an external session root and allows navigation inside it', () => {
        const root = '/Volumes/External SSD/projects/demo';
        expect(canGoUp(root, '/Users/j', root)).toBe(false);
        expect(canGoUp(`${root}/src`, '/Users/j', root)).toBe(true);
        expect(canGoUp(`${root}-private/src`, '/Users/j', root)).toBe(false);
    });
    it('stops at the filesystem root', () => {
        expect(canGoUp('/', '/Users/j', '/Volumes/External SSD/demo')).toBe(false);
    });
    it('normalizes trailing separators on allowed roots', () => {
        expect(canGoUp('/Users/j/projects', '/Users/j/', '/Users/j/projects/demo/')).toBe(true);
    });
});

describe('resolveBack', () => {
    const home = '/Users/j';
    const root = '/Users/j/projects/demo';
    it('exits at the browser root', () => {
        expect(resolveBack(root, root, home)).toEqual({ kind: 'exit' });
    });
    it('goes up one level below root', () => {
        expect(resolveBack('/Users/j/projects/demo/src', root, home)).toEqual({ kind: 'up', path: root });
    });
    it('goes up when navigated above root', () => {
        expect(resolveBack('/Users/j/projects', root, home)).toEqual({ kind: 'up', path: home });
    });
    it('exits at home even when home is not the root', () => {
        expect(resolveBack(home, root, home)).toEqual({ kind: 'exit' });
    });
    it('returns from external descendants and exits at the external root', () => {
        const externalRoot = '/Volumes/External SSD/demo';
        expect(resolveBack(`${externalRoot}/src`, externalRoot, home)).toEqual({ kind: 'up', path: externalRoot });
        expect(resolveBack(externalRoot, externalRoot, home)).toEqual({ kind: 'exit' });
    });
});
