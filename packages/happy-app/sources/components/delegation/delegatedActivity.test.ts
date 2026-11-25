import { describe, expect, it, vi } from 'vitest';
import type { DelegatedTaskSummary } from '@slopus/happy-wire';
vi.mock('@/text', () => ({ t: (key: string) => key }));
import { delegatedActivity } from './delegatedActivity';

const task: DelegatedTaskSummary = { id: 'linked-task', parentSessionId: 'parent', title: 'Write README', roleName: 'README', agent: 'antigravity',
    version: 1, status: 'starting', startedAt: 10, updatedAt: 11, resultAvailable: false, cancelRequested: false };
describe('linked subagent presentation', () => {
    it('shows the actual executor without inventing a saved role or resolved default model', () => {
        expect(delegatedActivity(task, 0)).toMatchObject({ id: task.id, provider: 'antigravity', status: 'running' });
        expect(delegatedActivity(task, 0).currentAction).toContain('delegation.starting');
        expect(delegatedActivity(task, 0).model).toBeUndefined();
    });
    it('preserves waiting and failure context and uses only the task snapshot route', () => {
        expect(delegatedActivity({ ...task, status: 'waiting-for-input', model: 'Neon', effort: 'High' }, 0).currentAction).toContain('delegation.waiting');
        expect(delegatedActivity({ ...task, status: 'interrupted', error: 'Worker exited', finishedAt: 15 }, 0)).toMatchObject({ status: 'failed', failureSummary: 'Worker exited', completedAt: 15 });
    });
});
