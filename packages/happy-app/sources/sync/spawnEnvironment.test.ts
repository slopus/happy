import { describe, expect, it } from 'vitest';
import { getClaudeTmuxSpawnEnvironment } from './spawnEnvironment';

describe('spawn environment', () => {
    it('adds TMUX_SESSION_NAME for Claude spawns when a session name is configured', () => {
        expect(getClaudeTmuxSpawnEnvironment({
            agent: 'claude',
            claudeTmuxSessionName: ' happy-dev ',
        })).toEqual({ TMUX_SESSION_NAME: 'happy-dev' });
    });

    it('treats an unspecified agent as Claude because the daemon defaults to Claude', () => {
        expect(getClaudeTmuxSpawnEnvironment({
            agent: undefined,
            claudeTmuxSessionName: 'happy-dev',
        })).toEqual({ TMUX_SESSION_NAME: 'happy-dev' });
    });

    it('does not add tmux env for non-Claude agents or empty session names', () => {
        expect(getClaudeTmuxSpawnEnvironment({
            agent: 'codex',
            claudeTmuxSessionName: 'happy-dev',
        })).toBeUndefined();
        expect(getClaudeTmuxSpawnEnvironment({
            agent: 'claude',
            claudeTmuxSessionName: '   ',
        })).toBeUndefined();
        expect(getClaudeTmuxSpawnEnvironment({
            agent: 'claude',
            claudeTmuxSessionName: null,
        })).toBeUndefined();
    });
});
