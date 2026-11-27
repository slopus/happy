import { describe, expect, it, vi } from 'vitest';
import { nativeCoverageFromRows, readNativeConversationCoverage, type NativeCoverageRow } from './nativeConversationCoverage';

const user = (seq: number, localId: string, text = 'Fix parser'): NativeCoverageRow => ({ seq, localId,
    content: { role: 'user', content: { type: 'text', text } } });
const event = (seq: number, turn: string, ev: object, extra = {}): NativeCoverageRow => ({ seq,
    content: { role: 'session', content: { role: 'agent', turn, ev, ...extra } } });
const file = (seq: number): NativeCoverageRow => ({ seq,
    content: { role: 'session', content: { type: 'session', data: { role: 'user', ev: { t: 'file', ref: 'encrypted-image' } } } } });
const turn = (start = 1, id = 'native-turn', localId = 'input'): NativeCoverageRow[] => [
    user(start, localId), event(start + 1, id, { t: 'turn-start', localIds: [localId] }),
    event(start + 2, id, { t: 'text', text: 'Done' }), event(start + 3, id, { t: 'turn-end', status: 'completed' }),
];
const coverage = (rows: NativeCoverageRow[], afterSeq = 0) => nativeCoverageFromRows('segment', rows.at(-1)?.seq ?? afterSeq, afterSeq, rows);

describe('proved native input coverage', () => {
    it('covers a normal completed native input and its own result', () => {
        expect(coverage(turn())).toEqual({ sessionId: 'segment', throughSeq: 4, afterSeq: 0 });
    });
    it.each(['failed', 'cancelled'])('does not cover a %s turn merely because its worker is idle', status => {
        const rows = turn(); rows[3] = event(4, 'native-turn', { t: 'turn-end', status });
        expect(coverage(rows).throughSeq).toBe(0);
    });
    it('does not cover queued or rejected user input lacking a completed native receipt', () => {
        expect(coverage([user(1, 'never-consumed'), event(2, 'another', { t: 'turn-end', status: 'completed' })]).throughSeq).toBe(0);
    });
    it('does not count a locally completed Codex command as native input delivery', () => {
        expect(coverage(turn(1, 'codex-command-uuid')).throughSeq).toBe(0);
    });
    it('leaves slash commands in the historical preview even if their UI turn completed', () => {
        const rows = turn(); rows[0] = user(1, 'input', '/status');
        expect(coverage(rows).throughSeq).toBe(0);
    });
    it('checks original displayText when the first prompt contains a historical prefix', () => {
        const rows = turn(); rows[0].content = { role: 'user', content: { text: 'historical prefix then /status' }, meta: { displayText: '/status' } };
        expect(coverage(rows).throughSeq).toBe(0);
    });
    it('does not infer file consumption from a completed text input batch', () => {
        const rows = [file(1), ...turn(2)];
        expect(coverage(rows).throughSeq).toBe(0);
    });
    it('does not cover a standalone unconsumed user file', () => {
        expect(coverage([file(1), event(2, 'other', { t: 'text', text: 'status' })]).throughSeq).toBe(0);
    });
    it('an unmatched file/input batch limits the prefix before its first attachment', () => {
        expect(coverage([...turn(), file(5), user(6, 'cancelled'), ...turn(7, 'next', 'next-input')]).throughSeq).toBe(4);
    });
    it('does not skip a hole just because a later normal turn completed', () => {
        expect(coverage([...turn(), user(5, 'rejected'), ...turn(6, 'next', 'next-input')]).throughSeq).toBe(4);
    });
    it('does not accept a subagent turn as the root input receipt', () => {
        const rows = turn(); rows[1] = event(2, 'native-turn', { t: 'turn-start', localIds: ['input'] }, { subagent: 'child' });
        expect(coverage(rows).throughSeq).toBe(0);
    });
    it('keeps reset boundaries as the first admissible sequence', () => {
        expect(coverage([...turn(), ...turn(5, 'after-clear', 'fresh')], 4)).toEqual({ sessionId: 'segment', throughSeq: 8, afterSeq: 4 });
    });
    it('includes legacy/native-generated outputs without claiming any new raw user input', () => {
        expect(coverage([{ seq: 1, content: { role: 'agent', content: { type: 'output', data: {} } } }]).throughSeq).toBe(1);
    });
    it('never crosses an unreadable record', () => {
        expect(coverage([...turn(), { seq: 5, content: null }, ...turn(6, 'next', 'next-input')]).throughSeq).toBe(4);
    });
});

describe('durable coverage page traversal', () => {
    it('reads every page once and ignores records appended beyond the snapshot frontier', async () => {
        const rows = turn(); const readPage = vi.fn().mockResolvedValueOnce({ messages: rows.slice(0, 2), hasMore: true })
            .mockResolvedValueOnce({ messages: [...rows.slice(2), user(5, 'late')], hasMore: true });
        expect(await readNativeConversationCoverage({ sessionId: 'segment', throughSeq: 4, afterSeq: 0, readPage })).toEqual({ sessionId: 'segment', throughSeq: 4, afterSeq: 0 });
        expect(readPage.mock.calls).toEqual([[0], [2]]);
    });
    it('rejects partial pages and stalled pagination instead of claiming their frontier', async () => {
        const readPage = vi.fn(async () => ({ messages: [user(2, 'missing-first')], hasMore: false }));
        await expect(readNativeConversationCoverage({ sessionId: 'segment', throughSeq: 4, afterSeq: 0, readPage })).rejects.toThrow('incomplete');
        readPage.mockResolvedValue({ messages: [], hasMore: true });
        await expect(readNativeConversationCoverage({ sessionId: 'segment', throughSeq: 4, afterSeq: 0, readPage })).rejects.toThrow('advance');
    });
});
