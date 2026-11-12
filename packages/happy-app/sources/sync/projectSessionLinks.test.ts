import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@/auth/accountRuntime', () => ({ getRuntimeAccountSelection: () => ({ key: 'a', scope: 'a', serverUrl: 'https://a.test', generation: 'current' }) }));
import { configureProjectSessionDeletionPersistence, isProjectSessionDeleted, markProjectSessionDeleted } from './projectSessionLinks';
afterEach(() => configureProjectSessionDeletionPersistence(undefined));
it('retains a persisted deletion in memory when a later disk read fails', () => {
    const has = vi.fn().mockReturnValueOnce(true).mockImplementation(() => { throw new Error('Storage unavailable'); });
    configureProjectSessionDeletionPersistence({ has, mark: () => {} });
    expect(isProjectSessionDeleted('persisted-deletion')).toBe(true);
    expect(isProjectSessionDeleted('persisted-deletion')).toBe(true);
    expect(has).toHaveBeenCalledTimes(1);
});
it('keeps an authoritative deletion fenced if its disk write fails', () => {
    configureProjectSessionDeletionPersistence({ has: () => false, mark: () => { throw new Error('Quota'); } });
    expect(() => markProjectSessionDeleted('failed-disk-write')).not.toThrow();
    expect(isProjectSessionDeleted('failed-disk-write')).toBe(true);
});
