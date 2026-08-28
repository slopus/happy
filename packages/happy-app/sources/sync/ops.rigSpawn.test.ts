import { beforeEach, describe, expect, it, vi } from 'vitest';

const { machineRPC } = vi.hoisted(() => ({ machineRPC: vi.fn() }));

vi.mock('./apiSocket', () => ({ apiSocket: { machineRPC } }));
vi.mock('./sync', () => ({ sync: {} }));
vi.mock('./storage', () => ({ storage: { getState: vi.fn() } }));

describe('Rig machine spawn RPC', () => {
    beforeEach(() => {
        machineRPC.mockReset();
    });

    it('sends only the Rig-native idempotent creation payload', async () => {
        machineRPC.mockResolvedValue({
            type: 'pending',
            clientRequestId: 'request-1',
            retryAfterMs: 2_000,
        });
        const { machineSpawnNewSession } = await import('./ops');

        await expect(machineSpawnNewSession({
            machineId: 'rig-machine',
            directory: '/work/project',
            approvedNewDirectoryCreation: false,
            agent: 'rig',
            clientRequestId: 'request-1',
            providerId: 'codex',
            modelId: 'gpt-5.6-sol',
            permissionMode: 'auto',
            effort: 'high',
            // These happy-cli fields must not leak into Rig's RPC contract.
            token: 'unused',
            modelMode: 'unused',
            effortLevel: 'unused',
            resumeClaudeSessionId: 'unused',
        })).resolves.toEqual({
            type: 'pending',
            clientRequestId: 'request-1',
            retryAfterMs: 2_000,
        });

        expect(machineRPC).toHaveBeenCalledWith(
            'rig-machine',
            'spawn-happy-session',
            {
                type: 'spawn-in-directory',
                agent: 'rig',
                clientRequestId: 'request-1',
                directory: '/work/project',
                approvedNewDirectoryCreation: false,
                providerId: 'codex',
                modelId: 'gpt-5.6-sol',
                permissionMode: 'auto',
                effort: 'high',
            },
        );
    });

    it('asks Happy Agent to create and spawn inside one native workspace', async () => {
        machineRPC.mockResolvedValue({
            type: 'pending',
            clientRequestId: 'request-2',
            retryAfterMs: 2_000,
        });
        const { machineSpawnNewSession } = await import('./ops');

        await machineSpawnNewSession({
            machineId: 'rig-machine',
            directory: '/work/project',
            agent: 'rig',
            clientRequestId: 'request-2',
            providerId: 'codex',
            modelId: 'gpt-5.6-sol',
            permissionMode: 'auto',
            effort: 'high',
            happyAgentTarget: { kind: 'newWorkspace', projectId: 'project-1' },
        });

        expect(machineRPC).toHaveBeenCalledWith(
            'rig-machine',
            'spawn-happy-session',
            {
                type: 'happy-agent-spawn',
                clientRequestId: 'request-2',
                target: { kind: 'newWorkspace', projectId: 'project-1' },
                agentConfiguration: {
                    type: 'happy-agent',
                    providerId: 'codex',
                    modelId: 'gpt-5.6-sol',
                    permissionMode: 'auto',
                    effort: 'high',
                },
            },
        );
    });

    it('rejects a non-idempotent Rig spawn before calling the machine', async () => {
        const { machineSpawnNewSession } = await import('./ops');

        await expect(machineSpawnNewSession({
            machineId: 'rig-machine',
            directory: '/work/project',
            agent: 'rig',
        })).resolves.toEqual({
            type: 'error',
            errorMessage: 'Rig session creation requires a client request ID',
        });
        expect(machineRPC).not.toHaveBeenCalled();
    });
});
