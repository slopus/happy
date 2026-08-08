/**
 * Daemon-owned terminal session manager.
 *
 * Terminals are first-class entities: each one has a persisted record, an
 * optional tmux target (restart persistence), an output ring buffer for
 * offline replay, and an approval-gated lifecycle. The manager itself is
 * transport-agnostic — encrypted frames are emitted through the callbacks
 * provided by the daemon wiring.
 */

import { createId } from '@paralleldrive/cuid2';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isTmuxAvailable } from '@/utils/tmux';
import { logger } from '@/ui/logger';
import { OutputRingBuffer } from './ringBuffer';
import { PtyShellSession } from './ptySession';
import { TmuxShellSession } from './tmuxSession';
import { TerminalPolicyStore } from './terminalPolicyStore';
import {
    ApprovalPolicy,
    ShellSession,
    TerminalAttachResult,
    TerminalCreateOptions,
    TerminalCreateResult,
    TerminalOutputFrame,
    TerminalRecord,
} from './types';

export interface TerminalManagerOptions {
    terminalsFile: string;
    policyStore: TerminalPolicyStore;
    shell: string;
    emitOutput: (terminalId: string, frame: TerminalOutputFrame) => void;
    emitExit: (terminalId: string, frame: TerminalOutputFrame) => void;
    emitError: (terminalId: string, frame: TerminalOutputFrame) => void;
    env?: NodeJS.ProcessEnv;
    tmuxEnabled?: boolean;
    ringBufferMaxBytes?: number;
    scrollback?: number;
    sessionFactory?: (record: TerminalRecord, cols: number, rows: number) => Promise<ShellSession>;
}

interface TerminalEntry {
    record: TerminalRecord;
    session: ShellSession | null;
    ring: OutputRingBuffer;
}

interface PersistedTerminalRegistry {
    version: 1;
    terminals: TerminalRecord[];
}

const REGISTRY_VERSION = 1;
const DEFAULT_RING_BUFFER_MAX_BYTES = 64 * 1024;
const DEFAULT_SCROLLBACK = 5000;

function isValidCuid(value: string): boolean {
    return /^[a-z0-9]{20,32}$/i.test(value);
}

export class TerminalManager {
    private readonly entries = new Map<string, TerminalEntry>();
    private readonly pendingApprovals = new Map<string, string>();
    private persistQueue: Promise<void> = Promise.resolve();
    private readonly options: Required<Pick<TerminalManagerOptions,
        | 'shell'
        | 'tmuxEnabled'
        | 'ringBufferMaxBytes'
        | 'scrollback'>> & TerminalManagerOptions;

    constructor(options: TerminalManagerOptions) {
        this.options = {
            ...options,
            tmuxEnabled: options.tmuxEnabled ?? true,
            ringBufferMaxBytes: options.ringBufferMaxBytes ?? DEFAULT_RING_BUFFER_MAX_BYTES,
            scrollback: options.scrollback ?? DEFAULT_SCROLLBACK,
        };
    }

    get policyStore(): TerminalPolicyStore {
        return this.options.policyStore;
    }

    /**
     * Load the persisted registry and recover what can be recovered.
     * tmux-backed sessions are reattached; plain PTY sessions are marked
     * exited (their processes died with the previous daemon); pending
     * approvals are dropped.
     */
    async start(): Promise<void> {
        await this.options.policyStore.load();

        const records = await this.loadRegistry();
        const kept: TerminalRecord[] = [];
        for (const record of records) {
            if (record.status === 'pending') {
                continue; // Approvals never survive a daemon restart.
            }
            if (record.status === 'running' && record.tmuxTarget) {
                try {
                    const session = await this.createSession(record, 80, 24);
                    this.wireSession(record, session);
                    record.status = 'running';
                    kept.push(record);
                    continue;
                } catch (error) {
                    logger.warn(`[TERMINAL] Failed to reattach tmux session ${record.terminalId}:`,
                        error instanceof Error ? error.message : error);
                }
            }
            if (record.status === 'running') {
                record.status = 'exited';
                record.exitCode = record.exitCode ?? 1;
            }
            kept.push(record);
        }

        for (const record of kept) {
            this.entries.set(record.terminalId, {
                record,
                session: null,
                ring: new OutputRingBuffer(this.options.ringBufferMaxBytes),
            });
        }
        await this.persist();
    }

    /** Terminal IDs of live sessions (used to re-register stream rooms). */
    getRunningTerminalIds(): string[] {
        return Array.from(this.entries.values())
            .filter((entry) => entry.record.status === 'running')
            .map((entry) => entry.record.terminalId);
    }

    list(): TerminalRecord[] {
        return Array.from(this.entries.values())
            .map((entry) => ({ ...entry.record }))
            .sort((a, b) => b.createdAt - a.createdAt);
    }

