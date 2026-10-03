import { describe, expect, it } from 'vitest';
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
    it('advertises support for per-message Saycode system prompt policy', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'claude',
            machineId: 'machine-1',
        });

        expect(metadata.runtimeCapabilities).toEqual({
            saycodeSystemPromptPreference: true,
        });
    });

    // aplus-dev-studio specs/e2ee-machine-control-boundary R18 — sealed with the session key.
    it('advertises bound session RPCs', () => {
        const { metadata } = createSessionMetadata({ flavor: 'claude', machineId: 'machine-1' });

        expect(metadata.rpcBinding).toEqual({ version: 1 });
    });
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

    it('sets fork lineage metadata when provided', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'codex',
            machineId: 'machine-6',
            parentSessionId: 'happy-source',
            forkedFromMessageId: 'message-2',
        });

        expect(metadata.parentSessionId).toBe('happy-source');
        expect(metadata.forkedFromMessageId).toBe('message-2');
    });

    it('sets metadata.createdBy when provided', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'claude',
            machineId: 'machine-7',
            createdBy: { accountId: 'acct-123', displayName: 'Ada' },
        });

        expect(metadata.createdBy).toEqual({ accountId: 'acct-123', displayName: 'Ada' });
    });

    it('omits metadata.createdBy when not provided (backward compatible)', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'claude',
            machineId: 'machine-8',
        });

        expect('createdBy' in metadata).toBe(false);
    });
});
