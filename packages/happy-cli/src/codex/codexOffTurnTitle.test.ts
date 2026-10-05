import { describe, expect, it, vi } from 'vitest';

import {
    buildOffTurnTitleExecArgs,
    createCodexExecTitleRunner,
    createOffTurnTitleJob,
    isOffTurnTitleEligible,
    parseEnabledMcpServerNames,
    parseOffTurnTitle,
    titleCoveredForTurn,
} from './codexOffTurnTitle';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function setup(overrides: { hasTitle?: () => boolean; changeTitle?: ReturnType<typeof vi.fn> } = {}) {
    const run = deferred<string | null>();
    const runner = vi.fn((_input: { prompt: string; model?: string; signal: AbortSignal }) => run.promise);
    const changeTitle = overrides.changeTitle ?? vi.fn(async () => ({ success: true }));
    const log = vi.fn();
    const job = createOffTurnTitleJob({
        run: runner,
        changeTitle,
        hasTitle: overrides.hasTitle ?? (() => false),
        log,
    });
    return { run, runner, changeTitle, log, job };
}

describe('createOffTurnTitleJob', () => {
    it('shouldCoverTheTitleWhileRunningSoTheTurnCanOmitTheInstruction', () => {
        const { job, runner } = setup();
        expect(job.start('성능 측정용 요청입니다', 'gpt-6-luna')).toBe(true);
        expect(job.covers()).toBe(true);
        expect(runner).toHaveBeenCalledTimes(1);
        expect(runner.mock.calls[0][0].model).toBe('gpt-6-luna');
        expect(runner.mock.calls[0][0].prompt).toContain('성능 측정용 요청입니다');
    });

    it('shouldRecordTitleAndBranchSlugWhenTheRunSucceeds', async () => {
        const { job, run, changeTitle } = setup();
        job.start('Fix the login bug', undefined);
        run.resolve(JSON.stringify({ title: 'Login bug fix', branchSlug: 'fix-login-bug' }));
        await job.settled();
        expect(changeTitle).toHaveBeenCalledWith('Login bug fix', 'fix-login-bug');
        expect(job.covers()).toBe(true);
    });

    it('shouldStopCoveringAfterAFailedRunSoTheNextTurnRestoresTheInstruction', async () => {
        const { job, run, changeTitle, log } = setup();
        job.start('hello', undefined);
        run.reject(new Error('exit 1'));
        await job.settled();
        expect(changeTitle).not.toHaveBeenCalled();
        expect(job.covers()).toBe(false);
        expect(log).toHaveBeenCalledWith(expect.stringContaining('failed'), expect.anything());
    });

    it('shouldTreatUnparseableOutputAsFailure', async () => {
        const { job, run, changeTitle } = setup();
        job.start('hello', undefined);
        run.resolve('not json');
        await job.settled();
        expect(changeTitle).not.toHaveBeenCalled();
        expect(job.covers()).toBe(false);
    });

    it('shouldStopCoveringWhenRecordingTheTitleFailsForAReasonOtherThanTheLock', async () => {
        const changeTitle = vi.fn(async () => ({ success: false, error: 'socket closed' }));
        const { job, run } = setup({ changeTitle });
        job.start('hello', undefined);
        run.resolve(JSON.stringify({ title: 'Greeting' }));
        await job.settled();
        expect(job.covers()).toBe(false);
    });

    it('shouldNotOverwriteATitleThatAppearedWhileRunning', async () => {
        let titled = false;
        const { job, run, changeTitle } = setup({ hasTitle: () => titled });
        job.start('hello', undefined);
        titled = true;
        run.resolve(JSON.stringify({ title: 'Greeting', branchSlug: 'say-hello' }));
        await job.settled();
        expect(changeTitle).not.toHaveBeenCalled();
    });

    it('shouldStartAtMostOnce', async () => {
        const { job, run, runner } = setup();
        expect(job.start('first', undefined)).toBe(true);
        run.reject(new Error('boom'));
        await job.settled();
        expect(job.start('second', undefined)).toBe(false);
        expect(runner).toHaveBeenCalledTimes(1);
    });

    it('shouldNotStartWhenTheSessionAlreadyHasATitle', () => {
        const { job, runner } = setup({ hasTitle: () => true });
        expect(job.start('hello', undefined)).toBe(false);
        expect(job.covers()).toBe(false);
        expect(runner).not.toHaveBeenCalled();
    });

    it('shouldAbortTheRunAndNotRecordAfterCancel', async () => {
        const { job, run, runner, changeTitle } = setup();
        job.start('hello', undefined);
        job.cancel();
        expect(runner.mock.calls[0][0].signal.aborted).toBe(true);
        run.resolve(JSON.stringify({ title: 'Greeting' }));
        await job.settled();
        expect(changeTitle).not.toHaveBeenCalled();
    });
});

