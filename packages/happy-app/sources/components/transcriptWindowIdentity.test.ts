import { expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({ View: 'View' }));
import { reconcileTranscriptIdentities } from './transcriptWindowIdentity';
const group = (ids: string[]) => ({ type: 'agent-work-group', id: ids.join('-'), messages: ids.map(id => ({ id })) }) as any;
const adapter = { key: 'scope', read: async () => null, save() {}, wireId: (id: string) => id,
    wireSeq: () => null, blockKey: () => 'text:0' };
it('gives the surviving identity to the largest part of a split group', () => {
    const before = reconcileTranscriptIdentities([group(['1', '2', '3', '4', '5'])], adapter);
    const next = reconcileTranscriptIdentities([group(['1']), group(['2', '3', '4', '5'])], adapter, before.identities);
    expect(next.keyed[1].renderKey).toBe(before.keyed[0].renderKey);
    expect(new Set(next.keyed.map(row => row.renderKey)).size).toBe(2);
});
it('inherits one identity when overlapping groups merge and retains no previous payloads', () => {
    const before = reconcileTranscriptIdentities([group(['1', '2', '3']), group(['4'])], adapter);
    const next = reconcileTranscriptIdentities([group(['2', '3', '4', '5'])], adapter, before.identities);
    expect(next.keyed[0].renderKey).toBe(before.keyed[0].renderKey);
    expect([...next.identities[0].members]).toEqual(['2', '3', '4', '5']);
});
it('does not transfer a row identity between sessions with identical provider message IDs', () => {
    const scoped = (sessionId: string, ids: string[]) => ({ ...group(ids), source: { sessionId, metadata: null, readOnly: true, reading: adapter } });
    const before = reconcileTranscriptIdentities([scoped('old', ['1', '2']), scoped('new', ['1', '2'])], undefined);
    expect(new Set(before.keyed.map(row => row.renderKey)).size).toBe(2);
    const next = reconcileTranscriptIdentities([scoped('old', ['2']), scoped('new', ['2'])], undefined, before.identities);
    expect(next.keyed.map(row => row.renderKey)).toEqual(before.keyed.map(row => row.renderKey));
});
