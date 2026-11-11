import { describe, expect, it } from 'vitest';
import { canRouteBack, canRouteForward } from '@/navigation/browserNavigation';
import { createProjectHistory, moveProjectHistory, projectHistoryLocation, pushProjectLocation } from './projectNavigation';

describe('project location navigation', () => {
    it('returns to the selected task without retaining its conversation, then forwards to that conversation', () => {
        let history = createProjectHistory({ machine: 'm' });
        history = pushProjectLocation(history, { project: 'p', feature: 'f' });
        history = pushProjectLocation(history, { task: 't', conversation: undefined });
        const task = history;
        history = pushProjectLocation(history, { conversation: 'recent' });
        history = moveProjectHistory(history, -1);
        expect(projectHistoryLocation(history)).toEqual({ machine: 'm', project: 'p', feature: 'f', task: 't', conversation: undefined, author: undefined });
        expect(history.cursor).toBe(task.cursor);
        expect(canRouteForward(history)).toBe(true);
        expect(projectHistoryLocation(moveProjectHistory(history, 1)).conversation).toBe('recent');
    });
    it('discards the old forward branch when another task is selected and clears old task context', () => {
        let history = createProjectHistory({ machine: 'm', project: 'p', feature: 'f', task: 'one' });
        history = pushProjectLocation(history, { conversation: 'chat-one' });
        history = moveProjectHistory(history, -1);
        history = pushProjectLocation(history, { task: 'two', conversation: undefined });
        expect(canRouteForward(history)).toBe(false);
        expect(projectHistoryLocation(history).conversation).toBeUndefined();
        history = pushProjectLocation(history, { project: undefined, feature: undefined, task: undefined, conversation: undefined });
        expect(projectHistoryLocation(history)).toEqual({ machine: 'm', project: undefined, feature: undefined, task: undefined, conversation: undefined, author: undefined });
    });
    it('does not add duplicate entries for refreshes or cross either end of the trail', () => {
        const history = createProjectHistory({ machine: 'm', project: 'p' });
        expect(pushProjectLocation(history, { project: 'p' })).toBe(history);
        expect(moveProjectHistory(history, -1)).toBe(history);
        expect(moveProjectHistory(history, 1)).toBe(history);
        expect(canRouteBack(history)).toBe(false);
        expect(canRouteForward(history)).toBe(false);
    });
});
