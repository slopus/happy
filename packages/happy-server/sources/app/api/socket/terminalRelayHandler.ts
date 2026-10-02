/**
 * Server-side relay for the remote terminal feature
 * (specs/remote-terminal/ Phase 2). Forwards opaque, end-to-end-encrypted
 * frames between the client (web-ui xterm panel) and the daemon (PTY on
 * the user's machine). The server never sees plaintext stdin/stdout — the
 * `data` field of every frame is encrypted at the originating endpoint
 * with the user's existing rpc-call secret key.
 *
 * Wire shape:
 *   client → server: 'terminal-open'   { machineId, params }, ack
 *   server → daemon: 'terminal-open-fwd' { sessionId, params }, ack
 *   client → server: 'terminal-frame'  { sessionId, data }
 *   client → server: 'terminal-resize' { sessionId, cols, rows }
 *   client → server: 'terminal-close'  { sessionId }
 *   daemon → server: 'terminal-frame'  { sessionId, data }
 *   daemon → server: 'terminal-closed' { sessionId, code, signal }
 *
 * The same handler is registered on every socket; direction is inferred
 * from whether the originating socket's id matches `clientSocketId` or
 * `daemonSocketId` of the resolved session. Both endpoints may live on
 * different replicas, so routing goes through `io.to(socketId)` and the
 * session registry is shared — see specs/relay-cross-replica-routing.
 *
 * ACL: terminal-open succeeds only if the caller's userId already has a
 * machine-scoped daemon socket connected for the requested machineId.
 * This is the same trust boundary as today's rpc-call routing — a
 * different user's terminal request lands at "Machine not connected for
 * this user" and never reaches the daemon.
 */

import { Socket } from 'socket.io';
import { eventRouter } from '@/app/events/eventRouter';
import {
    findMachineSockets as findMachineSocketsCrossReplica,
    newestMachineSocket,
} from '@/app/events/findMachineSockets';
import { log } from '@/utils/log';
import { randomUUID } from 'node:crypto';
import {
    addTerminalSession,
    getTerminalSession,
    rebindTerminalSessionSocket,
    removeTerminalSession,
    findTerminalSessionsBySocketId,
    countActiveSessionsForUser,
    MAX_TERMINALS_PER_USER,
    type TerminalSession,
} from './terminalSessions';

const TERMINAL_OPEN_TIMEOUT_MS = 10_000;

/**
 * How long a session outlives the client socket that opened it.
 *
 * The desktop terminal socket reconnects on purpose (so a blip does not kill
 * the panel), and a reconnect arrives as a *different* socket id. Tearing the
 * session down the moment the old id drops left nothing for the returning
 * client to re-claim. The window is short because the PTY keeps running on the
 * user's machine for its whole length: long enough for a reconnect, not long
 * enough to hoard shells for a client that is gone for good.
 */
export const CLIENT_REATTACH_GRACE_MS = 30_000;

/**
 * Pending grace timers, keyed by session id. Process-local: the replica that
 * owned the client socket is the one that saw it drop, and is the only one that
 * needs to act. A replica lost mid-window leaves the record to the store's own
 * TTL rather than to a cross-replica timer we would then have to keep correct.
 */
const reattachTimers = new Map<string, NodeJS.Timeout>();

/**
 * Session cleanup runs where nothing is waiting for it: a socket.io listener
 * whose returned promise is dropped, and a timer callback. Since Redis
 * commands gained a deadline these paths can reject, and an unhandled
 * rejection ends in process.exit(1) (main.ts) — the terminal record is left
 * to the store's own TTL instead.
 */
function reportCleanupFailure(error: unknown): void {
    log({ module: 'terminal-relay', level: 'error' },
        `[REMOTE-TERMINAL] session cleanup failed, leaving the record to its TTL: ${error}`);
}

function cancelReattachTimer(sessionId: string): void {
    const timer = reattachTimers.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    reattachTimers.delete(sessionId);
}

/**
 * Which side of the session this socket is, judged by who the socket *is*
 * rather than by an id captured when the session opened.
 *
 * The daemon side is a machine-scoped socket for this session's machine; the
 * client side is any socket authenticated as the session's own user. Both
 * checks read `socket.data`, which is stamped from the verified handshake, so
 * a socket belonging to a different user still matches neither — the
 * confused-deputy boundary the frozen ids were protecting is unchanged.
 */
