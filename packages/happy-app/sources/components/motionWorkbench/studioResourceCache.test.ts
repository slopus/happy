import { describe, expect, it } from 'vitest';
import { createStudioResourceCache } from './studioResourceCache.web';

const value = (...bytes: number[]) => new Uint8Array(bytes);
describe('studio immutable byte cache limits and owner leases', () => {
    it('keeps private copies across caller mutation and transferable buffer detachment', () => {
        const cache = createStudioResourceCache(), owner = cache.acquire('owner', () => true);
        const source = value(1, 2, 3); owner.putVerified('asset', source);
        source[0] = 9;
        const received = owner.get('asset')!;
        expect(received).toEqual(value(1, 2, 3));
        const transferred = structuredClone(received.buffer, { transfer: [received.buffer] });
        expect(received.byteLength).toBe(0);
        new Uint8Array(transferred)[1] = 8;
        expect(owner.get('asset')).toEqual(value(1, 2, 3));
    });
    it('enforces global and per-owner byte budgets with least-recently-used eviction', () => {
        const cache = createStudioResourceCache({ bytes: 8, ownerBytes: 6 });
        const a = cache.acquire('a', () => true), b = cache.acquire('b', () => true);
        a.putVerified('old', value(1, 2)); a.putVerified('keep', value(3, 4)); b.putVerified('old', value(5, 6));
        a.get('keep'); b.putVerified('new', value(7, 8, 9, 10));
        expect(a.get('old')).toBeUndefined(); expect(a.get('keep')).toEqual(value(3, 4));
        expect(b.get('old')).toEqual(value(5, 6));
        b.putVerified('over-owner', value(1, 2, 3, 4, 5));
        expect(b.get('old')).toBeUndefined(); expect(b.get('new')).toBeUndefined();
        expect(b.get('over-owner')).toHaveLength(5);
        b.putVerified('oversized', new Uint8Array(7));
        expect(b.get('oversized')).toBeUndefined(); expect(b.get('over-owner')).toHaveLength(5);
    });
    it('bounds even zero-byte entries per owner and globally', () => {
        const cache = createStudioResourceCache({ entries: 3, ownerEntries: 2 });
        const a = cache.acquire('a', () => true), b = cache.acquire('b', () => true);
        a.putVerified('a0', value()); a.putVerified('a1', value()); a.putVerified('a2', value());
        expect(a.get('a0')).toBeUndefined();
        b.putVerified('b0', value()); b.putVerified('b1', value());
        expect(a.get('a1')).toBeUndefined();
        expect(a.get('a2')).toEqual(value()); expect(b.get('b0')).toEqual(value()); expect(b.get('b1')).toEqual(value());
    });
    it('expires bytes on use without extending their lifetime on a hit', () => {
        let time = 0;
        const cache = createStudioResourceCache({ ttlMs: 100 }, () => time), owner = cache.acquire('owner', () => true);
        owner.putVerified('asset', value(1)); time = 99;
        expect(owner.get('asset')).toEqual(value(1)); time = 100;
        expect(owner.get('asset')).toBeUndefined();
    });
    it('bounds empty owner records and rejects late writes from evicted leases', () => {
        const cache = createStudioResourceCache({ owners: 2 });
        const old = cache.acquire('old', () => true);
        cache.acquire('empty', () => true); cache.acquire('new', () => true);
        old.putVerified('late', value(1));
        expect(cache.acquire('old', () => true).get('late')).toBeUndefined();
    });
    it('invalidates old account bytes and never lets an old lease replace the next owner', () => {
        const cache = createStudioResourceCache(); let current = true;
        const old = cache.acquire('owner', () => current); old.putVerified('asset', value(1));
        current = false;
        expect(old.get('asset')).toBeUndefined();
        const next = cache.acquire('owner', () => true); next.putVerified('asset', value(2));
        current = true; old.putVerified('asset', value(9)); old.invalidate();
        expect(next.get('asset')).toEqual(value(2));
        cache.clear(); next.putVerified('late', value(3));
        expect(cache.acquire('owner', () => true).get('late')).toBeUndefined();
    });
});
