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
import { dirname, isAbsolute } from 'node:path';
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
    TerminalControlApplyResult,
    TerminalCreateOptions,
    TerminalCreateResult,
    TerminalInputFrame,
    TerminalOutputEvent,
    TerminalRecord,
} from './types';

export interface TerminalManagerOptions {
    terminalsFile: string;
    policyStore: TerminalPolicyStore;
    shell: string;
    emitOutput: (terminalId: string, frame: TerminalOutputEvent) => void;
    emitExit: (terminalId: string, frame: TerminalOutputEvent) => void;
    emitError: (terminalId: string, frame: TerminalOutputEvent) => void;
    env?: NodeJS.ProcessEnv;
    tmuxEnabled?: boolean;
    ringBufferMaxBytes?: number;
    scrollback?: number;
    sessionFactory?: (
        record: TerminalRecord,
        cols: number,
        rows: number,
        mode: 'create-new' | 'attach-existing',
    ) => Promise<ShellSession>;
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
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_NAME_LENGTH = 80;
const MAX_SHELL_LENGTH = 256;
const MIN_DIMENSION = 1;
const MAX_DIMENSION = 1000;

function isValidCuid(value: string): boolean {
    return /^[a-z0-9]{20,32}$/i.test(value);
}

function isValidDimension(value: number): boolean {
    return Number.isSafeInteger(value) && value >= MIN_DIMENSION && value <= MAX_DIMENSION;
}

export class TerminalManager {
    private readonly entries = new Map<string, TerminalEntry>();
    private readonly pendingApprovals = new Map<string, string>();
    private readonly lastProcessedInputSeqByStream = new Map<string, number>();
    /** Daemon generation. Changes on every daemon start; frames from an older
     *  epoch are rejected so a restarted daemon never re-executes stale input. */
    private readonly streamEpoch = createId();
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

    getStreamEpoch(): string {
        return this.streamEpoch;
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
        const recoveredSessions = new Map<string, ShellSession>();
        const kept: TerminalRecord[] = [];
        for (const record of records) {
            if (record.status === 'pending') {
                continue; // Approvals never survive a daemon restart.
            }
            if (record.status === 'running' && record.tmuxTarget) {
                try {
                    const session = await this.attachExistingSession(record, 80, 24);
                    recoveredSessions.set(record.terminalId, session);
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
                session: recoveredSessions.get(record.terminalId) ?? null,
                ring: new OutputRingBuffer(this.options.ringBufferMaxBytes),
            });
        }
        // Wire AFTER entries exist: wireSession resolves the entry by id.
        for (const record of kept) {
            const session = recoveredSessions.get(record.terminalId);
            const entry = this.entries.get(record.terminalId);
            if (session && entry) {
                this.wireSession(record, session);
            }
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
        if (!isAbsolute(cwd)) {
            return { type: 'error', errorMessage: `cwd must be an absolute path: ${cwd}` };
        }
        if (!isValidDimension(options.cols) || !isValidDimension(options.rows)) {
            return {
                type: 'error',
                errorMessage: `cols and rows must be integers between ${MIN_DIMENSION} and ${MAX_DIMENSION}`,
            };
        }
        if (options.name && options.name.trim().length > MAX_NAME_LENGTH) {
            return { type: 'error', errorMessage: `name must be at most ${MAX_NAME_LENGTH} characters` };
        }
        if (options.shell !== undefined
            && (options.shell.trim().length === 0 || options.shell.trim().length > MAX_SHELL_LENGTH)) {
            return { type: 'error', errorMessage: `shell must be between 1 and ${MAX_SHELL_LENGTH} characters` };
        }
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
                streamEpoch: this.streamEpoch,
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
                streamEpoch: this.streamEpoch,
            };
        }

        // Snapshot first: the flush barrier guarantees every frame pushed up
        // to this point is included. Frames arriving afterwards are replayed
        // against the barrier so nothing is duplicated or lost.
        const snapshot = await entry.session.snapshot();
        const barrierSeq = entry.ring.nextSeq - 1;
        const replay = entry.ring.replay(barrierSeq);
        entry.record.lastAttachedAt = Date.now();
        await this.persist();

        return {
            status: 'running',
            snapshot,
            nextSeq: replay.nextSeq,
            truncated: replay.truncated,
            replayFrames: replay.frames,
            streamEpoch: this.streamEpoch,
        };
    }

    write(terminalId: string, data: string): void {
        const session = this.requireRunningSession(terminalId);
        session.write(data);
    }

