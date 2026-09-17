import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    uuidCount: 0,
    drafts: {} as Record<string, string>,
    sessions: {} as Record<string, { draft?: string }>,
    sendMessage: vi.fn<(sessionId: string, text: string) => Promise<boolean>>(),
    alert: vi.fn(),
}));

vi.mock('expo-crypto', () => ({ randomUUID: () => `uuid-${++mocks.uuidCount}` }));
vi.mock('@/sync/storage', () => ({
    storage: {
        getState: () => ({
            sessions: mocks.sessions,
            updateSessionDraft: (id: string, draft: string) => {
                mocks.drafts[id] = draft;
                mocks.sessions[id] = { ...(mocks.sessions[id] ?? {}), draft };
            },
        }),
    },
}));
vi.mock('@/sync/sync', () => ({ sync: { sendMessage: mocks.sendMessage } }));
vi.mock('@/modal', () => ({ Modal: { alert: mocks.alert } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

import { getPendingChat, openPendingChat, resetPendingChats, setPendingChatDraft, submitPendingChat } from './pendingChats';
import { handOverPendingChat, retirePendingChat, returnPendingChatDraft } from './pendingChatHandover';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    mocks.uuidCount = 0;
    mocks.drafts = {};
    mocks.sessions = { anchor: {} };
    mocks.sendMessage.mockReset();
    mocks.alert.mockReset();
    resetPendingChats();
});

describe('handOverPendingChat', () => {
    it('hands a draft over and settles in the same tick when nothing was sent', () => {
        const chat = openPendingChat('anchor', ['anchor']);
        setPendingChatDraft(chat.id, 'still typing');

        handOverPendingChat(chat.id, 'real');

        expect(mocks.drafts.real).toBe('still typing');
        expect(getPendingChat(chat.id)?.sessionId).toBe('real');
        expect(mocks.sendMessage).not.toHaveBeenCalled();
    });

    it('delivers sent messages in order and settles once they are accepted', async () => {
        mocks.sendMessage.mockResolvedValue(true);
        const chat = openPendingChat('anchor', ['anchor']);
        submitPendingChat(chat.id, 'first');
        submitPendingChat(chat.id, 'second');

        handOverPendingChat(chat.id, 'real');
        // Not yet: the stand-in stays until the machine has taken the messages.
        expect(getPendingChat(chat.id)?.sessionId).toBeNull();
        await flush();

        expect(mocks.sendMessage.mock.calls.map(([, text]) => text)).toEqual(['first', 'second']);
        expect(getPendingChat(chat.id)?.sessionId).toBe('real');
        expect(mocks.drafts.real).toBeUndefined();
    });

    // A send the chat declines is not a send: the composer everywhere else
    // keeps the text until it is accepted, and the handover must not be the
    // one place that drops it.
    it('puts a rejected message and everything behind it into the draft', async () => {
        mocks.sendMessage
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false);
        const chat = openPendingChat('anchor', ['anchor']);
        submitPendingChat(chat.id, 'first');
        submitPendingChat(chat.id, 'second');
        submitPendingChat(chat.id, 'third');
        setPendingChatDraft(chat.id, 'still typing');

        handOverPendingChat(chat.id, 'real');
        await flush();

        // Nothing is sent past the rejection, so order survives.
        expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
        expect(mocks.drafts.real).toBe('second\n\nthird\n\nstill typing');
        expect(getPendingChat(chat.id)?.sessionId).toBe('real');
    });

    it('treats a send that threw the same way, and says so', async () => {
        mocks.sendMessage.mockRejectedValueOnce(new Error('socket closed'));
        const chat = openPendingChat('anchor', ['anchor']);
        submitPendingChat(chat.id, 'first');

        handOverPendingChat(chat.id, 'real');
        await flush();

        expect(mocks.alert).toHaveBeenCalledWith('common.error', 'socket closed');
        expect(mocks.drafts.real).toBe('first');
        expect(getPendingChat(chat.id)?.sessionId).toBe('real');
    });
});

describe('retirePendingChat', () => {
    // The screen standing on the stand-in may be gone by the time the start
    // fails; the text has to come back regardless of who is watching.
    it('returns the writing to the anchor and retires the tab, with nobody watching', () => {
        const chat = openPendingChat('anchor', ['anchor']);
        submitPendingChat(chat.id, 'sent into the void');
        setPendingChatDraft(chat.id, 'half a thought');

        retirePendingChat(chat.id);

        expect(mocks.drafts.anchor).toBe('sent into the void\n\nhalf a thought');
        expect(getPendingChat(chat.id)?.status).toBe('failed');
    });

    it('goes in front of a draft already on the anchor rather than replacing it', () => {
        mocks.sessions.anchor = { draft: 'the other thought' };
        const chat = openPendingChat('anchor', ['anchor']);
        setPendingChatDraft(chat.id, 'this one');

        retirePendingChat(chat.id);

        expect(mocks.drafts.anchor).toBe('this one\n\nthe other thought');
    });

    it('gives the text back once, however many times it is asked', () => {
        const chat = openPendingChat('anchor', ['anchor']);
        setPendingChatDraft(chat.id, 'once');

        retirePendingChat(chat.id);
        returnPendingChatDraft(chat.id);

        expect(mocks.drafts.anchor).toBe('once');
    });

    it('writes nothing for a stand-in nobody typed into', () => {
        const chat = openPendingChat('anchor', ['anchor']);
        retirePendingChat(chat.id);
        expect(mocks.drafts.anchor).toBeUndefined();
        expect(getPendingChat(chat.id)?.status).toBe('failed');
    });
});
