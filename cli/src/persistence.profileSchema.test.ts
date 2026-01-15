import { describe, expect, it } from 'vitest';
import { AIBackendProfileSchema } from './persistence';

describe('AIBackendProfileSchema legacy provider config migration', () => {
    it('migrates legacy provider config objects into environmentVariables', () => {
        const profile = AIBackendProfileSchema.parse({
            id: 'profile-1',
            name: 'Profile 1',
            openaiConfig: {
                apiKey: '${OPENAI_KEY}',
            },
        });

        expect(profile.environmentVariables).toContainEqual({ name: 'OPENAI_API_KEY', value: '${OPENAI_KEY}' });
        expect((profile as any).openaiConfig).toBeUndefined();
    });

    it('migrates other legacy provider config objects into environmentVariables', () => {
        const profile = AIBackendProfileSchema.parse({
            id: 'profile-1',
            name: 'Profile 1',
            anthropicConfig: {
                authToken: '${ANTHROPIC_KEY}',
                baseUrl: '${ANTHROPIC_URL}',
            },
            azureOpenAIConfig: {
                apiKey: '${AZURE_KEY}',
                endpoint: '${AZURE_ENDPOINT}',
                deploymentName: '${AZURE_DEPLOYMENT}',
            },
            togetherAIConfig: {
                apiKey: '${TOGETHER_KEY}',
            },
        });

        expect(profile.environmentVariables).toContainEqual({ name: 'ANTHROPIC_AUTH_TOKEN', value: '${ANTHROPIC_KEY}' });
        expect(profile.environmentVariables).toContainEqual({ name: 'ANTHROPIC_BASE_URL', value: '${ANTHROPIC_URL}' });
        expect(profile.environmentVariables).toContainEqual({ name: 'AZURE_OPENAI_API_KEY', value: '${AZURE_KEY}' });
        expect(profile.environmentVariables).toContainEqual({ name: 'AZURE_OPENAI_ENDPOINT', value: '${AZURE_ENDPOINT}' });
        expect(profile.environmentVariables).toContainEqual({ name: 'AZURE_OPENAI_DEPLOYMENT_NAME', value: '${AZURE_DEPLOYMENT}' });
        expect(profile.environmentVariables).toContainEqual({ name: 'TOGETHER_API_KEY', value: '${TOGETHER_KEY}' });
    });

    it('does not override explicit environmentVariables with legacy config values', () => {
        const profile = AIBackendProfileSchema.parse({
            id: 'profile-1',
            name: 'Profile 1',
            environmentVariables: [{ name: 'OPENAI_API_KEY', value: 'explicit' }],
            openaiConfig: {
                apiKey: 'legacy',
            },
        });

        const apiKeyEntries = profile.environmentVariables.filter((ev) => ev.name === 'OPENAI_API_KEY');
        expect(apiKeyEntries).toHaveLength(1);
        expect(apiKeyEntries[0]?.value).toBe('explicit');
    });
});
