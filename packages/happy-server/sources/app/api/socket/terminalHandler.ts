/**
 * Terminal streaming relay for remote shells.
 *
 * Control-plane terminal operations (create/approve/attach/list/close) use the
 * existing machine-scoped `rpc-call` transport. This handler adds the
 * streaming plane:
 *
 * - daemon sockets (machine-scoped) register terminal rooms and push
 *   encrypted output/exit/input-ack frames;
 * - user sockets (user-scoped) subscribe to terminal rooms, request the
 *   single writer seat, and send encrypted input/resize/signal frames;
 * - the server relays opaque, already-encrypted payloads — it never sees
 *   terminal content.
 *
 * Room layout (all scoped by the authenticated userId):
 *   terminal:clients:<userId>:<terminalId>  — user sockets (view + writer)
 *   terminal:daemons:<userId>:<terminalId>  — the machine daemon
 *   terminal:writers:<userId>:<terminalId>  — exactly one writer seat
 */

import { Server, Socket } from 'socket.io';
import type { RemoteSocket } from 'socket.io';
import type { DefaultEventsMap } from 'socket.io/dist/typed-events';
import { Counter } from 'prom-client';
import { log } from '@/utils/log';

const TERMINAL_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_PAYLOAD_LENGTH = 1024 * 1024;

const terminalEventsCounter = new Counter({
    name: 'terminal_events_total',
    help: 'Terminal streaming events by event and role',
    labelNames: ['event', 'role'] as const,
});

function clientRoom(userId: string, terminalId: string): string {
    return `terminal:clients:${userId}:${terminalId}`;
}

function daemonRoom(userId: string, terminalId: string): string {
    return `terminal:daemons:${userId}:${terminalId}`;
}

function writerRoom(userId: string, terminalId: string): string {
    return `terminal:writers:${userId}:${terminalId}`;
}

function isValidTerminalId(value: unknown): value is string {
    return typeof value === 'string' && TERMINAL_ID_PATTERN.test(value);
}

function isValidPayload(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= MAX_PAYLOAD_LENGTH;
}

async function fetchDaemonSockets(
    io: Server,
    room: string,
): Promise<RemoteSocket<DefaultEventsMap, any>[]> {
    try {
        return await io.in(room).timeout(2_000).fetchSockets();
    } catch (error) {
        log({ module: 'websocket' }, `fetchSockets failed for terminal room ${room}: ${error}`);
        return [];
    }
}

export function terminalHandler(userId: string, socket: Socket, io: Server) {
    const clientType = socket.data.clientType as string | undefined;

    if (clientType === 'machine-scoped') {
        socket.on('terminal:register', (data: { terminalId?: unknown }) => {
            const terminalId = data?.terminalId;
            if (!isValidTerminalId(terminalId)) {
                return;
            }
            socket.join(daemonRoom(userId, terminalId));
            terminalEventsCounter.inc({ event: 'register', role: 'daemon' });
            log({ module: 'websocket' }, `Terminal daemon registered ${terminalId} for ${userId}`);
        });

        socket.on('terminal:unregister', (data: { terminalId?: unknown }) => {
            const terminalId = data?.terminalId;
            if (!isValidTerminalId(terminalId)) {
                return;
            }
            socket.leave(daemonRoom(userId, terminalId));
            terminalEventsCounter.inc({ event: 'unregister', role: 'daemon' });
        });

        socket.on('terminal:output', (data: { terminalId?: unknown; payload?: unknown }) => {
            const { terminalId, payload } = data ?? {};
            if (!isValidTerminalId(terminalId) || !isValidPayload(payload)) {
                return;
            }
            terminalEventsCounter.inc({ event: 'output', role: 'daemon' });
            io.to(clientRoom(userId, terminalId)).emit('terminal:output', { terminalId, payload });
        });

        socket.on('terminal:exit', (data: { terminalId?: unknown; payload?: unknown }) => {
            const { terminalId, payload } = data ?? {};
            if (!isValidTerminalId(terminalId) || !isValidPayload(payload)) {
                return;
            }
            terminalEventsCounter.inc({ event: 'exit', role: 'daemon' });
            io.to(clientRoom(userId, terminalId)).emit('terminal:exit', { terminalId, payload });
        });

        socket.on('terminal:input-ack', (data: { terminalId?: unknown; payload?: unknown }) => {
            const { terminalId, payload } = data ?? {};
            if (!isValidTerminalId(terminalId) || !isValidPayload(payload)) {
                return;
            }
            terminalEventsCounter.inc({ event: 'input-ack', role: 'daemon' });
            io.to(clientRoom(userId, terminalId)).emit('terminal:input-ack', { terminalId, payload });
        });

        return;
    }

    // User-scoped sockets: subscribe / unsubscribe / writer seat / input.
    socket.on('terminal:subscribe', (data: { terminalId?: unknown }) => {
        const terminalId = data?.terminalId;
        if (!isValidTerminalId(terminalId)) {
            return;
        }
        socket.join(clientRoom(userId, terminalId));
        terminalEventsCounter.inc({ event: 'subscribe', role: 'user' });
    });

    socket.on('terminal:unsubscribe', (data: { terminalId?: unknown }) => {
        const terminalId = data?.terminalId;
        if (!isValidTerminalId(terminalId)) {
            return;
        }
        socket.leave(clientRoom(userId, terminalId));
        socket.leave(writerRoom(userId, terminalId));
        terminalEventsCounter.inc({ event: 'unsubscribe', role: 'user' });
    });

    socket.on('terminal:takeover', async (data: { terminalId?: unknown }) => {
        const terminalId = data?.terminalId;
        if (!isValidTerminalId(terminalId)) {
            return;
        }

        // Exactly one writer seat: evict the previous writer (if any) and
        // grant it to the requester. `socketsLeave` is cluster-synced through
        // the streams adapter.
        await io.socketsLeave(writerRoom(userId, terminalId));
        await socket.join(writerRoom(userId, terminalId));

        terminalEventsCounter.inc({ event: 'takeover', role: 'user' });
        io.to(clientRoom(userId, terminalId)).emit('terminal:writer', {
            terminalId,
            writerSocketId: socket.id,
        });
    });

    const forwardWriterFrame = (
        event: 'terminal:input' | 'terminal:resize' | 'terminal:signal',
    ) => async (data: { terminalId?: unknown; payload?: unknown }) => {
        const { terminalId, payload } = data ?? {};
        if (!isValidTerminalId(terminalId) || !isValidPayload(payload)) {
            return;
        }
        if (!socket.rooms.has(writerRoom(userId, terminalId))) {
            return; // View-only sockets cannot write.
        }

        const targets = await fetchDaemonSockets(io, daemonRoom(userId, terminalId));
        if (targets.length === 0) {
            return;
        }
        targets[0].emit(event, { terminalId, payload });
        terminalEventsCounter.inc({ event, role: 'user' });
    };

    socket.on('terminal:input', forwardWriterFrame('terminal:input'));
    socket.on('terminal:resize', forwardWriterFrame('terminal:resize'));
    socket.on('terminal:signal', forwardWriterFrame('terminal:signal'));
}
