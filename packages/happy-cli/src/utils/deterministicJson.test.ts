import { describe, expect, it } from 'vitest';
import { deterministicStringify, hashObject, deepEqual, objectKey } from './deterministicJson';

describe('deterministicStringify', () => {
    it('should produce consistent output for objects with different key orders', () => {
        const obj1 = { b: 2, a: 1, c: 3 };
        const obj2 = { a: 1, c: 3, b: 2 };
        const obj3 = { c: 3, b: 2, a: 1 };

        const result1 = deterministicStringify(obj1);
        const result2 = deterministicStringify(obj2);
        const result3 = deterministicStringify(obj3);

        expect(result1).toBe(result2);
        expect(result2).toBe(result3);
        expect(result1).toBe('{"a":1,"b":2,"c":3}');
    });

    it('should handle nested objects consistently', () => {
        const obj1 = {
            outer: { z: 26, y: 25 },
            inner: { b: 2, a: 1 }
        };
        const obj2 = {
            inner: { a: 1, b: 2 },
            outer: { y: 25, z: 26 }
        };

        expect(deterministicStringify(obj1)).toBe(deterministicStringify(obj2));
    });

    it('should handle arrays without sorting by default', () => {
        const obj = { arr: [3, 1, 2] };
        expect(deterministicStringify(obj)).toBe('{"arr":[3,1,2]}');
    });

    it('should sort arrays when sortArrays is true', () => {
        const obj = { arr: [3, 1, 2] };
        const result = deterministicStringify(obj, { sortArrays: true });
        expect(result).toBe('{"arr":[1,2,3]}');
    });

    it('should handle undefined values according to options', () => {
        const obj = { a: 1, b: undefined, c: 3 };

        // Default: omit
        expect(deterministicStringify(obj)).toBe('{"a":1,"c":3}');

        // null behavior
        expect(deterministicStringify(obj, { undefinedBehavior: 'null' }))
            .toBe('{"a":1,"b":null,"c":3}');

        // throw behavior
        expect(() => deterministicStringify(obj, { undefinedBehavior: 'throw' }))
            .toThrow('Undefined value at key: b');
    });

    it('should handle special types', () => {
        const date = new Date('2024-01-01T00:00:00.000Z');
        const obj = {
            date,
            regex: /test/gi,
            bigint: BigInt(123),
            func: () => {},
            symbol: Symbol('test')
        };

        const result = deterministicStringify(obj);
        expect(result).toBe('{"bigint":"123n","date":"2024-01-01T00:00:00.000Z","regex":"/test/gi"}');
    });

    it('should detect circular references', () => {
        const obj: any = { a: 1 };
        obj.circular = obj;

        expect(() => deterministicStringify(obj)).toThrow('Circular reference detected');
    });

    it('should handle complex nested structures', () => {
        const obj = {
            users: [
                { id: 2, name: 'Bob', tags: ['admin', 'user'] },
                { id: 1, name: 'Alice', tags: ['user'] }
            ],
            metadata: {
                version: '1.0',
                counts: { total: 2, active: 2 }
            }
        };

        const str1 = deterministicStringify(obj);
        const str2 = deterministicStringify(obj);
        expect(str1).toBe(str2);
    });
});

describe('hashObject', () => {
    it('should produce consistent hashes for equivalent objects', () => {
        const obj1 = { b: 2, a: 1 };
        const obj2 = { a: 1, b: 2 };

        const hash1 = hashObject(obj1);
        const hash2 = hashObject(obj2);

        expect(hash1).toBe(hash2);
        expect(hash1).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
    });

    it('should produce different hashes for different objects', () => {
        const obj1 = { a: 1 };
        const obj2 = { a: 2 };

        expect(hashObject(obj1)).not.toBe(hashObject(obj2));
    });

    it('should support different encodings', () => {
        const obj = { a: 1 };

        const hex = hashObject(obj, undefined, 'hex');
        const base64 = hashObject(obj, undefined, 'base64');
        const base64url = hashObject(obj, undefined, 'base64url');

        expect(hex).toMatch(/^[a-f0-9]{64}$/);
        expect(base64).toMatch(/^[A-Za-z0-9+/]+=*$/);
        expect(base64url).toMatch(/^[A-Za-z0-9_-]+$/);
    });
});

describe('deepEqual', () => {
    it('should return true for deeply equal objects', () => {
        const obj1 = { a: 1, b: { c: 2 } };
        const obj2 = { b: { c: 2 }, a: 1 };

        expect(deepEqual(obj1, obj2)).toBe(true);
    });

    it('should return false for different objects', () => {
        const obj1 = { a: 1 };
        const obj2 = { a: 2 };

        expect(deepEqual(obj1, obj2)).toBe(false);
    });

    it('should handle arrays', () => {
        expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
        expect(deepEqual([1, 2, 3], [3, 2, 1])).toBe(false);
        expect(deepEqual([1, 2, 3], [3, 2, 1], { sortArrays: true })).toBe(true);
    });
});

describe('objectKey', () => {
    it('should produce stable keys for objects', () => {
        const obj1 = { b: 2, a: 1 };
        const obj2 = { a: 1, b: 2 };

        const key1 = objectKey(obj1);
        const key2 = objectKey(obj2);

        expect(key1).toBe(key2);
        expect(key1).toMatch(/^[A-Za-z0-9_-]+$/); // base64url
    });

    it('should be suitable for Map keys', () => {
        const map = new Map<string, any>();

        const obj1 = { data: 'test', id: 1 };
        const obj2 = { id: 1, data: 'test' };

        map.set(objectKey(obj1), 'value1');
        expect(map.get(objectKey(obj2))).toBe('value1');
    });
});