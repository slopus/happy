/**
 * Entry point for Kimi Code sessions.
 *
 * Mirrors the Claude integration's dual-mode design (see claude/loop.ts):
 *
 *   local  — Kimi's own TUI owns the terminal; Happy tails the session
 *            transcript and mirrors the conversation to the phone.
 *   remote — the phone drives the session over ACP (`kimi acp`).
 *
 * Both modes act on the *same* Kimi session: the TUI and the ACP server share
 * `~/.kimi-code/sessions`, so switching modes resumes the conversation rather
 * than starting a new one. The Happy session is likewise reused across the
 * switch by passing a stable session tag to `runAcp`.
 *
 * A message typed on the phone hands control to remote mode; the ACP runner
 * returning 'switch' hands it back to the terminal.
 */

import { randomUUID } from 'node:crypto';
import { ApiClient } from '@/api/api';
import { runAcp } from '@/agent/acp';
import { Credentials, readSettings } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/run';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { encodeBase64 } from '@/api/encryption';
import { connectionState } from '@/utils/serverConnectionErrors';
import { logger } from '@/ui/logger';
import { delay } from '@/utils/time';
import { kimiLocal, KimiExitCodeError } from './kimiLocal';
import { createKimiSessionScanner, type KimiSessionScanner } from './kimiSessionScanner';
import { createKimiWireState } from './kimiWireMapper';
import { findNewKimiSession, kimiWirePath, readKimiSessionIndex } from './kimiSessionStore';

/** How long to wait for a freshly spawned Kimi to register its session. */
const SESSION_DISCOVERY_TIMEOUT_MS = 30_000;
const SESSION_DISCOVERY_POLL_MS = 250;

type LocalResult =
    | { type: 'exit'; code: number }
    | { type: 'switch'; prompt: string };

/**
 * Wait for the Kimi process to register a session for `workDir` that was not
 * present before it started. Returns null if none appears in time (the mirror
 * is then skipped, but the TUI still works).
 */
async function discoverKimiSession(
    workDir: string,
    knownSessionIds: ReadonlySet<string>,
    abort: AbortSignal,
): Promise<{ sessionId: string; sessionDir: string } | null> {
    const deadline = Date.now() + SESSION_DISCOVERY_TIMEOUT_MS;
    while (Date.now() < deadline && !abort.aborted) {
        const found = await findNewKimiSession(workDir, knownSessionIds);
        if (found) {
            logger.debug(`[kimi] Discovered session ${found.sessionId}`);
            return { sessionId: found.sessionId, sessionDir: found.sessionDir };
        }
        await delay(SESSION_DISCOVERY_POLL_MS);
    }
    logger.debug('[kimi] Timed out waiting for Kimi to register a session');
    return null;
}

export async function runKimi(opts: {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
    verbose?: boolean;
    /** Extra flags forwarded to the kimi binary in local mode. */
    extraArgs?: string[];
    /** Start on the phone instead of the terminal (used by daemon spawns). */
    startingMode?: 'local' | 'remote';
}): Promise<number> {
    connectionState.setBackend('kimi');

    const api = await ApiClient.create(opts.credentials);
    const settings = await readSettings();
    if (!settings?.machineId) {
        throw new Error('No machine ID found in settings');
    }

    await api.getOrCreateMachine({
        machineId: settings.machineId,
        metadata: initialMachineMetadata,
    });

    const sessionTag = randomUUID();
    const { state, metadata } = createSessionMetadata({
        flavor: 'kimi',
        machineId: settings.machineId,
        startedBy: opts.startedBy,
        sandbox: settings.sandboxConfig,
    });
    const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
    if (response) {
        console.log(`Happy Session ID: ${response.id}`);
        try {
            await notifyDaemonSessionStarted(response.id, metadata, {
                encryptionKey: encodeBase64(response.encryptionKey),
                encryptionVariant: response.encryptionVariant,
                seq: response.seq,
                metadataVersion: response.metadataVersion,
                agentStateVersion: response.agentStateVersion,
            });
        } catch (error) {
            logger.debug('[kimi] Failed to report session to daemon:', error);
        }
    }

    /** Kimi-side session id, shared by both modes once discovered. */
    let kimiSessionId: string | null = null;
    let mode: 'local' | 'remote' = opts.startingMode ?? 'local';
    /** Message typed on the phone that caused the switch, replayed in remote mode. */
    let pendingPrompt: string | null = null;

    while (true) {
        if (mode === 'remote') {
            const result = await runAcp({
                credentials: opts.credentials,
                agentName: 'kimi',
                command: 'kimi',
                args: ['acp'],
                startedBy: opts.startedBy,
                verbose: opts.verbose,
                sessionTag,
                loadSessionId: kimiSessionId ?? undefined,
                allowSwitchToLocal: true,
                initialPrompt: pendingPrompt ?? undefined,
            });
            pendingPrompt = null;
            if (result === 'exit') {
                return 0;
            }
            mode = 'local';
            continue;
        }

        const local = await runLocalMode({
            api,
            sessionTag,
            metadata,
            state,
            response,
            resumeSessionId: kimiSessionId,
            extraArgs: opts.extraArgs,
            onSessionDiscovered: (id) => { kimiSessionId = id; },
        });

        if (local.type === 'exit') {
            return local.code;
        }
        pendingPrompt = local.prompt;
        mode = 'remote';
    }
}

