import { describe, expect, it } from 'vitest';
import { applySecretRequirementResult } from './secretRequirementApply';

describe('applySecretRequirementResult', () => {
    it('sets machine env choice and clears session-only value', () => {
        const out = applySecretRequirementResult({
            profileId: 'p1',
            result: { action: 'useMachine', envVarName: 'OPENAI_API_KEY' },
            selectedSecretIdByProfileIdByEnvVarName: { p1: { OPENAI_API_KEY: null } },
            sessionOnlySecretValueByProfileIdByEnvVarName: { p1: { OPENAI_API_KEY: 'abc' } },
            secretBindingsByProfileId: { p1: { OPENAI_API_KEY: 's0' } },
        });

        expect(out.nextSelectedSecretIdByProfileIdByEnvVarName.p1?.OPENAI_API_KEY).toBe('');
        expect(out.nextSessionOnlySecretValueByProfileIdByEnvVarName.p1?.OPENAI_API_KEY).toBeNull();
        expect(out.nextSecretBindingsByProfileId.p1?.OPENAI_API_KEY).toBe('s0');
    });

    it('stores session-only secret value and marks selection as machine-env preferred', () => {
        const out = applySecretRequirementResult({
            profileId: 'p1',
            result: { action: 'enterOnce', envVarName: 'OPENAI_API_KEY', value: 'sk-test' },
            selectedSecretIdByProfileIdByEnvVarName: { p1: {} },
            sessionOnlySecretValueByProfileIdByEnvVarName: {},
            secretBindingsByProfileId: {},
        });

        expect(out.nextSelectedSecretIdByProfileIdByEnvVarName.p1?.OPENAI_API_KEY).toBe('');
        expect(out.nextSessionOnlySecretValueByProfileIdByEnvVarName.p1?.OPENAI_API_KEY).toBe('sk-test');
    });

    it('selects a saved secret without changing defaults when setDefault=false', () => {
        const out = applySecretRequirementResult({
            profileId: 'p1',
            result: { action: 'selectSaved', envVarName: 'OPENAI_API_KEY', secretId: 's1', setDefault: false },
            selectedSecretIdByProfileIdByEnvVarName: { p1: { OPENAI_API_KEY: '' } },
            sessionOnlySecretValueByProfileIdByEnvVarName: { p1: { OPENAI_API_KEY: 'abc' } },
            secretBindingsByProfileId: { p1: { OPENAI_API_KEY: 's0' } },
        });

        expect(out.nextSelectedSecretIdByProfileIdByEnvVarName.p1?.OPENAI_API_KEY).toBe('s1');
        expect(out.nextSessionOnlySecretValueByProfileIdByEnvVarName.p1?.OPENAI_API_KEY).toBeNull();
        expect(out.nextSecretBindingsByProfileId.p1?.OPENAI_API_KEY).toBe('s0');
    });

    it('selects a saved secret and updates defaults when setDefault=true', () => {
        const out = applySecretRequirementResult({
            profileId: 'p1',
            result: { action: 'selectSaved', envVarName: 'OPENAI_API_KEY', secretId: 's1', setDefault: true },
            selectedSecretIdByProfileIdByEnvVarName: { p1: {} },
            sessionOnlySecretValueByProfileIdByEnvVarName: { p1: {} },
            secretBindingsByProfileId: { p1: { OPENAI_API_KEY: 's0' } },
        });

        expect(out.nextSelectedSecretIdByProfileIdByEnvVarName.p1?.OPENAI_API_KEY).toBe('s1');
        expect(out.nextSecretBindingsByProfileId.p1?.OPENAI_API_KEY).toBe('s1');
    });
});

