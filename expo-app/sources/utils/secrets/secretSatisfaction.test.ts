import { describe, expect, it } from 'vitest';

import type { AIBackendProfile, SavedSecret } from '@/sync/settings';
import { getSecretSatisfaction } from '@/utils/secrets/secretSatisfaction';

function makeProfile(reqs: AIBackendProfile['envVarRequirements']): AIBackendProfile {
    return {
        id: 'p1',
        name: 'Profile',
        isBuiltIn: false,
        environmentVariables: [],
        compatibility: { claude: true, codex: true, gemini: true },
        envVarRequirements: reqs ?? [],
        createdAt: 0,
        updatedAt: 0,
        version: '1.0.0',
    } as any;
}

describe('getSecretSatisfaction', () => {
    const secrets: SavedSecret[] = [
        { id: 's1', name: 'S1', kind: 'apiKey', encryptedValue: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'Zm9v' } }, createdAt: 0, updatedAt: 0 } as any,
        { id: 's2', name: 'S2', kind: 'apiKey', encryptedValue: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'YmFy' } }, createdAt: 0, updatedAt: 0 } as any,
    ];

    it('treats profiles with no secret requirements as satisfied', () => {
        const profile = makeProfile([{ name: 'FOO', kind: 'config', required: true }]);
        const res = getSecretSatisfaction({ profile, secrets });
        expect(res.hasSecretRequirements).toBe(false);
        expect(res.isSatisfied).toBe(true);
        expect(res.items).toEqual([]);
    });

    it('evaluates multiple required secrets independently and gates on required-only', () => {
        const profile = makeProfile([
            { name: 'A', kind: 'secret', required: true },
            { name: 'B', kind: 'secret', required: true },
        ]);

        const res = getSecretSatisfaction({
            profile,
            secrets,
            machineEnvReadyByName: { A: true, B: false },
        });

        expect(res.hasSecretRequirements).toBe(true);
        expect(res.isSatisfied).toBe(false);
        expect(res.items.map((i) => [i.envVarName, i.isSatisfied, i.satisfiedBy])).toEqual([
            ['A', true, 'machineEnv'],
            ['B', false, 'none'],
        ]);
    });

    it('prefers sessionOnly over selected/remembered/default/machine per env var', () => {
        const profile = makeProfile([{ name: 'A', kind: 'secret', required: true }]);
        const res = getSecretSatisfaction({
            profile,
            secrets,
            defaultBindings: { A: 's1' },
            selectedSecretIds: { A: 's2' },
            sessionOnlyValues: { A: 'sk-live' },
            machineEnvReadyByName: { A: true },
        });
        expect(res.isSatisfied).toBe(true);
        expect(res.items[0]?.satisfiedBy).toBe('sessionOnly');
    });

    it('when selectedSecretIds[env] is empty string, only machine env (or sessionOnly) can satisfy', () => {
        const profile = makeProfile([{ name: 'A', kind: 'secret', required: true }]);
        const res = getSecretSatisfaction({
            profile,
            secrets,
            defaultBindings: { A: 's1' },
            selectedSecretIds: { A: '' }, // prefer machine env
            machineEnvReadyByName: { A: false },
        });
        expect(res.isSatisfied).toBe(false);
        expect(res.items[0]?.satisfiedBy).toBe('none');
    });
});

