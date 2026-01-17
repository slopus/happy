import { describe, expect, it } from 'vitest';

import {
    EXPO_PUBLIC_STORAGE_SCOPE_ENV_VAR,
    normalizeStorageScope,
    readStorageScopeFromEnv,
    scopedStorageId,
} from './storageScope';

describe('storageScope', () => {
    describe('normalizeStorageScope', () => {
        it('returns null for non-strings and empty strings', () => {
            expect(normalizeStorageScope(undefined)).toBeNull();
            expect(normalizeStorageScope(null)).toBeNull();
            expect(normalizeStorageScope(123)).toBeNull();
            expect(normalizeStorageScope('')).toBeNull();
            expect(normalizeStorageScope('   ')).toBeNull();
        });

        it('sanitizes unsafe characters and clamps length', () => {
            expect(normalizeStorageScope(' pr272-107 ')).toBe('pr272-107');
            expect(normalizeStorageScope('a/b:c')).toBe('a_b_c');
            expect(normalizeStorageScope('a__b')).toBe('a_b');

            const long = 'x'.repeat(100);
            expect(normalizeStorageScope(long)?.length).toBe(64);
        });
    });

    describe('readStorageScopeFromEnv', () => {
        it('reads from EXPO_PUBLIC_HAPPY_STORAGE_SCOPE', () => {
            expect(readStorageScopeFromEnv({ [EXPO_PUBLIC_STORAGE_SCOPE_ENV_VAR]: 'stack-1' })).toBe('stack-1');
            expect(readStorageScopeFromEnv({ [EXPO_PUBLIC_STORAGE_SCOPE_ENV_VAR]: '   ' })).toBeNull();
        });
    });

    describe('scopedStorageId', () => {
        it('returns baseId when scope is null', () => {
            expect(scopedStorageId('auth_credentials', null)).toBe('auth_credentials');
        });

        it('namespaces when scope is present', () => {
            expect(scopedStorageId('auth_credentials', 'stack-1')).toBe('auth_credentials__stack-1');
        });
    });
});
