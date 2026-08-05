import { describe, expect, it } from 'vitest';
import {
    isArchivedLifecycleState,
    isSessionArchived,
    markSessionArchiveRequested,
    markSessionRestored,
} from './sessionLifecycle';

const metadata = {
    path: '/workspace/project',
    host: 'machine',
    lifecycleState: 'running',
    lifecycleStateSince: 1,
};

describe('session lifecycle archive semantics', () => {
    it.each(['archiveRequested', 'archived'])('treats %s as explicitly archived', (state) => {
        expect(isArchivedLifecycleState(state)).toBe(true);
        expect(isSessionArchived({ metadata: { ...metadata, lifecycleState: state } })).toBe(true);
    });

    it.each([undefined, 'running', 'disconnected'])('does not confuse %s with an archive', (state) => {
        expect(isArchivedLifecycleState(state)).toBe(false);
    });

    it('marks an archive request without changing transport presence', () => {
        expect(markSessionArchiveRequested(metadata, 20)).toEqual({
            ...metadata,
            lifecycleState: 'archiveRequested',
            lifecycleStateSince: 20,
            archivedBy: 'app',
            archiveReason: 'User archived',
        });
    });

    it('restores list membership and clears archive provenance', () => {
        expect(markSessionRestored({
            ...metadata,
            lifecycleState: 'archived',
            archivedBy: 'cli',
            archiveReason: 'User terminated',
        }, 30)).toEqual({
            ...metadata,
            lifecycleState: 'running',
            lifecycleStateSince: 30,
        });
    });
});
