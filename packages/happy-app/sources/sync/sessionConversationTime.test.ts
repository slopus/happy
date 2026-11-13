import { describe, expect, it } from 'vitest';
import { getConversationMessageTime, getSnapshotConversationTime } from './sessionConversationTime';
import type { ApiSessionSnapshot } from './apiTypes';
import type { DecryptedMessage } from './storageTypes';

const base = { createdAt: 10, activeAt: 1000, updatedAt: 1000 } as ApiSessionSnapshot;
const message = (content: any): DecryptedMessage => ({ id: 'wire', seq: 1, localId: null, createdAt: 1000, content });
const state = { turnStatus: { status: 'completed', updatedAt: 20 } } as any;
const envelope = (time: number, ev: object, extra = {}) => message({ role: 'session', content: { id: 'original', time, role: 'agent', turn: 'turn', ev, ...extra } });

describe('conversation activity clock', () => {
    it('keeps yesterday completion when a resumed executor writes a startup ready today', () => {
        const ready = message({ role: 'agent', content: { type: 'event', id: 'ready', data: { type: 'ready' } } });
        expect(getConversationMessageTime(ready)).toBeNull();
        expect(getSnapshotConversationTime(base, state, ready)).toBe(20);
    });
    it('uses original timestamps for thread replay and root terminal events', () => {
        expect(getConversationMessageTime(envelope(25, { t: 'text', text: 'old answer' }))).toBe(25);
        expect(getSnapshotConversationTime(base, state, envelope(30, { t: 'turn-end', status: 'completed' }))).toBe(30);
    });
    it('ignores services and child-agent events', () => {
        expect(getConversationMessageTime(envelope(999, { t: 'service', text: 'connected' }))).toBeNull();
        expect(getConversationMessageTime(envelope(999, { t: 'text', text: 'child' }, { subagent: 'child' }))).toBeNull();
    });
    it('promotes a new user message even when the executor has not updated its turn status', () => {
        expect(getSnapshotConversationTime(base, state, message({ role: 'user', content: { type: 'text', text: 'continue' } }))).toBe(1000);
    });
    it('preserves an already verified warm-cache clock when a later control message is the tail', () => {
        expect(getSnapshotConversationTime({ ...base, lastMessageAt: 900 }, state, null)).toBe(900);
    });
    it('leaves an empty imported shell unobserved so older real history can replace its display fallback', () => {
        expect(getSnapshotConversationTime(base, null, null)).toBeNull();
    });
});
