import { describe, it, expect } from 'vitest';
import { LRUSet } from './lru';

describe('LRUSet', () => {
    it('should throw error when maxSize is 0 or negative', () => {
        expect(() => new LRUSet(0)).toThrow('LRUSet maxSize must be greater than 0');
        expect(() => new LRUSet(-1)).toThrow('LRUSet maxSize must be greater than 0');
    });

    it('should create LRUSet with positive maxSize', () => {
        const lru = new LRUSet(3);
        expect(lru.size).toBe(0);
    });

    it('should add values to the set', () => {
        const lru = new LRUSet<number>(3);
        lru.add(1);
        lru.add(2);
        lru.add(3);
        
        expect(lru.size).toBe(3);
        expect(lru.has(1)).toBe(true);
        expect(lru.has(2)).toBe(true);
        expect(lru.has(3)).toBe(true);
    });

    it('should not duplicate values', () => {
        const lru = new LRUSet<number>(3);
        lru.add(1);
        lru.add(1);
        lru.add(1);
        
        expect(lru.size).toBe(1);
        expect(lru.has(1)).toBe(true);
    });

    it('should evict least recently used item when capacity exceeded', () => {
        const lru = new LRUSet<number>(3);
        lru.add(1);
        lru.add(2);
        lru.add(3);
        lru.add(4); // Should evict 1
        
        expect(lru.size).toBe(3);
        expect(lru.has(1)).toBe(false);
        expect(lru.has(2)).toBe(true);
        expect(lru.has(3)).toBe(true);
        expect(lru.has(4)).toBe(true);
    });

    it('should move accessed items to front', () => {
        const lru = new LRUSet<number>(3);
        lru.add(1);
        lru.add(2);
        lru.add(3);
        
        // Access 1, moving it to front
        lru.has(1);
        
        // Add 4, should evict 2 (least recently used)
        lru.add(4);
        
        expect(lru.has(1)).toBe(true);
        expect(lru.has(2)).toBe(false);
        expect(lru.has(3)).toBe(true);
        expect(lru.has(4)).toBe(true);
    });

    it('should move re-added items to front', () => {
        const lru = new LRUSet<number>(3);
        lru.add(1);
        lru.add(2);
        lru.add(3);
        
        // Re-add 1, moving it to front
        lru.add(1);
        
        // Add 4, should evict 2 (least recently used)
        lru.add(4);
        
        expect(lru.has(1)).toBe(true);
        expect(lru.has(2)).toBe(false);
        expect(lru.has(3)).toBe(true);
        expect(lru.has(4)).toBe(true);
    });

    it('should delete values', () => {
        const lru = new LRUSet<number>(3);
        lru.add(1);
        lru.add(2);
        lru.add(3);
        
        expect(lru.delete(2)).toBe(true);
        expect(lru.size).toBe(2);
        expect(lru.has(2)).toBe(false);
        
        expect(lru.delete(2)).toBe(false); // Already deleted
    });

    it('should handle delete of head node', () => {
        const lru = new LRUSet<number>(3);
        lru.add(1);
        lru.add(2);
        lru.add(3); // 3 is head
        
        expect(lru.delete(3)).toBe(true);
        expect(lru.size).toBe(2);
        expect(lru.toArray()).toEqual([2, 1]);
    });

    it('should handle delete of tail node', () => {
        const lru = new LRUSet<number>(3);
        lru.add(1); // 1 is tail
        lru.add(2);
        lru.add(3);
        
        expect(lru.delete(1)).toBe(true);
        expect(lru.size).toBe(2);
        expect(lru.toArray()).toEqual([3, 2]);
    });

    it('should clear all values', () => {
        const lru = new LRUSet<number>(3);
        lru.add(1);
        lru.add(2);
        lru.add(3);
        
        lru.clear();
        
        expect(lru.size).toBe(0);
        expect(lru.has(1)).toBe(false);
        expect(lru.has(2)).toBe(false);
        expect(lru.has(3)).toBe(false);
    });

    it('should iterate values in order from most to least recently used', () => {
        const lru = new LRUSet<number>(4);
        lru.add(1);
        lru.add(2);
        lru.add(3);
        lru.add(4);
        
        const values = Array.from(lru.values());
        expect(values).toEqual([4, 3, 2, 1]);
    });

    it('should convert to array in order from most to least recently used', () => {
        const lru = new LRUSet<number>(4);
        lru.add(1);
        lru.add(2);
        lru.add(3);
        lru.add(4);
        
        expect(lru.toArray()).toEqual([4, 3, 2, 1]);
    });

    it('should work with string values', () => {
        const lru = new LRUSet<string>(3);
        lru.add('a');
        lru.add('b');
        lru.add('c');
        lru.add('d');
        
        expect(lru.has('a')).toBe(false);
        expect(lru.has('b')).toBe(true);
        expect(lru.has('c')).toBe(true);
        expect(lru.has('d')).toBe(true);
    });

    it('should work with object values', () => {
        const lru = new LRUSet<{id: number}>(2);
        const obj1 = {id: 1};
        const obj2 = {id: 2};
        const obj3 = {id: 3};
        
        lru.add(obj1);
        lru.add(obj2);
        lru.add(obj3);
        
        expect(lru.has(obj1)).toBe(false);
        expect(lru.has(obj2)).toBe(true);
        expect(lru.has(obj3)).toBe(true);
    });

    it('should handle single item capacity', () => {
        const lru = new LRUSet<number>(1);
        lru.add(1);
        lru.add(2);
        
        expect(lru.size).toBe(1);
        expect(lru.has(1)).toBe(false);
        expect(lru.has(2)).toBe(true);
    });

    it('should handle operations on empty set', () => {
        const lru = new LRUSet<number>(3);
        
        expect(lru.size).toBe(0);
        expect(lru.has(1)).toBe(false);
        expect(lru.delete(1)).toBe(false);
        expect(lru.toArray()).toEqual([]);
        expect(Array.from(lru.values())).toEqual([]);
    });
});