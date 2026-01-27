import { describe, it, expect } from 'vitest';

import { getEnabledAgentIds, isAgentEnabled } from './enabled';

describe('agents/enabled', () => {
    it('enables stable agents regardless of experiments', () => {
        expect(isAgentEnabled({ agentId: 'claude', experiments: false, experimentalAgents: {} })).toBe(true);
        expect(isAgentEnabled({ agentId: 'codex', experiments: false, experimentalAgents: {} })).toBe(true);
        expect(isAgentEnabled({ agentId: 'opencode', experiments: false, experimentalAgents: {} })).toBe(true);
    });

    it('gates experimental agents behind experiments + per-agent toggle', () => {
        expect(isAgentEnabled({ agentId: 'gemini', experiments: false, experimentalAgents: { gemini: true } })).toBe(false);
        expect(isAgentEnabled({ agentId: 'gemini', experiments: true, experimentalAgents: { gemini: false } })).toBe(false);
        expect(isAgentEnabled({ agentId: 'gemini', experiments: true, experimentalAgents: { gemini: true } })).toBe(true);

        expect(isAgentEnabled({ agentId: 'auggie', experiments: false, experimentalAgents: { auggie: true } })).toBe(false);
        expect(isAgentEnabled({ agentId: 'auggie', experiments: true, experimentalAgents: { auggie: false } })).toBe(false);
        expect(isAgentEnabled({ agentId: 'auggie', experiments: true, experimentalAgents: { auggie: true } })).toBe(true);
    });

    it('returns enabled agent ids in display order', () => {
        expect(getEnabledAgentIds({ experiments: false, experimentalAgents: { gemini: true, auggie: true } })).toEqual(['claude', 'codex', 'opencode']);
        expect(getEnabledAgentIds({ experiments: true, experimentalAgents: { gemini: true, auggie: true } })).toEqual(['claude', 'codex', 'opencode', 'gemini', 'auggie']);
    });
});
