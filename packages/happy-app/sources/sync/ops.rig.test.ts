import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rigMetadataFixture } from './__testdata__/rigMetadata';

const { sessionRPC, getState } = vi.hoisted(() => ({
    sessionRPC: vi.fn(),
    getState: vi.fn(),
}));

vi.mock('./apiSocket', () => ({ apiSocket: { sessionRPC } }));
vi.mock('./sync', () => ({ sync: {} }));
vi.mock('./storage', () => ({ storage: { getState } }));

describe('Rig session RPC capability gates', () => {
    beforeEach(() => {
        sessionRPC.mockReset();
        sessionRPC.mockResolvedValue({ aborted: true });
        getState.mockReturnValue({
            sessions: { rig: { metadata: rigMetadataFixture } },
        });
    });

    it('calls the encrypted session-scoped abort RPC with an empty payload', async () => {
        const { sessionAbort } = await import('./ops');
        await sessionAbort('rig');
        expect(sessionRPC).toHaveBeenCalledWith('rig', 'abort', {});
    });

    it('does not call RPC methods that disappear after metadata refresh', async () => {
        getState.mockReturnValue({
            sessions: {
                rig: {
                    metadata: {
                        ...rigMetadataFixture,
                        capabilities: {
                            ...rigMetadataFixture.capabilities!,
                            files: { ...rigMetadataFixture.capabilities!.files, write: false },
                            rpcMethods: ['abort', 'bash', 'readFile', 'ripgrep'],
                        },
                    },
                },
            },
        });
        const { sessionWriteFile } = await import('./ops');
        await expect(sessionWriteFile('rig', '/tmp/a', 'YQ==', null)).resolves.toMatchObject({
            success: false,
            error: 'File writing is not available for this session',
        });
        expect(sessionRPC).not.toHaveBeenCalled();
    });

    it('never invokes unadvertised directory RPC helpers for Rig', async () => {
        const { sessionGetDirectoryTree, sessionListDirectory } = await import('./ops');
        expect(await sessionListDirectory('rig', '.')).toMatchObject({ success: false });
        expect(await sessionGetDirectoryTree('rig', '.', 2)).toMatchObject({ success: false });
        expect(sessionRPC).not.toHaveBeenCalled();
    });
});
