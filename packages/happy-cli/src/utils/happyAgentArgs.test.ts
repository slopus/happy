import { describe, expect, it } from 'vitest';
import { parseHappyAgentArgs } from './happyAgentArgs';

describe('parseHappyAgentArgs', () => {
    it('reads the flags the daemon always sends', () => {
        const parsed = parseHappyAgentArgs(['--happy-starting-mode', 'remote', '--started-by', 'daemon']);

        expect(parsed.startedBy).toBe('daemon');
        expect(parsed.verbose).toBe(false);
    });

    it('never forwards --happy-starting-mode to the agent', () => {
        // The exact daemon spawn line. OpenCode exits non-zero on an unknown
        // flag, so forwarding any of this makes the session fail to start.
        const parsed = parseHappyAgentArgs(['--happy-starting-mode', 'remote', '--started-by', 'daemon']);

        expect(parsed.forwarded).toEqual([]);
    });

    it('withholds a --happy- flag it has never heard of', () => {
        // The reason this is a namespace and not a list: the daemon adds flags
        // over time, and the agent must not be the one to discover them.
        const parsed = parseHappyAgentArgs(['--happy-some-future-flag', 'value', '--happy-toggle']);

        expect(parsed.forwarded).toEqual([]);
    });

    it('does not eat a following flag as a --happy- value', () => {
        const parsed = parseHappyAgentArgs(['--happy-toggle', '--verbose', 'prompt']);

        expect(parsed.verbose).toBe(true);
        expect(parsed.forwarded).toEqual(['prompt']);
    });

    it('treats --happy-x=value as carrying its own value', () => {
        const parsed = parseHappyAgentArgs(['--happy-starting-mode=remote', 'keep']);

        expect(parsed.forwarded).toEqual(['keep']);
    });

    it('forwards everything that is the agent\'s own', () => {
        const parsed = parseHappyAgentArgs(['--verbose', '--model', 'big-pickle', '--', 'rest']);

        expect(parsed.verbose).toBe(true);
        expect(parsed.forwarded).toEqual(['--model', 'big-pickle', '--', 'rest']);
    });

    it('ignores a --started-by value that is neither caller', () => {
        const parsed = parseHappyAgentArgs(['--started-by', 'somebody-else']);

        expect(parsed.startedBy).toBeUndefined();
        expect(parsed.forwarded).toEqual([]);
    });

    it('survives a trailing flag with no value', () => {
        expect(parseHappyAgentArgs(['--started-by'])).toEqual({
            startedBy: undefined,
            verbose: false,
            forwarded: [],
        });
    });
});
