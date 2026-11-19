import { describe, expect, it } from 'vitest';
import { isProjectConversationArchived } from './projectConversationLifecycle';

describe('project history lifecycle reconciliation', () => {
    it.each(['archived', 'archiveRequested'])('hides %s history without a loaded header', lifecycleState => {
        expect(isProjectConversationArchived({ updatedAt: 20, lifecycleState })).toBe(true);
    });
    it('keeps an offline resumable session visible', () => {
        expect(isProjectConversationArchived({ updatedAt: 20 })).toBe(false);
    });
    it('lets newer authoritative archive history override a stale running header', () => {
        expect(isProjectConversationArchived({ updatedAt: 20, lifecycleState: 'archived' }, { updatedAt: 10, metadata: { lifecycleState: 'running' } })).toBe(true);
    });
    it('lets a newer restored header override cached archive history', () => {
        expect(isProjectConversationArchived({ updatedAt: 10, lifecycleState: 'archived' }, { updatedAt: 20, metadata: { lifecycleState: 'running' } })).toBe(false);
    });
});
