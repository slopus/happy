import { describe, expect, it } from 'vitest';

import { MachineMetadataSchema } from '@/sync/storageTypes';
import { getAvailableAgents } from './availableAgents';

function metadata(input: Record<string, unknown>) {
    return MachineMetadataSchema.parse({
        host: 'test-machine',
        platform: 'darwin-arm64',
        happyCliVersion: '1.2.0',
        happyHomeDir: '/tmp',
        homeDir: '/tmp',
        ...input,
    });
}

describe('getAvailableAgents', () => {
    it('uses every agent advertised by a remote bridge', () => {
        const agents = getAvailableAgents(metadata({
            remoteCapabilities: {
                agents: [
                    { type: 'codex', name: 'Codex', description: 'OpenAI Codex' },
                    { type: 'claude-code', name: 'Claude Code' },
                    { type: 'claude-codex', name: 'Claude + Codex' },
                    { type: 'gemini', name: 'Gemini' },
                    { type: 'grok', name: 'Grok' },
                    { type: 'lmstudio', name: 'LM Studio', available: false },
                ],
                roots: [],
            },
        }));

        expect(agents.map((agent) => agent.key)).toEqual([
            'codex',
            'claude-code',
            'claude-codex',
            'gemini',
            'grok',
            'lmstudio',
        ]);
        expect(agents.find((agent) => agent.key === 'claude-codex')?.name).toBe('Claude + Codex');
    });

    it('keeps CLI availability as the fallback for standard Happy machines', () => {
        const agents = getAvailableAgents(metadata({
            cliAvailability: {
                claude: true,
                codex: true,
                gemini: false,
                openclaw: true,
                agy: false,
                detectedAt: 1,
            },
        }));

        expect(agents.map((agent) => agent.key)).toEqual(['claude', 'codex', 'openclaw']);
    });
});
