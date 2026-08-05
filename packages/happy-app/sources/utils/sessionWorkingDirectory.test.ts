import { describe, expect, it } from 'vitest';
import type { Session } from '@/sync/storageTypes';
import {
    formatWorkingDirectoryLabel,
    getRecentWorkingDirectories,
    resolveWorkingDirectoryAgent,
    resolveWorkingDirectorySwitchStrategy,
} from './sessionWorkingDirectory';

function session(id: string, machineId: string, path: string, updatedAt: number): Session {
    return {
        id,
        seq: 1,
        createdAt: updatedAt,
        updatedAt,
        active: true,
        activeAt: updatedAt,
        metadata: { path, host: 'mac', machineId },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
    };
}

describe('session working directory presentation', () => {
    it('shows a home-relative path and truncates only long labels', () => {
        expect(formatWorkingDirectoryLabel('/Users/jacky/projects/happy', '/Users/jacky')).toBe('~/projects/happy');
        expect(formatWorkingDirectoryLabel('/Users/jacky/projects/clients/acme/very-long-product-name', '/Users/jacky'))
            .toBe('~/…/acme/very-long-product-name');
    });

    it('returns unique recent directories from the same machine, newest first', () => {
        const sessions = [
            session('current', 'mac-1', '/repo/current', 40),
            session('older', 'mac-1', '/repo/older', 10),
            session('newer', 'mac-1', '/repo/newer', 30),
            session('duplicate', 'mac-1', '/repo/newer', 20),
            session('other-machine', 'mac-2', '/repo/other', 50),
        ];

        expect(getRecentWorkingDirectories(sessions, 'mac-1', '/repo/current')).toEqual([
            '/repo/newer',
            '/repo/older',
        ]);
    });

    it('only maps flavors the daemon can spawn', () => {
        expect(resolveWorkingDirectoryAgent('codex')).toBe('codex');
        expect(resolveWorkingDirectoryAgent('ask')).toBeNull();
        expect(resolveWorkingDirectoryAgent('custom-agent')).toBeNull();
    });

    it('requires provider continuation for Codex and Claude without weakening other Agent behavior', () => {
        expect(resolveWorkingDirectorySwitchStrategy('codex', true)).toBe('continue-context');
        expect(resolveWorkingDirectorySwitchStrategy('claude', true)).toBe('continue-context');
        expect(resolveWorkingDirectorySwitchStrategy('codex', false)).toBe('continuation-unavailable');
        expect(resolveWorkingDirectorySwitchStrategy('claude', false)).toBe('continuation-unavailable');
        expect(resolveWorkingDirectorySwitchStrategy('gemini', false)).toBe('new-session');
        expect(resolveWorkingDirectorySwitchStrategy('opencode', false)).toBe('new-session');
        expect(resolveWorkingDirectorySwitchStrategy('openclaw', false)).toBe('new-session');
        expect(resolveWorkingDirectorySwitchStrategy('ask', false)).toBe('unsupported');
        expect(resolveWorkingDirectorySwitchStrategy('custom-agent', false)).toBe('unsupported');
    });
});
