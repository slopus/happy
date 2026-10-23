/**
 * Exercise the real ripgrep fallback subprocess without a native addon.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { x } from 'tar';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

// The Unix fallback uses the bundled `rg`; Windows bundles `rg.exe` instead.
describe.skipIf(process.platform === 'win32')('ripgrep fallback output', () => {
    let fixtureDir: string;
    let launcherPath: string;
    let searchDir: string;

    beforeAll(async () => {
        fixtureDir = mkdtempSync(join(tmpdir(), 'happy-ripgrep-output-'));
        const fixtureScriptsDir = join(fixtureDir, 'scripts');
        const toolsDir = join(fixtureDir, 'tools', 'unpacked');
        searchDir = join(fixtureDir, 'project');
        mkdirSync(fixtureScriptsDir, { recursive: true });
        mkdirSync(toolsDir, { recursive: true });
        mkdirSync(searchDir);
        launcherPath = join(fixtureScriptsDir, 'ripgrep_launcher.cjs');
        copyFileSync(join(scriptsDir, 'ripgrep_launcher.cjs'), launcherPath);
        // Only extract the real binary so loadRipgrepNative must take a fallback.
        await x({
            file: join(scriptsDir, '..', 'tools', 'archives', `ripgrep-${process.arch}-${process.platform}.tar.gz`),
            cwd: toolsDir,
            filter: (path: string) => path === 'rg',
        });
        writeFileSync(join(searchDir, 'example.txt'), 'needle\n');
    });

    afterAll(() => {
        if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
    });

    it('returns only file paths for --files', () => {
        const result = spawnSync(process.execPath, [launcherPath, JSON.stringify(['--files'])], {
            cwd: searchDir,
            encoding: 'utf8',
        });
        expect(result.status).toBe(0);
        expect(result.stdout.trim()).toBe('example.txt');
        expect(result.stderr).toMatch(/Using (system ripgrep|packaged ripgrep binary)/);
    });

    it('keeps every --json output line parseable', () => {
        const result = spawnSync(process.execPath, [launcherPath, JSON.stringify(['--json', 'needle', 'example.txt'])], {
            cwd: searchDir,
            encoding: 'utf8',
        });
        expect(result.status).toBe(0);
        const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
        expect(events.find(event => event.type === 'match').data.lines.text).toBe('needle\n');
        expect(result.stderr).toMatch(/Using (system ripgrep|packaged ripgrep binary)/);
    });

    it('keeps stdout empty when there are no matches', () => {
        const result = spawnSync(process.execPath, [launcherPath, JSON.stringify(['absent', 'example.txt'])], {
            cwd: searchDir,
            encoding: 'utf8',
        });
        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toMatch(/Using (system ripgrep|packaged ripgrep binary)/);
    });
});
