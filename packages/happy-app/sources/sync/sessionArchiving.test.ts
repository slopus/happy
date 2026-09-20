import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rigMetadataFixture } from './__testdata__/rigMetadata';

// The real store; only native storage, the socket and encryption are replaced.
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } }));
vi.mock('./persistence', () => ({
    loadSettings: () => ({}), loadLocalSettings: () => ({}), saveLocalSettings: vi.fn(), saveSettings: vi.fn(),
    loadPurchases: () => null, savePurchases: vi.fn(), loadProfile: () => null, saveProfile: vi.fn(),
    loadSessionDrafts: () => ({}), saveSessionDrafts: vi.fn(),
    loadRigComposerDraft: () => null, saveRigComposerDraft: vi.fn(),
    loadSessionLastMessageSentAt: () => ({}), saveSessionLastMessageSentAt: vi.fn(),
}));
vi.mock('./sync', () => ({ sync: { encryption: null } }));
vi.mock('./apiSocket', () => ({ apiSocket: { emitWithAck: vi.fn() } }));
vi.mock('@/realtime/RealtimeSession', () => ({ getCurrentRealtimeSessionId: () => null, getVoiceSession: () => null }));
vi.mock('@/components/tools/knownTools', () => ({ isMutableTool: () => true }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

import { storage, type SessionListViewItem } from './storage';
import { MetadataSchema, type Metadata, type Session } from './storageTypes';

function metadata(extra: Record<string, unknown> = {}): Metadata {
    return MetadataSchema.parse({ ...rigMetadataFixture, ...extra });
}

function session(id: string, extra: Record<string, unknown> = {}): Session {
    return {
        id, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        metadata: metadata(), metadataVersion: 1,
        agentState: null, agentStateVersion: 0, thinking: false, thinkingAt: 0,
        ...extra,
    } as Session;
}

function rows(): SessionListViewItem[] {
    return storage.getState().sessionListViewData ?? [];
}

/** Every chat the list is still treating as work in flight. */
function live(): string[] {
    return rows().flatMap((item) => {
        if (item.type === 'bots') return item.sessions.map((row) => row.id);
        if (item.type !== 'project') return [];
        return item.project.workspaces.flatMap((workspace) => workspace.sessions.map((row) => row.id));
    });
}

/** The flat, date-grouped tail the archive is drawn as. */
function archived(): string[] {
    return rows().flatMap((item) => (item.type === 'session' ? [item.session.id] : []));
}

beforeEach(() => {
    storage.setState({ sessions: {}, archivingSessionIds: new Set<string>() } as any);
    storage.getState().applySessions([session('a'), session('b')]);
});

describe('archiving a chat before the machine has answered', () => {
    it('takes it out of the live list and puts it in the archive on the press', () => {
        expect(live()).toEqual(expect.arrayContaining(['a', 'b']));
        expect(archived()).toEqual([]);

        storage.getState().markArchiving('a');

        expect(live()).toEqual(['b']);
        expect(archived()).toEqual(['a']);
        // What the archive-visibility filter reads, so hiding the archive hides
        // this chat rather than leaving it half-gone.
        expect(rows().some((item) => item.type === 'session' && item.session.archived)).toBe(true);
    });

    it('brings it back when the archive fails', () => {
        storage.getState().markArchiving('a');
        storage.getState().unmarkArchiving('a');

        expect(live()).toEqual(expect.arrayContaining(['a', 'b']));
        expect(archived()).toEqual([]);
    });

    it('holds it out across everything else that rebuilds the list', () => {
        storage.getState().markArchiving('a');
        // An unrelated chat reporting in is a full rebuild, and the mark has to
        // survive it — otherwise the row reappears a second after it went.
        storage.getState().applySessions([session('b', { updatedAt: 2, seq: 2 })]);

        expect(live()).toEqual(['b']);
    });

    it('lets go once the chat is really archived', () => {
        storage.getState().markArchiving('a');
        storage.getState().applySessions([
            session('a', { seq: 2, updatedAt: 2, metadata: metadata({ lifecycleState: 'archived' }), metadataVersion: 2 }),
        ]);

        expect(storage.getState().archivingSessionIds.has('a')).toBe(false);
        expect(archived()).toEqual(['a']);
    });
});
