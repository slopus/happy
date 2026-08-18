import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rigMetadataFixture } from './__testdata__/rigMetadata';

const { sessionRPC, machineRPC, getState } = vi.hoisted(() => ({
    sessionRPC: vi.fn(),
    machineRPC: vi.fn(),
    getState: vi.fn(),
}));

vi.mock('./apiSocket', () => ({ apiSocket: { sessionRPC, machineRPC } }));
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

    it('forwards a worktree request in the Rig spawn payload', async () => {
        // The payload is rebuilt field by field rather than spread, so anything
        // new has to be added there explicitly — it was dropped in silence once.
        machineRPC.mockResolvedValue({ type: 'success', sessionId: 'rig-1' });
        const { machineSpawnNewSession } = await import('./ops');

        await machineSpawnNewSession({
            machineId: 'machine-1',
            directory: '/Users/dev/project',
            agent: 'rig',
            clientRequestId: 'request-1',
            providerId: 'codex',
            modelId: 'model',
            effort: 'high',
            worktree: { type: 'new', name: 'quiet-harbor' },
        });

        expect(machineRPC).toHaveBeenCalledWith(
            'machine-1',
            'spawn-happy-session',
            expect.objectContaining({ worktree: { type: 'new', name: 'quiet-harbor' } }),
        );
    });

    it('never invokes unadvertised directory RPC helpers for Rig', async () => {
        const { sessionGetDirectoryTree, sessionListDirectory } = await import('./ops');
        expect(await sessionListDirectory('rig', '.')).toMatchObject({ success: false });
        expect(await sessionGetDirectoryTree('rig', '.', 2)).toMatchObject({ success: false });
        expect(sessionRPC).not.toHaveBeenCalled();
    });
});
