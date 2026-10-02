import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeRemote } from '@/claude/claudeRemote';
import type { EnhancedMode } from '@/claude/loop';
import { CodexAppServerClient } from '@/codex/codexAppServerClient';
import { SandboxConfigSchema } from '@/persistence';
import { LOCAL_HISTORY_MAX_FILE_BYTES } from './checkpointLocalHistory';
import { CheckpointProtectionStateStore } from './checkpointProtectionState';
import { CheckpointRestoreExecutor } from './checkpointRestore';
import { CheckpointRestorePlanner } from './checkpointRestorePlan';
import { CHECKPOINT_SPAWN_CONTEXT_ENV_KEY } from './checkpointSpawnContext';
import { createCheckpointSessionComposition } from './checkpointSessionComposition';

const providerSmokeEnabled = process.env.HAPPY_RUN_CHECKPOINT_PROVIDER_SMOKE === '1';
const providerSmokeRoot = process.env.HAPPY_CHECKPOINT_PROVIDER_SMOKE_ROOT ?? tmpdir();
const EXCLUDED_PATTERNS = ['.env*', '.aplus/worktrees/'];
// specs/checkpoint-local-history — real Claude and Codex edit one file across turns in a project over
// the old 100-file limit, in the original folder; two checkpoints are restored and a restore undone.
describe.skipIf((process.platform !== 'darwin' && process.platform !== 'linux') || !providerSmokeEnabled)(
    'checkpoint local history provider smoke',
    { timeout: 600_000 },
    () => {
        let projectPath: string | null = null;
        let checkpointRoot: string | null = null;
        let client: CodexAppServerClient | null;

        beforeEach(async () => {
            await mkdir(providerSmokeRoot, { recursive: true });
            projectPath = await realpath(await mkdtemp(join(providerSmokeRoot, 'happy-checkpoint-provider-project-')));
            checkpointRoot = await realpath(await mkdtemp(join(providerSmokeRoot, 'happy-checkpoint-provider-store-')));
            client = null;
            await writeFile(join(projectPath, 'README.md'), '# Provider smoke\n');
            for (let index = 0; index < 150; index += 1) await writeFile(join(projectPath, `file-${index}.txt`), `${index}\n`);
        });

        afterEach(async () => {
            await client?.disconnect();
            if (projectPath) await rm(projectPath, { recursive: true, force: true });
            if (checkpointRoot) await rm(checkpointRoot, { recursive: true, force: true });
        });

        it('lets a real Codex session edit one file across turns and restores it', async () => {
            if (!projectPath || !checkpointRoot) throw new Error('provider smoke fixture is unavailable');
            const sessionId = 'provider-smoke-codex-repeat';
            const checkpointIds = captureCheckpointIds();
            const composition = await repeatComposition('codex', sessionId, projectPath, checkpointRoot, checkpointIds.publisher);
            const history = composition.localHistory!;
            client = new CodexAppServerClient(composition.sandboxConfig);
            await client.connect();
            await client.startThread({ cwd: projectPath, approvalPolicy: 'never', sandbox: 'danger-full-access' });
            await runRepeatedEdits(projectPath, checkpointRoot, sessionId, async (content) => {
                await history.beforeTurn();
                const result = await client!.sendTurnAndWait(editPrompt(content), {
                    approvalPolicy: 'never',
                    sandbox: 'danger-full-access',
                }).finally(() => history.afterTurn());
                expect(result.aborted).toBe(false);
            });
            await restoreRepeatedEdits(projectPath, checkpointRoot, sessionId, checkpointIds.all());
        }, 600_000);

        it('lets a real Claude session edit one file across turns and restores it', async () => {
            if (!projectPath || !checkpointRoot) throw new Error('provider smoke fixture is unavailable');
            const sessionId = 'provider-smoke-claude-repeat';
            const checkpointIds = captureCheckpointIds();
            const hookSettingsPath = join(checkpointRoot, 'claude-settings.json');
            await writeFile(hookSettingsPath, '{}\n');
            const composition = await repeatComposition('claude-remote', sessionId, projectPath, checkpointRoot, checkpointIds.publisher);
            const history = composition.localHistory!;
            const mode: EnhancedMode = { permissionMode: 'bypassPermissions', allowedTools: ['Bash', 'Write', 'Edit'] };
            let claudeSessionId: string | null = null;
            await runRepeatedEdits(projectPath, checkpointRoot, sessionId, async (content) => {
                const result = await claudeRemote({
                    sessionId: claudeSessionId,
                    path: projectPath!,
                    allowedTools: ['Bash', 'Write', 'Edit'],
                    hookSettingsPath,
                    exitAfterFirstTurn: true,
                    beforeTurn: history.beforeTurn,
                    afterTurn: history.afterTurn,
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
    const recorded = { excludedPatterns: EXCLUDED_PATTERNS };
    const localHistory = { maxFileBytes: LOCAL_HISTORY_MAX_FILE_BYTES };
    const firstPlan = await planner.plan({ ...binding, ...recorded, checkpointId: checkpointIds[0] });
    expect(firstPlan.entries).toContainEqual({ path: 'a.html', action: 'delete', reason: 'agent-created' });

    let safetyCheckpointId = '';
    for (const [index, expected] of [[2, 'hello hmall'], [1, 'hello world']] as const) {
        const plan = await planner.plan({ ...binding, ...recorded, checkpointId: checkpointIds[index] });
        const restored = await executor.execute({ ...binding, ...recorded, localHistory, operationId: randomUUID(), plan, confirmed: true });
        if (restored.status !== 'completed') throw new Error(`restore to turn ${index + 1} did not complete: ${restored.status}`);
        if (!safetyCheckpointId) safetyCheckpointId = restored.safetyCheckpointId;
        expect(await readFile(join(projectPath, 'a.html'), 'utf8')).toBe(`${expected}\n`);
    }
    const undo = await planner.plan({ ...binding, ...recorded, checkpointId: safetyCheckpointId });
    expect((await executor.execute({ ...binding, ...recorded, localHistory, operationId: randomUUID(), plan: undo, confirmed: true })).status)
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
