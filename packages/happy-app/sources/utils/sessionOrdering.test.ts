import { describe, expect, it } from 'vitest';
import { compareSessionOrder, getSessionUserTime } from './sessionOrdering';
import { sortSessionsForList } from './sessionPinning';

describe('user-driven session ordering', () => {
    const order = (rows: any[]) => rows.slice().sort(compareSessionOrder).map(row => row.id);
    it('keeps two running agents fixed through alternating output and status timestamps', () => {
        const a = { id: 'a', state: 'running', createdAt: 1, lastUserMessageAt: 100, lastMessageAt: 300 };
        const b = { id: 'b', state: 'running', createdAt: 2, lastUserMessageAt: 90, lastMessageAt: 400 };
        expect(order([a, b])).toEqual(['a', 'b']);
        b.lastMessageAt = 500;
        expect(order([a, b])).toEqual(['a', 'b']);
        a.lastMessageAt = 600;
        expect(order([a, b])).toEqual(['a', 'b']);
        expect(order([{ ...a, agentState: { turnStatus: { status: 'running', updatedAt: 9000 } } }, b])).toEqual(['a', 'b']);
        b.lastUserMessageAt = 110;
        expect(order([a, b])).toEqual(['b', 'a']);
    });
    it('gives running and permission-required one equal priority band, including over a completed pin', () => {
        const rows = [
            { id: 'done', state: 'completed', createdAt: 4, lastUserMessageAt: 900 },
            { id: 'run', state: 'running', createdAt: 3, lastUserMessageAt: 100 },
            { id: 'permission', state: 'permission_required', createdAt: 2, lastUserMessageAt: 90 },
        ];
        expect(sortSessionsForList(rows, ['done']).map(row => row.id)).toEqual(['run', 'permission', 'done']);
        expect(order([{ ...rows[1], state: 'permission_required' }, { ...rows[2], state: 'running' }])).toEqual(['run', 'permission']);
        rows[1].state = 'completed';
        expect(order(rows)).toEqual(['permission', 'done', 'run']);
    });
    it('does not use presence, draft, old history, or completion time as a user clock', () => {
        expect(getSessionUserTime({ id: 'legacy', createdAt: 50, ...{ lastMessageAt: 999, activityAt: 999, activeAt: 999 } })).toBe(50);
        const rows = [{ id: 'a', createdAt: 10, lastUserMessageAt: 20 }, { id: 'b', createdAt: 11, lastUserMessageAt: 19 }];
        expect(order(rows.map(row => ({ ...row, draft: 'typing', updatedAt: 1000, active: true })))).toEqual(['a', 'b']);
        expect(order(JSON.parse(JSON.stringify(rows)).reverse())).toEqual(['a', 'b']);
    });
});