describe('parseOffTurnTitle', () => {
    it('shouldTrimTheTitleAndDropAnInvalidBranchSlug', () => {
        expect(parseOffTurnTitle(JSON.stringify({ title: '  CLI 응답 속도 비교  ', branchSlug: 'Not A Slug!' })))
            .toEqual({ title: 'CLI 응답 속도 비교' });
    });

    it('shouldKeepAValidBranchSlug', () => {
        expect(parseOffTurnTitle(JSON.stringify({ title: 'Perf', branchSlug: 'cli-latency-compare' })))
            .toEqual({ title: 'Perf', branchSlug: 'cli-latency-compare' });
    });

    it('shouldRejectAnEmptyOrOverlongTitle', () => {
        expect(parseOffTurnTitle(JSON.stringify({ title: '   ' }))).toBeNull();
        expect(parseOffTurnTitle(JSON.stringify({ title: 'x'.repeat(201) }))).toBeNull();
        expect(parseOffTurnTitle(null)).toBeNull();
    });
});

describe('isOffTurnTitleEligible', () => {
    it('shouldAllowOnlyPlainLoginUnsandboxedInteractiveSessions', () => {
        expect(isOffTurnTitleEligible({ authSource: 'cli-login', sandboxEnabled: false, exitAfterFirstTurn: false })).toBe(true);
        expect(isOffTurnTitleEligible({ authSource: 'custom-home', sandboxEnabled: false, exitAfterFirstTurn: false })).toBe(true);
        expect(isOffTurnTitleEligible({ authSource: 'managed', sandboxEnabled: false, exitAfterFirstTurn: false })).toBe(false);
        expect(isOffTurnTitleEligible({ authSource: 'multi-auth', sandboxEnabled: false, exitAfterFirstTurn: false })).toBe(false);
        expect(isOffTurnTitleEligible({ authSource: 'unknown', sandboxEnabled: false, exitAfterFirstTurn: false })).toBe(false);
        expect(isOffTurnTitleEligible({ authSource: 'cli-login', sandboxEnabled: true, exitAfterFirstTurn: false })).toBe(false);
        expect(isOffTurnTitleEligible({ authSource: 'cli-login', sandboxEnabled: false, exitAfterFirstTurn: true })).toBe(false);
    });
});

