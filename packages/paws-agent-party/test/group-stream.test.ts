import { afterEach, expect, it, vi } from 'vitest';
import { mergeRooms, timelineMessages, watchGroupRoom } from '../src/web/group-stream.js';
import type { GroupRoomSnapshot } from '../src/group-chat/rooms.js';

afterEach(() => vi.useRealTimers());
const snapshot = (updatedAt: number) => ({ id: 'room', turns: [], updatedAt }) as unknown as GroupRoomSnapshot;

it('uses durable replyTo to replace live text when history arrives ahead of the room publication snapshot', () => {
  const room = { ...snapshot(1), turns: [{ participant: 'a', taskMessageId: 'task', live: { text: 'partial', status: 'running', createdAt: 1 } }] } as unknown as GroupRoomSnapshot;
  const messages = timelineMessages(room, [{ id: 'final', from: 'a', text: 'final answer', ts: 2, replyTo: 'task' }]);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ text: 'final answer', taskMessageId: 'task' });
  expect(messages[0].live).toBeUndefined();
});

it('retains newer streamed snapshots when older or equal polling responses arrive', () => {
  const current = snapshot(5);
  expect(mergeRooms([current], [snapshot(4)])[0]).toBe(current);
  expect(mergeRooms([current], [snapshot(5)])[0]).toBe(current);
  const next = snapshot(6);
  expect(mergeRooms([current], [next])[0]).toBe(next);
});

it('parses split UTF-8 and SSE frames, reconnects on disconnect, and cancels reads on abort', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const first = { ...snapshot(1), title: '你好' };
  const next = snapshot(2);
  const frames = new TextEncoder().encode(`: keepalive\r\n\r\ndata: ${JSON.stringify(first)}\r\n\r\n`);
  let connections = 0;
  let canceled = false;
  const seen: GroupRoomSnapshot[] = [];
  const transport = (async () => {
    connections++;
    return new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        if (connections === 1) { for (const byte of frames) stream.enqueue(new Uint8Array([byte])); stream.close(); }
        else stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(next)}\n\n`));
      },
      cancel() { canceled = true; },
    }), { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  const watching = watchGroupRoom({ roomId: 'room', token: 'token', signal: controller.signal, transport, onSnapshot: room => seen.push(room), onUnauthorized: () => { throw new Error('unexpected'); } });
  await vi.advanceTimersByTimeAsync(0);
  expect(seen).toEqual([first]);
  await vi.advanceTimersByTimeAsync(500);
  expect(seen).toEqual([first, next]);
  controller.abort(); await watching;
  expect(canceled).toBe(true);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(connections).toBe(2);
});

it('opens the token gate and does not reconnect after unauthorized', async () => {
  let unauthorized = false;
  let connections = 0;
  await watchGroupRoom({ roomId: 'room', token: 'bad', signal: new AbortController().signal,
    transport: (async () => { connections++; return new Response(null, { status: 401 }); }) as typeof fetch,
    onSnapshot: () => { throw new Error('unexpected'); }, onUnauthorized: () => { unauthorized = true; },
  });
  expect(unauthorized).toBe(true);
  expect(connections).toBe(1);
});
