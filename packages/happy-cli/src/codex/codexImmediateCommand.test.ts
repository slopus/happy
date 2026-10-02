import { describe, expect, it } from 'vitest';
import { immediateCodexCommandEnvelopes } from './codexImmediateCommand';

describe('local Codex command completion', () => {
    it('creates a separate completed Paws lifecycle for a command without a model turn', () => {
        const [start, response, end] = immediateCodexCommandEnvelopes('Available skills');
        expect(start.turn).toMatch(/^codex-command-/);
        expect(start.ev).toEqual({ t: 'turn-start' });
        expect(response).toMatchObject({ role: 'agent', turn: start.turn, ev: { t: 'text', text: 'Available skills' } });
        expect(end).toMatchObject({ role: 'agent', turn: start.turn, ev: { t: 'turn-end', status: 'completed' } });
        expect(immediateCodexCommandEnvelopes('Context was reset')[0].turn).not.toBe(start.turn);
    });
});
