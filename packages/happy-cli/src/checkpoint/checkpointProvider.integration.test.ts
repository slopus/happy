import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeRemote } from '@/claude/claudeRemote';
import type { EnhancedMode } from '@/claude/loop';
import { CodexAppServerClient } from '@/codex/codexAppServerClient';
import { SandboxConfigSchema } from '@/persistence';
import { CheckpointProtectionStateStore } from './checkpointProtectionState';
import { CheckpointRestoreExecutor } from './checkpointRestore';
import { CheckpointRestorePlanner } from './checkpointRestorePlan';
import { CHECKPOINT_SPAWN_CONTEXT_ENV_KEY } from './checkpointSpawnContext';
import { createCheckpointSessionComposition } from './checkpointSessionComposition';

const providerSmokeEnabled = process.env.HAPPY_RUN_CHECKPOINT_PROVIDER_SMOKE === '1';
const providerSmokeRoot = process.env.HAPPY_CHECKPOINT_PROVIDER_SMOKE_ROOT ?? tmpdir();
// specs/linux-checkpoint-enforcement-backend — runs on macOS and Linux (bubblewrap); still opt-in.
describe.skipIf((process.platform !== 'darwin' && process.platform !== 'linux') || !providerSmokeEnabled)(
    'checkpoint protected provider smoke',
    { timeout: 180_000 },
    () => {
        let projectPath: string | null = null;
        let checkpointRoot: string | null = null;
        let client: CodexAppServerClient | null;

        beforeEach(async () => {
            projectPath = null;
            checkpointRoot = null;
            await mkdir(providerSmokeRoot, { recursive: true });
            projectPath = await mkdtemp(join(providerSmokeRoot, 'happy-checkpoint-provider-project-'));
            checkpointRoot = await mkdtemp(join(providerSmokeRoot, 'happy-checkpoint-provider-store-'));
            client = null;
            await writeFile(join(projectPath, 'README.md'), '# Provider smoke\n');
        });

        afterEach(async () => {
            await client?.disconnect();
            if (projectPath) await rm(projectPath, { recursive: true, force: true });
            if (checkpointRoot) await rm(checkpointRoot, { recursive: true, force: true });
        });

        it('applies a real Codex file edit only through the protected turn boundary', async () => {
            if (!projectPath || !checkpointRoot) throw new Error('provider smoke fixture is unavailable');
            const checkpointEvents = captureCheckpointEvents();
            const events: Array<{
                type: string;
                message?: string;
                command?: unknown;
                cwd?: unknown;
                output?: unknown;
            }> = [];
            const composition = await createCheckpointSessionComposition({
                provider: 'codex',
                platform: process.platform,
                projectPath,
                sessionId: 'provider-smoke-codex',
                sandboxConfig: SandboxConfigSchema.parse({
                    checkpointProtection: {
                        secretPatterns: ['.env*'],
                        maxFileBytes: 1024 * 1024,
                        maxFiles: 100,
                        maxTotalBytes: 16 * 1024 * 1024,
                    },
                    extraWritePaths: [],
                    denyReadPaths: [],
                    networkMode: 'allowed',
                    allowLocalBinding: false,
                }),
                env: {
                    [CHECKPOINT_SPAWN_CONTEXT_ENV_KEY]: JSON.stringify({
                        schemaVersion: 1,
                        projectId: 'provider-smoke-project',
                        worktreeId: null,
                        checkpointRoot,
                    }),
                },
                checkpointEvents: checkpointEvents.publisher,
            });
            client = new CodexAppServerClient(
                composition.sandboxConfig,
                composition.beforeTurn,
                composition.completeTurn,
                undefined,
                undefined,
                composition.markTurnDispatched,
            );
            client.setEventHandler((event) => {
                events.push({
                    type: event.type,
                    ...('message' in event && typeof event.message === 'string'
                        ? { message: event.message }
                        : {}),
                    ...('command' in event ? { command: event.command } : {}),
                    ...('cwd' in event ? { cwd: event.cwd } : {}),
                    ...('output' in event ? { output: event.output } : {}),
                });
            });
            // Mirror runCodex: the gate opens (and materializes) the turn workspace before codex is
            // wrapped and spawned. specs/linux-checkpoint-enforcement-backend R4.
            await client.prepareProtectedTurn();
            await client.connect();
            await client.startThread({
                cwd: projectPath,
                approvalPolicy: 'never',
                sandbox: 'danger-full-access',
            });

            const result = await client.sendTurnAndWait(
                "Run this shell command in the current workspace exactly once: printf 'protected codex\\n' > provider-smoke.txt\n"
                    + 'Do not modify any other file. Finish immediately after the command succeeds.',
                { approvalPolicy: 'never', sandbox: 'danger-full-access' },
            );

            expect(result.aborted).toBe(false);
            try {
                expect(await readFile(join(projectPath, 'provider-smoke.txt'), 'utf8'))
                    .toBe('protected codex\n');
            } catch (error) {
                throw new Error(`Codex provider smoke did not apply the file: ${JSON.stringify(events)}`, {
                    cause: error,
                });
            }
            await restoreProviderEdit({
                checkpointRoot,
                projectPath,
                sessionId: 'provider-smoke-codex',
                checkpointId: checkpointEvents.checkpointId(),
            });
        });

        it('applies a real Claude file edit only through the protected turn boundary', async () => {
            if (!projectPath || !checkpointRoot) throw new Error('provider smoke fixture is unavailable');
            const checkpointEvents = captureCheckpointEvents();
            const hookSettingsPath = join(checkpointRoot, 'claude-settings.json');
            await writeFile(hookSettingsPath, '{}\n');
            const composition = await createCheckpointSessionComposition({
                provider: 'claude-remote',
                platform: process.platform,
                projectPath,
                sessionId: 'provider-smoke-claude',
                sandboxConfig: SandboxConfigSchema.parse({
                    checkpointProtection: {
                        secretPatterns: ['.env*'],
                        maxFileBytes: 1024 * 1024,
                        maxFiles: 100,
                        maxTotalBytes: 16 * 1024 * 1024,
                    },
                    extraWritePaths: [],
                    denyReadPaths: [],
                    networkMode: 'allowed',
                    allowLocalBinding: false,
                }),
                env: {
                    [CHECKPOINT_SPAWN_CONTEXT_ENV_KEY]: JSON.stringify({
                        schemaVersion: 1,
                        projectId: 'provider-smoke-project',
                        worktreeId: null,
                        checkpointRoot,
                    }),
                },
                checkpointEvents: checkpointEvents.publisher,
            });
            const mode: EnhancedMode = {
                permissionMode: 'bypassPermissions',
                allowedTools: ['Bash', 'Write', 'Edit'],
            };

            const result = await claudeRemote({
                sessionId: null,
                path: projectPath,
                allowedTools: ['Bash', 'Write', 'Edit'],
                hookSettingsPath,
                exitAfterFirstTurn: true,
                sandbox: composition.claudeSandbox,
                beforeTurn: composition.beforeTurn,
                completeTurn: composition.completeTurn,
                nextMessage: async () => ({
                    message: "Run this shell command in the current workspace exactly once: printf 'protected claude\\n' > provider-smoke.txt\n"
                        + 'Do not modify any other file. Finish immediately after the command succeeds.',
                    mode,
                }),
                onReady: () => {},
                canCallTool: async () => ({ behavior: 'allow' }) as any,
                isAborted: () => false,
                onSessionFound: () => {},
                onMessage: () => {},
            });

            expect(result).toBe('turn-complete');
            await expect(readFile(join(projectPath, 'provider-smoke.txt'), 'utf8'))
                .resolves.toBe('protected claude\n');
            await restoreProviderEdit({
                checkpointRoot,
                projectPath,
                sessionId: 'provider-smoke-claude',
                checkpointId: checkpointEvents.checkpointId(),
            });
        });

        // specs/checkpoint-protected-turn-recovery R1/R2 — the reported flow: the same file is edited on
        // three turns while a secret file appears between turns, then two checkpoints are restored and
        // the first restore is undone. Protection must stay on without a pending decision throughout.
        it('keeps a real Codex session protected across repeated edits of one file and restores them', async () => {
            if (!projectPath || !checkpointRoot) throw new Error('provider smoke fixture is unavailable');
            const sessionId = 'provider-smoke-codex-repeat';
            const checkpointIds = captureCheckpointIds();
            const composition = await repeatComposition('codex', sessionId, projectPath, checkpointRoot, checkpointIds.publisher);
            client = new CodexAppServerClient(
                composition.sandboxConfig,
                composition.beforeTurn,
                composition.completeTurn,
                undefined,
                undefined,
                composition.markTurnDispatched,
            );
            await runRepeatedEdits(projectPath, checkpointRoot, sessionId, async (content) => {
                await client!.prepareProtectedTurn();
                if (!client!.isConnected) {
                    if (client!.threadId) {
                        expect(await client!.reconnectAndResumeThread()).toBe(true);
                    } else {
                        await client!.connect();
                        await client!.startThread({ cwd: projectPath!, approvalPolicy: 'never', sandbox: 'danger-full-access' });
                    }
                }
                const result = await client!.sendTurnAndWait(editPrompt(content), {
                    approvalPolicy: 'never',
                    sandbox: 'danger-full-access',
                });
                expect(result.aborted).toBe(false);
            });
            await restoreRepeatedEdits(projectPath, checkpointRoot, sessionId, checkpointIds.all());
        }, 600_000);

        it('keeps a real Claude session protected across repeated edits of one file and restores them', async () => {
            if (!projectPath || !checkpointRoot) throw new Error('provider smoke fixture is unavailable');
            const sessionId = 'provider-smoke-claude-repeat';
            const checkpointIds = captureCheckpointIds();
            const hookSettingsPath = join(checkpointRoot, 'claude-settings.json');
            await writeFile(hookSettingsPath, '{}\n');
            const composition = await repeatComposition('claude-remote', sessionId, projectPath, checkpointRoot, checkpointIds.publisher);
            const mode: EnhancedMode = { permissionMode: 'bypassPermissions', allowedTools: ['Bash', 'Write', 'Edit'] };
            let claudeSessionId: string | null = null;
            await runRepeatedEdits(projectPath, checkpointRoot, sessionId, async (content) => {
                const result = await claudeRemote({
                    sessionId: claudeSessionId,
                    path: projectPath!,
                    allowedTools: ['Bash', 'Write', 'Edit'],
                    hookSettingsPath,
                    exitAfterFirstTurn: true,
                    sandbox: composition.claudeSandbox,
                    beforeTurn: composition.beforeTurn,
                    completeTurn: composition.completeTurn,
                    nextMessage: async () => ({ message: editPrompt(content), mode }),
                    onReady: () => {},
                    canCallTool: async () => ({ behavior: 'allow' }) as any,
                    isAborted: () => false,
                    onSessionFound: (id) => { claudeSessionId = id; },
                    onMessage: () => {},
                });
                expect(result).toBe('turn-complete');
            });
            await restoreRepeatedEdits(projectPath, checkpointRoot, sessionId, checkpointIds.all());
        }, 600_000);
    },
);