    /**
     * Unified, idempotent control-frame gate keyed by client stream.
     * Every kind (input/resize/signal) advances the per-stream sequence, so
     * ordering is exact across kinds. Duplicate frames are acked but never
     * executed twice; out-of-order frames are rejected; frames from an older
     * daemon epoch are rejected outright (at-most-once after restarts).
     */
    applyFrame(
        terminalId: string,
        frame: TerminalInputFrame,
    ): TerminalControlApplyResult {
        if (frame.epoch !== this.streamEpoch) {
            return { status: 'invalid', expectedSeq: 1 };
        }
        if (typeof frame.streamId !== 'string'
            || frame.streamId.length === 0
            || frame.streamId.length > 128) {
            return { status: 'invalid', expectedSeq: 1 };
        }
        const key = `${terminalId}:${frame.streamId}`;
        const last = this.lastProcessedInputSeqByStream.get(key) ?? 0;
        const expectedSeq = last + 1;
        if (!Number.isSafeInteger(frame.seq) || frame.seq <= 0) {
            return { status: 'invalid', expectedSeq };
        }
        if (frame.kind === 'input'
            && (typeof frame.data !== 'string'
                || Buffer.byteLength(frame.data, 'utf8') > MAX_INPUT_BYTES)) {
            return { status: 'invalid', expectedSeq };
        }
        if ((frame.kind === 'resize' && (!isValidDimension(frame.cols ?? 0)
            || !isValidDimension(frame.rows ?? 0)))
            || (frame.kind === 'signal'
                && (typeof frame.signal !== 'string' || frame.signal.length === 0))) {
            return { status: 'invalid', expectedSeq };
        }

        if (frame.seq <= last) {
            return { status: 'duplicate', expectedSeq };
        }
        if (frame.seq !== expectedSeq) {
            return { status: 'gap', expectedSeq };
        }

        const session = this.requireRunningSession(terminalId);
        switch (frame.kind) {
            case 'input':
                session.write(frame.data ?? '');
                break;
            case 'resize':
                session.resize(frame.cols ?? 80, frame.rows ?? 24);
                break;
            case 'signal':
                if (frame.signal === 'SIGINT') {
                    session.write('\x03');
                } else {
                    return { status: 'invalid', expectedSeq };
                }
                break;
        }
        this.lastProcessedInputSeqByStream.set(key, frame.seq);
        return { status: 'applied', expectedSeq: frame.seq + 1 };
    }

    resize(terminalId: string, cols: number, rows: number): void {
        if (!isValidDimension(cols) || !isValidDimension(rows)) {
            throw new Error(
                `cols and rows must be integers between ${MIN_DIMENSION} and ${MAX_DIMENSION}`,
            );
        }
        const session = this.requireRunningSession(terminalId);
        session.resize(cols, rows);
    }

    signal(terminalId: string, signal: string): void {
        if (typeof signal !== 'string' || signal.length === 0) {
            throw new Error('signal is required');
        }
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
            const session = await this.createNewSession(entry.record, cols, rows);
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

    private syncTmuxMetadata(record: TerminalRecord, session: ShellSession): void {
        if (session.kind !== 'tmux') {
            return;
        }
        record.tmuxTarget = session.tmuxTarget ?? record.tmuxTarget;
        record.tmuxPaneId = session.paneId ?? record.tmuxPaneId;
    }

    private async createNewSession(
        record: TerminalRecord,
        cols: number,
        rows: number,
    ): Promise<ShellSession> {
        if (this.options.sessionFactory) {
            const session = await this.options.sessionFactory(record, cols, rows, 'create-new');
            this.syncTmuxMetadata(record, session);
            return session;
        }

        const useTmux = this.options.tmuxEnabled && await isTmuxAvailable();
        if (useTmux) {
            const session = await TmuxShellSession.createNew({
                terminalId: record.terminalId,
                cwd: record.cwd,
                shell: record.shell,
                cols,
                rows,
                env: this.options.env,
            });
            this.syncTmuxMetadata(record, session);
            return session;
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

    private async attachExistingSession(
        record: TerminalRecord,
        cols: number,
        rows: number,
    ): Promise<ShellSession> {
        if (this.options.sessionFactory) {
            const session = await this.options.sessionFactory(record, cols, rows, 'attach-existing');
            this.syncTmuxMetadata(record, session);
            return session;
        }
        if (!this.options.tmuxEnabled || !await isTmuxAvailable()) {
            throw new Error('tmux is unavailable for terminal recovery');
        }

        const session = await TmuxShellSession.attachExisting({
            terminalId: record.terminalId,
            cwd: record.cwd,
            shell: record.shell,
            cols,
            rows,
            env: this.options.env,
            paneId: record.tmuxPaneId,
        });
        this.syncTmuxMetadata(record, session);
        return session;
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
        // A failed write must reject its caller without poisoning the tail:
        // later state changes should still be able to retry persistence.
        const payload: PersistedTerminalRegistry = {
            version: REGISTRY_VERSION,
            terminals: this.list(),
        };
        const write = this.persistQueue
            .catch(() => undefined)
            .then(() => this.writeRegistry(payload));
        this.persistQueue = write;
        await write;
    }

    private async writeRegistry(payload: PersistedTerminalRegistry): Promise<void> {
        const dir = dirname(this.options.terminalsFile);
        if (!existsSync(dir)) {
            await mkdir(dir, { recursive: true });
        }
        const tmp = `${this.options.terminalsFile}.tmp`;
        await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
        await rename(tmp, this.options.terminalsFile);
    }
}
