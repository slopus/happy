import { describe, expect, it } from 'vitest';
import { LruCache } from './lru';

describe('diff LRU', () => {
    it('evicts the least recently read entry and replaces without growing', () => {
        const cache = new LruCache<number>(2);
        cache.set('a', 1);
        cache.set('b', 2);
        expect(cache.get('a')).toBe(1);
        cache.set('c', 3);
        expect(cache.get('b')).toBeUndefined();
        cache.set('a', 4);
        expect(cache.get('c')).toBe(3);
        expect(cache.get('a')).toBe(4);
        cache.clear();
        expect(cache.get('a')).toBeUndefined();
    });

    it('bounds memory including replacement and oversized entries', () => {
        const cache = new LruCache<number>(48, 10);
        cache.set('a', 1, 5);
        cache.set('b', 2, 5);
        cache.set('b', 3, 6);
        expect(cache.get('a')).toBeUndefined();
        expect(cache.get('b')).toBe(3);
        cache.set('b', 4, 11);
        expect(cache.get('b')).toBeUndefined();
        cache.set('c', 5, 10);
        expect(cache.get('c')).toBe(5);
    });
});