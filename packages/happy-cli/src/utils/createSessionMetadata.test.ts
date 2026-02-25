import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { SandboxConfig } from '@/persistence';
import { createSessionMetadata } from './createSessionMetadata';

function createSandboxConfig(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
    return {
        enabled: true,
        workspaceRoot: '~/Developer',
        sessionIsolation: 'workspace',
        customWritePaths: [],
        denyReadPaths: ['~/.ssh', '~/.aws', '~/.gnupg'],
        extraWritePaths: ['/tmp'],
        denyWritePaths: ['.env'],
        networkMode: 'allowed',
        allowedDomains: [],
        deniedDomains: [],
        allowLocalBinding: true,
        ...overrides,
    };
}

describe('createSessionMetadata', () => {
    it('sets metadata.sandbox to the config when enabled', () => {
        const sandbox = createSandboxConfig();
        const { metadata } = createSessionMetadata({
            flavor: 'codex',
            machineId: 'machine-1',
            startedBy: 'terminal',
            sandbox,
        });

        expect(metadata.sandbox).toEqual(sandbox);
    });

    it('sets metadata.sandbox to null when sandbox is disabled', () => {
        const sandbox = createSandboxConfig({ enabled: false });
        const { metadata } = createSessionMetadata({
            flavor: 'gemini',
            machineId: 'machine-2',
            startedBy: 'daemon',
            sandbox,
        });

        expect(metadata.sandbox).toBeNull();
    });

    it('sets metadata.sandbox to null when sandbox is not provided', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'claude',
            machineId: 'machine-3',
        });

        expect(metadata.sandbox).toBeNull();
    });

    it('sets metadata.dangerouslySkipPermissions to null when not provided', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'codex',
            machineId: 'machine-4',
        });

        expect(metadata.dangerouslySkipPermissions).toBeNull();
    });

    it('sets metadata.dangerouslySkipPermissions when provided', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'claude',
            machineId: 'machine-5',
            dangerouslySkipPermissions: true,
        });

        expect(metadata.dangerouslySkipPermissions).toBe(true);
    });

    describe('spawnToken', () => {
        const originalSpawnToken = process.env.HAPPY_SPAWN_TOKEN;

        afterEach(() => {
            if (originalSpawnToken !== undefined) {
                process.env.HAPPY_SPAWN_TOKEN = originalSpawnToken;
            } else {
                delete process.env.HAPPY_SPAWN_TOKEN;
            }
        });

        it('sets metadata.spawnToken from HAPPY_SPAWN_TOKEN env var', () => {
            process.env.HAPPY_SPAWN_TOKEN = 'abc123';
            const { metadata } = createSessionMetadata({
                flavor: 'claude',
                machineId: 'machine-6',
            });

            expect(metadata.spawnToken).toBe('abc123');
        });

        it('sets metadata.spawnToken to undefined when env var not set', () => {
            delete process.env.HAPPY_SPAWN_TOKEN;
            const { metadata } = createSessionMetadata({
                flavor: 'claude',
                machineId: 'machine-7',
            });

            expect(metadata.spawnToken).toBeUndefined();
        });

        it('sets metadata.spawnToken to undefined when env var is empty string', () => {
            process.env.HAPPY_SPAWN_TOKEN = '';
            const { metadata } = createSessionMetadata({
                flavor: 'claude',
                machineId: 'machine-8',
            });

            // '' || undefined → undefined
            expect(metadata.spawnToken).toBeUndefined();
        });
    });
});
