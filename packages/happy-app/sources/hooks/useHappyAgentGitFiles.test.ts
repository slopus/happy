import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HappyAgentGitFile } from '@/sync/happyAgentGit';

const { readFile } = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock('@/sync/happyAgentGit', () => ({ readHappyAgentGitFile: readFile }));
import { useHappyAgentGitFiles } from './useHappyAgentGitFiles';

const base = 'a'.repeat(40);
const files: HappyAgentGitFile[] = ['a.ts', 'b.ts', 'c.ts'].map((path) => ({
    path, status: 'modified', staged: false, unstaged: false, binary: false,
}));
let current: ReturnType<typeof useHappyAgentGitFiles>;
let renderer: ReturnType<typeof create> | undefined;
function Harness({ sessionId = 'session' }: { sessionId?: string }) {
    current = useHappyAgentGitFiles(sessionId, base, files);
    return null;
}
function pendingRead() {
    let resolve!: (value: { kind: 'text'; oldText: string; newText: string }) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<{ kind: 'text'; oldText: string; newText: string }>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}
const contents = { kind: 'text' as const, oldText: 'before', newText: 'after' };

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    readFile.mockReset();
});
afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    vi.unstubAllGlobals();
});

describe('on-demand Happy Agent file reads', () => {
    it('starts no reads before expansion, deduplicates requests, and limits active file reads to two', async () => {
        const reads = [pendingRead(), pendingRead(), pendingRead()];
        reads.forEach((read) => readFile.mockReturnValueOnce(read.promise));
        await act(async () => { renderer = create(React.createElement(Harness)); });
        expect(readFile).not.toHaveBeenCalled();
        await act(async () => {
            current.requestContent('a.ts');
            current.requestContent('a.ts');
            current.requestContent('b.ts');
            current.requestContent('c.ts');
            current.requestContent('outside.ts');
        });
        expect(readFile).toHaveBeenCalledTimes(2);
        expect(readFile).toHaveBeenNthCalledWith(1, 'session', base, files[0]);
        await act(async () => { reads[0].resolve(contents); });
        expect(readFile).toHaveBeenCalledTimes(3);
        expect(readFile).toHaveBeenNthCalledWith(3, 'session', base, files[2]);
        await act(async () => {
            reads[1].resolve(contents);
            reads[2].resolve(contents);
            current.requestContent('a.ts');
        });
        expect(current.results.size).toBe(3);
        expect(readFile).toHaveBeenCalledTimes(3);
    });

    it('records failures, frees their slot, and never automatically retries a failed file', async () => {
        const first = pendingRead();
        const second = pendingRead();
        readFile.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValue(contents);
        await act(async () => { renderer = create(React.createElement(Harness)); });
        await act(async () => files.forEach((file) => current.requestContent(file.path)));
        await act(async () => { first.reject(new Error('File is too large')); });
        expect(readFile).toHaveBeenCalledTimes(3);
        expect(current.results.get('a.ts')).toEqual({ content: null, error: 'File is too large' });
        await act(async () => { current.requestContent('a.ts'); second.resolve(contents); });
        expect(readFile).toHaveBeenCalledTimes(3);
    });

    it('drops old replies and queued work when a different snapshot replaces the viewer', async () => {
        const old = [pendingRead(), pendingRead()];
        readFile.mockReturnValueOnce(old[0].promise).mockReturnValueOnce(old[1].promise).mockResolvedValue(contents);
        await act(async () => { renderer = create(React.createElement(Harness, { key: 'old' })); });
        await act(async () => files.forEach((file) => current.requestContent(file.path)));
        await act(async () => renderer.update(React.createElement(Harness, { key: 'new', sessionId: 'new-session' })));
        await act(async () => old.forEach((read) => read.resolve(contents)));
        expect(current.results.size).toBe(0);
        expect(readFile).toHaveBeenCalledTimes(2);
        await act(async () => current.requestContent('a.ts'));
        expect(readFile).toHaveBeenLastCalledWith('new-session', base, files[0]);
    });
});