    get(terminalId: string): TerminalRecord | null {
        const entry = this.entries.get(terminalId);
        return entry ? { ...entry.record } : null;
    }

    async create(options: TerminalCreateOptions): Promise<TerminalCreateResult> {
        const cwd = options.cwd;
        try {
            const cwdStat = await stat(cwd);
            if (!cwdStat.isDirectory()) {
                return { type: 'error', errorMessage: `Not a directory: ${cwd}` };
            }
        } catch {
            return { type: 'error', errorMessage: `Directory does not exist: ${cwd}` };
        }

        const terminalId = createId();
        const record: TerminalRecord = {
            terminalId,
            name: options.name?.trim() || `Terminal ${this.entries.size + 1}`,
            cwd,
            shell: options.shell?.trim() || this.options.shell,
            status: 'pending',
            tmuxTarget: undefined,
            createdAt: Date.now(),
        };

        this.entries.set(terminalId, {
            record,
            session: null,
            ring: new OutputRingBuffer(this.options.ringBufferMaxBytes),
        });
        await this.persist();

        const policy = this.options.policyStore.get();
        const needsApproval = policy === 'per-session'
            || (policy === 'once-per-machine' && !this.options.policyStore.getApprovedOnce());

        if (!needsApproval) {
            const result = await this.spawnRecord(terminalId, options.cols, options.rows);
            return result;
        }

        const approvalId = createId();
        this.pendingApprovals.set(approvalId, terminalId);
        return { type: 'awaiting-approval', approvalId, terminalId };
    }

    async approve(approvalId: string): Promise<TerminalCreateResult> {
        const terminalId = this.pendingApprovals.get(approvalId);
        if (!terminalId) {
            return { type: 'error', errorMessage: 'Approval request not found or already handled' };
        }
        this.pendingApprovals.delete(approvalId);

        const entry = this.entries.get(terminalId);
        if (!entry) {
            return { type: 'error', errorMessage: 'Terminal not found' };
        }
        if (entry.record.status !== 'pending') {
            return { type: 'error', errorMessage: 'Terminal is not awaiting approval' };
        }

        if (this.options.policyStore.get() === 'once-per-machine') {
            await this.options.policyStore.approveOnce();
        }

        return this.spawnRecord(terminalId, 80, 24);
    }

    async attach(terminalId: string, lastSeq: number): Promise<TerminalAttachResult> {
        const entry = this.entries.get(terminalId);
        if (!entry) {
            throw new Error('Terminal not found');
        }

        if (entry.record.status === 'pending') {
            return {
                status: 'pending',
                snapshot: '',
                nextSeq: 0,
                truncated: false,
                replayFrames: [],
            };
        }
        if (entry.record.status !== 'running' || !entry.session) {
            return {
                status: entry.record.status,
                snapshot: '',
                nextSeq: 0,
                truncated: false,
                replayFrames: [],
                exitCode: entry.record.exitCode,
            };
        }

        const replay = entry.ring.replay(lastSeq);
        const snapshot = await entry.session.snapshot();
        entry.record.lastAttachedAt = Date.now();
        await this.persist();

        return {
            status: 'running',
            snapshot,
            nextSeq: replay.nextSeq,
            truncated: replay.truncated,
            replayFrames: replay.frames,
        };
    }

    write(terminalId: string, data: string): void {
        const session = this.requireRunningSession(terminalId);
        session.write(data);
    }

    resize(terminalId: string, cols: number, rows: number): void {
        const session = this.requireRunningSession(terminalId);
        session.resize(cols, rows);
    }

    signal(terminalId: string, signal: string): void {
        if (signal === 'SIGINT') {
            this.requireRunningSession(terminalId).write('\x03');
            return;
        }
        throw new Error(`Unsupported terminal signal: ${signal}`);
    }

    /** Pause/resume the underlying shell when the transport is congested. */
    setTransportPaused(terminalId: string, paused: boolean): void {
        const entry = this.entries.get(terminalId);
        if (!entry?.session || entry.record.status !== 'running') {
            return;
        }
        if (paused) {
            entry.session.pause();
        } else {
            entry.session.resume();
        }
    }

    async close(terminalId: string): Promise<void> {
        const entry = this.entries.get(terminalId);
        if (!entry) {
            throw new Error('Terminal not found');
        }

        if (entry.session) {
            await entry.session.kill().catch(() => undefined);
        }
        entry.record.status = 'closed';
        entry.record.exitCode = entry.record.exitCode ?? 0;
        entry.session = null;
        this.entries.delete(terminalId);

        for (const [approvalId, pendingTerminalId] of this.pendingApprovals) {
            if (pendingTerminalId === terminalId) {
                this.pendingApprovals.delete(approvalId);
            }
        }
        await this.persist();
    }

