import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    ApprovalPolicy,
    ShellSession,
    TerminalInputFrame,
    TerminalOutputEvent,
    TerminalRecord,
} from './types';
import { TerminalManager } from './terminalManager';
import { TerminalPolicyStore } from './terminalPolicyStore';

const dirs: string[] = [];

function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'happy-terminal-manager-'));
    dirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

class FakeSession implements ShellSession {
    readonly kind: 'pty' | 'tmux';
    readonly tmuxTarget?: string;
    readonly paneId?: string;
    written: string[] = [];
    resizeCalls: Array<[number, number]> = [];
    paused = false;
    killed = false;
    snapshotText = 'fake-snapshot';

    private readonly outputListeners = new Set<(data: string) => void>();
    private readonly exitListeners = new Set<(exitCode: number) => void>();

    constructor(kind: 'pty' | 'tmux' = 'pty', tmuxTarget?: string, paneId?: string) {
        this.kind = kind;
        this.tmuxTarget = tmuxTarget;
        this.paneId = paneId;
    }

    write(data: string): void {
        this.written.push(data);
    }

    resize(cols: number, rows: number): void {
        this.resizeCalls.push([cols, rows]);
    }

    pause(): void {
        this.paused = true;
    }

    resume(): void {
        this.paused = false;
    }

    snapshot(): Promise<string> {
        return Promise.resolve(this.snapshotText);
    }

    kill(): Promise<void> {
        this.killed = true;
        for (const listener of this.exitListeners) {
            listener(0);
        }
        return Promise.resolve();
    }

    onOutput(listener: (data: string) => void): void {
        this.outputListeners.add(listener);
    }

    onExit(listener: (exitCode: number) => void): void {
        this.exitListeners.add(listener);
    }

    onError(_listener: (error: Error) => void): void {}

    emitOutput(data: string): void {
        for (const listener of this.outputListeners) {
            listener(data);
        }
    }

    emitExit(exitCode: number): void {
        for (const listener of this.exitListeners) {
            listener(exitCode);
        }
    }
}

interface Harness {
    manager: TerminalManager;
    sessions: Map<string, FakeSession>;
    frames: TerminalOutputEvent[];
    sessionModes: Array<'create-new' | 'attach-existing'>;
    files: { terminals: string; policy: string };
    dir: string;
}

async function createHarness(
    options: {
        policy?: ApprovalPolicy;
        ringBufferMaxBytes?: number;
        sessionKind?: 'pty' | 'tmux';
        tmuxTargetForRecovery?: string;
        tmuxPaneIdForRecovery?: string;
        failAttachExisting?: boolean;
    } = {},
): Promise<Harness> {
    const dir = tempDir();
    const files = {
        terminals: join(dir, 'terminals.json'),
        policy: join(dir, 'terminal.settings.json'),
    };
    const policyStore = new TerminalPolicyStore(files.policy);
    await policyStore.load();
    if (options.policy && options.policy !== 'per-session') {
        await policyStore.set(options.policy);
    }
    const sessions = new Map<string, FakeSession>();
    const frames: TerminalOutputEvent[] = [];
    const sessionModes: Array<'create-new' | 'attach-existing'> = [];

    const manager = new TerminalManager({
        terminalsFile: files.terminals,
        policyStore,
        shell: '/bin/sh',
        emitOutput: (id, frame) => frames.push(frame),
        emitExit: (id, frame) => frames.push(frame),
        emitError: (id, frame) => frames.push(frame),
        tmuxEnabled: false,
        ringBufferMaxBytes: options.ringBufferMaxBytes,
        sessionFactory: async (record: TerminalRecord, _cols, _rows, mode) => {
            sessionModes.push(mode);
            if (mode === 'attach-existing' && options.failAttachExisting) {
                throw new Error('tmux session missing');
            }
            const session = new FakeSession(
                options.sessionKind ?? 'pty',
                options.tmuxTargetForRecovery,
                options.tmuxPaneIdForRecovery,
            );
            sessions.set(record.terminalId, session);
            return session;
        },
    });

    return { manager, sessions, frames, sessionModes, files, dir };
}

