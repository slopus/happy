import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPausableDeadline } from './pausableDeadline';

const minute = 60_000;
describe('ACP local root work deadline', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('keeps the original five minute budget when no delegation is waiting', () => {
    const timeout = vi.fn();
    createPausableDeadline(5 * minute, timeout);
    vi.advanceTimersByTime(5 * minute - 1);
    expect(timeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(timeout).toHaveBeenCalledOnce();
  });

  it('allows a delegation longer than five minutes, then resumes only the unspent local budget', () => {
    const timeout = vi.fn();
    const deadline = createPausableDeadline(5 * minute, timeout);
    vi.advanceTimersByTime(minute);
    const release = deadline.pause();
    vi.advanceTimersByTime(11 * minute);
    expect(timeout).not.toHaveBeenCalled();
    release();
    vi.advanceTimersByTime(4 * minute - 1);
    expect(timeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(timeout).toHaveBeenCalledOnce();
  });

  it('waits for every overlapping delegation and makes duplicate releases harmless', () => {
    const timeout = vi.fn();
    const deadline = createPausableDeadline(5 * minute, timeout);
    vi.advanceTimersByTime(minute);
    const first = deadline.pause();
    vi.advanceTimersByTime(minute);
    const second = deadline.pause();
    first(); first();
    vi.advanceTimersByTime(10 * minute);
    expect(timeout).not.toHaveBeenCalled();
    second(); second();
    vi.advanceTimersByTime(4 * minute);
    expect(timeout).toHaveBeenCalledOnce();
  });

  it('retains local work already spent between separate delegations', () => {
    const timeout = vi.fn();
    const deadline = createPausableDeadline(5 * minute, timeout);
    vi.advanceTimersByTime(minute);
    const first = deadline.pause();
    vi.advanceTimersByTime(10 * minute); first();
    vi.advanceTimersByTime(30_000);
    const second = deadline.pause();
    vi.advanceTimersByTime(10 * minute); second();
    vi.advanceTimersByTime(210_000 - 1);
    expect(timeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(timeout).toHaveBeenCalledOnce();
  });

  it('cannot revive a cancelled or completed root and cannot change the next root deadline', () => {
    const oldTimeout = vi.fn();
    const old = createPausableDeadline(5 * minute, oldTimeout);
    const oldRelease = old.pause();
    old.cancel();
    const newTimeout = vi.fn();
    createPausableDeadline(minute, newTimeout);
    vi.advanceTimersByTime(30_000);
    oldRelease(); old.pause()();
    vi.advanceTimersByTime(30_000);
    expect(oldTimeout).not.toHaveBeenCalled();
    expect(newTimeout).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never rearms an already expired deadline', () => {
    const timeout = vi.fn();
    const deadline = createPausableDeadline(minute, timeout);
    vi.advanceTimersByTime(minute);
    deadline.pause()(); deadline.cancel();
    vi.advanceTimersByTime(10 * minute);
    expect(timeout).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
