import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ uuidCount: 0 }));
vi.mock('expo-crypto', () => ({ randomUUID: () => `uuid-${++mocks.uuidCount}` }));

import {
    dismissPendingChat,
    failPendingChat,
    getPendingChat,
    isPendingChatId,
    openPendingChat,
    resetPendingChats,
    setPendingChatDraft,
    settlePendingChat,
    submitPendingChat,
} from './pendingChats';

beforeEach(() => {
    mocks.uuidCount = 0;
    resetPendingChats();
});

describe('openPendingChat', () => {
    it('hands back a stand-in id that is never mistaken for a session', () => {
        const chat = openPendingChat('anchor', ['anchor']);
        expect(isPendingChatId(chat.id)).toBe(true);
        expect(isPendingChatId('anchor')).toBe(false);
        expect(chat.sessionId).toBeNull();
        expect(chat.status).toBe('starting');
    });

    it('sweeps only the starts that are not coming', () => {
        const settled = openPendingChat('anchor', ['anchor']);
        const failed = openPendingChat('anchor', ['anchor']);
        const waiting = openPendingChat('anchor', ['anchor']);
        settlePendingChat(settled.id, 'session-1');
        failPendingChat(failed.id);

        openPendingChat('anchor', ['anchor']);

        // A chat that landed is still the id its screen is standing on, and
        // the record is what says which chat that id means.
        expect(getPendingChat(settled.id)?.sessionId).toBe('session-1');
        // Still starting, so still someone's open tab.
        expect(getPendingChat(waiting.id)).not.toBeNull();
        // Nobody is standing on a start that already gave up.
        expect(getPendingChat(failed.id)).toBeNull();
    });

    it('is retired by the screen that was standing on it', () => {
        const chat = openPendingChat('anchor', ['anchor']);
        settlePendingChat(chat.id, 'session-1');
        dismissPendingChat(chat.id);
        expect(getPendingChat(chat.id)).toBeNull();
    });
});

describe('settlePendingChat', () => {
    it('records the session the machine created', () => {
        const chat = openPendingChat('anchor', ['anchor']);
        settlePendingChat(chat.id, 'session-1');
        expect(getPendingChat(chat.id)?.sessionId).toBe('session-1');
    });

    it('ignores a late second answer so the screen cannot be moved twice', () => {
        const chat = openPendingChat('anchor', ['anchor']);
        settlePendingChat(chat.id, 'session-1');
        settlePendingChat(chat.id, 'session-2');
        expect(getPendingChat(chat.id)?.sessionId).toBe('session-1');
    });
});

describe('failPendingChat', () => {
    it('cannot retire a chat that already landed', () => {
        const chat = openPendingChat('anchor', ['anchor']);
        settlePendingChat(chat.id, 'session-1');
        failPendingChat(chat.id);
        expect(getPendingChat(chat.id)?.status).toBe('starting');
    });
});

describe('typing into a chat that does not exist yet', () => {
    it('keeps what was typed, so leaving the tab and coming back does not lose it', () => {
        const chat = openPendingChat('anchor', ['anchor']);
        setPendingChatDraft(chat.id, 'half a thought');
        expect(getPendingChat(chat.id)?.draft).toBe('half a thought');
        expect(getPendingChat(chat.id)?.queued).toEqual([]);
    });

    it('takes a sent message out of the composer and holds it', () => {
        const chat = openPendingChat('anchor', ['anchor']);
        setPendingChatDraft(chat.id, 'the whole thought');
        submitPendingChat(chat.id, 'the whole thought');
        expect(getPendingChat(chat.id)?.draft).toBe('');
        expect(getPendingChat(chat.id)?.queued).toEqual(['the whole thought']);
    });

    it('keeps a second send behind the first rather than on top of it', () => {
        const chat = openPendingChat('anchor', ['anchor']);
        submitPendingChat(chat.id, 'first');
        submitPendingChat(chat.id, 'second');
        expect(getPendingChat(chat.id)?.queued).toEqual(['first', 'second']);
    });

    it('has nothing to send when send is pressed on an empty composer', () => {
        const chat = openPendingChat('anchor', ['anchor']);
        submitPendingChat(chat.id, '   ');
        expect(getPendingChat(chat.id)?.queued).toEqual([]);
    });

    it('stops accepting text once the real composer owns it', () => {
        const chat = openPendingChat('anchor', ['anchor']);
        setPendingChatDraft(chat.id, 'handed over');
        settlePendingChat(chat.id, 'session-1');
        // The stand-in is on its way out and its last keystrokes must not be
        // handed over a second time, on top of the real composer's own text.
        setPendingChatDraft(chat.id, 'a straggler');
        submitPendingChat(chat.id, 'a straggler');
        expect(getPendingChat(chat.id)?.draft).toBe('handed over');
        expect(getPendingChat(chat.id)?.queued).toEqual([]);
    });
});
