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
                        description: 'Default model (reasoning model for complex debugging/algorithms, use deepseek-chat for faster general tasks)',
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
export DEEPSEEK_CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1"

# Model selection guide:
# - deepseek-reasoner: Best for complex debugging, algorithms, precision (slower but more accurate)
# - deepseek-chat: Best for everyday coding, boilerplate, speed (handles 80% of general tasks)`,
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
        case 'openai':
            return {
                setupGuideUrl: 'https://platform.openai.com/docs/api-reference',
                description: 'OpenAI GPT-5 Codex API for code generation and completion',
                environmentVariables: [
                    {
                        name: 'OPENAI_BASE_URL',
                        expectedValue: 'https://api.openai.com/v1',
                        description: 'OpenAI API endpoint',
                        isSecret: false,
                    },
                    {
                        name: 'OPENAI_API_KEY',
                        expectedValue: '',
                        description: 'Your OpenAI API key',
                        isSecret: true,
                    },
                    {
                        name: 'OPENAI_MODEL',
                        expectedValue: 'gpt-5-codex-high',
                        description: 'Default model for code tasks',
                        isSecret: false,
                    },
                    {
                        name: 'OPENAI_SMALL_FAST_MODEL',
                        expectedValue: 'gpt-5-codex-low',
                        description: 'Fast model for quick responses',
                        isSecret: false,
                    },
                ],
                shellConfigExample: `# Add to ~/.zshrc or ~/.bashrc:
export OPENAI_BASE_URL="https://api.openai.com/v1"
export OPENAI_API_KEY="sk-YOUR_OPENAI_API_KEY"
export OPENAI_MODEL="gpt-5-codex-high"
export OPENAI_SMALL_FAST_MODEL="gpt-5-codex-low"`,
            };
        case 'azure-openai':
            return {
                setupGuideUrl: 'https://learn.microsoft.com/en-us/azure/ai-services/openai/',
                description: 'Azure OpenAI Service for enterprise-grade AI with enhanced security and compliance',
                environmentVariables: [
                    {
                        name: 'AZURE_OPENAI_ENDPOINT',
                        expectedValue: 'https://YOUR_RESOURCE.openai.azure.com',
                        description: 'Your Azure OpenAI endpoint URL',
                        isSecret: false,
                    },
                    {
                        name: 'AZURE_OPENAI_API_KEY',
                        expectedValue: '',
                        description: 'Your Azure OpenAI API key',
                        isSecret: true,
                    },
                    {
                        name: 'AZURE_OPENAI_API_VERSION',
                        expectedValue: '2024-02-15-preview',
                        description: 'Azure OpenAI API version',
                        isSecret: false,
                    },
                    {
                        name: 'AZURE_OPENAI_DEPLOYMENT_NAME',
                        expectedValue: 'gpt-5-codex',
                        description: 'Your deployment name for the model',
                        isSecret: false,
                    },
                ],
                shellConfigExample: `# Add to ~/.zshrc or ~/.bashrc:
export AZURE_OPENAI_ENDPOINT="https://YOUR_RESOURCE.openai.azure.com"
export AZURE_OPENAI_API_KEY="YOUR_AZURE_API_KEY"
export AZURE_OPENAI_API_VERSION="2024-02-15-preview"
export AZURE_OPENAI_DEPLOYMENT_NAME="gpt-5-codex"`,
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
                compatibility: { claude: true, codex: false, gemini: false },
                isBuiltIn: true,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                version: '1.0.0',
            };
        case 'deepseek':
            // DeepSeek profile: Maps DEEPSEEK_* daemon environment to ANTHROPIC_* for Claude CLI
            // Launch daemon with: DEEPSEEK_AUTH_TOKEN=sk-... DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic
            // Uses ${VAR:-default} format for fallback values (bash parameter expansion)
            // Secrets use ${VAR} without fallback for security
            // NOTE: anthropicConfig left empty so environmentVariables aren't overridden (getProfileEnvironmentVariables priority)
            return {
                id: 'deepseek',
                name: 'DeepSeek (Reasoner)',
                anthropicConfig: {},
                environmentVariables: [
                    { name: 'ANTHROPIC_BASE_URL', value: '${DEEPSEEK_BASE_URL:-https://api.deepseek.com/anthropic}' },
                    { name: 'ANTHROPIC_AUTH_TOKEN', value: '${DEEPSEEK_AUTH_TOKEN}' }, // Secret - no fallback
                    { name: 'API_TIMEOUT_MS', value: '${DEEPSEEK_API_TIMEOUT_MS:-600000}' },
                    { name: 'ANTHROPIC_MODEL', value: '${DEEPSEEK_MODEL:-deepseek-reasoner}' },
                    { name: 'ANTHROPIC_SMALL_FAST_MODEL', value: '${DEEPSEEK_SMALL_FAST_MODEL:-deepseek-chat}' },
                    { name: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', value: '${DEEPSEEK_CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:-1}' },
                ],
                defaultPermissionMode: 'default',
                compatibility: { claude: true, codex: false, gemini: false },
                isBuiltIn: true,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                version: '1.0.0',
            };
        case 'zai':
            // Z.AI profile: Maps Z_AI_* daemon environment to ANTHROPIC_* for Claude CLI
            // Launch daemon with: Z_AI_AUTH_TOKEN=sk-... Z_AI_BASE_URL=https://api.z.ai/api/anthropic
            // Model mappings: Z_AI_OPUS_MODEL=GLM-4.6, Z_AI_SONNET_MODEL=GLM-4.6, Z_AI_HAIKU_MODEL=GLM-4.5-Air
            // Uses ${VAR:-default} format for fallback values (bash parameter expansion)
            // Secrets use ${VAR} without fallback for security
            // NOTE: anthropicConfig left empty so environmentVariables aren't overridden
            return {
                id: 'zai',
                name: 'Z.AI (GLM-4.6)',
                anthropicConfig: {},
                environmentVariables: [
                    { name: 'ANTHROPIC_BASE_URL', value: '${Z_AI_BASE_URL:-https://api.z.ai/api/anthropic}' },
                    { name: 'ANTHROPIC_AUTH_TOKEN', value: '${Z_AI_AUTH_TOKEN}' }, // Secret - no fallback
                    { name: 'API_TIMEOUT_MS', value: '${Z_AI_API_TIMEOUT_MS:-3000000}' },
                    { name: 'ANTHROPIC_MODEL', value: '${Z_AI_MODEL:-GLM-4.6}' },
                    { name: 'ANTHROPIC_DEFAULT_OPUS_MODEL', value: '${Z_AI_OPUS_MODEL:-GLM-4.6}' },
                    { name: 'ANTHROPIC_DEFAULT_SONNET_MODEL', value: '${Z_AI_SONNET_MODEL:-GLM-4.6}' },
                    { name: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', value: '${Z_AI_HAIKU_MODEL:-GLM-4.5-Air}' },
                ],
                defaultPermissionMode: 'default',
                compatibility: { claude: true, codex: false, gemini: false },
                isBuiltIn: true,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                version: '1.0.0',
            };
        case 'openai':
            return {
                id: 'openai',
                name: 'OpenAI (GPT-5)',
                openaiConfig: {},
                environmentVariables: [
                    { name: 'OPENAI_BASE_URL', value: 'https://api.openai.com/v1' },
                    { name: 'OPENAI_MODEL', value: 'gpt-5-codex-high' },
                    { name: 'OPENAI_API_TIMEOUT_MS', value: '600000' },
                    { name: 'OPENAI_SMALL_FAST_MODEL', value: 'gpt-5-codex-low' },
                    { name: 'API_TIMEOUT_MS', value: '600000' },
                    { name: 'CODEX_SMALL_FAST_MODEL', value: 'gpt-5-codex-low' },
                ],
                compatibility: { claude: false, codex: true, gemini: false },
                isBuiltIn: true,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                version: '1.0.0',
            };
        case 'azure-openai':
            return {
                id: 'azure-openai',
                name: 'Azure OpenAI',
                azureOpenAIConfig: {},
                environmentVariables: [
                    { name: 'AZURE_OPENAI_API_VERSION', value: '2024-02-15-preview' },
                    { name: 'AZURE_OPENAI_DEPLOYMENT_NAME', value: 'gpt-5-codex' },
                    { name: 'OPENAI_API_TIMEOUT_MS', value: '600000' },
                    { name: 'API_TIMEOUT_MS', value: '600000' },
                ],
                compatibility: { claude: false, codex: true, gemini: false },
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
    }
];
