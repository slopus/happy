/**
 * Supervises the daemon's channel host child (Saycode specs/happy-cli-channel-host — T18).
 *
 * The host is `node <@buzzni/saycode-cli>/index.mjs channel-host`, talking NDJSON on its stdio
 * (the contract is `daemon-bridge-protocol.md` in the Desktop repository). This module owns the
 * process: it sends `init` first — on stdin only, because argv and the environment are readable by
 * other processes — turns `ready`/`unavailable` into the `channelHost` advertisement, relays sealed
 * settings calls, answers the host's requests, restarts a crashed child with a backoff, and stops
 * it on request. There is never more than one child: a restart is scheduled only from the previous
 * child's exit.
 *
 * Nothing the host sends or receives is logged. Settings calls are sealed to the host's key and the
 * init carries the daemon's credential, so diagnostics are closed codes only; the child's stderr is
 * drained and dropped.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import type { MachineMetadata } from '@/api/types';
import { scrubSessionLineageEnv } from '@/daemon/sessionEnv';

export const CHANNEL_HOST_PROTOCOL_VERSION = 1;

/**
 * The host's state lives in the happy home (sealed keys and credential; the adapter sandbox denies it).
 * Adapters are public catalog code and must be readable to the sandboxed adapter process, so they go
 * in a sibling of the happy home rather than inside it.
 */
export function channelHostDirectories(happyHomeDir: string): { dataDir: string; extensionsDir: string } {
    const home = happyHomeDir.replace(/[\\/]+$/, '');
    return { dataDir: join(home, 'channel-host'), extensionsDir: `${home}-channel-extensions` };
}

export type ChannelHostAdvertisement = NonNullable<MachineMetadata['channelHost']>;

export interface ChannelHostInit {
    v: typeof CHANNEL_HOST_PROTOCOL_VERSION;
    dataDir: string;
    /** Where the host installs adapters: outside the happy home, which its sandbox denies to adapters. */
    extensionsDir: string;
    machine: {
        id: string;
        platform: string;
        hostname: string;
        homeDir: string;
        /** What the daemon advertises for this machine; the host has no server machine list. */
        capabilities: Record<string, unknown>;
    };
    happyBaseUrl: string;
    /** The daemon's own Happy credential; `secret` only for a legacy account (base64). */
    happy: { token: string; secret: string | null };
}

/** The part of a child process the supervisor uses; `ChildProcess` satisfies it. */
export interface ChannelHostChild {
    stdin: Writable | null;
    stdout: Readable | null;
    stderr: Readable | null;
    kill(signal: NodeJS.Signals): boolean;
    once(event: 'exit', listener: () => void): unknown;
    once(event: 'error', listener: (error: Error) => void): unknown;
}

/** A refusal the host is told as a closed code. Anything else it hears as `DAEMON_FAILED`. */
export class ChannelHostRequestError extends Error {
    constructor(readonly code: string) {
        super(code);
        this.name = 'ChannelHostRequestError';
    }
}

type ChannelHostCallResult = { wire: { sealed: string; error?: string } } | { error: string; code: string };

export interface ChannelHostSupervisor {
    start(): void;
    /** Asks the child to stop, waits for its exit (SIGKILL after the grace), and stops restarting. */
    stop(): Promise<void>;
    /** The `channel-host:call` machine RPC. Never throws. */
    call(params: unknown): Promise<ChannelHostCallResult>;
}

const MIN_NODE: readonly [number, number] = [22, 13];

/**
 * Where the host entry is, or why this daemon cannot run one.
 *
 * Node 22.13 brings the stable permission model the host isolates adapter code with; on an older
 * Node the host could not keep its isolation promise, so the daemon neither starts nor advertises
 * it. A bundled saycode-cli without `channel-extension-host.mjs` predates the host.
 */
export function resolveChannelHostEntry(deps: {
    nodeVersion: string;
    resolveManifest: () => string;
    exists: (path: string) => boolean;
} = {
    nodeVersion: process.versions.node,
    resolveManifest: () => createRequire(import.meta.url).resolve('@buzzni/saycode-cli/package.json'),
    exists: existsSync,
}): { ok: true; entry: string } | { ok: false; code: 'NODE_TOO_OLD' | 'CLI_MISSING' | 'HOST_MISSING' } {
    const [major, minor] = deps.nodeVersion.split('.').map((part) => Number.parseInt(part, 10));
    if (!(major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]))) {
        return { ok: false, code: 'NODE_TOO_OLD' };
    }
    let cliDir: string;
    try {
        cliDir = dirname(deps.resolveManifest());
    } catch {
        return { ok: false, code: 'CLI_MISSING' };
    }
    const entry = join(cliDir, 'index.mjs');
    if (!deps.exists(entry)) return { ok: false, code: 'CLI_MISSING' };
    if (!deps.exists(join(cliDir, 'channel-extension-host.mjs'))) return { ok: false, code: 'HOST_MISSING' };
    return { ok: true, entry };
}

