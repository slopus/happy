import { describe, expect, it, vi } from 'vitest';
vi.mock('@/components/tools/knownTools', () => ({ knownTools: {} }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
import { composeContinuationItems, visibleContinuationIds } from './continuationTranscript';
const msg = (text: string) => ({ kind: 'user-text' as const, id: 'same-id', localId: null, text, createdAt: 1 });
describe('continuation transcript', () => {
    it('keeps session order and original identities even with matching IDs and timestamps', () => {
        const older = msg('old'); const newer = msg('new');
        const items = composeContinuationItems([
            { id: 'new', metadata: { continuationOfSessionId: 'old' } as any, messages: [newer] },
            { id: 'old', metadata: null, messages: [older] },
        ], 'new', false, false);
        expect(items.map(i => i.source?.sessionId)).toEqual(['new', 'new', 'old']);
        expect(new Set(items.map(i => i.id)).size).toBe(3);
        expect(items[0].type === 'message' && items[0].message).toBe(newer);
        expect(items[2].type === 'message' && items[2].message).toBe(older);
        expect(items[2].source?.readOnly).toBe(true);
        expect(items[1].continuationBoundary).toBe(true);
        expect(items[1].continuationWaiting).toBe(false);
    });
    it('shows a boundary for an empty new session without manufacturing a stored message', () => {
        const items = composeContinuationItems([{ id: 'new', metadata: { continuationOfSessionId: 'old' } as any, messages: [] }], 'new', true, false);
        expect(items).toHaveLength(1);
        expect(items[0].continuationBoundary).toBe(true);
        expect(items[0].continuationWaiting).toBe(true);
    });
    it('hides newer sections when an older session has a missing newer page, rather than showing a gap', () => {
        expect(visibleContinuationIds(['c', 'b', 'a'], { b: { hasMoreNewer: true } })).toEqual(['b', 'a']);
        expect(visibleContinuationIds(['c', 'b', 'a'], { a: { hasMoreNewer: true } })).toEqual(['a']);
        expect(visibleContinuationIds(['c', 'b'], {})).toEqual(['c', 'b']);
    });
});
it('projects browser runs per source and hides linked frames without losing their source identity', () => {
    const skill: any = { kind: 'tool-call', id: 'skill', localId: null, createdAt: 1, children: [], tool: {
        name: 'Skill', state: 'completed', input: { skillNames: ['ego-browser'], runId: 'run' }, createdAt: 1, startedAt: 1, completedAt: 2, description: null,
    } };
    const frame: any = { kind: 'tool-call', id: 'frame', localId: null, createdAt: 3, children: [], tool: {
        name: 'file', state: 'completed', input: { ref: 'attachment://old-frame', name: 'frame.png', source: 'browser_step', browserStep: { label: 'Done', runId: 'run', skillName: 'ego-browser' }, image: { width: 800, height: 600 } }, createdAt: 3, startedAt: 3, completedAt: 3, description: null,
    } };
    const items = composeContinuationItems([{ id: 'new', metadata: null, messages: [] }, { id: 'old', metadata: null, messages: [frame, skill] }], 'new', false, false);
    expect(items).toHaveLength(1);
    expect(items[0].source?.sessionId).toBe('old');
    expect(items[0].source?.browserRuns?.[0].steps[0].id).toBe('frame');
});
