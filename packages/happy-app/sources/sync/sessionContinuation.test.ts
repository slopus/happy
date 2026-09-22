import { describe, expect, it } from 'vitest';
import { createContinuationCoordinator, type ContinuationRecord } from './sessionContinuationCoordinator';

function fixture() {
    const records = new Map<string, ContinuationRecord>();
    const created: string[] = [];
    const linked: string[] = [];
    let failLink = false;
    const coordinator = createContinuationCoordinator({
        read: id => records.get(id),
        write: (id, record) => { records.set(id, record); },
        spawn: async () => { const id = `new-${created.length}`; created.push(id); return id; },
        link: async (source, id) => { if (failLink) throw new Error('hydrate'); linked.push(`${source}/${id}`); },
        assertCurrent: () => {},
    });
    return { records, created, linked, coordinator, failLink: () => { failLink = true; }, recover: () => { failLink = false; } };
}
describe('fresh continuation creation', () => {
    it('shares a single creation across independent simultaneous callers and repeated clicks', async () => {
        const f = fixture();
        expect(await Promise.all([f.coordinator('old'), f.coordinator('old')])).toEqual(['new-0', 'new-0']);
        expect(await f.coordinator('old')).toBe('new-0');
        expect(f.created).toEqual(['new-0']);
        expect(f.linked).toEqual(['old/new-0']);
    });
    it('retries linking the already-created session after hydration failed', async () => {
        const f = fixture(); f.failLink();
        await expect(f.coordinator('old')).rejects.toThrow('hydrate');
        expect(f.records.get('old')).toEqual({ phase: 'created', sessionId: 'new-0' });
        f.recover();
        expect(await f.coordinator('old')).toBe('new-0');
        expect(f.created).toHaveLength(1);
    });
    it('does not spawn again after an unknown creation outcome', async () => {
        const f = fixture(); f.records.set('old', { phase: 'starting' });
        await expect(f.coordinator('old')).rejects.toThrow('continuation-outcome-unknown');
        expect(f.created).toHaveLength(0);
    });
    it('allows another fresh session from the successor', async () => {
        const f = fixture();
        const next = await f.coordinator('old');
        expect(await f.coordinator(next)).toBe('new-1');
        expect(f.linked).toEqual(['old/new-0', 'new-0/new-1']);
    });
});
