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
    const application = { appId: 'advisor', bindingId: 'binding' };
    const completed = { status: 'completed' as const, updatedAt: 10, turnId: 'turn-1' };
    const warm = { metadata: { ...metadata, application }, agentState: { turnStatus: completed }, thinking: false };

    it('archives a durable completed application turn without changing its running processor metadata', () => {
        expect(isSessionArchived(warm)).toBe(true);
        expect(warm.metadata.lifecycleState).toBe('running');
        expect(isArchivedLifecycleState(warm.metadata.lifecycleState)).toBe(false);
        expect(isSessionArchived(JSON.parse(JSON.stringify(warm)))).toBe(true);
        expect(isSessionArchived({ ...warm, metadata })).toBe(false);
    });

    it('keeps unfinished, failed, pending-permission, queued and draft application sessions current', () => {
        for (const status of ['running', 'failed', 'cancelled'] as const) {
            expect(isSessionArchived({ ...warm, agentState: { turnStatus: { ...completed, status } } })).toBe(false);
        }
        expect(isSessionArchived({ ...warm, agentState: null })).toBe(false);
        expect(isSessionArchived({ ...warm, thinking: true })).toBe(false);
        expect(isSessionArchived({ ...warm, draft: 'followup' })).toBe(false);
        expect(isSessionArchived({ ...warm, agentState: { ...warm.agentState, queuedMessages: 1 } })).toBe(false);
        expect(isSessionArchived({ ...warm, agentState: { ...warm.agentState, requests: { approval: { tool: 'x', arguments: {} } } } })).toBe(false);
    });

    it('restores only the observed completed turn and archives the next completion', () => {
        const restored = markSessionRestored(warm.metadata, 20, completed);
        expect(isSessionArchived({ ...warm, metadata: restored })).toBe(false);
        // Replayed heartbeats/snapshots do not undo a user's restore.
        expect(isSessionArchived({ ...warm, metadata: restored, agentState: { turnStatus: { ...completed } } })).toBe(false);
        expect(isSessionArchived({ ...warm, metadata: restored, agentState: { turnStatus: { ...completed, turnId: 'turn-2', updatedAt: 30 } } })).toBe(true);
        expect(isSessionArchived({ ...warm, metadata: markSessionArchiveRequested(restored, 40), thinking: true })).toBe(true);
    });

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
