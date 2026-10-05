import { describe, expect, it, vi } from 'vitest';

import {
    buildOffTurnTitleExecArgs,
    createCodexExecTitleRunner,
    createOffTurnTitleJob,
    isOffTurnTitleEligible,
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
        const args = buildOffTurnTitleExecArgs({ model: 'gpt-6-luna', schemaPath: '/t/schema.json', outputPath: '/t/out.json' });
        expect(args.slice(0, 1)).toEqual(['exec']);
        expect(args).toEqual(expect.arrayContaining(['--ephemeral', '--skip-git-repo-check', '--output-schema', '/t/schema.json', '-o', '/t/out.json']));
        expect(args.join(' ')).toContain('-s read-only');
        expect(args.join(' ')).toContain('-m gpt-6-luna');
        expect(args.join(' ')).toContain('model_reasoning_effort="low"');
        expect(args.join(' ')).toContain('-c mcp_servers={}');
        expect(args[args.length - 1]).toBe('-');
    });

    it('shouldOmitTheModelFlagForTheDefaultModel', () => {
        const args = buildOffTurnTitleExecArgs({ schemaPath: '/s', outputPath: '/o' });
        expect(args).not.toContain('-m');
    });
});

describe('createCodexExecTitleRunner', () => {
    async function fakeSpawn(behavior: { exitCode?: number | null; output?: string; hang?: boolean }) {
        const { EventEmitter } = await import('node:events');
        const { PassThrough } = await import('node:stream');
        const { writeFile } = await import('node:fs/promises');
        const calls: { command: string; args: string[]; cwd?: string; stdin: string; killed: boolean }[] = [];
        const spawnImpl = vi.fn((command: string, args: string[], options: { cwd?: string }) => {
            const child = new EventEmitter() as InstanceType<typeof EventEmitter> & { stdin: InstanceType<typeof PassThrough>; stderr: InstanceType<typeof PassThrough>; kill: () => boolean };
            const call = { command, args, cwd: options.cwd, stdin: '', killed: false };
            calls.push(call);
            child.stdin = new PassThrough();
            child.stderr = new PassThrough();
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
        return { spawnImpl, calls };
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
