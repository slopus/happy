/**
 * Terminal streaming relay for remote shells.
 *
 * Control-plane terminal operations (create/approve/attach/list/close) use the
 * existing machine-scoped `rpc-call` transport. This handler adds the
 * streaming plane:
 *
 * - daemon sockets (machine-scoped) register terminal rooms and push
 *   encrypted output/exit/control ACK/NACK frames;
 * - user sockets (user-scoped) subscribe to terminal rooms, request the
 *   single writer seat, and send encrypted input/resize/signal frames;
 * - the server relays opaque, already-encrypted payloads — it never sees
 *   terminal content.
 *
 * Room layout (all scoped by the authenticated userId):
 *   terminal:clients:<userId>:<terminalId>  — user sockets (view + writer)
 *   terminal:daemons:<userId>:<terminalId>  — the machine daemon
 *
 * Writer ownership is NOT a room. It is an authoritative per-terminal value
 * (socket id + generation) so takeover is a serialized last-writer-wins swap:
 * in-process via a per-terminal queue, cross-replica via an atomic Redis Lua
 * script. Rooms are only used for broadcast/subscription.
 */

import { Server, Socket } from 'socket.io';
import type { RemoteSocket } from 'socket.io';
import type { DefaultEventsMap } from 'socket.io/dist/typed-events';
import { Counter } from 'prom-client';
import { Redis } from 'ioredis';
import { log } from '@/utils/log';

const TERMINAL_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_PAYLOAD_LENGTH = 1024 * 1024;
const WRITER_TTL_SECONDS = 24 * 60 * 60;

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

function writerKey(userId: string, terminalId: string): string {
    return `terminal:writer:${userId}:${terminalId}`;
}

const TAKE_WRITER_LUA = `
local current = redis.call('GET', KEYS[1])
local gen = 0
if current then
  local _, _, g = string.find(current, ':(%d+)$')
  if g then gen = tonumber(g) end
end
redis.call('SET', KEYS[1], ARGV[1] .. ':' .. tostring(gen + 1), 'EX', ARGV[2])
return tostring(gen + 1)
`;

const CLAIM_WRITER_IF_EMPTY_LUA = `
local current = redis.call('GET', KEYS[1])
if current then
  return { current, '0' }
end
local value = ARGV[1] .. ':1'
redis.call('SET', KEYS[1], value, 'EX', ARGV[2])
return { value, '1' }
`;

