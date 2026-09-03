import { describe, expect, it } from 'vitest';
import { boundedJsonUtf8ByteLength } from './boundedJsonUtf8ByteLength';

describe('boundedJsonUtf8ByteLength', () => {
    it('counts JSON punctuation, omission, null coercion, escapes, and UTF-8 strings', () => {
        expect(boundedJsonUtf8ByteLength({ keep: null, drop: undefined }, {
            maxBytes: 1_024,
        })).toBe(13);
        expect(boundedJsonUtf8ByteLength([undefined, () => {}, Symbol('drop')], {
            maxBytes: 1_024,
        })).toBe(16);
        expect(boundedJsonUtf8ByteLength('"\\\n', { maxBytes: 1_024 })).toBe(8);
        expect(boundedJsonUtf8ByteLength('é😀\ud800', { maxBytes: 1_024 })).toBe(14);
        expect(boundedJsonUtf8ByteLength(Number.NaN, { maxBytes: 1_024 })).toBe(4);
    });

    it('returns unknown for cycles, BigInt, accessors, throwing proxies, and exhausted bounds', () => {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        let getterCalls = 0;
        const getter = Object.defineProperty({}, 'secret', {
            enumerable: true,
            get() {
                getterCalls += 1;
                return 'must-not-run';
            },
        });
        const throwingProxy = new Proxy({}, {
            ownKeys() {
                throw new Error('proxy trap');
            },
        });

        expect(boundedJsonUtf8ByteLength(cyclic, { maxBytes: 1_024 })).toBeNull();
        expect(boundedJsonUtf8ByteLength(1n, { maxBytes: 1_024 })).toBeNull();
        expect(boundedJsonUtf8ByteLength(getter, { maxBytes: 1_024 })).toBeNull();
        expect(getterCalls).toBe(0);
        expect(boundedJsonUtf8ByteLength(throwingProxy, { maxBytes: 1_024 })).toBeNull();
        expect(boundedJsonUtf8ByteLength([[[['too deep']]]], {
            maxBytes: 1_024,
            maxDepth: 2,
        })).toBeNull();
        expect(boundedJsonUtf8ByteLength([1, 2, 3], {
            maxBytes: 1_024,
            maxNodes: 2,
        })).toBeNull();
    });

    it('caps a huge lazy array without visiting or encoding its full value', () => {
        const target: string[] = [];
        target.length = 1_000_000;
        let elementDescriptorVisits = 0;
        const lazy = new Proxy(target, {
            getOwnPropertyDescriptor(source, property) {
                if (typeof property === 'string' && /^\d+$/.test(property)) {
                    elementDescriptorVisits += 1;
                    return {
                        configurable: true,
                        enumerable: true,
                        writable: true,
                        value: '四'.repeat(1_024),
                    };
                }
                return Reflect.getOwnPropertyDescriptor(source, property);
            },
        });
        const cap = 256 * 1_024 + 1;

        expect(boundedJsonUtf8ByteLength(lazy, {
            maxBytes: cap,
            maxDepth: 32,
            maxNodes: 1_000,
        })).toBe(cap);
        expect(elementDescriptorVisits).toBeGreaterThan(0);
        expect(elementDescriptorVisits).toBeLessThan(100);
    });

    it('rejects cyclic prototype traps with one bounded lookup', () => {
        let prototypeLookups = 0;
        let cyclicPrototype: object;
        cyclicPrototype = new Proxy({}, {
            getPrototypeOf() {
                prototypeLookups += 1;
                if (prototypeLookups > 4) {
                    throw new Error('legacy prototype walk did not terminate');
                }
                return cyclicPrototype;
            },
        });

        expect(boundedJsonUtf8ByteLength(cyclicPrototype, { maxBytes: 1_024 })).toBeNull();
        expect(prototypeLookups).toBe(1);
        expect(boundedJsonUtf8ByteLength(Object.create({ inherited: true }), {
            maxBytes: 1_024,
        })).toBeNull();
    });

    it('rejects sparse arrays with custom prototypes and inherited indexed values', () => {
        const sparse: unknown[] = [];
        sparse.length = 1;
        const customPrototype = Object.create(Array.prototype) as Record<number, unknown>;
        customPrototype[0] = 'must-not-be-counted-as-null';
        Object.setPrototypeOf(sparse, customPrototype);

        expect(boundedJsonUtf8ByteLength(sparse, { maxBytes: 1_024 })).toBeNull();
    });

    it('rejects serialization hooks and non-JSON container prototypes without invoking hooks', () => {
        let toJsonCalls = 0;
        const ownToJson = {
            toJSON() {
                toJsonCalls += 1;
                return { secret: true };
            },
        };
        const accessorToJson = Object.defineProperty({}, 'toJSON', {
            get() {
                toJsonCalls += 1;
                return () => null;
            },
        });

        expect(boundedJsonUtf8ByteLength(ownToJson, { maxBytes: 1_024 })).toBeNull();
        expect(boundedJsonUtf8ByteLength(accessorToJson, { maxBytes: 1_024 })).toBeNull();
        expect(toJsonCalls).toBe(0);
        expect(boundedJsonUtf8ByteLength(new Date(0), { maxBytes: 1_024 })).toBeNull();
        expect(boundedJsonUtf8ByteLength(new Map(), { maxBytes: 1_024 })).toBeNull();
        expect(boundedJsonUtf8ByteLength(new Uint8Array([1]), { maxBytes: 1_024 })).toBeNull();
        expect(boundedJsonUtf8ByteLength(() => 'omitted', { maxBytes: 1_024 })).toBeNull();
    });
});
