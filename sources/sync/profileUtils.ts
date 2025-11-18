import { AIBackendProfile } from './settings';

/**
 * Documentation and expected values for built-in profiles.
 * These help users understand what environment variables to set and their expected values.
 */
export interface ProfileDocumentation {
    setupGuideUrl?: string; // Link to official setup documentation
    description: string; // Clear description of what this profile does
    environmentVariables: {
        name: string; // Environment variable name (e.g., "Z_AI_BASE_URL")
        expectedValue: string; // What value it should have (e.g., "https://api.z.ai/api/anthropic")
        description: string; // What this variable does
        isSecret: boolean; // Whether this is a secret (never retrieve or display actual value)
    }[];
    shellConfigExample: string; // Example .zshrc/.bashrc configuration
}

/**
 * Get documentation for a built-in profile.
 * Returns setup instructions, expected values, and configuration examples.
 */
export const getBuiltInProfileDocumentation = (id: string): ProfileDocumentation | null => {
    switch (id) {
        case 'anthropic':
            return {
                description: 'Official Anthropic Claude API - uses your default Anthropic credentials',
                environmentVariables: [],
                shellConfigExample: `# No additional environment variables needed
# Uses ANTHROPIC_AUTH_TOKEN from your login session`,
            };
        case 'deepseek':
            return {
                setupGuideUrl: 'https://api-docs.deepseek.com/',
                description: 'DeepSeek Reasoner API proxied through Anthropic-compatible interface',
                environmentVariables: [
                    {
                        name: 'DEEPSEEK_BASE_URL',
                        expectedValue: 'https://api.deepseek.com/anthropic',
                        description: 'DeepSeek API endpoint (Anthropic-compatible)',
                        isSecret: false,
                    },
                    {
                        name: 'DEEPSEEK_AUTH_TOKEN',
                        expectedValue: 'sk-...',
                        description: 'Your DeepSeek API key',
                        isSecret: true,
                    },
                    {
                        name: 'DEEPSEEK_API_TIMEOUT_MS',
                        expectedValue: '600000',
                        description: 'API timeout (10 minutes for reasoning models)',
                        isSecret: false,
                    },
                    {
                        name: 'DEEPSEEK_MODEL',
                        expectedValue: 'deepseek-reasoner',
                        description: 'Default model (reasoning model)',
                        isSecret: false,
                    },
                    {
                        name: 'DEEPSEEK_SMALL_FAST_MODEL',
                        expectedValue: 'deepseek-chat',
                        description: 'Fast model for quick responses',
                        isSecret: false,
                    },
                    {
                        name: 'DEEPSEEK_CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
                        expectedValue: '1',
                        description: 'Disable non-essential network traffic',
                        isSecret: false,
                    },
                ],
                shellConfigExample: `# Add to ~/.zshrc or ~/.bashrc:
export DEEPSEEK_BASE_URL="https://api.deepseek.com/anthropic"
export DEEPSEEK_AUTH_TOKEN="sk-YOUR_DEEPSEEK_API_KEY"
export DEEPSEEK_API_TIMEOUT_MS="600000"
export DEEPSEEK_MODEL="deepseek-reasoner"
export DEEPSEEK_SMALL_FAST_MODEL="deepseek-chat"
export DEEPSEEK_CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1"`,
            };
        case 'zai':
            return {
                setupGuideUrl: 'https://docs.z.ai/devpack/tool/claude',
                description: 'Z.AI GLM-4.6 API proxied through Anthropic-compatible interface',
                environmentVariables: [
                    {
                        name: 'Z_AI_BASE_URL',
                        expectedValue: 'https://api.z.ai/api/anthropic',
                        description: 'Z.AI API endpoint (Anthropic-compatible)',
                        isSecret: false,
                    },
                    {
                        name: 'Z_AI_AUTH_TOKEN',
                        expectedValue: 'sk-...',
                        description: 'Your Z.AI API key',
                        isSecret: true,
                    },
                    {
                        name: 'Z_AI_API_TIMEOUT_MS',
                        expectedValue: '3000000',
                        description: 'API timeout (50 minutes)',
                        isSecret: false,
                    },
                    {
                        name: 'Z_AI_MODEL',
                        expectedValue: 'GLM-4.6',
                        description: 'Default model',
                        isSecret: false,
                    },
                    {
                        name: 'Z_AI_OPUS_MODEL',
                        expectedValue: 'GLM-4.6',
                        description: 'Model for "Opus" tasks (maps to GLM-4.6)',
                        isSecret: false,
                    },
                    {
                        name: 'Z_AI_SONNET_MODEL',
                        expectedValue: 'GLM-4.6',
                        description: 'Model for "Sonnet" tasks (maps to GLM-4.6)',
                        isSecret: false,
                    },
                    {
                        name: 'Z_AI_HAIKU_MODEL',
                        expectedValue: 'GLM-4.5-Air',
                        description: 'Model for "Haiku" tasks (maps to GLM-4.5-Air)',
                        isSecret: false,
                    },
                ],
                shellConfigExample: `# Add to ~/.zshrc or ~/.bashrc:
export Z_AI_BASE_URL="https://api.z.ai/api/anthropic"
export Z_AI_AUTH_TOKEN="sk-YOUR_ZAI_API_KEY"
export Z_AI_API_TIMEOUT_MS="3000000"
export Z_AI_MODEL="GLM-4.6"
export Z_AI_OPUS_MODEL="GLM-4.6"
export Z_AI_SONNET_MODEL="GLM-4.6"
export Z_AI_HAIKU_MODEL="GLM-4.5-Air"`,
            };
        default:
            return null;
    }
};

