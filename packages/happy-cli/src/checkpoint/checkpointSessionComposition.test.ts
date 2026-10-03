import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SandboxConfigSchema } from '@/persistence';
import { CHECKPOINT_SPAWN_CONTEXT_ENV_KEY } from './checkpointSpawnContext';
import { CheckpointProtectionStateStore } from './checkpointProtectionState';
import { createCheckpointSessionComposition } from './checkpointSessionComposition';
import { resolveCheckpointStoreLayout } from './checkpointStore';

const execFileAsync = promisify(execFile);

// specs/checkpoint-local-history (Desktop) — a checkpoint session runs the provider in the original
// folder and records the folder at each turn boundary instead of isolating writes.
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

    // The old manifest limits Desktop still sends; local history must not be bounded by them.
    const protection = {
        secretPatterns: ['.env*'],
        maxFileBytes: 1024,
        maxFiles: 3,
        maxTotalBytes: 4096,
    };
    const checkpointEvents = {
        snapshot: async () => ({
            id: 'event-1', seq: 1, createdAt: Date.now(), idempotent: false,
        }),
    };
    const binding = () => ({ sessionId: 'session-1', projectId: 'project-1', worktreeId: null, projectPath });

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

    function compose(overrides: Partial<Parameters<typeof createCheckpointSessionComposition>[0]> = {}) {
        return createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
            checkpointEvents,
            ...overrides,
        });
    }

    async function recordedFile(checkpointId: string, path: string): Promise<string> {
        const layout = resolveCheckpointStoreLayout({ checkpointRoot: await realpath(checkpointRoot), ...binding() });
        return (await execFileAsync('git', [`--git-dir=${layout.gitDirectory}`, 'show', `${checkpointId}:${path}`])).stdout;
    }

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

        expect(result.sandboxConfig).toBe(sandboxConfig);
        expect(await result.agentReader?.status()).toMatchObject({ enabled: false, reason: 'session-context-unavailable' });
    });

    it('fails closed without a daemon-owned binding or on an unsupported platform', async () => {
        await expect(compose({ env: {} })).rejects.toThrow('authoritative checkpoint spawn context');
        await expect(compose({ platform: 'win32' })).rejects.toThrow('unsupported-platform');
        await expect(compose({ provider: 'gemini' as never })).rejects.toThrow('unsupported-provider');
        await expect(lstat(join(projectPath, '.aplus'))).rejects.toThrow();
    });

    it('fails closed when a checkpoint session has no durable event publisher', async () => {
        await expect(compose({ checkpointEvents: undefined })).rejects.toThrow('durable event publisher');
    });

    it('waits for a durable snapshot event acknowledgement before opening the provider turn', async () => {
        const snapshot = vi.fn()
            .mockRejectedValueOnce(new Error('event server unavailable'))
            .mockResolvedValueOnce({ id: 'event-1', seq: 1, createdAt: Date.now(), idempotent: true });
        const result = await compose({ checkpointEvents: { snapshot } });

        await expect(result.localHistory?.beforeTurn()).rejects.toThrow('event server unavailable');
        const retry = await result.localHistory?.beforeTurn();

        expect(snapshot).toHaveBeenCalledTimes(2);
        expect(snapshot.mock.calls[1]?.[0]).toEqual(snapshot.mock.calls[0]?.[0]);
        expect(snapshot.mock.calls[0]?.[0]).toMatchObject({
            operationId: retry?.operationId,
            checkpointId: retry?.checkpointId,
        });
    });

    it('lets the provider edit one file across turns in the original folder of a large project', async () => {
        for (let index = 0; index < 150; index += 1) await writeFile(join(projectPath, `file-${index}.txt`), `${index}`);
        const result = await compose();
        const history = result.localHistory!;
        const turns: string[] = [];

        for (const content of ['hello world', 'hello buzzni']) {
            const turn = await history.beforeTurn();
            expect(turn.providerPath).toBe(await realpath(projectPath));
            turns.push(turn.checkpointId);
            await writeFile(join(projectPath, 'b.html'), content);
            await history.afterTurn();
        }

        expect(await readFile(join(projectPath, 'b.html'), 'utf8')).toBe('hello buzzni');
        expect(await recordedFile(turns[1]!, 'b.html')).toBe('hello world');
        expect(await recordedFile(turns[1]!, 'file-149.txt')).toBe('149');
        expect((await new CheckpointProtectionStateStore(checkpointRoot).read(binding())).pendingDecision).toBeNull();
    });

    it('records with a disabled sandbox and leaves the sandbox configuration as configured', async () => {
        const sandboxConfig = SandboxConfigSchema.parse({ enabled: false, checkpointProtection: protection });
        const result = await compose({ sandboxConfig });

        expect(result.sandboxConfig).toBe(sandboxConfig);
        expect(result.claudeSandbox).toBeUndefined();
        await expect(result.localHistory?.beforeTurn()).resolves.toMatchObject({ checkpointId: expect.any(String) });
    });

    it('keeps secrets and Saycode worktrees out of the record', async () => {
        await writeFile(join(projectPath, '.env.local'), 'TOKEN=secret');
        await mkdir(join(projectPath, '.aplus', 'worktrees', 'chat-1'), { recursive: true });
        await writeFile(join(projectPath, '.aplus', 'worktrees', 'chat-1', 'copy.txt'), 'copy');
        const turn = await (await compose()).localHistory!.beforeTurn();

        await expect(recordedFile(turn.checkpointId, 'source.txt')).resolves.toBe('before');
        await expect(recordedFile(turn.checkpointId, '.env.local')).rejects.toThrow();
        await expect(recordedFile(turn.checkpointId, '.aplus/worktrees/chat-1/copy.txt')).rejects.toThrow();
    });

    it('clears a protection decision an older runtime left pending', async () => {
        const state = new CheckpointProtectionStateStore(checkpointRoot);
        await state.reportPending({ ...binding(), operationId: 'turn-1', source: 'policy-drift', excluded: [] });

        const result = await compose();

        expect(result.localHistory).toBeDefined();
        expect((await state.read(binding())).pendingDecision).toBeNull();
        expect((await state.read(binding())).protection.status).toBe('protected');
    });

    it('starts a restarted session without checkpoints after an explicit disable', async () => {
        const state = new CheckpointProtectionStateStore(checkpointRoot);
        await state.reportPending({ ...binding(), operationId: 'turn-1', source: 'policy-drift', excluded: [] });
        await state.resolveDecision({ ...binding(), operationId: 'turn-1', decision: 'disable-protection' });

        const result = await compose();

        expect(result.localHistory).toBeUndefined();
        expect(result.sandboxConfig?.checkpointProtection).toBeUndefined();
        expect(result.sandboxConfig?.enabled).toBe(true);
    });
});
