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
    it.each(['codex', 'antigravity', 'claude', 'gemini'] as const)('does not declare delegation before the %s worker has installed its RPCs', flavor => {
        expect(createSessionMetadata({ flavor, machineId: 'machine-1' }).metadata.capabilities?.delegation).toBeUndefined();
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

    it('preserves discovered skills when provided', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'codex',
            machineId: 'machine-7',
            skills: ['brainstorming', 'supabase:supabase'],
        });

        expect(metadata.skills).toEqual(['brainstorming', 'supabase:supabase']);
    });

    it('advertises Codex-native slash commands for remote autocomplete', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'codex',
            machineId: 'machine-8',
        });

        expect(metadata.slashCommands).toEqual([
            'clear',
            'compact',
            'mcp',
            'skills',
            'goal',
            'usage',
            'status',
            'diff',
            'new',
            'fork',
            'review',
            'plan',
        ]);
    });

    it('does not add Codex-native slash commands to non-Codex sessions', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'claude',
            machineId: 'machine-9',
        });

        expect(metadata.slashCommands).toBeUndefined();
    });

    it('marks title regeneration support for Claude and Codex sessions only', () => {
        expect(createSessionMetadata({ flavor: 'claude', machineId: 'machine-10' }).metadata.capabilities?.regenerateTitle).toBe(true);
        expect(createSessionMetadata({ flavor: 'codex', machineId: 'machine-11' }).metadata.capabilities?.regenerateTitle).toBe(true);
        expect(createSessionMetadata({ flavor: 'gemini', machineId: 'machine-12' }).metadata.capabilities?.regenerateTitle).toBe(false);
    });
});
