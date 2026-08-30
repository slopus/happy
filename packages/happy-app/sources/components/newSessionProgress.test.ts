import { describe, expect, it } from 'vitest';

import { resolveNewSessionPrimaryAction, resolveNewSessionProgressLabel } from './newSessionProgress';

describe('new session progress', () => {
    it('says nothing while nothing is being created', () => {
        expect(resolveNewSessionProgressLabel({
            phase: null,
            agentName: 'Codex',
            picksWorkspaces: false,
        })).toBeNull();
    });

    it('names each step of the flow', () => {
        expect(resolveNewSessionProgressLabel({
            phase: 'worktree',
            agentName: 'Codex',
            picksWorkspaces: false,
        })).toBe('Creating worktree…');
        expect(resolveNewSessionProgressLabel({
            phase: 'spawning',
            agentName: 'Codex',
            picksWorkspaces: false,
        })).toBe('Starting Codex…');
        expect(resolveNewSessionProgressLabel({
            phase: 'opening',
            agentName: 'Codex',
            picksWorkspaces: false,
        })).toBe('Opening session…');
    });

    it('calls a Happy Agent worktree a workspace', () => {
        expect(resolveNewSessionProgressLabel({
            phase: 'worktree',
            agentName: 'Happy',
            picksWorkspaces: true,
        })).toBe('Creating workspace…');
    });
});

describe('new session primary action', () => {
    it('sends only what can be sent', () => {
        expect(resolveNewSessionPrimaryAction({
            canSubmit: true,
            phase: null,
            canCancel: true,
        })).toBe('send');
        expect(resolveNewSessionPrimaryAction({
            canSubmit: false,
            phase: null,
            canCancel: true,
        })).toBe('idle');
    });

    // Stop hands the composer back immediately, so it stays Stop for the whole
    // flow rather than turning into a spinner nobody is waiting on.
    it('stays Stop through every step of creation', () => {
        for (const phase of ['worktree', 'spawning', 'opening'] as const) {
            expect(resolveNewSessionPrimaryAction({
                canSubmit: false,
                phase,
                canCancel: true,
            })).toBe('stop');
        }
    });

    it('reports the wait when there is nowhere to send a stop', () => {
        expect(resolveNewSessionPrimaryAction({
            canSubmit: false,
            phase: 'worktree',
            canCancel: false,
        })).toBe('busy');
    });
});