/**
 * Starts `node <entry> channel-host` with three pipes. Nothing secret goes in argv or the
 * environment — the credential travels in `init` on stdin — and session lineage the daemon may have
 * inherited is scrubbed like for any other child.
 */
export function spawnChannelHostChild(entry: string, cwd: string): ChannelHostChild {
    return spawn(process.execPath, ['--no-warnings', '--no-deprecation', entry, 'channel-host'], {
        cwd,
        env: scrubSessionLineageEnv(process.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
    });
}

const UNAVAILABLE_REASONS = new Set(['CUSTODY_UNAVAILABLE', 'NODE_TOO_OLD', 'LOCK_HELD', 'INIT_INVALID']);

/** A child that exits after one of these would say the same again: restarting it only churns processes. */
const PERMANENT_UNAVAILABLE_REASONS = new Set(['NODE_TOO_OLD', 'INIT_INVALID']);

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

/**
 * A host that cannot open a call answers `{sealed: '', error}` in plaintext. Only a closed code is
 * carried on; anything else in `error` is dropped rather than relayed.
 */
function readSealedWire(value: unknown): { sealed: string; error?: string } | null {
    if (!value || typeof value !== 'object') return null;
    const { sealed, error } = value as { sealed?: unknown; error?: unknown };
    if (typeof sealed !== 'string') return null;
    return typeof error === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error) ? { sealed, error } : { sealed };
}

function readAdvertisement(message: Record<string, unknown>): ChannelHostAdvertisement | null {
    const { hostKey, fingerprint, custody, isolation, providers } = message;
    if (!isNonEmptyString(hostKey) || !isNonEmptyString(fingerprint)) return null;
    if (custody !== 'available') return null;
    if (isolation !== 'available' && isolation !== 'unavailable') return null;
    if (!Array.isArray(providers) || !providers.every((provider) => typeof provider === 'string')) return null;
    return { protocolVersion: CHANNEL_HOST_PROTOCOL_VERSION, custody, isolation, providers: [...providers], hostKey, fingerprint };
}

const closed = (code: string) => ({ error: code, code });