describe('TerminalManager', () => {
    it('creates and immediately spawns when policy is none', async () => {
        const { manager, sessions } = await createHarness({ policy: 'none' });
        await manager.start();

        const result = await manager.create({ cwd: tmpdir(), cols: 80, rows: 24 });
        expect(result.type).toBe('success');
        expect(sessions.has((result as { terminalId: string }).terminalId)).toBe(true);
        expect(manager.list()[0].status).toBe('running');
    });

    it('requires approval per session by default', async () => {
        const { manager, sessions } = await createHarness();
        await manager.start();

        const result = await manager.create({ cwd: tmpdir(), cols: 80, rows: 24 });
        expect(result.type).toBe('awaiting-approval');
        const awaiting = result as { approvalId: string; terminalId: string };
        expect(sessions.has(awaiting.terminalId)).toBe(false);
        expect(manager.list()[0].status).toBe('pending');

        const approved = await manager.approve(awaiting.approvalId);
        expect(approved.type).toBe('success');
        expect(sessions.has(awaiting.terminalId)).toBe(true);
        expect(manager.list()[0].status).toBe('running');

        await expect(manager.approve(awaiting.approvalId)).resolves.toMatchObject({
            type: 'error',
        });
    });

    it('approves once per machine and then opens directly', async () => {
        const { manager } = await createHarness({ policy: 'once-per-machine' });
        await manager.start();

        const first = await manager.create({ cwd: tmpdir(), cols: 80, rows: 24 });
        expect(first.type).toBe('awaiting-approval');
        await manager.approve((first as { approvalId: string }).approvalId);

        const second = await manager.create({ cwd: tmpdir(), cols: 80, rows: 24 });
        expect(second.type).toBe('success');
    });

    it('rejects a missing or non-directory cwd', async () => {
        const { manager } = await createHarness({ policy: 'none' });
        await manager.start();
        await expect(manager.create({
            cwd: join(tmpdir(), 'does-not-exist-12345'),
            cols: 80,
            rows: 24,
        })).resolves.toMatchObject({ type: 'error' });
    });

    it('emits output frames with sequence numbers and replays them on attach', async () => {
        const { manager, sessions, frames } = await createHarness({ policy: 'none' });
        await manager.start();
        const result = await manager.create({ cwd: tmpdir(), cols: 80, rows: 24 });
        const terminalId = (result as { terminalId: string }).terminalId;
        const session = sessions.get(terminalId)!;

        session.emitOutput('line-1\n');
        session.emitOutput('line-2\n');

        expect(frames.map((frame) => frame.data)).toEqual(['line-1\n', 'line-2\n']);
        expect(frames.map((frame) => frame.seq)).toEqual([1, 2]);

        const attached = await manager.attach(terminalId, 0);
        expect(attached.snapshot).toBe('fake-snapshot');
        // Snapshot-first barrier: retained output is inside the snapshot, so
        // replay only carries frames pushed after the snapshot.
        expect(attached.replayFrames).toEqual([]);
        expect(attached.nextSeq).toBe(3);
        expect(attached.status).toBe('running');
        expect(attached.streamEpoch).toBe(manager.getStreamEpoch());

        const caughtUp = await manager.attach(terminalId, 2);
        expect(caughtUp.replayFrames).toEqual([]);
    });

    it('marks output as truncated when the ring buffer overflows', async () => {
        const { manager, sessions } = await createHarness({
            policy: 'none',
            ringBufferMaxBytes: 8,
        });
        await manager.start();
        const result = await manager.create({ cwd: tmpdir(), cols: 80, rows: 24 });
        const session = sessions.get((result as { terminalId: string }).terminalId)!;

        session.emitOutput('1234567890');
        session.emitOutput('more');

        const attached = await manager.attach((result as { terminalId: string }).terminalId, 0);
        expect(attached.truncated).toBe(true);
    });

    it('marks running plain-PTY terminals as exited after a restart', async () => {
        const { manager, files } = await createHarness({ policy: 'none' });
        writeFileSync(files.terminals, JSON.stringify({
            version: 1,
            terminals: [{
                terminalId: 'a'.repeat(24),
                name: 'old',
                cwd: tmpdir(),
                shell: '/bin/sh',
                status: 'running',
                createdAt: 1,
            }],
        }));
        await manager.start();

        const record = manager.get('a'.repeat(24));
        expect(record?.status).toBe('exited');
        expect(record?.exitCode).toBe(1);
    });

    it('reattaches tmux-backed terminals after a restart', async () => {
        const { manager, sessions, frames, sessionModes, files } = await createHarness({
            policy: 'none',
            sessionKind: 'tmux',
            tmuxPaneIdForRecovery: '%9',
        });
        const terminalId = 'b'.repeat(24);
        writeFileSync(files.terminals, JSON.stringify({
            version: 1,
            terminals: [{
                terminalId,
                name: 'persistent',
                cwd: tmpdir(),
                shell: '/bin/sh',
                status: 'running',
                tmuxTarget: `happy-term-${terminalId}`,
                tmuxPaneId: '%1',
                createdAt: 1,
            }],
        }));
        await manager.start();

        expect(manager.get(terminalId)?.status).toBe('running');
        expect(manager.get(terminalId)?.tmuxPaneId).toBe('%9');
        expect(sessionModes).toEqual(['attach-existing']);
        const session = sessions.get(terminalId);
        expect(session).toBeDefined();

        // Recovered sessions must be wired end-to-end, not just created.
        session!.emitOutput('hello-after-recovery\n');
        expect(frames.map((frame) => frame.data)).toEqual(['hello-after-recovery\n']);
        const attached = await manager.attach(terminalId, 0);
        expect(attached.status).toBe('running');
        expect(attached.snapshot).toBe('fake-snapshot');
    });

    it('marks a missing tmux session exited without creating a replacement', async () => {
        const { manager, sessions, sessionModes, files } = await createHarness({
            policy: 'none',
            sessionKind: 'tmux',
            failAttachExisting: true,
        });
        const terminalId = 'c'.repeat(24);
        writeFileSync(files.terminals, JSON.stringify({
            version: 1,
            terminals: [{
                terminalId,
                name: 'missing',
                cwd: tmpdir(),
                shell: '/bin/sh',
                status: 'running',
                tmuxTarget: `happy-term-${terminalId}`,
                tmuxPaneId: '%3',
                createdAt: 1,
            }],
        }));

        await manager.start();

        expect(sessionModes).toEqual(['attach-existing']);
        expect(sessions.has(terminalId)).toBe(false);
        expect(manager.get(terminalId)).toMatchObject({ status: 'exited', exitCode: 1 });
    });

    it('pauses and resumes the shell via transport backpressure', async () => {
        const { manager, sessions } = await createHarness({ policy: 'none' });
        await manager.start();
        const result = await manager.create({ cwd: tmpdir(), cols: 80, rows: 24 });
        const terminalId = (result as { terminalId: string }).terminalId;
        const session = sessions.get(terminalId)!;

        manager.setTransportPaused(terminalId, true);
        expect(session.paused).toBe(true);
        manager.setTransportPaused(terminalId, false);
        expect(session.paused).toBe(false);
    });

    it('closes a terminal and removes it from the registry', async () => {
        const { manager, sessions } = await createHarness({ policy: 'none' });
        await manager.start();
        const result = await manager.create({ cwd: tmpdir(), cols: 80, rows: 24 });
        const terminalId = (result as { terminalId: string }).terminalId;
        const session = sessions.get(terminalId)!;

        await manager.close(terminalId);
        expect(session.killed).toBe(true);
        expect(manager.get(terminalId)).toBeNull();
        expect(manager.list()).toEqual([]);
    });

    it('recovers registry persistence after a transient write failure', async () => {
        const { manager, files } = await createHarness({ policy: 'none' });
        await manager.start();

        const temporaryPath = `${files.terminals}.tmp`;
        mkdirSync(temporaryPath);
        await expect(manager.create({ cwd: tmpdir(), cols: 80, rows: 24 }))
            .rejects.toThrow();

        rmSync(temporaryPath, { recursive: true });
        await expect(manager.create({ cwd: tmpdir(), cols: 80, rows: 24 }))
            .resolves.toMatchObject({ type: 'success' });
    });

    it('forwards write, resize, and SIGINT to the session', async () => {
        const { manager, sessions } = await createHarness({ policy: 'none' });
        await manager.start();
        const result = await manager.create({ cwd: tmpdir(), cols: 80, rows: 24 });
        const terminalId = (result as { terminalId: string }).terminalId;
        const session = sessions.get(terminalId)!;

        manager.write(terminalId, 'echo hi');
        manager.resize(terminalId, 100, 30);
        manager.signal(terminalId, 'SIGINT');

        expect(session.written).toEqual(['echo hi', '\x03']);
        expect(session.resizeCalls).toEqual([[100, 30]]);
    });

    it('applies input idempotently per stream', async () => {
        const { manager, sessions } = await createHarness({ policy: 'none' });
        await manager.start();
        const result = await manager.create({ cwd: tmpdir(), cols: 80, rows: 24 });
        const terminalId = (result as { terminalId: string }).terminalId;
        const session = sessions.get(terminalId)!;
        const epoch = manager.getStreamEpoch();
        const frame = (partial: Partial<TerminalInputFrame>): TerminalInputFrame => ({
            version: 3,
            epoch,
            streamId: 'stream-a',
            terminalId,
            machineId: 'machine-1',
            direction: 'client-to-daemon' as const,
            seq: 1,
            kind: 'input',
            ...partial,
        });

        expect(manager.applyFrame(terminalId, frame({ seq: 1, kind: 'input', data: 'echo one' })))
            .toEqual({ status: 'applied', expectedSeq: 2 });
        // Duplicate (lost ACK, client resent) must be acked but never re-run.
        expect(manager.applyFrame(terminalId, frame({ seq: 1, kind: 'input', data: 'echo one' })))
            .toEqual({ status: 'duplicate', expectedSeq: 2 });
        // Out-of-order input is rejected without executing.
        expect(manager.applyFrame(terminalId, frame({ seq: 3, kind: 'input', data: 'echo three' })))
            .toEqual({ status: 'gap', expectedSeq: 2 });
        // A different writer stream starts its own sequence.
        expect(manager.applyFrame(terminalId, frame({
            streamId: 'stream-b',
            seq: 1,
            kind: 'input',
            data: 'echo bee',
        }))).toEqual({ status: 'applied', expectedSeq: 2 });

        expect(session.written).toEqual(['echo one', 'echo bee']);
    });

    it('orders resize and input in a single stream', async () => {
        const { manager, sessions } = await createHarness({ policy: 'none' });
        await manager.start();
        const result = await manager.create({ cwd: tmpdir(), cols: 80, rows: 24 });
        const terminalId = (result as { terminalId: string }).terminalId;
        const session = sessions.get(terminalId)!;
        const epoch = manager.getStreamEpoch();
        const frame = (partial: Partial<TerminalInputFrame>): TerminalInputFrame => ({
            version: 3,
            epoch,
            streamId: 'stream-a',
            terminalId,
            machineId: 'machine-1',
            direction: 'client-to-daemon' as const,
            seq: 1,
            kind: 'input',
            ...partial,
        });

        // resize seq=1 advances the watermark; input seq=2 must NOT be seen as
        // a gap (regression: resize used to break the next input).
        expect(manager.applyFrame(terminalId, frame({
            seq: 1,
            kind: 'resize',
            cols: 120,
            rows: 40,
        }))).toEqual({ status: 'applied', expectedSeq: 2 });
        expect(manager.applyFrame(terminalId, frame({ seq: 2, kind: 'input', data: 'ls' })))
            .toEqual({ status: 'applied', expectedSeq: 3 });
        expect(session.resizeCalls).toEqual([[120, 40]]);
        expect(session.written).toEqual(['ls']);

        // Replayed stale resize is deduped, not re-executed.
        expect(manager.applyFrame(terminalId, frame({
            seq: 1,
            kind: 'resize',
            cols: 100,
            rows: 30,
        }))).toEqual({ status: 'duplicate', expectedSeq: 3 });
        expect(session.resizeCalls).toEqual([[120, 40]]);
    });

    it('executes input exactly once after a missing resize is replayed', async () => {
        const { manager, sessions } = await createHarness({ policy: 'none' });
        await manager.start();
        const result = await manager.create({ cwd: tmpdir(), cols: 80, rows: 24 });
        const terminalId = (result as { terminalId: string }).terminalId;
        const session = sessions.get(terminalId)!;
        const epoch = manager.getStreamEpoch();
        const frame = (partial: Partial<TerminalInputFrame>): TerminalInputFrame => ({
            version: 3,
            epoch,
            streamId: 'stream-gap',
            terminalId,
            machineId: 'machine-1',
            direction: 'client-to-daemon',
            seq: 1,
            kind: 'input',
            ...partial,
        });

        expect(manager.applyFrame(terminalId, frame({
            seq: 2,
            kind: 'input',
            data: 'echo once',
        }))).toEqual({ status: 'gap', expectedSeq: 1 });
        expect(session.written).toEqual([]);

        expect(manager.applyFrame(terminalId, frame({
            seq: 1,
            kind: 'resize',
            cols: 100,
            rows: 30,
        }))).toEqual({ status: 'applied', expectedSeq: 2 });
        expect(manager.applyFrame(terminalId, frame({
            seq: 2,
            kind: 'input',
            data: 'echo once',
        }))).toEqual({ status: 'applied', expectedSeq: 3 });
        expect(manager.applyFrame(terminalId, frame({
            seq: 2,
            kind: 'input',
            data: 'echo once',
        }))).toEqual({ status: 'duplicate', expectedSeq: 3 });

        expect(session.resizeCalls).toEqual([[100, 30]]);
        expect(session.written).toEqual(['echo once']);
    });

    it('rejects frames from an older daemon epoch', async () => {
        const { manager, sessions } = await createHarness({ policy: 'none' });
        await manager.start();
        const result = await manager.create({ cwd: tmpdir(), cols: 80, rows: 24 });
        const terminalId = (result as { terminalId: string }).terminalId;
        const session = sessions.get(terminalId)!;

        expect(manager.applyFrame(terminalId, {
            version: 3,
            epoch: 'stale-epoch',
            streamId: 'stream-a',
            terminalId,
            machineId: 'machine-1',
            direction: 'client-to-daemon',
            seq: 1,
            kind: 'input',
            data: 'rm -rf /tmp/x',
        })).toEqual({ status: 'invalid', expectedSeq: 1 });
        expect(session.written).toEqual([]);
    });

    it('rejects invalid input frames', async () => {
        const { manager } = await createHarness({ policy: 'none' });
        await manager.start();
        const result = await manager.create({ cwd: tmpdir(), cols: 80, rows: 24 });
        const terminalId = (result as { terminalId: string }).terminalId;
        const epoch = manager.getStreamEpoch();
        const frame = (partial: Partial<TerminalInputFrame>): TerminalInputFrame => ({
            version: 3,
            epoch,
            streamId: 'stream-a',
            terminalId,
            machineId: 'machine-1',
            direction: 'client-to-daemon' as const,
            seq: 1,
            kind: 'input',
            ...partial,
        });

        expect(manager.applyFrame(terminalId, frame({ streamId: '', seq: 1, kind: 'input', data: 'x' })))
            .toEqual({ status: 'invalid', expectedSeq: 1 });
        expect(manager.applyFrame(terminalId, frame({ seq: 0, kind: 'input', data: 'x' })))
            .toEqual({ status: 'invalid', expectedSeq: 1 });
        expect(manager.applyFrame(terminalId, frame({ seq: 1.5, kind: 'input', data: 'x' })))
            .toEqual({ status: 'invalid', expectedSeq: 1 });
        expect(manager.applyFrame(terminalId, frame({
            seq: 1,
            kind: 'input',
            data: 'x'.repeat(1024 * 1024 + 1),
        }))).toEqual({ status: 'invalid', expectedSeq: 1 });
        expect(manager.applyFrame(terminalId, frame({
            seq: 1,
            kind: 'resize',
            cols: 0,
            rows: 24,
        }))).toEqual({ status: 'invalid', expectedSeq: 1 });
        expect(manager.applyFrame(terminalId, frame({
            seq: 1,
            kind: 'signal',
            signal: 'SIGKILL',
        }))).toEqual({ status: 'invalid', expectedSeq: 1 });
    });

    it('rejects invalid create parameters at the daemon boundary', async () => {
        const { manager } = await createHarness({ policy: 'none' });
        await manager.start();

        await expect(manager.create({ cwd: 'relative/path', cols: 80, rows: 24 }))
            .resolves.toMatchObject({ type: 'error' });
        await expect(manager.create({ cwd: tmpdir(), cols: 0, rows: 24 }))
            .resolves.toMatchObject({ type: 'error' });
        await expect(manager.create({ cwd: tmpdir(), cols: 80, rows: Number.POSITIVE_INFINITY }))
            .resolves.toMatchObject({ type: 'error' });
        await expect(manager.create({ cwd: tmpdir(), cols: 80, rows: 24, name: 'x'.repeat(81) }))
            .resolves.toMatchObject({ type: 'error' });
        await expect(manager.create({ cwd: tmpdir(), cols: 80, rows: 24, shell: '' }))
            .resolves.toMatchObject({ type: 'error' });
    });

    it('rejects invalid resize dimensions', async () => {
        const { manager } = await createHarness({ policy: 'none' });
        await manager.start();
        const result = await manager.create({ cwd: tmpdir(), cols: 80, rows: 24 });
        const terminalId = (result as { terminalId: string }).terminalId;

        expect(() => manager.resize(terminalId, 0, 24)).toThrow();
        expect(() => manager.resize(terminalId, 80, Number.NaN)).toThrow();
        expect(() => manager.resize(terminalId, 80.5, 24)).toThrow();
    });
});
