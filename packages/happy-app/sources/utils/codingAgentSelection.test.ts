import { describe, it, expect } from 'vitest';
import { enabledCodingAgents } from './codingAgentSelection';
describe('enabled coding agents', () => {
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
