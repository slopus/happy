import type { SecretFinding } from './secretScanner';

export type ShareExportInspection = {
    findings: SecretFinding[];
    unresolvedAttachments: string[];
};

export type ShareExportPolicyOptions = {
    allowSensitive?: boolean;
};

export class UnsafeExportError extends Error {
    constructor(readonly code: 'sensitive-content' | 'unresolved-attachments', message: string) {
        super(message);
    }
}

export function assertShareExportSafe(
    inspection: ShareExportInspection,
    options: ShareExportPolicyOptions,
): void {
    if (inspection.unresolvedAttachments.length > 0) {
        throw new UnsafeExportError(
            'unresolved-attachments',
            `${inspection.unresolvedAttachments.length} structured attachment(s) could not be resolved`,
        );
    }
    const blocking = inspection.findings.filter((finding) => finding.severity === 'block');
    if (blocking.length > 0 && !options.allowSensitive) {
        throw new UnsafeExportError(
            'sensitive-content',
            `${blocking.length} high-confidence secret finding(s) block public sharing`,
        );
    }
}