    /** Stop daemon-owned PTY sessions; tmux sessions intentionally survive. */
    async stop(): Promise<void> {
        await Promise.all(
            Array.from(this.entries.values()).map(async (entry) => {
                if (entry.session && entry.session.kind === 'pty') {
                    await entry.session.kill().catch(() => undefined);
                }
            }),
        );
    }

    private requireRunningSession(terminalId: string): ShellSession {
        const entry = this.entries.get(terminalId);
        if (!entry) {
            throw new Error('Terminal not found');
        }
        if (entry.record.status !== 'running' || !entry.session) {
            throw new Error(`Terminal is not running (status: ${entry.record.status})`);
        }
        return entry.session;
    }

    private async spawnRecord(
        terminalId: string,
        cols: number,
        rows: number,
    ): Promise<TerminalCreateResult> {
        const entry = this.entries.get(terminalId);
        if (!entry) {
            return { type: 'error', errorMessage: 'Terminal not found' };
        }

        try {
            const session = await this.createSession(entry.record, cols, rows);
            this.wireSession(entry.record, session);
            entry.record.status = 'running';
            await this.persist();
            return { type: 'success', terminalId };
        } catch (error) {
            entry.record.status = 'exited';
            entry.record.exitCode = 1;
            await this.persist();
            return {
                type: 'error',
                errorMessage: error instanceof Error ? error.message : String(error),
            };
        }
    }

    private wireSession(record: TerminalRecord, session: ShellSession): void {
        const entry = this.entries.get(record.terminalId);
        if (!entry) {
            return;
        }
        entry.session = session;

        session.onOutput((data) => {
            if (entry.record.status !== 'running') {
                return;
            }
            const seq = entry.ring.push(data);
            this.options.emitOutput(record.terminalId, { seq, kind: 'output', data });
        });

        session.onExit((exitCode) => {
            if (entry.record.status !== 'running') {
                return;
            }
            entry.record.status = 'exited';
            entry.record.exitCode = exitCode;
            entry.session = null;
            this.persist().catch((error) => {
                logger.warn('[TERMINAL] Failed to persist exit state:', error);
            });
            this.options.emitExit(record.terminalId, {
                seq: entry.ring.nextSeq,
                kind: 'exit',
                exitCode,
            });
        });

        session.onError((error) => {
            this.options.emitError(record.terminalId, {
                seq: entry.ring.nextSeq,
                kind: 'error',
                error: error.message,
            });
        });
    }

    private async createSession(
        record: TerminalRecord,
        cols: number,
        rows: number,
    ): Promise<ShellSession> {
        if (this.options.sessionFactory) {
            return this.options.sessionFactory(record, cols, rows);
        }

        const useTmux = this.options.tmuxEnabled && await isTmuxAvailable();
        if (useTmux) {
            const target = `happy-term-${record.terminalId}`;
            record.tmuxTarget = target;
            return TmuxShellSession.create({
                terminalId: record.terminalId,
                cwd: record.cwd,
                shell: record.shell,
                cols,
                rows,
                env: this.options.env,
            });
        }

        return new PtyShellSession({
            cwd: record.cwd,
            shell: record.shell,
            cols,
            rows,
            env: this.options.env,
            scrollback: this.options.scrollback,
        });
    }

    private async loadRegistry(): Promise<TerminalRecord[]> {
        if (!existsSync(this.options.terminalsFile)) {
            return [];
        }
        try {
            const raw = JSON.parse(await readFile(this.options.terminalsFile, 'utf8')) as
                Partial<PersistedTerminalRegistry>;
            if (!Array.isArray(raw.terminals)) {
                return [];
            }
            return raw.terminals.filter((record): record is TerminalRecord =>
                typeof record?.terminalId === 'string'
                && isValidCuid(record.terminalId)
                && typeof record.cwd === 'string'
                && typeof record.shell === 'string');
        } catch (error) {
            logger.warn('[TERMINAL] Failed to read terminal registry, starting empty:',
                error instanceof Error ? error.message : error);
            return [];
        }
    }

    private async persist(): Promise<void> {
        // Serialize writes: concurrent persists would race on the shared
        // `.tmp` path (one rename consumes the file before the other runs).
        this.persistQueue = this.persistQueue.then(() => this.writeRegistry());
        await this.persistQueue;
    }

    private async writeRegistry(): Promise<void> {
        const payload: PersistedTerminalRegistry = {
            version: REGISTRY_VERSION,
            terminals: this.list(),
        };
        const dir = dirname(this.options.terminalsFile);
        if (!existsSync(dir)) {
            await mkdir(dir, { recursive: true });
        }
        const tmp = `${this.options.terminalsFile}.tmp`;
        await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
        await rename(tmp, this.options.terminalsFile);
    }
}
