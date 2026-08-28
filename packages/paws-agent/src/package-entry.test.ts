import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';

describe('package root', () => {
    it('exports the SDK without parsing argv or printing output', async () => {
        const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

        await import('./index');

        expect(stdout).not.toHaveBeenCalled();
        expect(stderr).not.toHaveBeenCalled();
    });

    it('keeps root and browser bundles free of Node built-ins', async () => {
        const bundles = await Promise.all([
            readFile(new URL('../dist/index.mjs', import.meta.url), 'utf8'),
            readFile(new URL('../dist/browser.mjs', import.meta.url), 'utf8'),
        ]);

        for (const bundle of bundles) {
            expect(bundle).not.toMatch(/(?:from\s+|import\s*)['"]node:/);
            expect(bundle).not.toContain('Buffer.from');
        }
    });

    it('publishes only the documented SDK entrypoints', async () => {
        const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
            exports: Record<string, unknown>;
        };
        expect(Object.keys(manifest.exports)).toEqual(['.', './node', './browser', './package.json']);

        const nodeEntry = await import('./node');
        expect(Object.keys(nodeEntry).sort()).toEqual([
            'FileCredentialProvider',
            'PawsAgentClient',
            'PawsAgentError',
            'createDefaultFileCredentialProvider',
        ]);
    });

    it('keeps transport dependencies out of the public client constructor', async () => {
        const declaration = await readFile(new URL('../dist/index.d.mts', import.meta.url), 'utf8');
        expect(declaration).toContain('constructor(options: PawsAgentClientOptions);');
        expect(declaration).not.toContain('ClientDependencies');
        expect(declaration).not.toContain('PawsHttpTransport');
        expect(declaration).not.toContain('PawsRealtimeTransport');
    });
});
