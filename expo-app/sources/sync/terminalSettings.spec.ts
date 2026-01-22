import { describe, it, expect } from 'vitest';

import { settingsDefaults } from './settings';
import { resolveTerminalSpawnOptions } from './terminalSettings';

describe('resolveTerminalSpawnOptions', () => {
    it('returns null when tmux is disabled', () => {
        const settings: any = {
            ...settingsDefaults,
            sessionUseTmux: false,
        };
        expect(resolveTerminalSpawnOptions({ settings, machineId: 'm1' })).toBeNull();
    });

    it('returns tmux spawn options when enabled', () => {
        const settings: any = {
            ...settingsDefaults,
            sessionUseTmux: true,
            sessionTmuxSessionName: 'happy',
            sessionTmuxIsolated: true,
            sessionTmuxTmpDir: null,
            sessionTmuxByMachineId: {},
        };

        expect(resolveTerminalSpawnOptions({ settings, machineId: 'm1' })).toEqual({
            mode: 'tmux',
            tmux: {
                sessionName: 'happy',
                isolated: true,
                tmpDir: null,
            },
        });
    });

    it('allows blank session name to use current/most recent tmux session', () => {
        const settings: any = {
            ...settingsDefaults,
            sessionUseTmux: true,
            sessionTmuxSessionName: '   ',
            sessionTmuxIsolated: true,
            sessionTmuxTmpDir: null,
            sessionTmuxByMachineId: {},
        };

        expect(resolveTerminalSpawnOptions({ settings, machineId: 'm1' })?.tmux?.sessionName).toBe('');
    });

    it('supports per-machine overrides when enabled', () => {
        const settings: any = {
            ...settingsDefaults,
            sessionUseTmux: true,
            sessionTmuxSessionName: 'happy',
            sessionTmuxIsolated: true,
            sessionTmuxTmpDir: null,
            sessionTmuxByMachineId: {
                m1: {
                    useTmux: true,
                    sessionName: 'dev',
                    isolated: false,
                    tmpDir: '/tmp/tmux',
                },
            },
        };

        expect(resolveTerminalSpawnOptions({ settings, machineId: 'm1' })).toEqual({
            mode: 'tmux',
            tmux: {
                sessionName: 'dev',
                isolated: false,
                tmpDir: '/tmp/tmux',
            },
        });
    });
});