function terminalSideOf(session: TerminalSession, socket: Socket, userId: string): 'client' | 'daemon' | null {
    if (socket.data?.clientType === 'machine-scoped') {
        return socket.data?.machineId === session.machineId ? 'daemon' : null;
    }
    return session.userId === userId ? 'client' : null;
}

/**
 * Resolves the session and this socket's side, re-pointing that side at the
 * current socket when the id has moved. Returns null when the socket has no
 * business with this session.
 */
async function resolveTerminalSide(
    sessionId: unknown,
    socket: Socket,
    userId: string,
): Promise<{ session: TerminalSession; side: 'client' | 'daemon' } | null> {
    const found = await getTerminalSession(typeof sessionId === 'string' ? sessionId : null);
    if (!found) return null;
    const side = terminalSideOf(found, socket, userId);
    if (!side) return null;
    const bound = side === 'client' ? found.clientSocketId : found.daemonSocketId;
    if (bound === socket.id) return { session: found, side };
    const session = await rebindTerminalSessionSocket(found.id, side, socket.id);
    if (!session) return null;
    // A client that comes back within the window keeps its terminal.
    if (side === 'client') cancelReattachTimer(session.id);
    log({ module: 'terminal-relay' }, `[REMOTE-TERMINAL] rebind session=${session.id} side=${side} ${bound} -> ${socket.id}`);
    return { session, side };
}

/**
 * Every socket is auto-joined to a room named after its own id, so addressing
 * a room by socket id reaches that socket on whichever replica owns it
 * (specs/relay-cross-replica-routing). Replaces holding a Socket object,
 * which only works when both endpoints are on the same process.
 */
function emitToSocket(socketId: string, event: string, payload: unknown): void {
    eventRouter.server.to(socketId).emit(event, payload);
}

// Resolves the daemon socket across replicas via the machine room, then picks
// the newest one (see newestMachineSocket for why "newest" matters).
//
// previewRoutes.ts hits the same reconnect race but answers it differently: it
// fans out to every live socket and takes the first response (Promise.any).
// That is safe for an idempotent HTTP proxy hop; terminal-open spawns a PTY,
// so fanning out would leak duplicate shells. Pick one socket here.
async function findMachineSocket(userId: string, machineId: string) {
    const { sockets, degraded } = await findMachineSocketsCrossReplica(
        eventRouter.server,
        userId,
        machineId,
    );
    return { socket: newestMachineSocket(sockets), degraded };
}