async function runLocalMode(opts: {
    api: ApiClient;
    sessionTag: string;
    metadata: ReturnType<typeof createSessionMetadata>['metadata'];
    state: ReturnType<typeof createSessionMetadata>['state'];
    response: Awaited<ReturnType<ApiClient['getOrCreateSession']>>;
    resumeSessionId: string | null;
    extraArgs?: string[];
    onSessionDiscovered: (sessionId: string) => void;
}): Promise<LocalResult> {
    const workDir = process.cwd();

    const { session, reconnectionHandle } = setupOfflineReconnection({
        api: opts.api,
        sessionTag: opts.sessionTag,
        metadata: opts.metadata,
        state: opts.state,
        response: opts.response,
        onSessionSwap: () => { /* local mode holds no per-session handlers */ },
    });

    const abortController = new AbortController();
    let switchPrompt: string | null = null;

    // A message from the phone means the user wants to drive the session
    // remotely: stop the local TUI so remote mode can pick it up.
    session.onUserMessage((message) => {
        if (!message.content.text || switchPrompt !== null) {
            return;
        }
        switchPrompt = message.content.text;
        logger.debug('[kimi] Phone message received, switching to remote mode');
        abortController.abort();
    });
    session.rpcHandlerManager.registerHandler('switch', async () => {
        switchPrompt = switchPrompt ?? '';
        abortController.abort();
    });

    session.keepAlive(false, 'local');
    const keepAliveInterval = setInterval(() => {
        session.keepAlive(false, 'local');
    }, 2000);

    // Snapshot existing sessions so the one Kimi is about to create is identifiable.
    const knownSessionIds = new Set(
        (await readKimiSessionIndex()).map((entry) => entry.sessionId),
    );

    const wireState = createKimiWireState();
    const startScanner = (sessionDir: string, startAtEnd: boolean): KimiSessionScanner =>
        createKimiSessionScanner({
            wireFile: kimiWirePath(sessionDir),
            onEnvelopes: (envelopes) => {
                for (const envelope of envelopes) {
                    session.sendSessionProtocolMessage(envelope);
                }
            },
            startAtEnd,
            state: wireState,
        });

    // Discovery runs alongside the TUI: the session only lands in the index
    // once Kimi has started up.
    const mirrorReady: Promise<KimiSessionScanner | null> = (async () => {
        if (opts.resumeSessionId) {
            const entries = await readKimiSessionIndex();
            const resumed = entries.find((entry) => entry.sessionId === opts.resumeSessionId);
            // History already reached the phone before the switch.
            if (resumed) {
                return startScanner(resumed.sessionDir, true);
            }
        }

        const discovered = await discoverKimiSession(workDir, knownSessionIds, abortController.signal);
        if (!discovered) {
            return null;
        }
        opts.onSessionDiscovered(discovered.sessionId);
        return startScanner(discovered.sessionDir, false);
    })();

    try {
        await kimiLocal({
            abort: abortController.signal,
            path: workDir,
            resumeSessionId: opts.resumeSessionId,
            extraArgs: opts.extraArgs,
        });

        const scanner = await mirrorReady;
        await scanner?.stop(switchPrompt !== null ? 'cancelled' : 'completed');

        if (switchPrompt !== null) {
            return { type: 'switch', prompt: switchPrompt };
        }
        return { type: 'exit', code: 0 };
    } catch (error) {
        const scanner = await mirrorReady.catch(() => null);
        await scanner?.stop('failed');

        if (switchPrompt !== null) {
            return { type: 'switch', prompt: switchPrompt };
        }
        if (error instanceof KimiExitCodeError) {
            return { type: 'exit', code: error.exitCode };
        }
        throw error;
    } finally {
        clearInterval(keepAliveInterval);
        reconnectionHandle?.cancel();
        await session.flush();
        // Remote mode re-attaches to this same Happy session by tag, so the
        // socket is closed without announcing the session's death.
        await session.close();
    }
}