describe('buildOffTurnTitleExecArgs', () => {
    it('shouldRunAnEphemeralReadOnlyLowEffortExecThatReadsThePromptFromStdin', () => {
        const args = buildOffTurnTitleExecArgs({ model: 'gpt-6-luna', schemaPath: '/t/schema.json', outputPath: '/t/out.json', mcpServerNames: [] });
        expect(args.slice(0, 1)).toEqual(['exec']);
        expect(args).toEqual(expect.arrayContaining(['--ephemeral', '--skip-git-repo-check', '--output-schema', '/t/schema.json', '-o', '/t/out.json']));
        expect(args.join(' ')).toContain('-s read-only');
        expect(args.join(' ')).toContain('-m gpt-6-luna');
        expect(args.join(' ')).toContain('model_reasoning_effort="low"');
        expect(args[args.length - 1]).toBe('-');
    });

    it('shouldDisableEachNamedMcpServer', () => {
        const args = buildOffTurnTitleExecArgs({ schemaPath: '/s', outputPath: '/o', mcpServerNames: ['linear', 'my_tools-2'] });
        expect(args.join(' ')).toContain('-c mcp_servers.linear.enabled=false -c mcp_servers.my_tools-2.enabled=false');
    });

    it('shouldOmitTheModelFlagForTheDefaultModel', () => {
        const args = buildOffTurnTitleExecArgs({ schemaPath: '/s', outputPath: '/o', mcpServerNames: [] });
        expect(args).not.toContain('-m');
    });
});

describe('parseEnabledMcpServerNames', () => {
    it('shouldReturnTheEnabledServerNames', () => {
        expect(parseEnabledMcpServerNames(JSON.stringify([
            { name: 'linear', enabled: true },
            { name: 'off', enabled: false },
            { name: 'legacy' },
        ]))).toEqual(['linear', 'legacy']);
        expect(parseEnabledMcpServerNames('[]')).toEqual([]);
    });

    it('shouldRejectAnEnabledNameThatACliKeyCannotAddress', () => {
        expect(parseEnabledMcpServerNames(JSON.stringify([{ name: 'dotted.name', enabled: true }]))).toBeNull();
        expect(parseEnabledMcpServerNames(JSON.stringify([{ name: 'dotted.name', enabled: false }]))).toEqual([]);
    });

    it('shouldRejectUnreadableOutput', () => {
        expect(parseEnabledMcpServerNames('not json')).toBeNull();
        expect(parseEnabledMcpServerNames('{}')).toBeNull();
        expect(parseEnabledMcpServerNames('[{"enabled":true}]')).toBeNull();
    });
});

