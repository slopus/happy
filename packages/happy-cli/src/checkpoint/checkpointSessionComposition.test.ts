import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SandboxConfigSchema } from '@/persistence';
import { CHECKPOINT_SPAWN_CONTEXT_ENV_KEY } from './checkpointSpawnContext';
import { CheckpointProtectionStateStore } from './checkpointProtectionState';
import { createCheckpointSessionComposition } from './checkpointSessionComposition';
import { CheckpointExclusionGuard, CheckpointPolicyDriftError } from './checkpointExclusionPolicy';
import { CheckpointRestorePlanner } from './checkpointRestorePlan';
import { CheckpointRestoreExecutor } from './checkpointRestore';

vi.mock('@/sandbox/dependencyPreflight', () => ({
    cachedLinuxSandboxDependencyStatus: vi.fn(() => ({ ok: true })),
}));

describe('createCheckpointSessionComposition', () => {
    let fixtureRoot: string;
    let projectPath: string;
    let checkpointRoot: string;

    beforeEach(async () => {
        fixtureRoot = await mkdtemp(join(tmpdir(), 'happy-checkpoint-composition-'));
        projectPath = join(fixtureRoot, 'project');
        checkpointRoot = join(fixtureRoot, 'checkpoints');
        await mkdir(projectPath);
        await writeFile(join(projectPath, 'source.txt'), 'before');
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await rm(fixtureRoot, { recursive: true, force: true });
    });

    const protection = {
        secretPatterns: ['.env*'],
        maxFileBytes: 1024,
        maxFiles: 100,
        maxTotalBytes: 4096,
    };
    const checkpointEvents = {
        snapshot: async () => ({
            id: 'event-1', seq: 1, createdAt: Date.now(), idempotent: false,
        }),
    };

    function contextEnv() {
        return {
            [CHECKPOINT_SPAWN_CONTEXT_ENV_KEY]: JSON.stringify({
                schemaVersion: 1,
                projectId: 'project-1',
                worktreeId: null,
                checkpointRoot,
            }),
        };
    }

    it.each(['claude-remote', 'codex'] as const)('keeps %s create/edit/restore/undo within the protected boundary', async (provider) => {
        const composition = await createCheckpointSessionComposition({ provider, platform: 'darwin', projectPath,
            sessionId: 'session-1', sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(), checkpointEvents });
        const checkpoints: string[] = [];
        for (const version of ['created', 'edited once', 'edited twice']) {
            const prepared = await composition.beforeTurn!();
            checkpoints.push(prepared.checkpointId);
            await writeFile(join(prepared.providerPath, 'a.html'), version);
            composition.markTurnDispatched!();
            expect((await composition.completeTurn!(async () => {})).status).toBe('completed');
        }
        const binding = { sessionId: 'session-1', projectId: 'project-1', worktreeId: null, projectPath };
        const planner = new CheckpointRestorePlanner(checkpointRoot);
        const executor = new CheckpointRestoreExecutor(checkpointRoot);
        let safetyCheckpointId = '';
        for (const [index, checkpointId] of [checkpoints[2], checkpoints[1]].entries()) {
            const plan = await planner.plan({ ...binding, checkpointId });
            const restored = await executor.execute({ ...binding, operationId: `restore-${index}`, plan, confirmed: true });
            if (restored.status !== 'completed') throw new Error('restore did not complete');
            if (index === 0) safetyCheckpointId = restored.safetyCheckpointId;
        }
        expect(await readFile(join(projectPath, 'a.html'), 'utf8')).toBe('created');
        const undo = await planner.plan({ ...binding, checkpointId: safetyCheckpointId });
        expect((await executor.execute({ ...binding, operationId: 'restore-undo', plan: undo, confirmed: true })).status).toBe('completed');
        expect(await readFile(join(projectPath, 'a.html'), 'utf8')).toBe('edited twice');
        expect((await new CheckpointProtectionStateStore(checkpointRoot).read(binding)).protection.status).toBe('protected');
        await composition.dispose!();
    }, 15_000);

    it('diagnoses newly written children of an ignored directory', async () => {
        await mkdir(join(projectPath, 'cache'));
        await writeFile(join(projectPath, '.gitignore'), 'cache/\n');
        await writeFile(join(projectPath, 'cache', 'existing.txt'), 'untouched');
        const composition = await createCheckpointSessionComposition({ provider: 'codex', platform: 'darwin', projectPath,
            sessionId: 'session-1', sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(), checkpointEvents });
        const prepared = await composition.beforeTurn!();
        await mkdir(join(prepared.providerPath, 'cache'), { recursive: true });
        await writeFile(join(prepared.providerPath, 'cache', 'new.txt'), 'denied');
        composition.markTurnDispatched!();
        await composition.completeTurn!(async () => {});
        const status = await new CheckpointProtectionStateStore(checkpointRoot).read({ sessionId: 'session-1',
            projectId: 'project-1', worktreeId: null, projectPath });
        expect(status.pendingDecision?.excluded).toContainEqual({ path: 'cache/new.txt', reason: 'ignored' });
        expect(status.pendingDecision?.diagnostic?.changes[0]).toMatchObject({ path: 'cache/new.txt', currentReason: 'ignored' });
        await expect(readFile(join(projectPath, 'cache', 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('does not create a gate when checkpoint protection was not explicitly configured', async () => {
        const sandboxConfig = SandboxConfigSchema.parse({});
        const result = await createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig,
            env: {},
        });

        expect(result).toEqual({ sandboxConfig });
    });

    it('fails closed without a daemon-owned binding or on an unsupported platform', async () => {
        const sandboxConfig = SandboxConfigSchema.parse({ checkpointProtection: protection });
        await expect(createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig,
            env: {},
        })).rejects.toThrow('authoritative checkpoint spawn context');
        await expect(createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'win32',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig,
            env: contextEnv(),
        })).rejects.toThrow('unsupported-platform');
        await expect(lstat(join(projectPath, '.aplus'))).rejects.toThrow();
    });

    it('fails closed when a protected runtime has no durable event publisher', async () => {
        await expect(createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
        })).rejects.toThrow('durable event publisher');
        await expect(lstat(join(projectPath, '.aplus'))).rejects.toThrow();
    });

    it.each(['claude-remote', 'codex'] as const)(
        'binds %s sandbox and turn gate to the same protected runtime',
        async (provider) => {
            const result = await createCheckpointSessionComposition({
                provider,
                platform: 'darwin',
                projectPath,
                sessionId: 'session-1',
                sandboxConfig: SandboxConfigSchema.parse({
                    checkpointProtection: protection,
                    denyWritePaths: ['existing-deny'],
                }),
                env: contextEnv(),
                checkpointEvents,
            });
            const canonicalProjectPath = await realpath(projectPath);
            if (!result.sandboxConfig) throw new Error('expected protected sandbox config');

            expect(result.providerPath).toEqual(expect.any(String));
            expect(result.sandboxConfig.sessionIsolation).toBe('custom');
            expect(result.sandboxConfig.customWritePaths).toEqual([result.providerPath]);
            expect(result.sandboxConfig.denyWritePaths).toEqual(expect.arrayContaining([
                'existing-deny',
                canonicalProjectPath,
                join(canonicalProjectPath, '**', '.env*'),
            ]));
            expect(result.beforeTurn).toEqual(expect.any(Function));
            const turn = await result.beforeTurn?.();
            const canonicalCheckpointRoot = await realpath(checkpointRoot);
            expect(turn).toMatchObject({
                operationId: expect.any(String),
                checkpointId: expect.stringMatching(/^[a-f0-9]{40,64}$/),
                providerPath: result.providerPath,
                sandboxConfig: {
                    denyWritePaths: expect.arrayContaining([canonicalProjectPath]),
                },
            });
            expect(turn!.providerPath.startsWith(`${canonicalCheckpointRoot}${sep}`)).toBe(true);
            await expect(readFile(join(turn!.providerPath, 'source.txt'), 'utf8')).resolves.toBe('before');
            if (provider === 'claude-remote') {
                expect(turn!.claudeSandbox).toMatchObject({
                    enabled: true,
                    failIfUnavailable: true,
                    allowUnsandboxedCommands: false,
                    filesystem: {
                        allowWrite: expect.arrayContaining([turn!.providerPath]),
                        denyWrite: expect.arrayContaining([canonicalProjectPath]),
                    },
                });
                expect(turn!.claudeSandbox?.filesystem?.denyWrite).toEqual(expect.arrayContaining([
                    join(turn!.providerPath, '**', '.env*'),
                ]));
                expect(result.claudeSandbox).toMatchObject({
                    enabled: true,
                    failIfUnavailable: true,
                    allowUnsandboxedCommands: false,
                    filesystem: {
                        denyWrite: expect.arrayContaining([
                            join(result.providerPath!, 'existing-deny'),
                            join(canonicalProjectPath, '**', '.env*'),
                            canonicalProjectPath,
                        ]),
                    },
                });
            } else {
                expect(result.claudeSandbox).toBeUndefined();
            }
        },
    );

    it('waits for a durable snapshot event acknowledgement before opening the provider turn', async () => {
        const snapshot = vi.fn()
            .mockRejectedValueOnce(new Error('event server unavailable'))
            .mockResolvedValueOnce({
                id: 'event-1', seq: 1, createdAt: Date.now(), idempotent: true,
            });
        const result = await createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
            checkpointEvents: { snapshot },
        });

        await expect(result.beforeTurn?.()).rejects.toThrow('event server unavailable');
        expect(result.protectedBashCwd?.()).toBeNull();
        const retry = await result.beforeTurn?.();

        expect(retry).toBeDefined();
        expect(snapshot).toHaveBeenCalledTimes(2);
        expect(snapshot.mock.calls[1]?.[0]).toEqual(snapshot.mock.calls[0]?.[0]);
        expect(snapshot.mock.calls[0]?.[0]).toMatchObject({
            operationId: retry?.operationId,
            checkpointId: retry?.checkpointId,
        });
    });

    it('applies an isolated diff only after the provider writer tree is quiescent', async () => {
        const result = await createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
            checkpointEvents,
        });
        expect(result.protectedBashCwd?.()).toBeNull();
        const turn = await result.beforeTurn?.();
        if (!turn || !result.completeTurn) throw new Error('expected protected turn lifecycle');
        expect(result.protectedBashCwd?.()).toBe(turn.providerPath);
        await writeFile(join(turn.providerPath, 'source.txt'), 'agent change');

        let releaseQuiescence!: () => void;
        const quiescence = new Promise<void>((resolve) => {
            releaseQuiescence = resolve;
        });
        const completion = result.completeTurn(() => quiescence);
        await new Promise((resolve) => setTimeout(resolve, 0));

        await expect(readFile(join(projectPath, 'source.txt'), 'utf8')).resolves.toBe('before');
        releaseQuiescence();
        await expect(completion).resolves.toMatchObject({
            status: 'completed',
            entries: [{ path: 'source.txt', action: 'write', outcome: 'written' }],
        });
        await expect(readFile(join(projectPath, 'source.txt'), 'utf8')).resolves.toBe('agent change');
        expect(result.protectedBashCwd?.()).toBeNull();
    });

    it('rotates the sandbox to a never-reused provider workspace after each completed turn', async () => {
        const result = await createCheckpointSessionComposition({
            provider: 'claude-remote',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
            checkpointEvents,
        });
        if (!result.beforeTurn || !result.completeTurn) throw new Error('expected protected turn lifecycle');

        const first = await result.beforeTurn();
        await writeFile(join(first.providerPath, 'source.txt'), 'first turn');
        await result.completeTurn(async () => {});
        const second = await result.beforeTurn();

        expect(second.providerPath).not.toBe(first.providerPath);
        expect(result.providerPath).toBe(second.providerPath);
        expect(result.sandboxConfig?.customWritePaths).toEqual([second.providerPath]);
        expect(result.claudeSandbox?.filesystem?.allowWrite).toContain(second.providerPath);
        expect(result.claudeSandbox?.filesystem?.allowWrite).not.toContain(first.providerPath);
        expect(second.operationId).not.toBe(first.operationId);
        expect(second.checkpointId).not.toBe(first.checkpointId);
        await expect(readFile(join(second.providerPath, 'source.txt'), 'utf8')).resolves.toBe('first turn');
        await result.completeTurn(async () => {});
    });

    it.each(['claude-remote', 'codex'] as const)(
        'keeps %s protected across repeated edits and unrelated exclusion changes',
        async (provider) => {
            const events = { snapshot: vi.fn(checkpointEvents.snapshot) };
            const result = await createCheckpointSessionComposition({
                provider, platform: 'darwin', projectPath, sessionId: 'session-1',
                sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
                env: contextEnv(), checkpointEvents: events,
            });
            if (!result.beforeTurn || !result.completeTurn) throw new Error('expected protected composition');
            const checkpoints: string[] = [];
            for (const content of ['hello world', 'hello hmall', 'hello hmall22']) {
                const turn = await result.beforeTurn();
                checkpoints.push(turn.checkpointId);
                await writeFile(join(turn.providerPath, 'a.html'), content);
                result.markTurnDispatched?.();
                await result.completeTurn(async () => {});
                expect(await readFile(join(projectPath, 'a.html'), 'utf8')).toBe(content);
                if (content === 'hello world') {
                    await writeFile(join(projectPath, '.env.production'), 'excluded secret');
                } else if (content === 'hello hmall') {
                    await rm(join(projectPath, '.env.production'));
                }
            }
            expect(new Set(checkpoints).size).toBe(3);
            expect(events.snapshot).toHaveBeenCalledTimes(3);
            expect(result.sandboxConfig?.checkpointProtection).toEqual(protection);
            expect((await new CheckpointProtectionStateStore(checkpointRoot).read({
                sessionId: 'session-1', projectId: 'project-1', worktreeId: null, projectPath,
            })).pendingDecision).toBeNull();
            await result.dispose?.();
        },
    );

    it('refreshes new literal exclusions in the workspace sandbox before dispatch', async () => {
        const result = await createCheckpointSessionComposition({
            provider: 'claude-remote', platform: 'darwin', projectPath, sessionId: 'session-1',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(), checkpointEvents,
        });
        if (!result.beforeTurn || !result.completeTurn) throw new Error('expected protected composition');
        await result.beforeTurn();
        await result.completeTurn(async () => {});
        await writeFile(join(projectPath, 'large.bin'), 'x'.repeat(protection.maxFileBytes + 1));
        const turn = await result.beforeTurn();
        expect(turn.sandboxConfig?.denyWritePaths).toContain(join(turn.providerPath, 'large.bin'));
        expect(turn.claudeSandbox?.filesystem?.denyWrite).toContain(join(turn.providerPath, 'large.bin'));
        await expect(readFile(join(turn.providerPath, 'large.bin'))).rejects.toThrow();
        await result.completeTurn(async () => {});
        await result.dispose?.();
    });

    it('reserves the provider workspace directory before the first turn and after each rotation', async () => {
        // specs/linux-checkpoint-enforcement-backend R4 — Codex wraps its sandbox in connect(), before
        // beforeTurn() materializes the workspace. Linux bubblewrap skips allowWrite paths that do not
        // exist yet, so the reserved path must already be a directory when the sandbox is built.
        const result = await createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
            checkpointEvents,
        });
        if (!result.beforeTurn || !result.completeTurn || !result.providerPath) throw new Error('expected protected turn lifecycle');

        await expect(stat(result.providerPath)).resolves.toMatchObject({ mode: expect.any(Number) });
        expect((await stat(result.providerPath)).isDirectory()).toBe(true);
        const first = await result.beforeTurn();
        expect(first.providerPath).toBe(result.providerPath);
        await expect(readFile(join(first.providerPath, 'source.txt'), 'utf8')).resolves.toBe('before');
        await result.completeTurn(async () => {});

        expect(result.providerPath).not.toBe(first.providerPath);
        expect((await stat(result.providerPath)).isDirectory()).toBe(true);
        await expect(stat(first.providerPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('omits glob and passthrough deny entries from the Linux sandbox only', async () => {
        // specs/linux-checkpoint-enforcement-backend R3 (2026-09-05 개정) / R8 — bubblewrap cannot
        // enforce globs (and leaves ws/** mount points) and refuses to start when a deny entry is a
        // symlink inside the writable workspace; the passthrough target is already read-only via /.
        await writeFile(join(projectPath, '.gitignore'), 'dependencies/\n');
        await mkdir(join(projectPath, 'dependencies'));
        await writeFile(join(projectPath, 'dependencies', 'package.txt'), 'cached');
        await writeFile(join(projectPath, 'large.bin'), 'x'.repeat(2048));
        const canonicalProjectPath = await realpath(projectPath);
        const configFor = async (platform: NodeJS.Platform) => {
            const result = await createCheckpointSessionComposition({
                provider: 'codex',
                platform,
                projectPath,
                sessionId: `session-${platform}`,
                sandboxConfig: SandboxConfigSchema.parse({
                    checkpointProtection: { ...protection, readOnlyPassthroughPaths: ['dependencies'] },
                    denyWritePaths: ['user-glob/*.pem'],
                }),
                env: contextEnv(),
                checkpointEvents,
            });
            if (!result.sandboxConfig || !result.providerPath) throw new Error('expected protected sandbox config');
            return { deny: result.sandboxConfig.denyWritePaths, ws: result.providerPath };
        };

        const linux = await configFor('linux');
        expect(linux.deny).toEqual(expect.arrayContaining([
            'user-glob/*.pem',
            canonicalProjectPath,
            join(linux.ws, 'large.bin'),
        ]));
        expect(linux.deny).not.toContain(join(canonicalProjectPath, '**', '.env*'));
        expect(linux.deny).not.toContain(join(linux.ws, '**', '.env*'));
        expect(linux.deny).not.toContain(join(linux.ws, 'dependencies'));

        const darwin = await configFor('darwin');
        expect(darwin.deny).toEqual(expect.arrayContaining([
            'user-glob/*.pem',
            canonicalProjectPath,
            join(canonicalProjectPath, '**', '.env*'),
            join(darwin.ws, '**', '.env*'),
            join(darwin.ws, 'dependencies'),
            join(darwin.ws, 'large.bin'),
        ]));
    });

    it('keeps literal deny entries on Linux even when the project path contains glob characters', async () => {
        const oddProjectPath = join(fixtureRoot, 'app[1]?');
        await mkdir(oddProjectPath);
        await writeFile(join(oddProjectPath, 'source.txt'), 'before');
        await writeFile(join(oddProjectPath, 'large.bin'), 'x'.repeat(2048));
        const result = await createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'linux',
            projectPath: oddProjectPath,
            sessionId: 'session-odd',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
            checkpointEvents,
        });
        if (!result.sandboxConfig || !result.providerPath) throw new Error('expected protected sandbox config');
        const canonicalOddPath = await realpath(oddProjectPath);
        expect(result.sandboxConfig.denyWritePaths).toEqual(expect.arrayContaining([
            canonicalOddPath,
            join(canonicalOddPath, 'large.bin'),
            join(result.providerPath, 'large.bin'),
        ]));
        expect(result.sandboxConfig.denyWritePaths).not.toContain(join(canonicalOddPath, '**', '.env*'));
    });

    it('dispose removes an unused workspace reservation but never an active turn', async () => {
        const result = await createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-dispose',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
            checkpointEvents,
        });
        if (!result.beforeTurn || !result.completeTurn || !result.providerPath || !result.dispose) {
            throw new Error('expected protected turn lifecycle');
        }
        const reserved = result.providerPath;
        const turn = await result.beforeTurn();
        await result.dispose();
        await expect(readFile(join(turn.providerPath, 'source.txt'), 'utf8')).resolves.toBe('before');
        await result.completeTurn(async () => {});

        const nextReserved = result.providerPath;
        expect(nextReserved).not.toBe(reserved);
        await result.dispose();
        await expect(stat(nextReserved)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(result.dispose()).resolves.toBeUndefined();
    });

    it('abortTurn discards a turn that was opened but never dispatched', async () => {
        // specs/linux-checkpoint-enforcement-backend R4 — the gate now opens the turn before the
        // provider process starts, so a turn that never gets dispatched (reconnect failure, refusal,
        // session exit) must not leave the workspace materialized nor block the next gate.
        const result = await createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-abort',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
            checkpointEvents,
        });
        if (!result.beforeTurn || !result.completeTurn || !result.abortTurn) {
            throw new Error('expected protected turn lifecycle');
        }
        const first = await result.beforeTurn();
        await writeFile(join(first.providerPath, 'source.txt'), 'never dispatched');

        await result.abortTurn();

        // The abandoned workspace is gone, the original is untouched, and the writable path rotates.
        await expect(stat(first.providerPath)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(join(projectPath, 'source.txt'), 'utf8')).resolves.toBe('before');
        expect(result.providerPath).not.toBe(first.providerPath);
        expect(result.protectedBashCwd?.()).toBeNull();

        // The next gate opens normally instead of throwing 'already active'.
        const second = await result.beforeTurn();
        expect(second.providerPath).toBe(result.providerPath);
        await expect(result.completeTurn(async () => {})).resolves.toMatchObject({ status: 'completed' });
        await expect(result.abortTurn()).resolves.toBeUndefined();
    });

    // chmod cannot take write access away from root (CAP_DAC_OVERRIDE), so the failure this test
    // injects only materializes for an unprivileged user.
    it.skipIf(process.getuid?.() === 0)('abortTurn preserves the sealed workspace of a partially applied turn', async () => {
        // A partial apply keeps activeTurn and the sealed copy so the failed files can be retried
        // from the journal. The abort path must not confuse that with a turn that was never sent.
        const result = await createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-partial',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
            checkpointEvents,
        });
        if (!result.beforeTurn || !result.completeTurn || !result.abortTurn) {
            throw new Error('expected protected turn lifecycle');
        }
        const turn = await result.beforeTurn();
        await writeFile(join(turn.providerPath, 'source.txt'), 'agent change');
        // Make the original unwritable so the applier reports a failed mutation (status: partial).
        await chmod(projectPath, 0o555);
        try {
            await expect(result.completeTurn(async () => {})).resolves.toMatchObject({ status: 'partial' });
        } finally {
            await chmod(projectPath, 0o755);
        }
        const sealedPath = join(dirname(turn.providerPath), 'sealed');
        await expect(readFile(join(sealedPath, 'source.txt'), 'utf8')).resolves.toBe('agent change');

        await result.abortTurn();

        // The apply input survives: a partial turn is recoverable, not discardable.
        await expect(readFile(join(sealedPath, 'source.txt'), 'utf8')).resolves.toBe('agent change');
    });

    it('abortTurn keeps a dispatched turn whose outcome is unknown', async () => {
        // A turn that reached the provider may already have produced work. If the response never
        // arrives (turn timeout, transport error) the workspace must be preserved, not discarded.
        const result = await createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-dispatched',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
            checkpointEvents,
        });
        if (!result.beforeTurn || !result.completeTurn || !result.abortTurn || !result.markTurnDispatched) {
            throw new Error('expected protected turn lifecycle');
        }
        const turn = await result.beforeTurn();
        result.markTurnDispatched();
        await writeFile(join(turn.providerPath, 'source.txt'), 'agent work in flight');

        await result.abortTurn();

        await expect(readFile(join(turn.providerPath, 'source.txt'), 'utf8')).resolves.toBe('agent work in flight');
        // Still the active turn, so the session fails closed instead of silently starting a new one.
        await expect(result.beforeTurn()).rejects.toThrow('already active');
        await expect(result.completeTurn(async () => {})).resolves.toMatchObject({ status: 'completed' });
    });


    // Astra P1 (2026-09-10): checkpoint 세션은 policy 인자 없이 runtime 설정을 만들어
    // 기본 owner-choice 로 떨어졌다. 런처가 checkpoint 설정을 그대로 반환하고 실제
    // 실행도 initialTurn.claudeSandbox 를 우선하므로, 여기서 floor 가 빠지면 공유
    // 머신 checkpoint remote 세션에 신뢰 경계가 아예 없다.
    it('applies the mandatory trust floor to the initial turn and to every rotation', async () => {
        const { configuration } = await import('@/configuration');
        const result = await createCheckpointSessionComposition({
            provider: 'claude-remote',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig: SandboxConfigSchema.parse({
                checkpointProtection: protection,
                denyReadPaths: [],
            }),
            env: contextEnv(),
            checkpointEvents,
            sandboxPolicyMode: 'mandatory',
        });
        if (!result.beforeTurn || !result.completeTurn) throw new Error('expected protected turn lifecycle');

        expect(result.claudeSandbox?.filesystem?.denyRead).toContain(configuration.daemonHappyHomeDir);
        expect(result.claudeSandbox?.filesystem?.denyWrite).toContain(configuration.daemonHappyHomeDir);
        expect(result.claudeSandbox?.failIfUnavailable).toBe(true);
        expect(result.claudeSandbox?.allowUnsandboxedCommands).toBe(false);

        // 턴이 회전하면 설정이 새로 만들어진다 — 거기서 floor 가 떨어지면 안 된다.
        const first = await result.beforeTurn();
        expect(first.claudeSandbox?.filesystem?.denyRead).toContain(configuration.daemonHappyHomeDir);
        await result.completeTurn(async () => {});
        const second = await result.beforeTurn();

        expect(second.providerPath).not.toBe(first.providerPath);
        expect(result.claudeSandbox?.filesystem?.denyRead).toContain(configuration.daemonHappyHomeDir);
        expect(result.claudeSandbox?.filesystem?.allowWrite).toContain(second.providerPath);
        await result.completeTurn(async () => {});
    });

    it('leaves a personal machine checkpoint session unchanged', async () => {
        const { configuration } = await import('@/configuration');
        const result = await createCheckpointSessionComposition({
            provider: 'claude-remote',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig: SandboxConfigSchema.parse({
                checkpointProtection: protection,
                denyReadPaths: [],
            }),
            env: contextEnv(),
            checkpointEvents,
        });

        expect(result.claudeSandbox?.filesystem?.denyRead)
            .not.toContain(configuration.daemonHappyHomeDir);
    });

    it('records a daemon-readable pending decision when two preparations remain unstable', async () => {
        const result = await createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
            checkpointEvents,
        });
        await writeFile(join(projectPath, '.env.production'), 'secret');
        const check = vi.spyOn(CheckpointExclusionGuard.prototype, 'dispatchAfterPolicyCheck')
            .mockRejectedValue(new CheckpointPolicyDriftError([{ path: '.env.production', reason: 'secret' }]));

        await expect(result.beforeTurn?.()).rejects.toMatchObject({
            name: 'CheckpointPolicyDriftError',
        });
        await expect(new CheckpointProtectionStateStore(checkpointRoot).read({
            sessionId: 'session-1',
            projectId: 'project-1',
            worktreeId: null,
            projectPath,
        })).resolves.toMatchObject({
            protection: { status: 'protected' },
            pendingDecision: {
                operationId: expect.any(String),
                source: 'policy-drift',
                excluded: [{ path: '.env.production', reason: 'secret' }],
            },
        });
        expect(check).toHaveBeenCalledTimes(2);
        await result.dispose?.();
    });

    it('does not apply a newly created oversized file and reports the actual write target', async () => {
        const result = await createCheckpointSessionComposition({
            provider: 'codex', platform: 'darwin', projectPath, sessionId: 'session-1',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(), checkpointEvents,
        });
        if (!result.beforeTurn || !result.completeTurn) throw new Error('expected protected composition');
        const turn = await result.beforeTurn();
        await writeFile(join(turn.providerPath, 'large.bin'), 'x'.repeat(protection.maxFileBytes + 1));
        const applied = await result.completeTurn(async () => {});
        expect(applied.entries).toContainEqual({ path: 'large.bin', action: 'conflict', outcome: 'conflict' });
        await expect(readFile(join(projectPath, 'large.bin'))).rejects.toThrow();
        expect((await new CheckpointProtectionStateStore(checkpointRoot).read({
            sessionId: 'session-1', projectId: 'project-1', worktreeId: null, projectPath,
        })).pendingDecision).toMatchObject({ source: 'turn-apply', excluded: [{ path: 'large.bin', reason: 'too-large' }] });
        await result.dispose?.();
    });

    it('bounds pending state for twenty thousand ignored outputs without losing the total', async () => {
        await writeFile(join(projectPath, '.gitignore'), 'dist/\n');
        const result = await createCheckpointSessionComposition({
            provider: 'codex', platform: 'darwin', projectPath,
            sessionId: 'session-many-outputs', env: contextEnv(), checkpointEvents,
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
        });
        if (!result.beforeTurn || !result.completeTurn) throw new Error('expected protected turn');
        const turn = await result.beforeTurn();
        await mkdir(join(turn.providerPath, 'dist'), { recursive: true });
        for (let batch = 0; batch < 200; batch += 1) {
            await Promise.all(Array.from({ length: 100 }, (_, offset) => writeFile(
                join(turn.providerPath, 'dist', `${batch * 100 + offset}.txt`), 'generated')));
        }
        await result.completeTurn(async () => {});
        const state = await new CheckpointProtectionStateStore(checkpointRoot).read({
            sessionId: 'session-many-outputs', projectId: 'project-1', worktreeId: null, projectPath,
        });
        expect(state.pendingDecision?.excluded).toEqual([{ path: 'dist', reason: 'ignored' }]);
        expect(state.pendingDecision?.diagnostic?.counts.totalChanges).toBe(20_000);
        await expect(readFile(join(projectPath, 'dist', '0.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
        await result.dispose?.();
    }, 120_000);

    it('records an excluded-path conflict discovered by the turn applier', async () => {
        const result = await createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
            checkpointEvents,
        });
        const turn = await result.beforeTurn?.();
        if (!turn || !result.completeTurn) throw new Error('expected protected turn lifecycle');
        await writeFile(join(turn.providerPath, '.env.future'), 'sandbox bypass');

        await expect(result.completeTurn(async () => {})).resolves.toMatchObject({
            entries: [{ path: '.env.future', action: 'conflict', outcome: 'conflict' }],
        });
        await expect(new CheckpointProtectionStateStore(checkpointRoot).read({
            sessionId: 'session-1',
            projectId: 'project-1',
            worktreeId: null,
            projectPath,
        })).resolves.toMatchObject({
            protection: { status: 'protected' },
            pendingDecision: {
                operationId: turn.operationId,
                source: 'turn-apply',
                excluded: [{ path: '.env.future', reason: 'secret' }],
            },
        });
        await expect(result.beforeTurn?.()).rejects.toThrow('excluded path decision is pending');
    });

    it('starts a restarted session without checkpoint protection after explicit disable', async () => {
        const state = new CheckpointProtectionStateStore(checkpointRoot);
        const binding = {
            sessionId: 'session-1',
            projectId: 'project-1',
            worktreeId: null,
            projectPath,
        } as const;
        await state.reportPending({
            ...binding,
            operationId: 'turn-1',
            source: 'policy-drift',
            excluded: [],
        });
        await state.resolveDecision({
            ...binding,
            operationId: 'turn-1',
            decision: 'disable-protection',
        });
        const result = await createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
            checkpointEvents,
        });

        expect(result.beforeTurn).toBeUndefined();
        expect(result.sandboxConfig?.checkpointProtection).toBeUndefined();
        expect(result.sandboxConfig?.enabled).toBe(true);
    });

    it('exposes files written to .aplus/uploads/ before a turn through the provider path', async () => {
        await writeFile(join(projectPath, '.gitignore'), '.aplus/\n');

        const result = await createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
            checkpointEvents,
        });

        await mkdir(join(projectPath, '.aplus', 'uploads'), { recursive: true });
        await writeFile(join(projectPath, '.aplus', 'uploads', 'attachment.txt'), 'uploaded content');
        await writeFile(join(projectPath, '.aplus', '.env.production'), 'dummy-secret');

        const turn = await result.beforeTurn?.();
        if (!turn) throw new Error('expected turn preparation');

        await expect(readFile(join(turn.providerPath, '.aplus', 'uploads', 'attachment.txt'), 'utf8'))
            .resolves.toBe('uploaded content');
        await expect(lstat(join(turn.providerPath, '.aplus', '.env.production'))).rejects.toThrow();
    });

    it('exposes .aplus/uploads through the provider path when the root gitignore never mentions .aplus', async () => {
        await writeFile(join(projectPath, '.gitignore'), 'dist/\n');

        const result = await createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
            checkpointEvents,
        });

        await writeFile(join(projectPath, '.aplus', 'uploads', 'attachment.txt'), 'narrow shape');

        const turn = await result.beforeTurn?.();
        if (!turn) throw new Error('expected turn preparation');

        await expect(readFile(join(turn.providerPath, '.aplus', 'uploads', 'attachment.txt'), 'utf8'))
            .resolves.toBe('narrow shape');
    });

    it('does not reject with policy drift when a file larger than maxFileBytes is uploaded after composition', async () => {
        const result = await createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
            checkpointEvents,
        });

        const turn = await result.beforeTurn?.();
        if (!turn || !result.completeTurn) throw new Error('expected protected turn lifecycle');

        await result.completeTurn(async () => {});

        await mkdir(join(projectPath, '.aplus', 'uploads'), { recursive: true });
        const largeBuffer = Buffer.alloc(4096, 1);
        await writeFile(join(projectPath, '.aplus', 'uploads', 'oversized.bin'), largeBuffer);

        await expect(result.beforeTurn?.()).resolves.toBeDefined();
    });

    it('falls back to no passthrough when .aplus/.gitignore exists with tracked content', async () => {
        await mkdir(join(projectPath, '.aplus'), { recursive: true });
        await writeFile(join(projectPath, '.aplus', '.gitignore'), 'uploads/\n');
        await writeFile(join(projectPath, '.aplus', 'tracked.txt'), 'keep me');

        const result = await createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
            checkpointEvents,
        });

        const turn = await result.beforeTurn?.();
        if (!turn) throw new Error('expected turn preparation');

        // No passthrough was registered, so the upload directory is absent from
        // the workspace — but the project's own tracked file is still snapshotted.
        await expect(lstat(join(turn.providerPath, '.aplus', 'uploads'))).rejects.toThrow();
        await expect(readFile(join(turn.providerPath, '.aplus', 'tracked.txt'), 'utf8'))
            .resolves.toBe('keep me');
    });
});
