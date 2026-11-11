import { describe, expect, it, vi } from 'vitest';
import { mergeProjectTaskHistory } from './mergeProjectTaskHistory';
vi.mock('./projectSessionLinks', () => ({ isProjectSessionDeleted: (id: string) => id === 'deleted' }));
vi.mock('./apiSocket', () => ({ apiSocket: {} }));
vi.mock('./ops', () => ({}));
vi.mock('@/text', () => ({ t: (key: string) => key }));
const scope = { machineId: 'm', featurePath: '/f', taskId: 't', directory: '/f/tasks/t' };
const old = { sessionId: 'old', title: 'Old', directory: scope.directory, updatedAt: 1, executed: false };
describe('shared Task history merge', () => {
    it('resumes a newer matching live conversation instead of the stale cached newest', () => {
        const result = mergeProjectTaskHistory([old], [{ id: 'new', updatedAt: 10, active: false, metadata: { machineId: 'm', path: scope.directory, goalBoard: { featurePath: '/f', taskId: 't' } } }], scope);
        expect(result.map(value => value.sessionId)).toEqual(['new', 'old']);
    });
    it('rejects contradictory Task/machine headers and deleted cached links', () => {
        const result = mergeProjectTaskHistory([old, { ...old, sessionId: 'deleted' }], [{ id: 'old', updatedAt: 10, active: true, metadata: { machineId: 'm', path: scope.directory, goalBoard: { featurePath: '/f', taskId: 'other' } } }, { id: 'other-machine', updatedAt: 12, active: true, metadata: { machineId: 'other', path: scope.directory } }], scope);
        expect(result).toEqual([]);
    });
    it('preserves RPC-canonicalized legacy paths only if no explicit owner contradicts them', () => {
        const result = mergeProjectTaskHistory([old], [{ id: 'old', updatedAt: 20, active: false, metadata: { machineId: 'm', path: '/symlink/to/task' } }], scope);
        expect(result[0]).toMatchObject({ sessionId: 'old', updatedAt: 20, directory: scope.directory });
    });
});
