import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ApprovalPolicy, ShellSession, TerminalOutputFrame, TerminalRecord } from './types';
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
    frames: TerminalOutputFrame[];
    files: { terminals: string; policy: string };
    dir: string;
}

async function createHarness(
    options: { policy?: ApprovalPolicy; ringBufferMaxBytes?: number } = {},
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
    const frames: TerminalOutputFrame[] = [];

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
            const session = new FakeSession('pty');
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
        expect(attached.replayFrames.map((frame) => frame.data)).toEqual(['line-1\n', 'line-2\n']);
        expect(attached.nextSeq).toBe(3);
        expect(attached.status).toBe('running');

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
        const { manager, sessions, files } = await createHarness({ policy: 'none' });
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

        expect(manager.get('b'.repeat(24))?.status).toBe('running');
        expect(sessions.has('b'.repeat(24))).toBe(true);
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
});