/**
 * Get a built-in AI backend profile by ID.
 * Built-in profiles provide sensible defaults for popular AI providers.
 *
 * ENVIRONMENT VARIABLE FLOW:
 * 1. User launches daemon with env vars: Z_AI_AUTH_TOKEN=sk-... Z_AI_BASE_URL=https://api.z.ai
 * 2. Profile defines mappings: ANTHROPIC_AUTH_TOKEN=${Z_AI_AUTH_TOKEN}
 * 3. When spawning session, daemon expands ${VAR} from its process.env
 * 4. Session receives: ANTHROPIC_AUTH_TOKEN=sk-... (actual value)
 * 5. Claude CLI reads ANTHROPIC_* env vars, connects to Z.AI
 *
 * This pattern lets users:
 * - Set credentials ONCE when launching daemon
 * - Switch backends by selecting different profiles
 * - Each profile maps daemon env vars to what CLI expects
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
                defaultPermissionMode: 'default',
                compatibility: { claude: true, codex: false },
                isBuiltIn: true,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                version: '1.0.0',
            };
        case 'deepseek':
            // DeepSeek profile: Maps DEEPSEEK_* daemon environment to ANTHROPIC_* for Claude CLI
            // Launch daemon with: DEEPSEEK_AUTH_TOKEN=sk-... DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic
            // Profile uses ${VAR} substitution for all config, no hardcoded values
            // NOTE: anthropicConfig left empty so environmentVariables aren't overridden (getProfileEnvironmentVariables priority)
            return {
                id: 'deepseek',
                name: 'DeepSeek (Reasoner)',
                anthropicConfig: {},
                environmentVariables: [
                    { name: 'ANTHROPIC_BASE_URL', value: '${DEEPSEEK_BASE_URL}' },
                    { name: 'ANTHROPIC_AUTH_TOKEN', value: '${DEEPSEEK_AUTH_TOKEN}' },
                    { name: 'API_TIMEOUT_MS', value: '${DEEPSEEK_API_TIMEOUT_MS}' },
                    { name: 'ANTHROPIC_MODEL', value: '${DEEPSEEK_MODEL}' },
                    { name: 'ANTHROPIC_SMALL_FAST_MODEL', value: '${DEEPSEEK_SMALL_FAST_MODEL}' },
                    { name: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', value: '${DEEPSEEK_CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC}' },
                ],
                defaultPermissionMode: 'default',
                compatibility: { claude: true, codex: false },
                isBuiltIn: true,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                version: '1.0.0',
            };
        case 'zai':
            // Z.AI profile: Maps Z_AI_* daemon environment to ANTHROPIC_* for Claude CLI
            // Launch daemon with: Z_AI_AUTH_TOKEN=sk-... Z_AI_BASE_URL=https://api.z.ai/api/anthropic
            // Model mappings: Z_AI_OPUS_MODEL=GLM-4.6, Z_AI_SONNET_MODEL=GLM-4.6, Z_AI_HAIKU_MODEL=GLM-4.5-Air
            // Profile uses ${VAR} substitution for all config, no hardcoded values
            // NOTE: anthropicConfig left empty so environmentVariables aren't overridden
            return {
                id: 'zai',
                name: 'Z.AI (GLM-4.6)',
                anthropicConfig: {},
                environmentVariables: [
                    { name: 'ANTHROPIC_BASE_URL', value: '${Z_AI_BASE_URL}' },
                    { name: 'ANTHROPIC_AUTH_TOKEN', value: '${Z_AI_AUTH_TOKEN}' },
                    { name: 'API_TIMEOUT_MS', value: '${Z_AI_API_TIMEOUT_MS}' },
                    { name: 'ANTHROPIC_MODEL', value: '${Z_AI_MODEL}' },
                    { name: 'ANTHROPIC_DEFAULT_OPUS_MODEL', value: '${Z_AI_OPUS_MODEL}' },
                    { name: 'ANTHROPIC_DEFAULT_SONNET_MODEL', value: '${Z_AI_SONNET_MODEL}' },
                    { name: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', value: '${Z_AI_HAIKU_MODEL}' },
                ],
                defaultPermissionMode: 'default',
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
