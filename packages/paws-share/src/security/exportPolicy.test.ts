import { describe, expect, it } from 'vitest';
import { assertShareExportSafe, UnsafeExportError } from './exportPolicy';
import type { SecretFinding } from './secretScanner';

const blockingFinding: SecretFinding = {
    rule: 'vendor-token',
    severity: 'block',
    location: 'message:1',
    fingerprint: '123456789abc',
};

describe('assertShareExportSafe', () => {
    it('blocks high-confidence secrets by default', () => {
        expect(() => assertShareExportSafe({ findings: [blockingFinding], unresolvedAttachments: [] }, {}))
            .toThrowError(expect.objectContaining({ code: 'sensitive-content' }));
    });

    it('allows a separately explicit sensitive-content override', () => {
        expect(() => assertShareExportSafe(
            { findings: [blockingFinding], unresolvedAttachments: [] },
            { allowSensitive: true },
        )).not.toThrow();
    });

    it('never silently publishes unresolved structured attachments', () => {
        try {
            assertShareExportSafe({ findings: [], unresolvedAttachments: ['missing.png'] }, { allowSensitive: true });
            throw new Error('expected policy to fail');
        } catch (error) {
            expect(error).toBeInstanceOf(UnsafeExportError);
            expect(error).toMatchObject({ code: 'unresolved-attachments' });
            expect((error as Error).message).not.toContain('/Users/');
        }
    });
});