describe('createCodexExecTitleRunner', () => {
    async function fakeSpawn(behavior: { exitCode?: number | null; output?: string; hang?: boolean; mcpList?: string }) {
        const { EventEmitter } = await import('node:events');
        const { PassThrough } = await import('node:stream');
        const { writeFile } = await import('node:fs/promises');
        const calls: { command: string; args: string[]; cwd?: string; stdin: string; killed: boolean }[] = [];
        const lists: { cwd?: string }[] = [];
        const spawnImpl = vi.fn((command: string, args: string[], options: { cwd?: string }) => {
            const child = new EventEmitter() as InstanceType<typeof EventEmitter> & { stdin: InstanceType<typeof PassThrough>; stdout: InstanceType<typeof PassThrough>; stderr: InstanceType<typeof PassThrough>; kill: () => boolean };
            child.stdout = new PassThrough();
            child.stderr = new PassThrough();
            if (args[0] === 'mcp') {
                lists.push({ cwd: options.cwd });
                setImmediate(() => { child.stdout.end(behavior.mcpList ?? '[]'); child.emit('close', 0, null); });
                return child;
            }
            const call = { command, args, cwd: options.cwd, stdin: '', killed: false };
            calls.push(call);
            child.stdin = new PassThrough();
            child.stdin.on('data', (chunk: Buffer) => { call.stdin += chunk.toString(); });
            child.kill = () => { call.killed = true; setImmediate(() => child.emit('close', null, 'SIGTERM')); return true; };
            child.stdin.on('finish', async () => {
                if (behavior.hang) return;
                const out = args[args.indexOf('-o') + 1];
                if (behavior.output !== undefined) await writeFile(out, behavior.output);
                child.emit('close', behavior.exitCode ?? 0, null);
            });
            return child;
        });
        return { spawnImpl, calls, lists };
    }

    it('shouldPipeThePromptAndReturnTheFinalMessageThenRemoveItsTempDir', async () => {
        const { existsSync } = await import('node:fs');
        const { spawnImpl, calls } = await fakeSpawn({ output: '{"title":"T","branchSlug":"a-b"}' });
        const run = createCodexExecTitleRunner({ spawnImpl: spawnImpl as never });
        const raw = await run({ prompt: 'PROMPT', model: 'gpt-6-luna', signal: new AbortController().signal });
        expect(raw).toBe('{"title":"T","branchSlug":"a-b"}');
        expect(calls[0].command).toBe('codex');
        expect(calls[0].stdin).toBe('PROMPT');
        expect(calls[0].args).toContain('gpt-6-luna');
        expect(existsSync(calls[0].cwd!)).toBe(false);
    });

    it('shouldDisableTheListedMcpServersInTheSameDir', async () => {
        const { spawnImpl, calls, lists } = await fakeSpawn({ output: '{"title":"T"}', mcpList: '[{"name":"linear","enabled":true}]' });
        const run = createCodexExecTitleRunner({ spawnImpl: spawnImpl as never });
        await run({ prompt: 'P', signal: new AbortController().signal });
        expect(lists).toEqual([{ cwd: calls[0].cwd }]);
        expect(calls[0].args.join(' ')).toContain('-c mcp_servers.linear.enabled=false');
    });

    it('shouldNotRunExecWhenAnMcpServerCannotBeDisabled', async () => {
        const { spawnImpl, calls } = await fakeSpawn({ output: '{"title":"T"}', mcpList: '[{"name":"a.b","enabled":true}]' });
        const run = createCodexExecTitleRunner({ spawnImpl: spawnImpl as never });
        await expect(run({ prompt: 'P', signal: new AbortController().signal })).rejects.toThrow('MCP server');
        expect(calls).toHaveLength(0);
    });

    it('shouldRejectWhenExecExitsNonZero', async () => {
        const { spawnImpl } = await fakeSpawn({ exitCode: 1 });
        const run = createCodexExecTitleRunner({ spawnImpl: spawnImpl as never });
        await expect(run({ prompt: 'P', signal: new AbortController().signal })).rejects.toThrow('exited with code 1');
    });

    it('shouldKillTheProcessOnAbort', async () => {
        const { spawnImpl, calls } = await fakeSpawn({ hang: true });
        const run = createCodexExecTitleRunner({ spawnImpl: spawnImpl as never });
        const controller = new AbortController();
        const pending = run({ prompt: 'P', signal: controller.signal });
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        controller.abort();
        await expect(pending).rejects.toThrow();
        expect(calls[0].killed).toBe(true);
    });

    it('shouldKillTheProcessWhenItExceedsTheTimeout', async () => {
        const { spawnImpl, calls } = await fakeSpawn({ hang: true });
        const run = createCodexExecTitleRunner({ spawnImpl: spawnImpl as never, timeoutMs: 20 });
        await expect(run({ prompt: 'P', signal: new AbortController().signal })).rejects.toThrow('timed out');
        expect(calls[0].killed).toBe(true);
    });
});

describe('titleCoveredForTurn', () => {
    it('shouldKeepTheExistingTitleWithoutStartingAJob', () => {
        const { job, runner } = setup();
        expect(titleCoveredForTurn({ hasTitle: true, job, eligible: true, message: 'm' })).toBe(true);
        expect(runner).not.toHaveBeenCalled();
    });

    it('shouldStartTheJobAndOmitTheInstructionOnAnEligibleUntitledTurn', () => {
        const { job, runner } = setup();
        expect(titleCoveredForTurn({ hasTitle: false, job, eligible: true, message: 'm', model: 'gpt-6-luna' })).toBe(true);
        expect(runner).toHaveBeenCalledTimes(1);
    });

    it('shouldKeepTheInTurnInstructionWhenNotEligible', () => {
        const { job, runner } = setup();
        expect(titleCoveredForTurn({ hasTitle: false, job, eligible: false, message: 'm' })).toBe(false);
        expect(runner).not.toHaveBeenCalled();
    });

    it('shouldRestoreTheInTurnInstructionOnTheTurnAfterAFailedJob', async () => {
        const { job, run } = setup();
        titleCoveredForTurn({ hasTitle: false, job, eligible: true, message: 'first' });
        run.reject(new Error('exit 1'));
        await job.settled();
        expect(titleCoveredForTurn({ hasTitle: false, job, eligible: true, message: 'second' })).toBe(false);
    });
});

