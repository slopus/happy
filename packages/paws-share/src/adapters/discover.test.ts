import { describe, expect, it } from 'vitest';
import { AmbiguousTranscriptError, selectCurrentCandidate } from './discover';
import type { TranscriptCandidate } from './types';

const candidates: TranscriptCandidate[] = [
    { provider: 'codex', path: '/sessions/codex.jsonl', cwd: '/projects/alpha', modifiedAt: 10 },
    { provider: 'claude-code', path: '/sessions/claude.jsonl', cwd: '/projects/beta', modifiedAt: 20 },
];

describe('selectCurrentCandidate', () => {
    it('selects the only session whose recorded working directory matches', () => {
        expect(selectCurrentCandidate(candidates, '/projects/alpha')).toEqual(candidates[0]);
    });

    it('fails closed when more than one current-directory session is available', () => {
        expect(() => selectCurrentCandidate([
            ...candidates,
            { provider: 'claude-code', path: '/sessions/other.jsonl', cwd: '/projects/alpha', modifiedAt: 30 },
        ], '/projects/alpha')).toThrow(AmbiguousTranscriptError);
    });

    it('does not silently select an unrelated newest session', () => {
        expect(() => selectCurrentCandidate(candidates, '/projects/missing')).toThrow('No session found for the current directory');
    });
});
