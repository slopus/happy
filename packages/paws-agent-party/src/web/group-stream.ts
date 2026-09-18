import type { GroupRoomSnapshot, GroupTurn } from '../group-chat/rooms.js';
import type { ImageRef } from '../contracts.js';

export type VisibleMessage = { id: string; from: string; text: string; ts: number; images?: ImageRef[]; replyTo?: string; taskMessageId?: string; live?: GroupTurn['live'] };

export function mergeRooms(current: GroupRoomSnapshot[], incoming: GroupRoomSnapshot[]): GroupRoomSnapshot[] {
  const byId = new Map(current.map(room => [room.id, room]));
  for (const room of incoming) {
    const previous = byId.get(room.id);
    if (!previous || room.updatedAt > previous.updatedAt) byId.set(room.id, room);
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Full-list polling is authoritative for membership; SSE snapshots remain additive via mergeRooms. */
export function reconcileRoomList(current: GroupRoomSnapshot[], incoming: GroupRoomSnapshot[]): GroupRoomSnapshot[] {
  const currentById = new Map(current.map(room => [room.id, room]));
  return incoming.map(room => {
    const previous = currentById.get(room.id);
    return previous && previous.updatedAt > room.updatedAt ? previous : room;
  }).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function timelineMessages(room: GroupRoomSnapshot, messages: VisibleMessage[]): VisibleMessage[] {
  const published = new Set(messages.map(message => message.id));
  const result: VisibleMessage[] = messages.map(message => ({ ...message, taskMessageId: room.turns.find(turn => turn.publicMessageId === message.id || (turn.taskMessageId === message.replyTo && turn.participant === message.from))?.taskMessageId }));
  const publishedTasks = new Set(result.map(message => message.taskMessageId).filter(Boolean));
  for (const turn of room.turns) {
    if (!turn.live || publishedTasks.has(turn.taskMessageId) || (turn.publicMessageId && published.has(turn.publicMessageId))) continue;
    result.push({ id: turn.taskMessageId, taskMessageId: turn.taskMessageId, from: turn.participant, text: turn.live.text, ts: turn.live.createdAt, live: turn.live });
  }
  return result.sort((a, b) => a.ts - b.ts);
}

/** Auth stays in headers; reconnects receive a complete current snapshot. */
export async function watchGroupRoom(options: {
  roomId: string; token: string; signal: AbortSignal;
  onSnapshot(room: GroupRoomSnapshot): void; onUnauthorized(): void;
  transport?: typeof fetch; baseUrl?: string;
}): Promise<void> {
  const { signal } = options;
  const prefix = (options.baseUrl ?? import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
  let retryMs = 500;
  while (!signal.aborted) {
    try {
      const response = await (options.transport ?? fetch)(`${prefix}/api/group-chat/rooms/${encodeURIComponent(options.roomId)}/events`, {
        headers: { authorization: `Bearer ${options.token}`, accept: 'text/event-stream' }, signal, cache: 'no-store',
      });
      if (response.status === 401) { options.onUnauthorized(); return; }
      if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Group stream unavailable');
      const reader = response.body.getReader();
      const abort = () => { void reader.cancel().catch(() => undefined); };
      signal.addEventListener('abort', abort, { once: true });
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary: RegExpExecArray | null;
          while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
            const frame = buffer.slice(0, boundary.index);
            buffer = buffer.slice(boundary.index + boundary[0].length);
            const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
            if (!data || signal.aborted) continue;
            const room = JSON.parse(data) as GroupRoomSnapshot;
            if (room.id !== options.roomId || !Number.isFinite(room.updatedAt) || !Array.isArray(room.turns)) continue;
            options.onSnapshot(room); retryMs = 500;
          }
        }
      } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    } catch { /* Global polling remains available while the stream reconnects. */ }
    if (signal.aborted) return;
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, retryMs);
      signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted) finish();
    });
    retryMs = Math.min(retryMs * 2, 5000);
  }
}
