import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const buildModulePath = resolve(import.meta.dirname, '../../scripts/build-atomic.cjs');
const temporaryDirectories: string[] = [];

function makePackageDir(): string {
    const packageDir = mkdtempSync(join(tmpdir(), 'paws-atomic-build-'));
    temporaryDirectories.push(packageDir);
    mkdirSync(join(packageDir, 'dist'), { recursive: true });
    writeFileSync(join(packageDir, 'dist/index.mjs'), 'old entry');
    writeFileSync(join(packageDir, 'dist/old-chunk.mjs'), 'old chunk');
    return packageDir;
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

describe('atomic CLI build', () => {
    it('keeps the live dist intact when validation fails', () => {
        const packageDir = makePackageDir();
        const { runAtomicBuild } = require(buildModulePath) as {
            runAtomicBuild: (options: {
                packageDir: string;
                requiredOutputs: string[];
                runTypecheck: () => void;
                runBundler: (stagingDist: string) => void;
            }) => void;
        };

        expect(() => runAtomicBuild({
            packageDir,
            requiredOutputs: ['index.mjs'],
            runTypecheck: () => {
                expect(readFileSync(join(packageDir, 'dist/index.mjs'), 'utf8')).toBe('old entry');
                throw new Error('typecheck failed');
            },
            runBundler: () => {
                throw new Error('bundler must not run');
            },
        })).toThrow('typecheck failed');

        expect(readFileSync(join(packageDir, 'dist/index.mjs'), 'utf8')).toBe('old entry');
    });

    it('promotes a complete build without deleting files used by running processes', () => {
        const packageDir = makePackageDir();
        const { runAtomicBuild } = require(buildModulePath) as {
            runAtomicBuild: (options: {
                packageDir: string;
                requiredOutputs: string[];
                runTypecheck: () => void;
                runBundler: (stagingDist: string) => void;
            }) => void;
        };

        runAtomicBuild({
            packageDir,
            requiredOutputs: ['index.mjs'],
            runTypecheck: () => undefined,
            runBundler: (stagingDist) => {
                expect(readFileSync(join(packageDir, 'dist/index.mjs'), 'utf8')).toBe('old entry');
                mkdirSync(stagingDist, { recursive: true });
                writeFileSync(join(stagingDist, 'index.mjs'), 'new entry');
                writeFileSync(join(stagingDist, 'new-chunk.mjs'), 'new chunk');
            },
        });

        expect(readFileSync(join(packageDir, 'dist/index.mjs'), 'utf8')).toBe('new entry');
        expect(readFileSync(join(packageDir, 'dist/new-chunk.mjs'), 'utf8')).toBe('new chunk');
        expect(readFileSync(join(packageDir, 'dist/old-chunk.mjs'), 'utf8')).toBe('old chunk');
    });
});
