import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    CheckpointExclusionGuard,
    resolveCheckpointProtectionCapability,
} from './checkpointExclusionPolicy';

describe('resolveCheckpointProtectionCapability', () => {
    it.each(['claude-remote', 'codex'] as const)(
        'supports protected %s sessions on macOS',
        (provider) => {
            expect(resolveCheckpointProtectionCapability({
                platform: 'darwin',
                provider,
            })).toEqual({ supported: true });
        },
    );

    // specs/linux-checkpoint-enforcement-backend R1/R2 — Linux is protected only when the bubblewrap
    // backend of @anthropic-ai/sandbox-runtime can actually run; the probe result is injected so the
    // matrix does not depend on the host.
    it.each(['claude-remote', 'codex'] as const)(
        'supports protected %s sessions on Linux when the sandbox dependencies are present',
        (provider) => {
            expect(resolveCheckpointProtectionCapability({
                platform: 'linux',
                provider,
                linuxSandboxDependencies: () => ({ ok: true }),
            })).toEqual({ supported: true });
        },
    );

    it('keeps Linux unavailable when bubblewrap dependencies are missing', () => {
        expect(resolveCheckpointProtectionCapability({
            platform: 'linux',
            provider: 'codex',
            linuxSandboxDependencies: () => ({ ok: false, missing: ['bwrap', 'socat'] }),
        })).toEqual({ supported: false, reason: 'unsupported-platform' });
    });

    it('keeps Linux unavailable when the dependency probe itself fails', () => {
        expect(resolveCheckpointProtectionCapability({
            platform: 'linux',
            provider: 'codex',
            linuxSandboxDependencies: () => { throw new Error('which exploded'); },
        })).toEqual({ supported: false, reason: 'unsupported-platform' });
    });

    it('does not consult the Linux probe on macOS', () => {
        const probe = vi.fn(() => ({ ok: false as const, missing: ['bwrap'] }));
        expect(resolveCheckpointProtectionCapability({
            platform: 'darwin',
            provider: 'codex',
            linuxSandboxDependencies: probe,
        })).toEqual({ supported: true });
        expect(probe).not.toHaveBeenCalled();
    });

    it('keeps protected sessions unavailable on win32', () => {
        expect(resolveCheckpointProtectionCapability({
            platform: 'win32',
            provider: 'codex',
            linuxSandboxDependencies: () => ({ ok: true }),
        })).toEqual({ supported: false, reason: 'unsupported-platform' });
    });

    it('keeps providers without a proven pre-write gate unavailable', () => {
        expect(resolveCheckpointProtectionCapability({
            platform: 'darwin',
            provider: 'claude-local',
        })).toEqual({ supported: false, reason: 'unsupported-provider' });
    });
});

