import { beforeAll, describe, expect, it } from 'vitest';
import sodium from '@/encryption/libsodium.lib';
import { getAuthQrCodeKind } from './authQrCodeKind';

describe('getAuthQrCodeKind', () => {
    beforeAll(async () => {
        await sodium.ready;
    });

    it.each([
        ['paws:///account?dh2I7IMEE5Gd_p1NHVbxfmU8jJlAgt9bE3uQoK5u33Q', 'account'],
        ['paws://terminal?AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', 'terminal'],
        ['paws:///account?AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', null],
        ['paws://terminal?AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', null],
        ['paws:///account?', null],
        ['paws://terminal?', null],
        ['paws:///account?A', null],
        ['paws://terminal?AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', null],
        ['paws:///account?not valid', null],
        ['paws://terminal?<script>', null],
        ['https://example.com/not-a-paws-code', null],
    ] as const)('classifies %s as %s', (url, expectedKind) => {
        expect(getAuthQrCodeKind(url)).toBe(expectedKind);
    });
});
