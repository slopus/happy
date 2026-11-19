import { expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installedClaudeExecutable } from './installedClaude';

const require = createRequire(import.meta.url);
const resolverPath = require.resolve('../../scripts/claude_version_utils.cjs');
const resolver = require(resolverPath);

it('resolves the installed platform binary when native postinstall was skipped', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'paws-claude-postinstall-'));
    try {
        const packageDir = join(directory, 'node_modules', '@anthropic-ai', 'claude-code');
        await mkdir(join(packageDir, 'bin'), { recursive: true });
        await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', bin: { claude: 'bin/claude.exe' } }));
        const placeholder = join(packageDir, 'bin', 'claude.exe');
        await writeFile(placeholder, 'echo "Error: claude native binary not installed." >&2\nexit 1\n', { mode: 0o755 });

        // Missing optional dependencies must not return a known broken executable.
        expect(resolver.resolveClaudeEntrypoint(packageDir)).toBeNull();
        const overridden = () => JSON.parse(execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(require(process.argv[1]).findGlobalClaudeCliPath()))', resolverPath], {
            encoding: 'utf8', env: { ...process.env, HAPPY_CLAUDE_PATH: placeholder }, timeout: 3_000,
        }));
        expect(overridden()).toBeNull();
        const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
        const musl = process.platform === 'linux' && !report.header?.glibcVersionRuntime;
        let fixtureArch = process.arch;
        if (process.platform === 'darwin' && fixtureArch === 'x64') {
            try {
                if (execFileSync('sysctl', ['-n', 'sysctl.proc_translated'], { encoding: 'utf8', timeout: 1_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() === '1') fixtureArch = 'arm64';
            } catch { /* Native x64 macOS. */ }
        }
        const platformPackage = `@anthropic-ai/claude-code-${process.platform}-${fixtureArch}${musl ? '-musl' : ''}`;
        const platformDir = join(directory, 'node_modules', platformPackage);
        await mkdir(platformDir, { recursive: true });
        await writeFile(join(platformDir, 'package.json'), JSON.stringify({ name: platformPackage }));
        const binary = join(platformDir, process.platform === 'win32' ? 'claude.exe' : 'claude');
        await writeFile(binary, 'native fixture', { mode: 0o755 });
        expect(resolver.resolveClaudeEntrypoint(packageDir)).toBe(await realpath(binary));
        expect(overridden()?.path).toBe(await realpath(binary));

        if (process.platform !== 'win32') {
            const binDir = join(directory, 'bin');
            await mkdir(binDir);
            await symlink(placeholder, join(binDir, 'claude'));
            const result = JSON.parse(execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(require(process.argv[1]).findClaudeInPath()))', resolverPath], {
                encoding: 'utf8', env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin:/usr/sbin` }, timeout: 3_000,
            }));
            expect(result.path).toBe(await realpath(binary));
        }

        // An installed native executable or custom wrapper remains untouched.
        await writeFile(placeholder, '#!/bin/sh\necho custom-wrapper\n');
        expect(resolver.resolveClaudeEntrypoint(packageDir)).toBe(placeholder);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

it('honors the same explicit CLI override as local mode even when PATH names another installation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'paws-claude-override-'));
    const original = process.env.HAPPY_CLAUDE_PATH;
    try {
        const executable = join(directory, 'selected-claude');
        await writeFile(executable, 'fixture');
        process.env.HAPPY_CLAUDE_PATH = executable;
        expect(installedClaudeExecutable()).toBe(await realpath(executable));
    } finally {
        if (original === undefined) delete process.env.HAPPY_CLAUDE_PATH; else process.env.HAPPY_CLAUDE_PATH = original;
        await rm(directory, { recursive: true, force: true });
    }
});
