import { describe, expect, it } from 'vitest';

import { settingsParse } from '@/sync/settings';
import { pruneSecretBindings } from '@/sync/secretBindings';

describe('pruneSecretBindings', () => {
    it('drops bindings for unknown profiles, unknown secrets, and non-required env names; normalizes env var name casing', () => {
        const base = settingsParse({});

        const settings = {
            ...base,
            profiles: [
                {
                    id: 'custom-1',
                    name: 'Custom',
                    environmentVariables: [],
                    compatibility: { claude: true, codex: true, gemini: true },
                    envVarRequirements: [{ name: 'OPENAI_API_KEY', kind: 'secret', required: true }],
                    isBuiltIn: false,
                    createdAt: 0,
                    updatedAt: 0,
                    version: '1.0.0',
                },
            ],
            secrets: [
                { id: 's1', name: 'S1', kind: 'apiKey', encryptedValue: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'Zm9v' } }, createdAt: 0, updatedAt: 0 },
            ],
            secretBindingsByProfileId: {
                // Unknown profile -> drop
                'missing-profile': { OPENAI_API_KEY: 's1' },
                // Known profile:
                'custom-1': {
                    // Normalized to uppercase and kept
                    openai_api_key: 's1',
                    // Env var not declared as secret requirement -> drop
                    OTHER_SECRET: 's1',
                    // Unknown secret id -> drop
                    OPENAI_API_KEY: 'missing-secret',
                    // Invalid env name -> drop
                    'not valid': 's1',
                },
            },
        };

        const pruned = pruneSecretBindings(settings as any);
        expect(pruned.secretBindingsByProfileId).toEqual({
            'custom-1': {
                OPENAI_API_KEY: 's1',
            },
        });
    });
});