export function createChannelHostSupervisor(deps: {
    spawnChild: () => ChannelHostChild;
    buildInit: () => ChannelHostInit;
    onAdvertisement: (advertisement: ChannelHostAdvertisement | undefined) => void;
    handleRequest: (method: string, params: unknown) => Promise<unknown>;
    /** Closed codes only. */
    log: (code: string) => void;
    restartDelayMs?: { initial: number; max: number };
    /** Retry delay for a child that exited without custody — a keychain can be unlocked later. */
    custodyRetryMs?: number;
    stopGraceMs?: number;
    settingsTimeoutMs?: number;
}): ChannelHostSupervisor {
    const restartDelay = deps.restartDelayMs ?? { initial: 1_000, max: 60_000 };
    const custodyRetryMs = deps.custodyRetryMs ?? 3_600_000;
    const stopGraceMs = deps.stopGraceMs ?? 10_000;
    const settingsTimeoutMs = deps.settingsTimeoutMs ?? 30_000;

    type Running = {
        child: ChannelHostChild;
        startedAt: number;
        ready: boolean;
        unavailableReason: string | null;
        exited: Promise<void>;
        pending: Map<string, (result: ChannelHostCallResult) => void>;
    };

    let running: Running | null = null;
    let stopped = true;
    let restartTimer: NodeJS.Timeout | null = null;
    let nextDelay = restartDelay.initial;
    let sequence = 0;

    const write = (target: Running, message: Record<string, unknown>) => {
        // Only ever to the child that is still current: a reply meant for a dead child must not
        // reach its replacement.
        if (running !== target) return;
        target.child.stdin?.write(`${JSON.stringify(message)}\n`);
    };

    const setReady = (target: Running, advertisement: ChannelHostAdvertisement | undefined) => {
        target.ready = advertisement !== undefined;
        deps.onAdvertisement(advertisement);
    };

    const answerRequest = async (target: Running, id: string, method: unknown, params: unknown) => {
        try {
            if (typeof method !== 'string') throw new ChannelHostRequestError('METHOD_UNKNOWN');
            const value = await deps.handleRequest(method, params);
            write(target, { t: 'reply', id, ok: true, value });
        } catch (error) {
            const code = error instanceof ChannelHostRequestError ? error.code : 'DAEMON_FAILED';
            deps.log(`request-refused:${code}`);
            write(target, { t: 'reply', id, ok: false, code });
        }
    };

    const onLine = (target: Running, line: string) => {
        let message: Record<string, unknown>;
        try {
            const parsed: unknown = JSON.parse(line);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
            message = parsed as Record<string, unknown>;
        } catch {
            deps.log('line-invalid');
            return;
        }
        if (running !== target) return;
        if (message.t === 'ready') {
            const advertisement = readAdvertisement(message);
            if (!advertisement) {
                deps.log('ready-invalid');
                return;
            }
            deps.log('ready');
            setReady(target, advertisement);
        } else if (message.t === 'unavailable') {
            const reason = UNAVAILABLE_REASONS.has(message.reason as string) ? message.reason as string : 'UNKNOWN';
            deps.log(`unavailable:${reason}`);
            target.unavailableReason = reason;
            setReady(target, undefined);
        } else if (message.t === 'settings-result' && isNonEmptyString(message.id)) {
            const resolve = target.pending.get(message.id);
            if (!resolve) return;
            target.pending.delete(message.id);
            const wire = readSealedWire(message.wire);
            resolve(wire ? { wire } : closed('CHANNEL_HOST_INVALID_RESULT'));
        } else if (message.t === 'request' && isNonEmptyString(message.id)) {
            void answerRequest(target, message.id, message.method, message.params);
        }
    };

    const scheduleRestart = (unavailableReason: string | null = null) => {
        if (stopped || restartTimer) return;
        let delay: number;
        if (unavailableReason === 'CUSTODY_UNAVAILABLE') {
            // Not a crash: the crash backoff stays where it was.
            delay = custodyRetryMs;
            deps.log(`restart-scheduled:${unavailableReason}`);
        } else {
            delay = nextDelay;
            nextDelay = Math.min(nextDelay * 2, restartDelay.max);
            deps.log('restart-scheduled');
        }
        restartTimer = setTimeout(() => {
            restartTimer = null;
            launch();
        }, delay);
        restartTimer.unref?.();
    };

    const launch = () => {
        if (stopped || running) return;
        let child: ChannelHostChild;
        try {
            child = deps.spawnChild();
        } catch {
            deps.log('spawn-failed');
            scheduleRestart();
            return;
        }
        let markExited!: () => void;
        const target: Running = {
            child,
            startedAt: Date.now(),
            ready: false,
            unavailableReason: null,
            exited: new Promise<void>((resolve) => { markExited = resolve; }),
            pending: new Map(),
        };
        running = target;
        deps.log('started');

        let exitHandled = false;
        const onExit = () => {
            if (exitHandled) return;
            exitHandled = true;
            deps.log('exited');
            if (running === target) {
                running = null;
                if (target.ready) setReady(target, undefined);
                for (const resolve of target.pending.values()) resolve(closed('CHANNEL_HOST_UNAVAILABLE'));
                target.pending.clear();
                // A child that ran a whole backoff ceiling was healthy; its crash starts over.
                if (Date.now() - target.startedAt >= restartDelay.max) nextDelay = restartDelay.initial;
                if (target.unavailableReason && PERMANENT_UNAVAILABLE_REASONS.has(target.unavailableReason)) {
                    deps.log(`restart-abandoned:${target.unavailableReason}`);
                } else {
                    scheduleRestart(target.unavailableReason);
                }
            }
            markExited();
        };
        child.once('exit', onExit);
        child.once('error', () => {
            deps.log('child-error');
            onExit();
        });
        child.stdin?.on('error', () => undefined);
        child.stderr?.resume();
        if (child.stdout) {
            createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => onLine(target, line));
        }
        write(target, { t: 'init', init: deps.buildInit() });
    };

    return {
        start() {
            if (!stopped) return;
            stopped = false;
            launch();
        },

        async stop() {
            stopped = true;
            if (restartTimer) {
                clearTimeout(restartTimer);
                restartTimer = null;
            }
            const target = running;
            if (!target) return;
            if (target.ready) setReady(target, undefined);
            write(target, { t: 'stop' });
            let graceTimer: NodeJS.Timeout | null = null;
            const graceOver = new Promise<'grace-over'>((resolve) => {
                graceTimer = setTimeout(() => resolve('grace-over'), stopGraceMs);
            });
            const outcome = await Promise.race([target.exited.then(() => 'exited' as const), graceOver]);
            if (graceTimer) clearTimeout(graceTimer);
            if (outcome === 'grace-over') {
                deps.log('stop-killed');
                target.child.kill('SIGKILL');
                await target.exited;
            }
        },

        async call(params) {
            const wire = readSealedWire((params as { wire?: unknown } | null)?.wire);
            const target = running;
            if (!target || !target.ready) return closed('CHANNEL_HOST_UNAVAILABLE');
            if (!wire) return closed('CHANNEL_HOST_INVALID_PARAMS');
            const id = `d${(sequence += 1)}`;
            return new Promise<ChannelHostCallResult>((resolve) => {
                const timer = setTimeout(() => {
                    target.pending.delete(id);
                    resolve(closed('CHANNEL_HOST_TIMEOUT'));
                }, settingsTimeoutMs);
                timer.unref?.();
                target.pending.set(id, (result) => {
                    clearTimeout(timer);
                    resolve(result);
                });
                write(target, { t: 'settings', id, wire });
            });
        },
    };
}
