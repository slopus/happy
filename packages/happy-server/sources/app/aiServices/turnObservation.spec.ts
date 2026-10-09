import { afterEach, expect, it, vi } from 'vitest';
import { TurnObservation, turnObservationCursor } from './turnObservation';
afterEach(() => vi.useRealTimers());
const initial = () => ({ sequence: 1, record: { status: 'running', phase: 'thinking' } });
it('wakes immediately for state-only changes, including terminal at the same sequence', async () => {
 vi.useFakeTimers(); const observer = new TurnObservation(); let value = initial();
 const read = vi.fn(async () => value);
 const waiting = observer.read('turn', read, turnObservationCursor(value));
 await vi.advanceTimersByTimeAsync(0);
 value = { ...value, record: { ...value.record, status: 'completed' } }; observer.notify('turn');
 expect((await waiting).record.status).toBe('completed'); expect(vi.getTimerCount()).toBe(0);
});
it('does not lose a notification arriving during the authorized read', async () => {
 const observer = new TurnObservation(); const value = initial(); let reads = 0;
 const result = await observer.read('turn', async () => {
  if (++reads === 1) { observer.notify('turn'); return value; }
  return { ...value, sequence: 2 };
 }, turnObservationCursor(value));
 expect(result.sequence).toBe(2); expect(reads).toBe(2);
});
it('rereads authorization after a notification and after timeout; unrelated turns do not wake it', async () => {
 vi.useFakeTimers(); const observer = new TurnObservation(), value = initial(); let revoked = false;
 const read = vi.fn(async () => { if (revoked) throw new Error('authorization-revoked'); return value; });
 const pending = observer.read('turn', read, turnObservationCursor(value));
 const rejected = expect(pending).rejects.toThrow('authorization-revoked');
 await vi.advanceTimersByTimeAsync(0); observer.notify('other'); await vi.advanceTimersByTimeAsync(0);
 expect(read).toHaveBeenCalledTimes(1); revoked = true;
 await vi.advanceTimersByTimeAsync(1000); await rejected; expect(vi.getTimerCount()).toBe(0);
});
it('periodically sees other server writes and cleans up abort/timeout waiters', async () => {
 vi.useFakeTimers(); const observer = new TurnObservation(); let value = initial();
 const read = async () => value;
 const pending = observer.read('turn', read, turnObservationCursor(value));
 await vi.advanceTimersByTimeAsync(0); value = { ...value, sequence: 2 };
 await vi.advanceTimersByTimeAsync(1000); expect((await pending).sequence).toBe(2);
 for (let i = 0; i < 70; i++) {
  const control = new AbortController(); const waiting = observer.read('turn', read, turnObservationCursor(value), control.signal);
  await vi.advanceTimersByTimeAsync(0); control.abort(); await waiting;
 }
 const timeout = observer.read('turn', read, turnObservationCursor(value), undefined, 25);
 await vi.advanceTimersByTimeAsync(25); await timeout; expect(vi.getTimerCount()).toBe(0);
});
