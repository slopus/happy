import { describe, expect, it } from 'vitest';
import { ALL_AGENTS, getAvailableNewSessionAgents } from './newSessionAgents';
import { MachineMetadataSchema } from '@/sync/storageTypes';

describe('getAvailableNewSessionAgents', () => {
    it('includes OpenCode when machine metadata reports OpenCode CLI availability', () => {
        const agents = getAvailableNewSessionAgents({
            claude: true,
            codex: true,
            gemini: false,
            openclaw: false,
            opencode: true,
            detectedAt: 1,
        });

        expect(agents.map((agent) => agent.key)).toEqual(['claude', 'codex', 'opencode']);
    });

    it('hides OpenCode when machine metadata reports it unavailable', () => {
        const agents = getAvailableNewSessionAgents({
            claude: true,
            codex: true,
            gemini: true,
            openclaw: true,
            opencode: false,
            detectedAt: 1,
        });

        expect(agents.map((agent) => agent.key)).toEqual(['claude', 'codex', 'openclaw', 'gemini']);
    });

    it('keeps OpenCode in the default provider list when metadata has no availability', () => {
        expect(getAvailableNewSessionAgents(undefined)).toEqual(ALL_AGENTS);
        expect(ALL_AGENTS.map((agent) => agent.key)).toContain('opencode');
    });

    it('accepts older machine metadata without OpenCode CLI availability', () => {
        const parsed = MachineMetadataSchema.safeParse({
            host: 'host',
            platform: 'darwin',
            happyCliVersion: '1.0.0',
            happyHomeDir: '/tmp/.happy',
            homeDir: '/tmp',
            cliAvailability: {
                claude: true,
                codex: true,
                gemini: false,
                openclaw: false,
                detectedAt: 1,
            },
        });

        expect(parsed.success).toBe(true);
    });

    it('hides OpenCode when older machine metadata has no OpenCode CLI availability field', () => {
        const agents = getAvailableNewSessionAgents({
            claude: true,
            codex: true,
            gemini: true,
            openclaw: false,
            detectedAt: 1,
        });

        expect(agents.map((agent) => agent.key)).toEqual(['claude', 'codex', 'gemini']);
    });
});
