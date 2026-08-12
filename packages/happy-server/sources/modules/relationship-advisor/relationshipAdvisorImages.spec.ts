import { describe, expect, it, vi } from 'vitest';

const filesMock = vi.hoisted(() => ({
    isLocalStorage: vi.fn(() => false),
    getLocalFilesDir: vi.fn(() => '/tmp/files'),
    s3bucket: 'test-bucket',
    s3client: {
        presignedGetObject: vi.fn(async (_bucket: string, ref: string) => `https://oss.test/${ref}?signed=1`),
    },
}));

vi.mock('@/storage/files', () => filesMock);

import { resolveRelationshipAdvisorImageUrls } from './relationshipAdvisorImages';

describe('resolveRelationshipAdvisorImageUrls', () => {
    it('returns short-lived private-bucket URLs for refs owned by the user', async () => {
        const urls = await resolveRelationshipAdvisorImageUrls('user-1', [
            'advisor/user-1/12345678-1234-1234-1234-123456789abc.jpg',
        ]);

        expect(urls).toEqual([
            'https://oss.test/advisor/user-1/12345678-1234-1234-1234-123456789abc.jpg?signed=1',
        ]);
        expect(filesMock.s3client.presignedGetObject).toHaveBeenCalledWith(
            'test-bucket',
            'advisor/user-1/12345678-1234-1234-1234-123456789abc.jpg',
            10 * 60,
        );
    });
});
