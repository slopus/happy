import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cachedLinuxSandboxDependencyStatus } from '@/sandbox/dependencyPreflight';
import { injectCheckpointSpawnContext } from '@/checkpoint/checkpointSpawnContext';
import { CheckpointProtectionStateStore } from '@/checkpoint/checkpointProtectionState';
import { SandboxConfigSchema } from '@/persistence';
import { resolveCheckpointSessionAuthority } from './checkpointSessionAuthority';

vi.mock('@/sandbox/dependencyPreflight', () => ({
    cachedLinuxSandboxDependencyStatus: vi.fn(() => ({ ok: true })),
}));
import { captureSaycodeAgentEnvironment } from './sessionEnv';
import type { TrackedSession } from './types';

describe('resolveCheckpointSessionAuthority', () => {
    let fixtureRoot: string;
    let checkpointRoot: string;
    let projectPath: string;

    beforeEach(async () => {
        fixtureRoot = await mkdtemp(join(tmpdir(), 'happy-checkpoint-authority-'));
        checkpointRoot = join(fixtureRoot, 'checkpoints');
        const projectDirectory = join(fixtureRoot, 'project');
        await mkdir(projectDirectory, { recursive: true });
        projectPath = await realpath(projectDirectory);
        await writeFile(join(projectPath, '.env'), 'secret\n');
        await writeFile(join(projectPath, 'source.txt'), 'source\n');
    });

    afterEach(async () => {
        await rm(fixtureRoot, { recursive: true, force: true });
    });

    function trackedSession(): TrackedSession {
        return {
            startedBy: 'daemon',
            happySessionId: 'session-1',
            directory: projectPath,
            pid: 1234,
            agentEnvironment: captureSaycodeAgentEnvironment(injectCheckpointSpawnContext({}, {
                projectId: 'project-1',
                worktreeId: null,
                checkpointRoot,
            })),
            happySessionMetadataFromLocalWebhook: {
                flavor: 'codex',
                sandbox: SandboxConfigSchema.parse({
                    checkpointProtection: {
                        secretPatterns: ['.env*'],
                        maxFileBytes: 1024,
                        maxFiles: 100,
                        maxTotalBytes: 4096,
                    },
                }),
            } as TrackedSession['happySessionMetadataFromLocalWebhook'],
        };
    }

    it('derives exact binding and exclusions from daemon-owned session state', async () => {
        await expect(resolveCheckpointSessionAuthority({
            sessionId: 'session-1',
            trackedSession: trackedSession(),
            checkpointRoot,
            platform: 'darwin',
        })).resolves.toMatchObject({
            sessionId: 'session-1',
            projectId: 'project-1',
            worktreeId: null,
            projectPath,
            protection: { status: 'protected' },
            mode: 'local-history',
            excludedPaths: [],
            excludedPatterns: ['.env*', '.aplus/worktrees/'],
        });
    });

    it('does not authorize a different session id', async () => {
        await expect(resolveCheckpointSessionAuthority({
            sessionId: 'other-session',
            trackedSession: trackedSession(),
            checkpointRoot,
            platform: 'darwin',
        })).resolves.toBeNull();
    });

    it('reports legacy when the tracked session did not enable checkpoint protection', async () => {
        const tracked = trackedSession();
        tracked.happySessionMetadataFromLocalWebhook = {
            ...tracked.happySessionMetadataFromLocalWebhook,
            sandbox: SandboxConfigSchema.parse({}),
        } as TrackedSession['happySessionMetadataFromLocalWebhook'];

        await expect(resolveCheckpointSessionAuthority({
            sessionId: 'session-1',
            trackedSession: tracked,
            checkpointRoot,
            platform: 'darwin',
        })).resolves.toMatchObject({
            protection: { status: 'legacy' },
            excludedPaths: [],
            excludedPatterns: [],
        });
    });

    it('reports unavailable on a platform without the v1 enforcement backend', async () => {
        await expect(resolveCheckpointSessionAuthority({
            sessionId: 'session-1',
            trackedSession: trackedSession(),
            checkpointRoot,
            platform: 'win32',
        })).resolves.toMatchObject({
            protection: { status: 'unavailable', reason: 'unsupported-platform' },
            excludedPaths: [],
            excludedPatterns: [],
        });
    });

    // specs/checkpoint-local-history — recording needs git, not the Linux sandbox backend.
    it('offers local history on Linux without the bubblewrap dependencies', async () => {
        vi.mocked(cachedLinuxSandboxDependencyStatus).mockReturnValue({ ok: false, missing: ['socat'] });
        await expect(resolveCheckpointSessionAuthority({
            sessionId: 'session-1',
            trackedSession: trackedSession(),
            checkpointRoot,
            platform: 'linux',
        })).resolves.toMatchObject({
            protection: { status: 'protected' },
            mode: 'local-history',
        });
    });

    it('preserves daemon-authoritative pending and disabled protection state', async () => {
        const store = new CheckpointProtectionStateStore(checkpointRoot);
        const binding = {
            sessionId: 'session-1',
            projectId: 'project-1',
            worktreeId: null,
            projectPath,
        } as const;
        await store.reportPending({
            ...binding,
            operationId: 'turn-1',
            source: 'policy-drift',
            excluded: [{ path: '.env', reason: 'secret' }],
        });

        await expect(resolveCheckpointSessionAuthority({
            sessionId: 'session-1',
            trackedSession: trackedSession(),
            checkpointRoot,
            platform: 'darwin',
        })).resolves.toMatchObject({
            protection: { status: 'protected' },
            pendingDecision: { operationId: 'turn-1' },
        });

        await store.resolveDecision({
            ...binding,
            operationId: 'turn-1',
            decision: 'disable-protection',
        });
        const disabledTracked = trackedSession();
        disabledTracked.happySessionMetadataFromLocalWebhook = {
            ...disabledTracked.happySessionMetadataFromLocalWebhook,
            sandbox: SandboxConfigSchema.parse({
                checkpointProtection: {
                    secretPatterns: ['.env*'],
                    maxFileBytes: 1024,
                    maxFiles: 100,
                    maxTotalBytes: 4096,
                    readOnlyPassthroughPaths: ['missing-cache'],
                },
            }),
        } as TrackedSession['happySessionMetadataFromLocalWebhook'];
        await expect(resolveCheckpointSessionAuthority({
            sessionId: 'session-1',
            trackedSession: disabledTracked,
            checkpointRoot,
            platform: 'darwin',
        })).resolves.toMatchObject({
            protection: { status: 'unavailable', reason: 'excluded-path' },
            pendingDecision: null,
        });
    });
});
