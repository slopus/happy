import { createHash } from 'node:crypto';
import { deny } from './errors';

type Snapshot = { record: { status: string }; sequence: number };
export function turnObservationCursor(value: Snapshot): string {
 return createHash('sha256').update(JSON.stringify([value.sequence, value.record])).digest('hex');
}

/** Notifications carry no data or authority. Every wake reads through current
 * authorization again; periodic reads also cover writes on another server. */
export class TurnObservation {
 private readonly listeners = new Map<string, Set<() => void>>();
 private count = 0;
 notify(id: string) { for (const wake of this.listeners.get(id) ?? []) wake(); }
 async read<T extends Snapshot>(id: string, read: () => Promise<T>, cursor?: string, signal?: AbortSignal, timeoutMs = 10_000): Promise<T & { observationCursor: string }> {
  if (this.count >= 4096 || (this.listeners.get(id)?.size ?? 0) >= 64) deny('resource-busy');
  const listeners = this.listeners.get(id) ?? new Set<() => void>();
  this.listeners.set(id, listeners);
  let changed = false, wake: (() => void) | undefined;
  const notify = () => { changed = true; wake?.(); };
  listeners.add(notify); this.count++;
  signal?.addEventListener('abort', notify, { once: true });
  const deadline = Date.now() + timeoutMs;
  try {
   while (true) {
    changed = false;
    const value = await read();
    const observationCursor = turnObservationCursor(value);
    if (!cursor || cursor !== observationCursor || ['completed','failed','cancelled','interrupted'].includes(value.record.status) || signal?.aborted || Date.now() >= deadline) return { ...value, observationCursor };
    if (changed) continue;
    await new Promise<void>(resolve => {
     const timer = setTimeout(done, Math.min(1000, Math.max(0, deadline - Date.now())));
     function done() { clearTimeout(timer); wake = undefined; resolve(); }
     wake = done;
     if (changed || signal?.aborted) done();
    });
   }
  } finally {
   signal?.removeEventListener('abort', notify);
   listeners.delete(notify); this.count--;
   if (!listeners.size) this.listeners.delete(id);
  }
 }
}
