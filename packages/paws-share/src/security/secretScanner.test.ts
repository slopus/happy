import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PublicSessionSnapshot } from '@slopus/happy-wire';
import { createTemporaryDirectory, removeTemporaryDirectory } from '../testSupport/temporaryDirectory';
import { scanShareExport, scanText } from './secretScanner';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(removeTemporaryDirectory));
});

function snapshot(markdown: string): PublicSessionSnapshot {
    return {
        version: 1,
        title: 'Security review',
        sharedAt: 1_788_192_000_000,
        source: { provider: 'codex' },
        messages: [{
            id: 'message-1',
            role: 'assistant',
            createdAt: 1_788_192_000_000,
            blocks: [{ type: 'text', markdown }],
        }],
    };
}

describe('secretScanner', () => {
    it.each([
        ['private-key', `-----BEGIN ${'PRIVATE'} KEY-----\nexample\n-----END PRIVATE KEY-----`],
        ['vendor-token', ['sk', 'examplelongcredentialvalue123456789'].join('-')],
        ['bearer-token', `Authorization: ${['Bearer', 'examplelongcredentialvalue123456789'].join(' ')}`],
        ['credential-assignment', `${['API', 'KEY'].join('_')}=examplelongcredentialvalue123456789`],
    ])('blocks %s findings without returning the secret value', (rule, text) => {
        const findings = scanText(text, 'message:1');

        expect(findings).toEqual(expect.arrayContaining([
            expect.objectContaining({ rule, severity: 'block', location: 'message:1', fingerprint: expect.stringMatching(/^[a-f0-9]{12}$/) }),
        ]));
        expect(JSON.stringify(findings)).not.toContain('examplelongcredentialvalue123456789');
    });

    it('warns about identity and machine-location data without blocking it', () => {
        const findings = scanText('Contact owner@example.com from /Users/example/project at 192.0.2.10', 'message:2');

        expect(findings.filter((finding) => finding.severity === 'warn').map((finding) => finding.rule))
            .toEqual(expect.arrayContaining(['email-address', 'absolute-home-path', 'ip-address']));
        expect(findings.some((finding) => finding.severity === 'block')).toBe(false);
    });

    it('scans small textual attachments but never includes their secret bytes in findings', async () => {
        const home = await createTemporaryDirectory('paws-share-security-');
        temporaryDirectories.push(home);
        const attachmentPath = join(home, 'credentials.env');
        const secret = `${['SERVICE', 'TOKEN'].join('_')}=examplelongcredentialvalue123456789`;
        await writeFile(attachmentPath, secret);

        const findings = await scanShareExport(snapshot('Safe message'), [{
            attachmentId: '11111111-1111-4111-8111-111111111111',
            path: attachmentPath,
            name: 'credentials.env',
            mimeType: 'text/plain',
            kind: 'file',
            size: Buffer.byteLength(secret),
            sha256: 'a'.repeat(64),
        }]);

        expect(findings).toEqual(expect.arrayContaining([
            expect.objectContaining({ rule: 'credential-assignment', severity: 'block', location: 'attachment:credentials.env' }),
        ]));
        expect(JSON.stringify(findings)).not.toContain('examplelongcredentialvalue123456789');
    });
});
