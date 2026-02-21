import { describe, it, expect } from 'vitest';
import { MetadataSchema } from './storageTypes';

describe('MetadataSchema', () => {
    const baseMetadata = {
        path: '/home/user/project',
        host: 'my-host',
    };

    describe('startedBy field', () => {
        it('accepts daemon as startedBy value', () => {
            const result = MetadataSchema.safeParse({
                ...baseMetadata,
                startedBy: 'daemon',
            });
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.startedBy).toBe('daemon');
            }
        });

        it('accepts terminal as startedBy value', () => {
            const result = MetadataSchema.safeParse({
                ...baseMetadata,
                startedBy: 'terminal',
            });
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.startedBy).toBe('terminal');
            }
        });

        it('accepts metadata without startedBy (optional)', () => {
            const result = MetadataSchema.safeParse(baseMetadata);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.startedBy).toBeUndefined();
            }
        });

        it('rejects invalid startedBy values', () => {
            const result = MetadataSchema.safeParse({
                ...baseMetadata,
                startedBy: 'unknown',
            });
            expect(result.success).toBe(false);
        });
    });
});
