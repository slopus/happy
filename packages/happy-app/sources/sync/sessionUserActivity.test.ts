import { describe, expect, it } from 'vitest';
import { getUserMessageTime, getSnapshotUserMessageTime } from './sessionUserActivity';

const message = (content: any) => ({ id: 'wire', seq: 1, localId: null, createdAt: 999, content });
const user = (at?: number) => message({ role: 'user', content: { type: 'text', text: 'continue' }, meta: { userSentAt: at } });
describe('verified user submission clock', () => {
    it('accepts only marked user sends and retains the original marker through replay', () => {
        expect(getUserMessageTime(user(20))).toBe(20);
        expect(getUserMessageTime({ ...user(20), createdAt: 9999 })).toBe(20);
        expect(getUserMessageTime(user())).toBeNull();
        expect(getUserMessageTime(message({ role: 'agent', content: { type: 'text', text: 'reply' }, meta: { userSentAt: 999 } }))).toBeNull();
        expect(getUserMessageTime(message({ role: 'session', content: { id: 'child', time: 1000, role: 'user', subagent: 'child', ev: { t: 'text', text: 'child' } }, meta: { userSentAt: 1000 } }))).toBeNull();
    });
    it('restores from encrypted metadata even when the latest tail is an agent response', () => {
        const snapshot = { createdAt: 10, lastMessageAt: 1000 } as any;
        expect(getSnapshotUserMessageTime(snapshot, { lastUserMessageAt: 20 } as any, null)).toBe(20);
        expect(getSnapshotUserMessageTime({ ...snapshot, lastUserMessageAt: 30 }, { lastUserMessageAt: 20 } as any, user(25))).toBe(30);
        expect(getSnapshotUserMessageTime(snapshot, null, user())).toBeNull();
    });
});
