import { describe, expect, it } from 'vitest';

describe('modelOptions', () => {
    it('builds generic options for unknown modes', async () => {
        const { getModelOptionsForModes } = await import('./modelOptions');
        const out = getModelOptionsForModes(['gpt-5-low', 'default']);
        expect(out.map((o) => o.value)).toEqual(['gpt-5-low', 'default']);
        expect(out[0].label).toBe('gpt-5-low');
        expect(out[0].description).toBe('');
    });

    it('returns options for agents with configurable model selection', async () => {
        const { getModelOptionsForAgentType } = await import('./modelOptions');
        expect(getModelOptionsForAgentType('gemini').map((o) => o.value)).toEqual([
            'gemini-2.5-pro',
            'gemini-2.5-flash',
            'gemini-2.5-flash-lite',
        ]);
    });

    it('returns no options for agents without configurable model selection', async () => {
        const { getModelOptionsForAgentType } = await import('./modelOptions');
        expect(getModelOptionsForAgentType('claude')).toEqual([]);
        expect(getModelOptionsForAgentType('codex')).toEqual([]);
    });
});
