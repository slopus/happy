import { describe, it, expect } from 'vitest';
import { CodingAgentsInspectResponseSchema, supportedCodingAgentIds } from '@slopus/happy-wire';
import { agentKeys, normalizeAgentKey, getCodeAgentDefaults } from '@/sync/agentDefaults';
import { enabledCodingAgents, getCodingAgentCycle } from './codingAgentSelection';
describe('enabled coding agents', () => {
    it('offers Antigravity only on the enabled machine with advertised installation', () => {
        const choices = [{ key: 'antigravity' }];
        expect(enabledCodingAgents(choices, 'm1', { m1: ['antigravity'] }, { antigravity: true })).toEqual(choices);
        expect(enabledCodingAgents(choices, 'm2', { m1: ['antigravity'] }, { antigravity: true })).toEqual([]);
        expect(enabledCodingAgents(choices, 'm1', { m1: ['antigravity'] }, {})).toEqual([]);
    });
    it('ignores a saved Gemini CLI opt-in while retaining Antigravity', () => {
        const choices = [{ key: 'gemini' }, { key: 'antigravity' }];
        expect(enabledCodingAgents(choices, 'm1', { m1: ['gemini', 'antigravity'] }, { gemini: true, antigravity: true })).toEqual([{ key: 'antigravity' }]);
        expect(enabledCodingAgents(choices, 'm1', { m1: ['gemini'] }, { gemini: true })).toEqual([]);
    });
    const agents = [{ key: 'codex' }, { key: 'claude' }, { key: 'opencode' }];
    it('starts with Codex only and respects an explicitly empty selection', () => {
        expect(enabledCodingAgents(agents, 'm1', undefined, undefined)).toEqual([{ key: 'codex' }]);
        expect(enabledCodingAgents(agents, 'm1', { m1: [] }, undefined)).toEqual([]);
    });
    it('isolates machines and filters unavailable or unrecognized agents', () => {
        expect(enabledCodingAgents(agents, 'm1', { m1: ['claude', 'opencode'], m2: ['codex'] }, { claude: true, opencode: false })).toEqual([{ key: 'claude' }]);
        expect(enabledCodingAgents(agents, 'm2', { m1: ['claude'] }, { codex: true })).toEqual([{ key: 'codex' }]);
    });
});

it('keeps legacy responses and session identity readable without offering Gemini CLI', () => {
    expect(supportedCodingAgentIds).not.toContain('gemini');
    expect(getCodingAgentCycle([{ key: 'gemini' }, { key: 'antigravity' }, { key: 'codex' }])).toEqual([{ key: 'codex' }, { key: 'antigravity' }]);
    expect(agentKeys).not.toContain('gemini');
    expect(agentKeys).toContain('antigravity');
    expect(normalizeAgentKey('gemini')).toBe('gemini');
    expect(getCodeAgentDefaults('gemini').modelMode).toBe('gemini-2.5-pro');
    expect(CodingAgentsInspectResponseSchema.safeParse({
        agents: [{ id: 'gemini', installed: true, version: '1.0', latestVersion: null, executable: '/cli/gemini', source: 'npm', reason: null }], checkedAt: 1,
    }).success).toBe(true);
});
