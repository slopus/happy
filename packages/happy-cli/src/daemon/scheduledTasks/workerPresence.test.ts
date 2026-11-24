import { expect, it, vi } from 'vitest';
import { scheduledWorkerPresence } from './workerPresence';

it('distinguishes a stopped worker from stale relay presence', () => {
    expect(scheduledWorkerPresence(123, () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); })).toBe('stopped');
    expect(scheduledWorkerPresence(123, () => {})).toBe('running');
});
it('fails closed when worker identity or process access is unavailable', () => {
    const probe = vi.fn();
    expect(scheduledWorkerPresence(undefined, probe)).toBe('unknown');
    expect(scheduledWorkerPresence(-1, probe)).toBe('unknown');
    expect(probe).not.toHaveBeenCalled();
    expect(scheduledWorkerPresence(123, () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); })).toBe('unknown');
});
