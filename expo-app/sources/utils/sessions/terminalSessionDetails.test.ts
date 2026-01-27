import { describe, it, expect } from 'vitest';

import { getAttachCommandForSession, getTmuxFallbackReason, getTmuxTargetForSession } from './terminalSessionDetails';

describe('terminalSessionDetails', () => {
    it('returns an attach command when tmux target exists', () => {
        expect(getAttachCommandForSession({
            sessionId: 's1',
            terminal: {
                mode: 'tmux',
                tmux: { target: 'happy:win-1' },
            },
        } as any)).toBe('happy attach s1');
    });

    it('returns null attach command when terminal is not tmux', () => {
        expect(getAttachCommandForSession({
            sessionId: 's1',
            terminal: {
                mode: 'plain',
                requested: 'tmux',
            },
        } as any)).toBeNull();
    });

    it('returns tmux target when present', () => {
        expect(getTmuxTargetForSession({
            mode: 'tmux',
            tmux: { target: 'happy:win-1', tmpDir: '/tmp' },
        } as any)).toBe('happy:win-1');
    });

    it('returns tmux fallback reason when present', () => {
        expect(getTmuxFallbackReason({
            mode: 'plain',
            requested: 'tmux',
            fallbackReason: 'tmux not found',
        } as any)).toBe('tmux not found');
    });
});

