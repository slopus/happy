import { describe, expect, it } from 'vitest';

import { neighbouringTabId, resolveWorktreeTabs } from './worktreeTabs';
import type { PendingChat } from '@/sync/pendingChats';
import type { SessionRowData } from '@/sync/storage';

// Only the identity the resolver reads; the rest of a row is the strip's.
function tab(id: string): SessionRowData {
    return { id } as SessionRowData;
}

function chat(overrides: Partial<PendingChat> & { id: string }): PendingChat {
    return {
        anchorSessionId: 'anchor',
        sessionId: null,
        knownSessionIds: ['anchor'],
        status: 'starting',
        draft: '',
        queued: [],
        createdAt: 0,
        ...overrides,
    };
}

describe('neighbouringTabId', () => {
    const tabs = [tab('first'), tab('middle'), tab('last')];

    it('hands over to the tab on the left', () => {
        expect(neighbouringTabId(tabs, 'last')).toBe('middle');
        expect(neighbouringTabId(tabs, 'middle')).toBe('first');
    });

    it('goes right when there is nothing to the left', () => {
        expect(neighbouringTabId(tabs, 'first')).toBe('middle');
    });

    it('has nobody to hand over to when it is the only tab', () => {
        expect(neighbouringTabId([tab('only')], 'only')).toBeNull();
    });

    it('answers for a chat that is not a tab at all', () => {
        expect(neighbouringTabId(tabs, 'elsewhere')).toBeNull();
    });
});

describe('resolveWorktreeTabs', () => {
    it('leaves a checkout with nothing being started alone', () => {
        const tabs = [tab('anchor'), tab('other')];
        expect(resolveWorktreeTabs({ tabs, pending: [] })).toEqual({ tabs, pending: [] });
    });

    it('draws the stand-in while its session is still unnamed', () => {
        const opening = chat({ id: 'pending-1' });
        const resolved = resolveWorktreeTabs({ tabs: [tab('anchor')], pending: [opening] });
        expect(resolved.tabs.map((item) => item.id)).toEqual(['anchor']);
        expect(resolved.pending).toEqual([opening]);
    });

    it('holds back the arrival its stand-in is already standing for', () => {
        // The session reached the list before the request that made it came
        // back with its name — the case that used to draw the chat twice.
        const opening = chat({ id: 'pending-1' });
        const resolved = resolveWorktreeTabs({
            tabs: [tab('anchor'), tab('arrival')],
            pending: [opening],
        });
        expect(resolved.tabs.map((item) => item.id)).toEqual(['anchor']);
        expect(resolved.pending).toEqual([opening]);
    });

    it('hands the tab over once the stand-in knows its name', () => {
        const named = chat({ id: 'pending-1', sessionId: 'arrival' });
        const resolved = resolveWorktreeTabs({
            tabs: [tab('anchor'), tab('arrival')],
            pending: [named],
        });
        expect(resolved.tabs.map((item) => item.id)).toEqual(['anchor', 'arrival']);
        expect(resolved.pending).toEqual([]);
    });

    it('does not put a named stand-in back when its chat leaves the checkout', () => {
        // Archiving is how a chat leaves, and the stand-in used to come back to
        // hold a place for it — a third tab that opened an archived chat.
        const named = chat({ id: 'pending-1', sessionId: 'archived' });
        const resolved = resolveWorktreeTabs({ tabs: [tab('anchor')], pending: [named] });
        expect(resolved.tabs.map((item) => item.id)).toEqual(['anchor']);
        expect(resolved.pending).toEqual([]);
    });

    it('stops holding an arrival back once the stand-in is named', () => {
        const named = chat({ id: 'pending-1', sessionId: 'arrival' });
        const resolved = resolveWorktreeTabs({
            tabs: [tab('anchor'), tab('arrival'), tab('elsewhere')],
            pending: [named],
        });
        expect(resolved.tabs.map((item) => item.id)).toEqual(['anchor', 'arrival', 'elsewhere']);
    });

    it('gives concurrent starts an arrival each, in the order asked', () => {
        const first = chat({ id: 'pending-1', createdAt: 1 });
        const second = chat({ id: 'pending-2', createdAt: 2, knownSessionIds: ['anchor'] });
        const resolved = resolveWorktreeTabs({
            tabs: [tab('anchor'), tab('arrival-1'), tab('arrival-2')],
            pending: [first, second],
        });
        expect(resolved.tabs.map((item) => item.id)).toEqual(['anchor']);
        expect(resolved.pending).toEqual([first, second]);
    });

    it('holds back one arrival per start, not every newcomer', () => {
        const opening = chat({ id: 'pending-1' });
        const resolved = resolveWorktreeTabs({
            tabs: [tab('anchor'), tab('arrival'), tab('elsewhere')],
            pending: [opening],
        });
        // A chat opened from another device is delayed by nothing and shown.
        expect(resolved.tabs.map((item) => item.id)).toEqual(['anchor', 'elsewhere']);
    });
});
