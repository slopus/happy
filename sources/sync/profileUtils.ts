import { AIBackendProfile } from './settings';

/**
 * Get a built-in AI backend profile by ID.
 * Built-in profiles provide sensible defaults for popular AI providers.
 *
 * @param id - The profile ID (anthropic, deepseek, zai, openai, azure-openai, together)
 * @returns The complete profile configuration, or null if not found
 */
export const getBuiltInProfile = (id: string): AIBackendProfile | null => {
    switch (id) {
        case 'anthropic':
            return {
                id: 'anthropic',
                name: 'Anthropic (Default)',
                anthropicConfig: {},
                environmentVariables: [],
                compatibility: { claude: true, codex: false },
                isBuiltIn: true,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                version: '1.0.0',
            };
        case 'deepseek':
            return {
                id: 'deepseek',
                name: 'DeepSeek (Reasoner)',
                anthropicConfig: {
                    baseUrl: 'https://api.deepseek.com/anthropic',
                    model: 'deepseek-reasoner',
                },
                environmentVariables: [
                    { name: 'ANTHROPIC_BASE_URL', value: '${DEEPSEEK_BASE_URL}' },
                    { name: 'ANTHROPIC_AUTH_TOKEN', value: '${DEEPSEEK_AUTH_TOKEN}' },
                    { name: 'ANTHROPIC_MODEL', value: '${DEEPSEEK_MODEL}' },
                    { name: 'API_TIMEOUT_MS', value: '${DEEPSEEK_API_TIMEOUT_MS}' },
                    { name: 'ANTHROPIC_SMALL_FAST_MODEL', value: '${DEEPSEEK_SMALL_FAST_MODEL}' },
                    { name: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', value: '${DEEPSEEK_CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC}' },
                ],
                compatibility: { claude: true, codex: false },
                isBuiltIn: true,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                version: '1.0.0',
            };
        case 'zai':
            return {
                id: 'zai',
                name: 'Z.AI (GLM-4.6)',
                anthropicConfig: {
                    baseUrl: 'https://api.z.ai/api/anthropic',
                    model: 'glm-4.6',
                },
                environmentVariables: [
                    { name: 'ANTHROPIC_BASE_URL', value: '${Z_AI_BASE_URL}' },
                    { name: 'ANTHROPIC_AUTH_TOKEN', value: '${Z_AI_AUTH_TOKEN}' },
                    { name: 'ANTHROPIC_MODEL', value: '${Z_AI_MODEL}' },
                ],
                compatibility: { claude: true, codex: false },
                isBuiltIn: true,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                version: '1.0.0',
            };
        case 'openai':
            return {
                id: 'openai',
                name: 'OpenAI (GPT-5)',
                openaiConfig: {
                    baseUrl: 'https://api.openai.com/v1',
                    model: 'gpt-5-codex-high',
                },
                environmentVariables: [
                    { name: 'OPENAI_API_TIMEOUT_MS', value: '600000' },
                    { name: 'OPENAI_SMALL_FAST_MODEL', value: 'gpt-5-codex-low' },
                    { name: 'API_TIMEOUT_MS', value: '600000' },
                    { name: 'CODEX_SMALL_FAST_MODEL', value: 'gpt-5-codex-low' },
                ],
                compatibility: { claude: false, codex: true },
                isBuiltIn: true,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                version: '1.0.0',
            };
        case 'azure-openai':
            return {
                id: 'azure-openai',
                name: 'Azure OpenAI',
                azureOpenAIConfig: {
                    apiVersion: '2024-02-15-preview',
                    deploymentName: 'gpt-5-codex',
                },
                environmentVariables: [
                    { name: 'OPENAI_API_TIMEOUT_MS', value: '600000' },
                    { name: 'API_TIMEOUT_MS', value: '600000' },
                ],
                compatibility: { claude: false, codex: true },
                isBuiltIn: true,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                version: '1.0.0',
            };
        case 'together':
            return {
                id: 'together',
                name: 'Together AI',
                openaiConfig: {
                    baseUrl: 'https://api.together.xyz/v1',
                    model: 'meta-llama/Llama-3.1-405B-Instruct-Turbo',
                },
                environmentVariables: [
                    { name: 'OPENAI_API_TIMEOUT_MS', value: '600000' },
                    { name: 'API_TIMEOUT_MS', value: '600000' },
                ],
                compatibility: { claude: false, codex: true },
                isBuiltIn: true,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                version: '1.0.0',
            };
        default:
            return null;
    }
};

/**
 * Default built-in profiles available to all users.
 * These provide quick-start configurations for popular AI providers.
 */
export const DEFAULT_PROFILES = [
    {
        id: 'anthropic',
        name: 'Anthropic (Default)',
        isBuiltIn: true,
    },
    {
        id: 'deepseek',
        name: 'DeepSeek (Reasoner)',
        isBuiltIn: true,
    },
    {
        id: 'zai',
        name: 'Z.AI (GLM-4.6)',
        isBuiltIn: true,
    },
    {
        id: 'openai',
        name: 'OpenAI (GPT-5)',
        isBuiltIn: true,
    },
    {
        id: 'azure-openai',
        name: 'Azure OpenAI',
        isBuiltIn: true,
    },
    {
        id: 'together',
        name: 'Together AI',
        isBuiltIn: true,
    }
];
