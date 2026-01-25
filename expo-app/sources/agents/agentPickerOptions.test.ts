import { describe, expect, it } from 'vitest';

import { getAgentPickerOptions } from './agentPickerOptions';

describe('agents/agentPickerOptions', () => {
    it('returns display metadata for enabled agents', () => {
        const options = getAgentPickerOptions(['claude', 'codex', 'gemini']);
        expect(options.map((o) => o.agentId)).toEqual(['claude', 'codex', 'gemini']);
        expect(options[0]?.titleKey).toBe('agentInput.agent.claude');
        expect(options[1]?.titleKey).toBe('agentInput.agent.codex');
        expect(options[2]?.titleKey).toBe('agentInput.agent.gemini');
        expect(typeof options[0]?.iconName).toBe('string');
    });
});

