import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    written: string[] = [];
    resizeCalls: Array<[number, number]> = [];
    paused = false;
    killed = false;
    snapshotText = 'fake-snapshot';

    private readonly outputListeners = new Set<(data: string) => void>();
    private readonly exitListeners = new Set<(exitCode: number) => void>();

    constructor(kind: 'pty' | 'tmux' = 'pty', tmuxTarget?: string) {
        this.kind = kind;
        this.tmuxTarget = tmuxTarget;
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
    files: { terminals: string; policy: string };
    dir: string;
}

async function createHarness(
    options: {
        policy?: ApprovalPolicy;
        ringBufferMaxBytes?: number;
        sessionKind?: 'pty' | 'tmux';
        tmuxTargetForRecovery?: string;
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

    const manager = new TerminalManager({
        terminalsFile: files.terminals,
        policyStore,
        shell: '/bin/sh',
        emitOutput: (id, frame) => frames.push(frame),
        emitExit: (id, frame) => frames.push(frame),
        emitError: (id, frame) => frames.push(frame),
        tmuxEnabled: false,
        ringBufferMaxBytes: options.ringBufferMaxBytes,
        sessionFactory: async (record: TerminalRecord) => {
            const session = new FakeSession(
                options.sessionKind ?? 'pty',
                options.tmuxTargetForRecovery,
            );
            sessions.set(record.terminalId, session);
            return session;
        },
    });

    return { manager, sessions, frames, files, dir };
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
        const { manager, sessions, frames, files } = await createHarness({
            policy: 'none',
            sessionKind: 'tmux',
        });
        writeFileSync(files.terminals, JSON.stringify({
            version: 1,
            terminals: [{
                terminalId: 'b'.repeat(24),
                name: 'persistent',
                cwd: tmpdir(),
                shell: '/bin/sh',
                status: 'running',
                tmuxTarget: 'happy-term-b'.repeat(1) + 'b'.repeat(24),
                createdAt: 1,
            }],
        }));
        await manager.start();

        const terminalId = 'b'.repeat(24);
        expect(manager.get(terminalId)?.status).toBe('running');
        const session = sessions.get(terminalId);
        expect(session).toBeDefined();

        // Recovered sessions must be wired end-to-end, not just created.
        session!.emitOutput('hello-after-recovery\n');
        expect(frames.map((frame) => frame.data)).toEqual(['hello-after-recovery\n']);
        const attached = await manager.attach(terminalId, 0);
        expect(attached.status).toBe('running');
        expect(attached.snapshot).toBe('fake-snapshot');
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
            .toBe('applied');
        // Duplicate (lost ACK, client resent) must be acked but never re-run.
        expect(manager.applyFrame(terminalId, frame({ seq: 1, kind: 'input', data: 'echo one' })))
            .toBe('duplicate');
        // Out-of-order input is rejected without executing.
        expect(manager.applyFrame(terminalId, frame({ seq: 3, kind: 'input', data: 'echo three' })))
            .toBe('gap');
        // A different writer stream starts its own sequence.
        expect(manager.applyFrame(terminalId, frame({
            streamId: 'stream-b',
            seq: 1,
            kind: 'input',
            data: 'echo bee',
        }))).toBe('applied');

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
        }))).toBe('applied');
        expect(manager.applyFrame(terminalId, frame({ seq: 2, kind: 'input', data: 'ls' })))
            .toBe('applied');
        expect(session.resizeCalls).toEqual([[120, 40]]);
        expect(session.written).toEqual(['ls']);

        // Replayed stale resize is deduped, not re-executed.
        expect(manager.applyFrame(terminalId, frame({
            seq: 1,
            kind: 'resize',
            cols: 100,
            rows: 30,
        }))).toBe('duplicate');
        expect(session.resizeCalls).toEqual([[120, 40]]);
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
        })).toBe('invalid');
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
            .toBe('invalid');
        expect(manager.applyFrame(terminalId, frame({ seq: 0, kind: 'input', data: 'x' })))
            .toBe('invalid');
        expect(manager.applyFrame(terminalId, frame({ seq: 1.5, kind: 'input', data: 'x' })))
            .toBe('invalid');
        expect(manager.applyFrame(terminalId, frame({
            seq: 1,
            kind: 'input',
            data: 'x'.repeat(1024 * 1024 + 1),
        }))).toBe('invalid');
        expect(manager.applyFrame(terminalId, frame({
            seq: 1,
            kind: 'resize',
            cols: 0,
            rows: 24,
        }))).toBe('invalid');
        expect(manager.applyFrame(terminalId, frame({
            seq: 1,
            kind: 'signal',
            signal: 'SIGKILL',
        }))).toBe('invalid');
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
