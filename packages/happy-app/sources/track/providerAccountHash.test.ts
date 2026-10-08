import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/encryption/libsodium.lib', () => ({ default: require('libsodium-wrappers') }));

import sodium from '@/encryption/libsodium.lib';
import { providerAccountHash } from './providerAccountHash';

const userA = new Uint8Array(32).fill(1);
const userB = new Uint8Array(32).fill(2);

beforeAll(async () => {
    await sodium.ready;
});

describe('providerAccountHash', () => {
    it('is twelve hex characters and never contains the account id', () => {
        const hash = providerAccountHash(userA, 'claude_extra');
        expect(hash).toMatch(/^[0-9a-f]{12}$/);
        expect(hash).not.toContain('claude');
    });

    it('is stable for one user and account, and differs across accounts and users', () => {
        expect(providerAccountHash(userA, 'claude_extra')).toBe(providerAccountHash(userA, 'claude_extra'));
        expect(providerAccountHash(userA, 'claude_extra')).not.toBe(providerAccountHash(userA, 'claude'));
        expect(providerAccountHash(userA, 'claude_extra')).not.toBe(providerAccountHash(userB, 'claude_extra'));
    });
});