function captureCheckpointEvents(): {
    publisher: {
        snapshot(event: { checkpointId: string }): Promise<{
            id: string;
            seq: number;
            createdAt: number;
            idempotent: boolean;
        }>;
    };
    checkpointId(): string;
} {
    let checkpointId: string | null = null;
    return {
        publisher: {
            snapshot: async (event) => {
                checkpointId = event.checkpointId;
                return { id: 'event-1', seq: 1, createdAt: Date.now(), idempotent: false };
            },
        },
        checkpointId: () => {
            if (!checkpointId) throw new Error('provider smoke did not publish a snapshot');
            return checkpointId;
        },
    };
}

async function restoreProviderEdit(input: {
    checkpointRoot: string;
    projectPath: string;
    sessionId: string;
    checkpointId: string;
}): Promise<void> {
    const binding = {
        sessionId: input.sessionId,
        projectId: 'provider-smoke-project',
        worktreeId: null,
        projectPath: input.projectPath,
    } as const;
    const plan = await new CheckpointRestorePlanner(input.checkpointRoot).plan({
        ...binding,
        checkpointId: input.checkpointId,
    });
    expect(plan.entries).toContainEqual({
        path: 'provider-smoke.txt',
        action: 'delete',
        reason: 'agent-created',
    });

    await expect(new CheckpointRestoreExecutor(input.checkpointRoot).execute({
        ...binding,
        operationId: randomUUID(),
        plan,
        confirmed: true,
    })).resolves.toMatchObject({ status: 'completed' });
    await expect(readFile(join(input.projectPath, 'provider-smoke.txt'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
}

const REPEATED_CONTENTS = ['hello world', 'hello hmall', 'hello hmall22'] as const;

function editPrompt(content: string): string {
    return `Run this shell command in the current workspace exactly once: printf '${content}\\n' > a.html\n`
        + 'Do not modify any other file. Finish immediately after the command succeeds.';
}

function repeatBinding(sessionId: string, projectPath: string) {
    return { sessionId, projectId: 'provider-smoke-project', worktreeId: null, projectPath } as const;
}

async function repeatComposition(
    provider: 'codex' | 'claude-remote',
    sessionId: string,
    projectPath: string,
    checkpointRoot: string,
    publisher: ReturnType<typeof captureCheckpointIds>['publisher'],
) {
    return createCheckpointSessionComposition({
        provider,
        platform: process.platform,
        projectPath,
        sessionId,
        sandboxConfig: SandboxConfigSchema.parse({
            checkpointProtection: {
                secretPatterns: ['.env*'],
                maxFileBytes: 1024 * 1024,
                maxFiles: 100,
                maxTotalBytes: 16 * 1024 * 1024,
            },
            extraWritePaths: [],
            denyReadPaths: [],
            networkMode: 'allowed',
            allowLocalBinding: false,
        }),
        env: {
            [CHECKPOINT_SPAWN_CONTEXT_ENV_KEY]: JSON.stringify({
                schemaVersion: 1,
                projectId: 'provider-smoke-project',
                worktreeId: null,
                checkpointRoot,
            }),
        },
        checkpointEvents: publisher,
    });
}

async function runRepeatedEdits(
    projectPath: string,
    checkpointRoot: string,
    sessionId: string,
    runTurn: (content: string) => Promise<void>,
): Promise<void> {
    const state = new CheckpointProtectionStateStore(checkpointRoot);
    for (const [index, content] of REPEATED_CONTENTS.entries()) {
        await runTurn(content);
        expect(await readFile(join(projectPath, 'a.html'), 'utf8')).toBe(`${content}\n`);
        const status = await state.read(repeatBinding(sessionId, projectPath));
        expect(status.protection.status).toBe('protected');
        expect(status.pendingDecision).toBeNull();
        // A secret file appearing between turns changes the observed exclusions; before
        // checkpoint-protected-turn-recovery this alone forced the user to disable protection.
        if (index === 0) await writeFile(join(projectPath, '.env.local'), 'TOKEN=kept\n');
    }
}

async function restoreRepeatedEdits(
    projectPath: string,
    checkpointRoot: string,
    sessionId: string,
    checkpointIds: string[],
): Promise<void> {
    expect(new Set(checkpointIds).size).toBe(REPEATED_CONTENTS.length);
    const binding = repeatBinding(sessionId, projectPath);
    const planner = new CheckpointRestorePlanner(checkpointRoot);
    const executor = new CheckpointRestoreExecutor(checkpointRoot);
    const firstPlan = await planner.plan({ ...binding, checkpointId: checkpointIds[0] });
    expect(firstPlan.entries).toContainEqual({ path: 'a.html', action: 'delete', reason: 'agent-created' });

    let safetyCheckpointId = '';
    for (const [index, expected] of [[2, 'hello hmall'], [1, 'hello world']] as const) {
        const plan = await planner.plan({ ...binding, checkpointId: checkpointIds[index] });
        const restored = await executor.execute({ ...binding, operationId: randomUUID(), plan, confirmed: true });
        if (restored.status !== 'completed') throw new Error(`restore to turn ${index + 1} did not complete: ${restored.status}`);
        if (!safetyCheckpointId) safetyCheckpointId = restored.safetyCheckpointId;
        expect(await readFile(join(projectPath, 'a.html'), 'utf8')).toBe(`${expected}\n`);
    }
    const undo = await planner.plan({ ...binding, checkpointId: safetyCheckpointId });
    expect((await executor.execute({ ...binding, operationId: randomUUID(), plan: undo, confirmed: true })).status)
        .toBe('completed');
    expect(await readFile(join(projectPath, 'a.html'), 'utf8')).toBe('hello hmall22\n');
    expect(await readFile(join(projectPath, '.env.local'), 'utf8')).toBe('TOKEN=kept\n');
    expect((await new CheckpointProtectionStateStore(checkpointRoot).read(binding)).protection.status).toBe('protected');
}

function captureCheckpointIds() {
    const ids: string[] = [];
    return {
        publisher: {
            snapshot: async (event: { checkpointId: string }) => {
                ids.push(event.checkpointId);
                return { id: `event-${ids.length}`, seq: ids.length, createdAt: Date.now(), idempotent: false };
            },
        },
        all: () => [...ids],
    };
}
