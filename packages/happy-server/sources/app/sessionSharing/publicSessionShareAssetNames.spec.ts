import { describe, expect, it } from 'vitest';
import {
    normalizePublicSessionAssetName,
    publicSessionUserAssetNameSchema,
} from './publicSessionShareAssetNames';

describe('public session share asset names', () => {
    it.each([
        '__paws_internal__:pexels-cover-v1:forged',
        'folder/__paws_internal__:pexels-claim-v1:forged',
        'folder\\pexels-cover-v1:forged',
        '../pexels-cover-pending:forged',
    ])('rejects the current and legacy reserved basename namespace in %s', (name) => {
        expect(publicSessionUserAssetNameSchema.safeParse(name).success).toBe(false);
    });

    it.each([
        ['folder/photo.png', 'photo.png'],
        ['folder\\photo.png', 'photo.png'],
        ['folder/%5F%5Fpaws_internal%5F%5F%3Aphoto.png', '%5F%5Fpaws_internal%5F%5F%3Aphoto.png'],
        ['folder/report%20final.pdf', 'report%20final.pdf'],
    ])('normalizes %s to the safe literal basename %s', (name, expected) => {
        expect(normalizePublicSessionAssetName(name)).toBe(expected);
        expect(publicSessionUserAssetNameSchema.parse(name)).toBe(expected);
    });
});
