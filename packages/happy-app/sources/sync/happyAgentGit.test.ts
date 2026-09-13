import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    sessionRPC: vi.fn(),
    state: {
        sessions: {} as Record<string, { metadata?: unknown }>,
    },
}));

vi.mock('./apiSocket', () => ({
    apiSocket: { sessionRPC: mocks.sessionRPC },
}));
vi.mock('./storage', () => ({
    storage: { getState: () => mocks.state },
}));

import { rigMetadataFixture } from './__testdata__/rigMetadata';
import {
    getHappyAgentGitState,
    readHappyAgentGitFile,
    supportsHappyAgentGit,
    type HappyAgentGitFile,
    type HappyAgentGitState,
} from './happyAgentGit';
import type { Metadata } from './storageTypes';

const SESSION_ID = 'session-1';
const BASE = 'a'.repeat(40);
const HASH = 'b'.repeat(64);

const nativeMetadata: Metadata = {
    ...rigMetadataFixture,
    capabilities: {
        ...rigMetadataFixture.capabilities!,
        files: { ...rigMetadataFixture.capabilities!.files, read: true },
        rpcMethods: [
            ...rigMetadataFixture.capabilities!.rpcMethods,
            'gitState',
            'readFileAtRevision',
        ],
    },
};

function file(overrides: Partial<HappyAgentGitFile> = {}): HappyAgentGitFile {
    return {
        path: 'src/file.ts',
        status: 'modified',
        staged: false,
        unstaged: true,
        binary: false,
        ...overrides,
    };
}

function gitState(files: HappyAgentGitFile[] = []): HappyAgentGitState {
    return {
        facts: {
            branch: 'feature/mobile-changes',
            detached: false,
            head: BASE,
            upstream: 'origin/feature/mobile-changes',
            ahead: 1,
            behind: 2,
        },
        comparison: 'ready',
        base: BASE,
        changedFiles: files.length,
        insertions: 3,
        deletions: 1,
        countsExact: true,
        conflicted: false,
        files,
        filesTruncated: false,
        scannedAt: 123,
    };
}

function useNativeSession(metadata: Metadata | null = nativeMetadata): void {
    mocks.state.sessions = { [SESSION_ID]: { metadata } };
}

function textResponse(content: string) {
    return { success: true, content, hash: HASH };
}

function revisionResponse(content: string) {
    return { success: true, content };
}

beforeEach(() => {
    mocks.sessionRPC.mockReset();
    mocks.state.sessions = {};
});

describe('Happy Agent Git capability gating', () => {
    it('requires native V1, readable files, and every Git RPC method', () => {
        expect(supportsHappyAgentGit(nativeMetadata)).toBe(true);
        expect(supportsHappyAgentGit({
            ...nativeMetadata,
            rigMetadataVersion: 0,
        } as Metadata)).toBe(false);
        expect(supportsHappyAgentGit({
            ...nativeMetadata,
            rigMetadataVersion: undefined,
        })).toBe(false);
        expect(supportsHappyAgentGit({
            ...nativeMetadata,
            capabilities: {
                ...nativeMetadata.capabilities!,
                files: { ...nativeMetadata.capabilities!.files, read: false },
            },
        })).toBe(false);
        expect(supportsHappyAgentGit({
            ...nativeMetadata,
            capabilities: {
                ...nativeMetadata.capabilities!,
                rpcMethods: ['readFile', 'gitState'],
            },
        })).toBe(false);
    });

    it('does not call RPC for unsupported, V0, or legacy sessions', async () => {
        for (const metadata of [
            null,
            { ...nativeMetadata, rigMetadataVersion: 0 } as Metadata,
            { ...nativeMetadata, rigMetadataVersion: undefined },
        ]) {
            useNativeSession(metadata);
            await expect(getHappyAgentGitState(SESSION_ID)).rejects.toThrow(/not available/);
        }
        expect(mocks.sessionRPC).not.toHaveBeenCalled();
    });
});

describe('Happy Agent Git state', () => {
    it('uses an exact session-scoped empty gitState request and preserves committed files', async () => {
        const committed = file({ path: 'committed.ts', staged: false, unstaged: false });
        const staged = file({ path: 'staged.ts', staged: true, unstaged: false });
        useNativeSession();
        mocks.sessionRPC.mockResolvedValue({ success: true, git: gitState([committed, staged]) });

        await expect(getHappyAgentGitState(SESSION_ID)).resolves.toEqual(gitState([committed, staged]));
        expect(mocks.sessionRPC).toHaveBeenCalledExactlyOnceWith(SESSION_ID, 'gitState', {});
    });

    it('throws the native failure message and rejects malformed or unknown responses', async () => {
        useNativeSession();
        mocks.sessionRPC.mockResolvedValueOnce({
            success: false,
            code: 'unavailable',
            error: 'Git is unavailable for this workspace.',
        });
        await expect(getHappyAgentGitState(SESSION_ID)).rejects.toThrow('Git is unavailable for this workspace.');

        mocks.sessionRPC.mockResolvedValueOnce({ success: true, git: { comparison: 'unknown' } });
        await expect(getHappyAgentGitState(SESSION_ID)).rejects.toThrow('invalid Git state');
    });
});

