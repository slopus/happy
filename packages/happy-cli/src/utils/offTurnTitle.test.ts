import { describe, expect, it, vi } from 'vitest';

import {
    createOffTurnTitleJob,
    parseOffTurnTitle,
    titleCoveredForTurn,
} from './offTurnTitle';

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

    it('shouldFailInsteadOfRejectingWhenRecordingTheTitleThrows', async () => {
        const changeTitle = vi.fn(async () => { throw new Error('socket gone'); });
        const { job, run, log } = setup({ changeTitle });
        job.start('hello', undefined);
        run.resolve(JSON.stringify({ title: 'Greeting' }));
        await expect(job.settled()).resolves.toBeUndefined();
        expect(job.covers()).toBe(false);
        expect(log).toHaveBeenCalledWith(expect.stringContaining('failed'), expect.anything());
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