const DELETE_WRITER_IF_MATCH_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`;

let redis: Redis | null = null;
if (process.env.REDIS_URL) {
    redis = new Redis(process.env.REDIS_URL);
}

interface WriterSeat {
    socketId: string;
    generation: number;
    value: string;
}

interface WriterSeatReference extends WriterSeat {
    key: string;
    userId: string;
    terminalId: string;
}

interface TerminalWriterState {
    writerSocketId: string | null;
    generation: number;
    isWriter: boolean;
}

type TerminalWriterAck = (state: TerminalWriterState) => void;

/** Single-replica fallback writer state + per-terminal serialization. */
const writerState = new Map<string, { socketId: string; generation: number }>();
/** socketId -> terminal key -> latest exact generation owned by that socket. */
const socketWriterSeats = new Map<string, Map<string, WriterSeatReference>>();

class KeyedSerialExecutor {
    private readonly tails = new Map<string, Promise<void>>();

    get size(): number {
        return this.tails.size;
    }

    async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
        const previous = this.tails.get(key) ?? Promise.resolve();
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const tail = previous.then(() => gate);
        this.tails.set(key, tail);

        await previous;
        try {
            return await operation();
        } finally {
            release();
            if (this.tails.get(key) === tail) {
                this.tails.delete(key);
            }
        }
    }
}

const terminalOperations = new KeyedSerialExecutor();

/**
 * Per-terminal in-process serialization for writer operations. Forwarding and
 * takeover share the same lock so an old writer cannot emit after a swap.
 */
export async function withTerminalOpLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return terminalOperations.run(key, fn);
}

export function terminalOpQueueSize(): number {
    return terminalOperations.size;
}

function parseWriterSeat(value: string | null): WriterSeat | null {
    if (!value) {
        return null;
    }
    const separator = value.lastIndexOf(':');
    if (separator <= 0) {
        return null;
    }
    const socketId = value.slice(0, separator);
    const generation = Number(value.slice(separator + 1));
    if (!socketId || !Number.isSafeInteger(generation) || generation <= 0) {
        return null;
    }
    return { socketId, generation, value };
}

function rememberWriterSeat(reference: WriterSeatReference): void {
    const seats = socketWriterSeats.get(reference.socketId) ?? new Map();
    seats.set(reference.key, reference);
    socketWriterSeats.set(reference.socketId, seats);
}

async function claimWriterIfEmpty(
    key: string,
    socketId: string,
): Promise<{ seat: WriterSeat; claimed: boolean }> {
    if (redis) {
        const result = await redis.eval(
            CLAIM_WRITER_IF_EMPTY_LUA,
            1,
            key,
            socketId,
            String(WRITER_TTL_SECONDS),
        ) as [string, string];
        const seat = parseWriterSeat(result[0]);
        if (!seat) {
            throw new Error(`Invalid terminal writer seat for ${key}`);
        }
        return { seat, claimed: result[1] === '1' };
    }

    const current = writerState.get(key);
    if (current) {
        return {
            seat: {
                ...current,
                value: `${current.socketId}:${current.generation}`,
            },
            claimed: false,
        };
    }
    const seat = { socketId, generation: 1, value: `${socketId}:1` };
    writerState.set(key, { socketId, generation: seat.generation });
    return { seat, claimed: true };
}

async function takeWriter(key: string, socketId: string): Promise<WriterSeat> {
    if (redis) {
        const generation = Number(await redis.eval(
            TAKE_WRITER_LUA,
            1,
            key,
            socketId,
            String(WRITER_TTL_SECONDS),
        ));
        return { socketId, generation, value: `${socketId}:${generation}` };
    }

    const generation = (writerState.get(key)?.generation ?? 0) + 1;
    writerState.set(key, { socketId, generation });
    return { socketId, generation, value: `${socketId}:${generation}` };
}

async function currentWriter(key: string): Promise<WriterSeat | null> {
    if (redis) {
        return parseWriterSeat(await redis.get(key));
    }
    const state = writerState.get(key);
    return state
        ? { ...state, value: `${state.socketId}:${state.generation}` }
        : null;
}

async function writerGeneration(key: string, socketId: string): Promise<number> {
    const state = await currentWriter(key);
    return state?.socketId === socketId ? state.generation : 0;
}

async function releaseWriterIfOwned(reference: WriterSeatReference): Promise<boolean> {
    if (redis) {
        return Number(await redis.eval(
            DELETE_WRITER_IF_MATCH_LUA,
            1,
            reference.key,
            reference.value,
        )) === 1;
    }
    const current = writerState.get(reference.key);
    if (current && `${current.socketId}:${current.generation}` === reference.value) {
        writerState.delete(reference.key);
        return true;
    }
    return false;
}

function broadcastWriter(
    io: Server,
    userId: string,
    terminalId: string,
    seat: WriterSeat | null,
): void {
    io.to(clientRoom(userId, terminalId)).emit('terminal:writer', {
        terminalId,
        writerSocketId: seat?.socketId ?? null,
        generation: seat?.generation ?? 0,
    });
}

function writerAck(seat: WriterSeat | null, socketId: string): TerminalWriterState {
    return {
        writerSocketId: seat?.socketId ?? null,
        generation: seat?.generation ?? 0,
        isWriter: seat?.socketId === socketId,
    };
}

async function releaseSocketWriters(socketId: string, io: Server): Promise<void> {
    const seats = socketWriterSeats.get(socketId);
    if (!seats) {
        return;
    }
    socketWriterSeats.delete(socketId);
    await Promise.all(Array.from(seats.values()).map((reference) => (
        withTerminalOpLock(reference.key, async () => {
            if (await releaseWriterIfOwned(reference)) {
                broadcastWriter(io, reference.userId, reference.terminalId, null);
            }
        })
    )));
}

async function releaseWriterSeat(socketId: string, key: string): Promise<WriterSeatReference | null> {
    const seats = socketWriterSeats.get(socketId);
    if (!seats) {
        return null;
    }
    const reference = seats.get(key);
    if (!reference) {
        return null;
    }
    seats.delete(key);
    if (seats.size === 0) {
        socketWriterSeats.delete(socketId);
    }
    return await releaseWriterIfOwned(reference) ? reference : null;
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

        socket.on('terminal:epoch', (data: { terminalId?: unknown; payload?: unknown }) => {
            const { terminalId, payload } = data ?? {};
            if (!isValidTerminalId(terminalId) || !isValidPayload(payload)) {
                return;
            }
            terminalEventsCounter.inc({ event: 'epoch', role: 'daemon' });
            io.to(clientRoom(userId, terminalId)).emit('terminal:epoch', { terminalId, payload });
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

        socket.on('terminal:control-ack', (data: { terminalId?: unknown; payload?: unknown }) => {
            const { terminalId, payload } = data ?? {};
            if (!isValidTerminalId(terminalId) || !isValidPayload(payload)) {
                return;
            }
            terminalEventsCounter.inc({ event: 'control-ack', role: 'daemon' });
            io.to(clientRoom(userId, terminalId)).emit('terminal:control-ack', { terminalId, payload });
        });

        socket.on('terminal:control-nack', (data: { terminalId?: unknown; payload?: unknown }) => {
            const { terminalId, payload } = data ?? {};
            if (!isValidTerminalId(terminalId) || !isValidPayload(payload)) {
                return;
            }
            terminalEventsCounter.inc({ event: 'control-nack', role: 'daemon' });
            io.to(clientRoom(userId, terminalId)).emit('terminal:control-nack', { terminalId, payload });
        });

        return;
    }

    // User-scoped sockets: subscribe / unsubscribe / writer seat / input.
    socket.on('terminal:subscribe', async (
        data: { terminalId?: unknown },
        acknowledge: TerminalWriterAck = () => undefined,
    ) => {
        const terminalId = data?.terminalId;
        if (!isValidTerminalId(terminalId)) {
            acknowledge(writerAck(null, socket.id));
            return;
        }
        await socket.join(clientRoom(userId, terminalId));
        const key = writerKey(userId, terminalId);
        await withTerminalOpLock(key, async () => {
            const { seat, claimed } = await claimWriterIfEmpty(key, socket.id);
            if (seat.socketId === socket.id) {
                rememberWriterSeat({ ...seat, key, userId, terminalId });
            }
            if (!socket.connected) {
                const released = await releaseWriterSeat(socket.id, key);
                if (released) {
                    broadcastWriter(io, userId, terminalId, null);
                }
                return;
            }
            acknowledge(writerAck(seat, socket.id));
            if (claimed) {
                broadcastWriter(io, userId, terminalId, seat);
            }
            terminalEventsCounter.inc({ event: 'subscribe', role: 'user' });
        });
    });

    socket.on('terminal:unsubscribe', (data: { terminalId?: unknown }) => {
        const terminalId = data?.terminalId;
        if (!isValidTerminalId(terminalId)) {
            return;
        }
        const key = writerKey(userId, terminalId);
        void (async () => {
            await socket.leave(clientRoom(userId, terminalId));
            await withTerminalOpLock(key, async () => {
                if (await releaseWriterSeat(socket.id, key)) {
                    broadcastWriter(io, userId, terminalId, null);
                }
                terminalEventsCounter.inc({ event: 'unsubscribe', role: 'user' });
            });
        })().catch((error) => {
            log({ module: 'websocket' }, `Terminal unsubscribe failed: ${error}`);
        });
    });

    socket.on('terminal:takeover', async (
        data: { terminalId?: unknown },
        acknowledge: TerminalWriterAck = () => undefined,
    ) => {
        const terminalId = data?.terminalId;
        if (!isValidTerminalId(terminalId)) {
            acknowledge(writerAck(null, socket.id));
            return;
        }

        const key = writerKey(userId, terminalId);
        await withTerminalOpLock(key, async () => {
            const seat = await takeWriter(key, socket.id);
            rememberWriterSeat({ ...seat, key, userId, terminalId });
            if (!socket.connected) {
                // Socket died while the takeover was queued; drop the seat again.
                if (await releaseWriterSeat(socket.id, key)) {
                    broadcastWriter(io, userId, terminalId, null);
                }
                return;
            }
            terminalEventsCounter.inc({ event: 'takeover', role: 'user' });
            acknowledge(writerAck(seat, socket.id));
            broadcastWriter(io, userId, terminalId, seat);
        });
    });

    const forwardWriterFrame = (
        event: 'terminal:input' | 'terminal:resize' | 'terminal:signal',
    ) => async (data: { terminalId?: unknown; payload?: unknown }) => {
        const { terminalId, payload } = data ?? {};
        if (!isValidTerminalId(terminalId) || !isValidPayload(payload)) {
            return;
        }
        const key = writerKey(userId, terminalId);
        await withTerminalOpLock(key, async () => {
            const generation = await writerGeneration(key, socket.id);
            if (!generation) {
                return; // View-only sockets cannot write.
            }

            const targets = await fetchDaemonSockets(io, daemonRoom(userId, terminalId));
            if (targets.length === 0) {
                return;
            }
            if (redis) {
                // Cross-replica fencing: another replica may have swapped the
                // writer while we were looking up the daemon socket.
                if (await writerGeneration(key, socket.id) !== generation) {
                    return;
                }
            }
            targets[0].emit(event, { terminalId, payload });
            terminalEventsCounter.inc({ event, role: 'user' });
        });
    };

    socket.on('terminal:input', forwardWriterFrame('terminal:input'));
    socket.on('terminal:resize', forwardWriterFrame('terminal:resize'));
    socket.on('terminal:signal', forwardWriterFrame('terminal:signal'));

    socket.on('disconnect', () => {
        void releaseSocketWriters(socket.id, io).catch((error) => {
            log({ module: 'websocket' }, `Terminal disconnect cleanup failed: ${error}`);
        });
    });
}