describe('CheckpointExclusionGuard', () => {
    let projectPath: string;

    beforeEach(async () => {
        projectPath = await realpath(await mkdtemp(join(tmpdir(), 'happy-checkpoint-policy-')));
    });

    afterEach(async () => {
        await rm(projectPath, { recursive: true, force: true });
    });

    it('builds a deterministic manifest for secret, ignored, size, count, and total limits', async () => {
        await mkdir(join(projectPath, 'x'));
        await writeFile(join(projectPath, '.gitignore'), 'x/\n');
        await writeFile(join(projectPath, '.env.local'), 'secret');
        await writeFile(join(projectPath, 'x', 'cache.txt'), 'ignored');
        await writeFile(join(projectPath, 'a.txt'), '12345');
        await writeFile(join(projectPath, 'b.txt'), '12345');
        await writeFile(join(projectPath, 'c.txt'), '12345');
        await writeFile(join(projectPath, 'large.bin'), '123456789');

        const guard = await CheckpointExclusionGuard.create({
            projectPath,
            secretPatterns: ['.env*'],
            maxFileBytes: 8,
            maxFiles: 3,
            maxTotalBytes: 100,
        });

        expect(guard.manifest.excluded).toEqual([
            { path: '.env.local', reason: 'secret' },
            { path: 'c.txt', reason: 'file-limit' },
            { path: 'large.bin', reason: 'too-large' },
            { path: 'x', reason: 'ignored' },
        ]);
        expect(guard.manifest.denyWritePaths).toEqual([
            join(projectPath, '**', '.env*'),
            join(projectPath, '.env.local'),
            join(projectPath, 'c.txt'),
            join(projectPath, 'large.bin'),
            join(projectPath, 'x'),
        ]);

        const samePolicy = await CheckpointExclusionGuard.create({
            projectPath,
            secretPatterns: ['.env*'],
            maxFileBytes: 8,
            maxFiles: 3,
            maxTotalBytes: 100,
        });
        expect(samePolicy.manifest.fingerprint).toBe(guard.manifest.fingerprint);
    });

    it('uses the total-size reason when the file-count limit still has room', async () => {
        await writeFile(join(projectPath, 'a.txt'), '12345');
        await writeFile(join(projectPath, 'b.txt'), '12345');
        await writeFile(join(projectPath, 'c.txt'), '12345');

        const guard = await CheckpointExclusionGuard.create({
            projectPath,
            secretPatterns: [],
            maxFileBytes: 8,
            maxFiles: 10,
            maxTotalBytes: 11,
        });

        expect(guard.manifest.excluded).toEqual([
            { path: 'c.txt', reason: 'total-size-limit' },
        ]);
    });

    it('applies a nested gitignore only within its directory', async () => {
        await mkdir(join(projectPath, 'src', 'cache'), { recursive: true });
        await mkdir(join(projectPath, 'cache'));
        await writeFile(join(projectPath, 'src', '.gitignore'), 'cache/\n');
        await writeFile(join(projectPath, 'src', 'cache', 'blob.bin'), 'ignored');
        await writeFile(join(projectPath, 'cache', 'kept.txt'), 'kept');

        const guard = await CheckpointExclusionGuard.create({
            projectPath,
            secretPatterns: [],
            maxFileBytes: 1024,
            maxFiles: 100,
            maxTotalBytes: 4096,
        });

        expect(guard.manifest.excluded).toEqual([
            { path: 'src/cache', reason: 'ignored' },
        ]);
        expect(guard.manifest.denyWritePaths).not.toContain(join(projectPath, 'cache'));
    });

    it('does not consume the file-count quota when a file is excluded by total size', async () => {
        await writeFile(join(projectPath, 'a.txt'), '123456789');
        await writeFile(join(projectPath, 'b.txt'), '1');

        const guard = await CheckpointExclusionGuard.create({
            projectPath,
            secretPatterns: [],
            maxFileBytes: 20,
            maxFiles: 1,
            maxTotalBytes: 5,
        });

        expect(guard.manifest.excluded).toEqual([
            { path: 'a.txt', reason: 'total-size-limit' },
        ]);
    });

    it('compiles a basename secret pattern to cover future files at every depth', async () => {
        const guard = await CheckpointExclusionGuard.create({
            projectPath,
            secretPatterns: ['.env*'],
            maxFileBytes: 1024,
            maxFiles: 100,
            maxTotalBytes: 4096,
        });

        expect(guard.manifest.denyWritePaths).toContain(join(projectPath, '**', '.env*'));
    });

    it('allows read-only passthrough only for an ignored directory', async () => {
        await mkdir(join(projectPath, 'dependencies'));
        await writeFile(join(projectPath, '.gitignore'), 'dependencies/\n');
        const guard = await CheckpointExclusionGuard.create({
            projectPath,
            secretPatterns: [],
            readOnlyPassthroughPaths: ['dependencies'],
            maxFileBytes: 1024,
            maxFiles: 100,
            maxTotalBytes: 4096,
        });

        expect(guard.manifest.readOnlyPassthroughPaths).toEqual(['dependencies']);
        await expect(CheckpointExclusionGuard.create({
            projectPath,
            secretPatterns: [],
            readOnlyPassthroughPaths: ['.gitignore'],
            maxFileBytes: 1024,
            maxFiles: 100,
            maxTotalBytes: 4096,
        })).rejects.toThrow('ignored directory');
    });

    it('allows a narrow directory passthrough beneath an ignored ancestor', async () => {
        await mkdir(join(projectPath, '.aplus', 'uploads'), { recursive: true });
        await writeFile(join(projectPath, '.gitignore'), '.aplus/\n');

        const guard = await CheckpointExclusionGuard.create({
            projectPath,
            secretPatterns: ['.env*'],
            readOnlyPassthroughPaths: ['.aplus/uploads'],
            maxFileBytes: 1024,
            maxFiles: 100,
            maxTotalBytes: 4096,
        });

        expect(guard.manifest.readOnlyPassthroughPaths).toEqual(['.aplus/uploads']);
    });

    it('rejects a narrow passthrough that escapes through an ignored symlink ancestor', async () => {
        const outsider = await mkdtemp(join(tmpdir(), 'happy-checkpoint-policy-outsider-'));
        try {
            await mkdir(join(outsider, 'uploads'));
            await symlink(outsider, join(projectPath, '.aplus'), 'dir');
            await writeFile(join(projectPath, '.gitignore'), '.aplus/\n');

            await expect(CheckpointExclusionGuard.create({
                projectPath,
                secretPatterns: ['.env*'],
                readOnlyPassthroughPaths: ['.aplus/uploads'],
                maxFileBytes: 1024,
                maxFiles: 100,
                maxTotalBytes: 4096,
            })).rejects.toThrow('ignored directory');
        } finally {
            await rm(outsider, { recursive: true, force: true });
        }
    });

    it.each(['/absolute', '../outside'])(
        'rejects an unsafe read-only passthrough path: %j',
        async (readOnlyPassthroughPath) => {
            await expect(CheckpointExclusionGuard.create({
                projectPath,
                secretPatterns: [],
                readOnlyPassthroughPaths: [readOnlyPassthroughPath],
                maxFileBytes: 1024,
                maxFiles: 100,
                maxTotalBytes: 4096,
            })).rejects.toThrow('project-relative');
        },
    );

    it.each(['', '/etc/**', '../outside/**', '!safe.env'])(
        'rejects a secret deny pattern that can escape or weaken protection: %j',
        async (secretPattern) => {
            await expect(CheckpointExclusionGuard.create({
                projectPath,
                secretPatterns: [secretPattern],
                maxFileBytes: 1024,
                maxFiles: 100,
                maxTotalBytes: 4096,
            })).rejects.toThrow('project-relative deny globs');
        },
    );

    it('blocks dispatch when a newly excluded path changes the sandbox policy', async () => {
        await writeFile(join(projectPath, 'source.ts'), 'safe');
        const guard = await CheckpointExclusionGuard.create({
            projectPath,
            secretPatterns: ['.env*'],
            maxFileBytes: 1024,
            maxFiles: 100,
            maxTotalBytes: 4096,
        });
        const dispatch = vi.fn(async () => undefined);
        await writeFile(join(projectPath, '.env.production'), 'secret');

        await expect(guard.dispatchAfterPolicyCheck(dispatch)).rejects.toMatchObject({
            name: 'CheckpointPolicyDriftError',
            action: 'restart-sandbox-or-disable-protection',
            excluded: [{ path: '.env.production', reason: 'secret' }],
        });
        expect(dispatch).not.toHaveBeenCalled();
    });

    // Desktop parseCheckpointRecovery rejects a change whose path is not in `excluded`, so a removed
    // exclusion must stay listed with its previous reason or the whole recovery diagnostic is dropped.
    it('keeps every changed path, including removed exclusions, in the drift excluded list', async () => {
        await writeFile(join(projectPath, '.env'), 'secret');
        const guard = await CheckpointExclusionGuard.create({
            projectPath,
            secretPatterns: ['.env*'],
            maxFileBytes: 1024,
            maxFiles: 100,
            maxTotalBytes: 4096,
        });
        await rm(join(projectPath, '.env'));
        await writeFile(join(projectPath, '.env.local'), 'secret');

        const error = await guard.dispatchAfterPolicyCheck(async () => undefined).catch((caught) => caught);
        expect(error.excluded).toEqual([
            { path: '.env', reason: 'secret' },
            { path: '.env.local', reason: 'secret' },
        ]);
        expect(error.diagnostic.changes.map((change: { path: string; change: string }) => [change.path, change.change]))
            .toEqual([['.env', 'removed'], ['.env.local', 'added']]);
    });
});