export function terminalRelayHandler(userId: string, socket: Socket): void {
    socket.on('terminal-open', async (data: any, ack?: (response: any) => void) => {
        const reply = (resp: any) => { if (typeof ack === 'function') ack(resp); };
        try {
            const machineId = data?.machineId;
            if (!machineId || typeof machineId !== 'string') {
                reply({ ok: false, error: 'machineId is required' });
                return;
            }

            if (await countActiveSessionsForUser(userId) >= MAX_TERMINALS_PER_USER) {
                reply({ ok: false, error: 'Too many active terminals' });
                return;
            }

            const { socket: daemonSocket, degraded } = await findMachineSocket(userId, machineId);
            if (!daemonSocket) {
                // `degraded` means the cross-replica lookup itself failed, so we
                // do not know whether the daemon is there. Same user-facing
                // error, distinct log line — conflating the two is what made the
                // 2026-08-07 cluster-bus outage read as mass daemon disconnects.
                if (degraded) {
                    log({ module: 'terminal-relay', level: 'error' },
                        `terminal-open lookup degraded user=${userId} machine=${machineId} — cluster bus did not answer`);
                }
                reply({ ok: false, error: 'Machine not connected for this user' });
                return;
            }

            const sessionId = randomUUID();
            // Registered before the daemon is asked: it spawns the PTY and the shell prints its prompt at
            // once, often before its ack reaches this replica. On the daemon's replica that frame must already
            // find the session (shared through Redis), or it is dropped and a web terminal stays blank.
            await addTerminalSession({
                id: sessionId,
                userId,
                machineId,
                clientSocketId: socket.id,
                daemonSocketId: daemonSocket.id,
                createdAt: Date.now(),
            });
            let daemonAck: unknown;
            try {
                daemonAck = await daemonSocket
                    .timeout(TERMINAL_OPEN_TIMEOUT_MS)
                    .emitWithAck('terminal-open-fwd', {
                        sessionId,
                        params: data?.params ?? null,
                    });
            } catch (err) {
                await removeTerminalSession(sessionId);
                log({ module: 'terminal-relay', level: 'error' }, `terminal-open-fwd timeout: ${(err as Error).message}`);
                reply({ ok: false, error: 'Daemon did not acknowledge terminal-open in time' });
                return;
            }

            const ackResp = daemonAck as { ok?: boolean; error?: string; caps?: unknown } | null | undefined;
            if (!ackResp || ackResp.ok !== true) {
                await removeTerminalSession(sessionId);
                reply({ ok: false, error: ackResp?.error ?? 'Daemon failed to open terminal' });
                return;
            }
            log({ module: 'terminal-relay' }, `[REMOTE-TERMINAL] open user=${userId} machine=${machineId} session=${sessionId}`);
            /*
             * specs/desktop-terminal-reliability/ Phase 3 — capability
             * negotiation. The relay does not decide what is supported; it
             * carries whatever the daemon claims. An older daemon sends no
             * `caps` and the client stays in legacy mode, which is exactly the
             * graceful degradation the client was built for.
             */
            reply({ ok: true, sessionId, ...(ackResp.caps ? { caps: ackResp.caps } : {}) });
        } catch (e) {
            log({ module: 'terminal-relay', level: 'error' }, `terminal-open error: ${(e as Error).message}`);
            reply({ ok: false, error: 'Internal error' });
        }
    });

    socket.on('terminal-frame', async (data: any) => {
        // Direction is inferred from the source socket, and the session's view
        // of that side is corrected when the id has moved. Frames from a socket
        // that is neither side are dropped — the confused-deputy defence that
        // matters (a *different user* guessing a sessionId) lives in
        // terminalSideOf, which reads the verified handshake.
        const resolved = await resolveTerminalSide(data?.sessionId, socket, userId);
        if (!resolved) return;
        const { session, side } = resolved;
        if (side === 'client') {
            emitToSocket(session.daemonSocketId, 'terminal-frame-fwd', {
                sessionId: session.id,
                data: data?.data,
            });
        } else {
            // `seq` is the daemon's; the relay neither assigns nor validates it.
            emitToSocket(session.clientSocketId, 'terminal-frame', {
                sessionId: session.id,
                seq: data?.seq,
                data: data?.data,
            });
        }
    });

    /*
     * specs/desktop-terminal-reliability/ Phase 3 — client → daemon.
     *
     * The client noticed a gap in `seq` (or just reconnected) and wants
     * everything after the last frame it actually saw. The relay carries the
     * ask; the daemon owns the buffer and decides between replay, snapshot and
     * "there is a hole here".
     */
    socket.on('terminal-resume', async (data: any) => {
        const resolved = await resolveTerminalSide(data?.sessionId, socket, userId);
        if (!resolved || resolved.side !== 'client') return;
        const afterSeq = Number(data?.afterSeq);
        if (!Number.isFinite(afterSeq) || afterSeq < 0) return;
        emitToSocket(resolved.session.daemonSocketId, 'terminal-resume-fwd', {
            sessionId: resolved.session.id,
            afterSeq: Math.trunc(afterSeq),
        });
    });

    /*
     * daemon → client. Both are answers to a resume, and both are routed the
     * same way ordinary output is — the relay reads neither.
     */
    socket.on('terminal-snapshot', async (data: any) => {
        const resolved = await resolveTerminalSide(data?.sessionId, socket, userId);
        if (!resolved || resolved.side !== 'daemon') return;
        emitToSocket(resolved.session.clientSocketId, 'terminal-snapshot', {
            sessionId: resolved.session.id,
            seq: data?.seq,
            data: data?.data,
        });
    });

    socket.on('terminal-frame-gap', async (data: any) => {
        const resolved = await resolveTerminalSide(data?.sessionId, socket, userId);
        if (!resolved || resolved.side !== 'daemon') return;
        emitToSocket(resolved.session.clientSocketId, 'terminal-frame-gap', {
            sessionId: resolved.session.id,
            fromSeq: data?.fromSeq,
        });
    });

    socket.on('terminal-resize', async (data: any) => {
        const resolved = await resolveTerminalSide(data?.sessionId, socket, userId);
        if (!resolved || resolved.side !== 'client') return;
        const cols = Number(data?.cols);
        const rows = Number(data?.rows);
        if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return;
        emitToSocket(resolved.session.daemonSocketId, 'terminal-resize-fwd', {
            sessionId: resolved.session.id,
            cols,
            rows,
        });
    });

    socket.on('terminal-close', async (data: any) => {
        const resolved = await resolveTerminalSide(data?.sessionId, socket, userId);
        if (!resolved) return;
        const { session, side } = resolved;
        if (side === 'client') {
            emitToSocket(session.daemonSocketId, 'terminal-close-fwd', { sessionId: session.id });
        }
        cancelReattachTimer(session.id);
        await removeTerminalSession(session.id);
        log({ module: 'terminal-relay' }, `[REMOTE-TERMINAL] close session=${session.id} (explicit)`);
    });

    socket.on('terminal-closed', async (data: any) => {
        // Daemon-originated close (PTY exited).
        const resolved = await resolveTerminalSide(data?.sessionId, socket, userId);
        if (!resolved || resolved.side !== 'daemon') return;
        const { session } = resolved;
        emitToSocket(session.clientSocketId, 'terminal-closed', {
            sessionId: session.id,
            code: data?.code,
            signal: data?.signal,
        });
        cancelReattachTimer(session.id);
        await removeTerminalSession(session.id);
        log({ module: 'terminal-relay' }, `[REMOTE-TERMINAL] close session=${session.id} exit=${data?.code} signal=${data?.signal}`);
    });

    const cleanUpAfterDisconnect = async () => {
        const sessions = await findTerminalSessionsBySocketId(socket.id);
        if (sessions.length === 0) return;
        for (const session of sessions) {
            /*
             * A superseded socket must not close a session that has already
             * moved on. After a rebind the old id still sits in this replica's
             * reverse index, and its late `disconnect` would otherwise tear
             * down the live terminal it was replaced by.
             */
            if (socket.id !== session.clientSocketId && socket.id !== session.daemonSocketId) continue;

            if (socket.id === session.daemonSocketId) {
                /*
                 * The daemon kills every local PTY when its own socket drops
                 * (apiMachine.ts, specs/remote-terminal/ Phase 2), so by the
                 * time we get here the shell is already gone. Nothing to hold
                 * open — say so and clear the record.
                 */
                try {
                    emitToSocket(session.clientSocketId, 'terminal-closed', {
                        sessionId: session.id,
                        code: -1,
                        signal: null,
                        reason: 'daemon-disconnected',
                    });
                } catch {
                    /* ignore — counterpart socket may also be tearing down */
                }
                cancelReattachTimer(session.id);
                await removeTerminalSession(session.id);
                log({ module: 'terminal-relay' }, `[REMOTE-TERMINAL] close session=${session.id} (daemon disconnect)`);
                continue;
            }

            /*
             * Client side. The PTY is still running, and the desktop socket
             * reconnects by design — give it a window to come back and re-claim
             * the session (any frame from the returning socket rebinds it) before
             * telling the daemon to close the shell.
             */
            cancelReattachTimer(session.id);
            const timer = setTimeout(() => {
                reattachTimers.delete(session.id);
                void (async () => {
                    const current = await getTerminalSession(session.id);
                    // Re-read, because "still bound to the socket that left" is
                    // the only thing that means nobody came back.
                    if (!current || current.clientSocketId !== socket.id) return;
                    try {
                        emitToSocket(current.daemonSocketId, 'terminal-close-fwd', { sessionId: current.id });
                    } catch {
                        /* ignore — counterpart socket may also be tearing down */
                    }
                    await removeTerminalSession(current.id);
                    log({ module: 'terminal-relay' }, `[REMOTE-TERMINAL] close session=${current.id} (client did not return)`);
                })().catch(reportCleanupFailure);
            }, CLIENT_REATTACH_GRACE_MS);
            // Never hold the process open for a terminal nobody is watching.
            timer.unref?.();
            reattachTimers.set(session.id, timer);
            log({ module: 'terminal-relay' }, `[REMOTE-TERMINAL] client detached session=${session.id} — ${CLIENT_REATTACH_GRACE_MS}ms to re-attach`);
        }
    };
    socket.on('disconnect', () => {
        // socket.io drops whatever a listener returns, and main.ts ends an
        // unhandled rejection in process.exit(1). These lookups now reach
        // Redis with a command deadline, so one that fails while a client
        // disconnects must not take the replica down. Still returned, for
        // callers that do await the handler.
        const cleanup = cleanUpAfterDisconnect();
        cleanup.catch(reportCleanupFailure);
        return cleanup;
    });
}