describe('Happy Agent Git file reads', () => {
    it('reads a modified file from the exact base and working-tree paths in parallel', async () => {
        useNativeSession();
        mocks.sessionRPC
            .mockResolvedValueOnce(revisionResponse(btoa('old text\n')))
            .mockResolvedValueOnce(textResponse(btoa('new text\n')));

        await expect(readHappyAgentGitFile(SESSION_ID, BASE, file())).resolves.toEqual({
            kind: 'text',
            oldText: 'old text\n',
            newText: 'new text\n',
        });
        expect(mocks.sessionRPC).toHaveBeenCalledTimes(2);
        expect(mocks.sessionRPC).toHaveBeenCalledWith(SESSION_ID, 'readFileAtRevision', {
            path: 'src/file.ts',
            revision: BASE,
        });
        expect(mocks.sessionRPC).toHaveBeenCalledWith(SESSION_ID, 'readFile', { path: 'src/file.ts' });
    });

    it('uses previousPath for renames and skips the absent side for add/delete', async () => {
        useNativeSession();
        mocks.sessionRPC
            .mockResolvedValueOnce(revisionResponse(btoa('before\n')))
            .mockResolvedValueOnce(textResponse(btoa('after\n')));
        await expect(readHappyAgentGitFile(SESSION_ID, BASE, file({
            path: 'new/name.ts',
            previousPath: 'old/name.ts',
            status: 'renamed',
        }))).resolves.toEqual({ kind: 'text', oldText: 'before\n', newText: 'after\n' });
        expect(mocks.sessionRPC).toHaveBeenNthCalledWith(1, SESSION_ID, 'readFileAtRevision', {
            path: 'old/name.ts', revision: BASE,
        });
        expect(mocks.sessionRPC).toHaveBeenNthCalledWith(2, SESSION_ID, 'readFile', { path: 'new/name.ts' });

        mocks.sessionRPC.mockReset();
        mocks.sessionRPC.mockResolvedValueOnce(textResponse(btoa('added\n')));
        await expect(readHappyAgentGitFile(SESSION_ID, BASE, file({ status: 'added' }))).resolves.toEqual({
            kind: 'text', oldText: '', newText: 'added\n',
        });
        expect(mocks.sessionRPC).toHaveBeenCalledExactlyOnceWith(SESSION_ID, 'readFile', { path: 'src/file.ts' });

        mocks.sessionRPC.mockReset();
        mocks.sessionRPC.mockResolvedValueOnce(revisionResponse(btoa('deleted\n')));
        await expect(readHappyAgentGitFile(SESSION_ID, BASE, file({ status: 'deleted' }))).resolves.toEqual({
            kind: 'text', oldText: 'deleted\n', newText: '',
        });
        expect(mocks.sessionRPC).toHaveBeenCalledExactlyOnceWith(SESSION_ID, 'readFileAtRevision', {
            path: 'src/file.ts', revision: BASE,
        });
    });

    it('keeps empty and equal content as text instead of treating it as missing', async () => {
        useNativeSession();
        mocks.sessionRPC
            .mockResolvedValueOnce(revisionResponse(''))
            .mockResolvedValueOnce(textResponse(''));

        await expect(readHappyAgentGitFile(SESSION_ID, BASE, file())).resolves.toEqual({
            kind: 'text', oldText: '', newText: '',
        });
    });

    it('preserves a UTF-8 byte order mark so adding or removing one is a visible change', async () => {
        const bomBytes = String.fromCharCode(0xef, 0xbb, 0xbf);
        useNativeSession();
        mocks.sessionRPC
            .mockResolvedValueOnce(revisionResponse(btoa('hello\n')))
            .mockResolvedValueOnce(textResponse(btoa(`${bomBytes}hello\n`)));

        const result = await readHappyAgentGitFile(SESSION_ID, BASE, file());
        expect(result.kind).toBe('text');
        if (result.kind !== 'text') return;
        expect(result.oldText).toBe('hello\n');
        expect(result.newText).toBe('\ufeffhello\n');
        expect(result.oldText).not.toBe(result.newText);

        mocks.sessionRPC.mockReset();
        mocks.sessionRPC.mockResolvedValueOnce(textResponse(btoa(bomBytes)));
        await expect(readHappyAgentGitFile(SESSION_ID, BASE, file({ status: 'added' }))).resolves.toEqual({
            kind: 'text', oldText: '', newText: '\ufeff',
        });
    });

    it('returns explicit messages for unsupported and non-image binary files without reading', async () => {
        useNativeSession();
        for (const status of ['conflicted', 'submodule', 'type_changed'] as const) {
            await expect(readHappyAgentGitFile(SESSION_ID, BASE, file({ status }))).resolves.toMatchObject({
                kind: 'message',
            });
        }
        await expect(readHappyAgentGitFile(SESSION_ID, BASE, file({ path: 'archive.dat', binary: true }))).resolves.toEqual({
            kind: 'message', message: 'Binary file changes cannot be previewed.',
        });
        expect(mocks.sessionRPC).not.toHaveBeenCalled();
    });

    it('returns image data with the path-specific MIME type for a binary rename', async () => {
        useNativeSession();
        mocks.sessionRPC
            .mockResolvedValueOnce(revisionResponse(btoa('\x89PNG\r\n')))
            .mockResolvedValueOnce(textResponse(btoa('GIF89a')));

        await expect(readHappyAgentGitFile(SESSION_ID, BASE, file({
            path: 'new/photo.jpg',
            previousPath: 'old/photo.png',
            status: 'renamed',
            binary: true,
        }))).resolves.toEqual({
            kind: 'image',
            before: 'data:image/png;base64,iVBORw0K',
            after: 'data:image/jpeg;base64,R0lGODlh',
        });
    });

    it('surfaces native missing and local oversize failures as human errors', async () => {
        useNativeSession();
        mocks.sessionRPC
            .mockResolvedValueOnce({ success: false, code: 'missing', error: 'The file does not exist at this revision.' })
            .mockResolvedValueOnce(textResponse(btoa('new\n')));
        await expect(readHappyAgentGitFile(SESSION_ID, BASE, file())).rejects.toThrow(
            'The file does not exist at this revision.',
        );

        mocks.sessionRPC.mockReset();
        const tooLarge = btoa('x'.repeat(512 * 1024 + 1));
        mocks.sessionRPC.mockResolvedValueOnce(textResponse(tooLarge));
        await expect(readHappyAgentGitFile(SESSION_ID, BASE, file({ status: 'added' }))).rejects.toThrow(
            'This file is too large to preview on the phone.',
        );

        mocks.sessionRPC.mockReset();
        const exactlyAtLimit = 'x'.repeat(512 * 1024);
        mocks.sessionRPC.mockResolvedValueOnce(textResponse(btoa(exactlyAtLimit)));
        await expect(readHappyAgentGitFile(SESSION_ID, BASE, file({ status: 'added' }))).resolves.toEqual({
            kind: 'text', oldText: '', newText: exactlyAtLimit,
        });
    });

    it('rejects malformed read responses and preserves transport errors', async () => {
        useNativeSession();
        mocks.sessionRPC.mockResolvedValueOnce({ success: true, content: 7, hash: HASH });
        await expect(readHappyAgentGitFile(SESSION_ID, BASE, file({ status: 'added' }))).rejects.toThrow('invalid file response');

        const transportError = new Error('The computer did not respond');
        mocks.sessionRPC.mockReset();
        mocks.sessionRPC.mockRejectedValueOnce(transportError);
        await expect(readHappyAgentGitFile(SESSION_ID, BASE, file({ status: 'added' }))).rejects.toBe(transportError);
    });

    it('waits for the other started side after one RPC rejects', async () => {
        useNativeSession();
        const beforeError = new Error('base read failed');
        let resolveAfter!: (response: unknown) => void;
        const afterPending = new Promise<unknown>((resolve) => { resolveAfter = resolve; });
        mocks.sessionRPC.mockImplementation((_sessionId: string, method: string) =>
            method === 'readFileAtRevision' ? Promise.reject(beforeError) : afterPending,
        );

        let settled = false;
        const reading = readHappyAgentGitFile(SESSION_ID, BASE, file());
        void reading.then(() => { settled = true; }, () => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);

        resolveAfter(textResponse(btoa('after\n')));
        await expect(reading).rejects.toBe(beforeError);
    });

    it('reports binary-looking text and empty images without fabricating text', async () => {
        useNativeSession();
        mocks.sessionRPC.mockResolvedValueOnce(textResponse(btoa('a\u0000b')));
        await expect(readHappyAgentGitFile(SESSION_ID, BASE, file({ status: 'added' }))).resolves.toEqual({
            kind: 'message', message: 'This file contains binary data and cannot be shown as text.',
        });

        mocks.sessionRPC.mockReset();
        mocks.sessionRPC.mockResolvedValueOnce(textResponse(''));
        await expect(readHappyAgentGitFile(SESSION_ID, BASE, file({ path: 'empty.png', status: 'added', binary: true }))).resolves.toEqual({
            kind: 'message', message: 'Image content is empty.',
        });
    });

    it('allows 20,000 combined lines, ignores a trailing newline, and caps larger text', async () => {
        useNativeSession();
        const tenThousandLines = 'x\n'.repeat(10_000);
        mocks.sessionRPC
            .mockResolvedValueOnce(revisionResponse(btoa(tenThousandLines)))
            .mockResolvedValueOnce(textResponse(btoa(tenThousandLines)));
        await expect(readHappyAgentGitFile(SESSION_ID, BASE, file())).resolves.toMatchObject({
            kind: 'text', oldText: tenThousandLines, newText: tenThousandLines,
        });

        mocks.sessionRPC.mockReset();
        const tooManyLines = 'x\n'.repeat(20_001);
        mocks.sessionRPC.mockResolvedValueOnce(textResponse(btoa(tooManyLines)));
        await expect(readHappyAgentGitFile(SESSION_ID, BASE, file({ status: 'added' }))).resolves.toEqual({
            kind: 'message', message: 'This file has too many lines to preview here.',
        });
    });
});