import { describe, it, expect } from '@/dev/testRunner';
import { deriveKey, deriveSecretKeyTreeRoot, deriveSecretKeyTreeChild } from './deriveKey';
import { encodeUTF8 } from './text';
import { encodeHex } from './hex';

describe('Key Derivation Tests', () => {
    // Test vectors
    const testVectors = [
        {
            seed: encodeUTF8('test seed'),
            usage: 'test usage',
            path: ['child1', 'child2'],
            expectedRootKey: 'E6E55652456F9FE47D6FF46CA3614E85B499F77E7B340FBBB1553307CEDC1E74',
            expectedRootChainCode: '81ECFD529E8EF95DD5C06CFE169158CF02B7C09A33746C527B4BD4D740B9CC5A',
            expectedChildKey: 'D5EAE039FB9143E9433BB1ADC104C2FF5D7FA6751E680B4B1CBC7ADF1AF65BF3',
            expectedChildChainCode: '8AA339189BAB38B51DD8770B1498682BCB03E42240E273041ACC7E3DF62FE868',
            expectedFinalKey: '1011C097D2105D27362B987A631496BBF68B836124D1D072E9D1613C6028CF75',
            expectedFinalChainCode: 'BE98EF894B1C62B8253B480DD415B6EB707028362F2FCECF2CB3871DB8B007F1'
        }
    ];

    it('deriveSecretKeyTreeRoot should produce correct root key and chain code', async () => {
        for (const vector of testVectors) {
            const result = await deriveSecretKeyTreeRoot(vector.seed, vector.usage);
            expect(encodeHex(result.key)).toEqual(vector.expectedRootKey);
            expect(encodeHex(result.chainCode)).toEqual(vector.expectedRootChainCode);
        }
    });

    it('deriveSecretKeyTreeChild should produce correct child key and chain code', async () => {
        for (const vector of testVectors) {
            const rootState = await deriveSecretKeyTreeRoot(vector.seed, vector.usage);
            const childState = await deriveSecretKeyTreeChild(rootState.chainCode, vector.path[0]);
            const childState2 = await deriveSecretKeyTreeChild(childState.chainCode, vector.path[1]);
            expect(encodeHex(childState.key)).toEqual(vector.expectedChildKey);
            expect(encodeHex(childState.chainCode)).toEqual(vector.expectedChildChainCode);
            expect(encodeHex(childState2.key)).toEqual(vector.expectedFinalKey);
            expect(encodeHex(childState2.chainCode)).toEqual(vector.expectedFinalChainCode);
        }
    });

    it('deriveKey should produce correct final key for given path', async () => {
        for (const vector of testVectors) {
            const result = await deriveKey(vector.seed, vector.usage, vector.path);
            expect(encodeHex(result)).toEqual(vector.expectedFinalKey);
        }
    });

    it('deriveKey should be deterministic', async () => {
        for (const vector of testVectors) {
            const result1 = await deriveKey(vector.seed, vector.usage, vector.path);
            const result2 = await deriveKey(vector.seed, vector.usage, vector.path);
            expect(encodeHex(result1)).toEqual(encodeHex(result2));
        }
    });

    it('deriveKey should produce different keys for different paths', async () => {
        for (const vector of testVectors) {
            const result1 = await deriveKey(vector.seed, vector.usage, vector.path);
            const result2 = await deriveKey(vector.seed, vector.usage, [...vector.path, 'additional']);
            expect(encodeHex(result1)).not.toEqual(encodeHex(result2));
        }
    });

    it('deriveKey should produce different keys for different usages', async () => {
        for (const vector of testVectors) {
            const result1 = await deriveKey(vector.seed, vector.usage, vector.path);
            const result2 = await deriveKey(vector.seed, vector.usage + 'different', vector.path);
            expect(encodeHex(result1)).not.toEqual(encodeHex(result2));
        }
    });
});