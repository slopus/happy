import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runCli, type CliDependencies, type CliIo } from './cli';

function capture(): { io: CliIo; stdout: string[]; stderr: string[] } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return {
        stdout,
        stderr,
        io: {
            stdout: (value) => stdout.push(value),
            stderr: (value) => stderr.push(value),
        },
    };
}

describe('paws-share CLI', () => {
    it('prints a stable version without reading records or provider stores', async () => {
        const output = capture();

        const exitCode = await runCli(['node', 'paws-share', '--version'], output.io);

        expect(exitCode).toBe(0);
        expect(output.stdout.join('')).toBe('0.1.0-beta.0\n');
        expect(output.stderr).toEqual([]);
    });

    it('documents the session sharing management commands', async () => {
        const output = capture();

        const exitCode = await runCli(['node', 'paws-share', '--help'], output.io);

        expect(exitCode).toBe(0);
        expect(output.stdout.join('')).toContain('inspect');
        expect(output.stdout.join('')).toContain('share');
        expect(output.stdout.join('')).toContain('list');
        expect(output.stdout.join('')).toContain('renew');
        expect(output.stdout.join('')).toContain('revoke');
        expect(output.stderr).toEqual([]);
    });

    it('inspects an explicit Codex session and emits a machine-readable disclosure', async () => {
        const output = capture();

        const exitCode = await runCli([
            'node', 'paws-share', 'inspect',
            '--source', 'codex',
            '--session', resolve('test/fixtures/codex-session.jsonl'),
            '--json',
        ], output.io);

        expect(exitCode).toBe(0);
        expect(JSON.parse(output.stdout.join(''))).toMatchObject({
            source: 'codex',
            title: 'Create a purple Paws sharing illustration.',
            messageCount: 4,
            attachmentCount: 1,
            unresolvedAttachmentCount: 0,
            blockingFindingCount: 0,
        });
    });

    it('shows the disclosure but refuses to publish until --yes is explicit', async () => {
        const output = capture();
        const share = vi.fn(async () => ({
            publicUrl: 'https://paws.test/share/public-1', publicId: 'public-1', expiresAt: '2026-11-30T00:00:00.000Z',
            source: 'codex' as const, messageCount: 1, attachmentCount: 0, attachmentBytes: 0, recordId: 'public-1',
        }));
        const dependencies: Partial<CliDependencies> = {
            inspectSession: async () => ({
                source: 'codex', title: 'Review', messageCount: 1, attachmentCount: 0, attachmentBytes: 0,
                unresolvedAttachmentCount: 0, blockingFindingCount: 0, warningFindingCount: 0,
            }),
            shareSession: share,
        };

        const exitCode = await runCli([
            'node', 'paws-share', 'share', '--source', 'codex', '--session', '/tmp/session.jsonl',
        ], output.io, dependencies);

        expect(exitCode).toBe(2);
        expect(output.stdout.join('')).toContain('Review');
        expect(output.stderr.join('')).toContain('--yes');
        expect(share).not.toHaveBeenCalled();
    });

    it('publishes with --yes and prints public JSON without a capability token', async () => {
        const output = capture();
        const token = Buffer.alloc(32, 9).toString('base64url');
        const dependencies: Partial<CliDependencies> = {
            shareSession: async () => ({
                publicUrl: 'https://paws.test/share/public-1', publicId: 'public-1', expiresAt: '2026-11-30T00:00:00.000Z',
                source: 'codex', messageCount: 4, attachmentCount: 1, attachmentBytes: 320, recordId: 'public-1',
            }),
        };

        const exitCode = await runCli([
            'node', 'paws-share', 'share', '--source', 'codex', '--session', '/tmp/session.jsonl',
            '--server', 'https://paws.test', '--yes', '--json',
        ], output.io, dependencies);

        expect(exitCode).toBe(0);
        expect(JSON.parse(output.stdout.join(''))).toMatchObject({ publicId: 'public-1', attachmentCount: 1 });
        expect(output.stdout.join('')).not.toContain(token);
        expect(output.stderr).toEqual([]);
    });

    it('lists, renews, and revokes records without printing local management tokens', async () => {
        const output = capture();
        const managementToken = Buffer.alloc(32, 9).toString('base64url');
        const dependencies: Partial<CliDependencies> = {
            listRecords: async () => [{
                recordId: 'public-1', serverUrl: 'https://paws.test', publicId: 'public-1', shareId: 'share-1',
                source: 'codex', title: 'Review', createdAt: '2026-09-01T00:00:00.000Z', expiresAt: '2026-11-30T00:00:00.000Z',
            }],
            renewManagedShare: async () => ({ publicId: 'public-1', expiresAt: '2026-12-01T00:00:00.000Z' }),
            revokeManagedShare: async () => ({ publicId: 'public-1', revoked: true as const }),
        };

        expect(await runCli(['node', 'paws-share', 'list', '--json'], output.io, dependencies)).toBe(0);
        expect(await runCli(['node', 'paws-share', 'renew', 'public-1', '--json'], output.io, dependencies)).toBe(0);
        expect(await runCli(['node', 'paws-share', 'revoke', 'public-1', '--json'], output.io, dependencies)).toBe(0);

        expect(output.stdout.join('')).not.toContain(managementToken);
        expect(output.stdout.join('')).toContain('"revoked":true');
    });

    it('installs the provider-neutral Agent Skill for both supported agents', async () => {
        const output = capture();
        const dependencies: Partial<CliDependencies> = {
            installSkill: async () => ({ installed: ['/codex/skills/share-session', '/claude/skills/share-session'] }),
        };

        const exitCode = await runCli([
            'node', 'paws-share', 'install-skill', '--target', 'all', '--json',
        ], output.io, dependencies);

        expect(exitCode).toBe(0);
        expect(JSON.parse(output.stdout.join(''))).toEqual({
            installed: ['/codex/skills/share-session', '/claude/skills/share-session'],
        });
    });
});