const HAS_CODEX = (await import('node:child_process')).spawnSync('codex', ['--version'], { stdio: 'ignore' }).status === 0;

describe.skipIf(!HAS_CODEX)('createCodexExecTitleRunner with a real codex', () => {
    /**
     * Isolated CODEX_HOME whose model provider accepts connections and never
     * answers, so no tokens are spent and a connection proves the exec got
     * past config loading. Each MCP server appends to a marker when started.
     */
    async function isolatedCodexHome(serverNames: string[]) {
        const { mkdtemp, readFile } = await import('node:fs/promises');
        const { writeFile } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const { createServer } = await import('node:net');
        const home = await mkdtemp(join(tmpdir(), 'happy-codex-title-home-'));
        const marker = join(home, 'mcp-started');
        const sockets: import('node:net').Socket[] = [];
        let connected = false;
        const server = createServer((socket) => { connected = true; sockets.push(socket); });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as import('node:net').AddressInfo).port;
        const servers = serverNames.map((name) => [
            `[mcp_servers.${JSON.stringify(name)}]`,
            'command = "/bin/sh"',
            `args = ["-c", ${JSON.stringify(`echo ${name} >> '${marker}'; exec sleep 5`)}]`,
        ].join('\n'));
        await writeFile(join(home, 'config.toml'), [
            'model = "gpt-5"',
            'model_provider = "hold"',
            '[model_providers.hold]',
            'name = "hold"',
            `base_url = "http://127.0.0.1:${port}/v1"`,
            'wire_api = "responses"',
            'request_max_retries = 0',
            'stream_max_retries = 0',
            ...servers,
        ].join('\n'));
        return {
            home,
            connected: () => connected,
            started: () => readFile(marker, 'utf8').catch(() => ''),
            async dispose() {
                sockets.forEach((socket) => socket.destroy());
                server.close();
                const { rm } = await import('node:fs/promises');
                await rm(home, { recursive: true, force: true });
            },
        };
    }

    async function withCodexHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
        const previous = process.env.CODEX_HOME;
        process.env.CODEX_HOME = home;
        try { return await fn(); } finally {
            if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
        }
    }

    it('shouldNotStartTheUsersConfiguredMcpServers', async () => {
        const fixture = await isolatedCodexHome(['probe', 'second_probe']);
        try {
            await withCodexHome(fixture.home, async () => {
                const controller = new AbortController();
                const pending = createCodexExecTitleRunner({ timeoutMs: 30_000 })({ prompt: 'P', signal: controller.signal });
                pending.catch(() => {});
                await vi.waitFor(() => expect(fixture.connected()).toBe(true), { timeout: 20_000, interval: 50 });
                await new Promise((resolve) => setTimeout(resolve, 500));
                controller.abort();
                await expect(pending).rejects.toThrow('aborted');
            });
            expect(await fixture.started()).toBe('');
        } finally {
            await fixture.dispose();
        }
    }, 40_000);

    it('shouldRefuseToRunWhenAnMcpServerNameCannotBeDisabled', async () => {
        const fixture = await isolatedCodexHome(['dotted.name']);
        try {
            await withCodexHome(fixture.home, async () => {
                const run = createCodexExecTitleRunner({ timeoutMs: 30_000 });
                await expect(run({ prompt: 'P', signal: new AbortController().signal })).rejects.toThrow('MCP server');
            });
            expect(fixture.connected()).toBe(false);
            expect(await fixture.started()).toBe('');
        } finally {
            await fixture.dispose();
        }
    }, 40_000);
});
