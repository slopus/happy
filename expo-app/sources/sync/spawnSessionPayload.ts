import type { TerminalSpawnOptions } from './terminalSettings';

// Options for spawning a session
export interface SpawnSessionOptions {
    machineId: string;
    directory: string;
    approvedNewDirectoryCreation?: boolean;
    token?: string;
    agent?: 'codex' | 'claude' | 'gemini';
    // Session-scoped profile identity (non-secret). Empty string means "no profile".
    profileId?: string;
    // Environment variables from AI backend profile
    // Accepts any environment variables - daemon will pass them to the agent process
    // Common variables include:
    // - ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_MODEL, ANTHROPIC_SMALL_FAST_MODEL
    // - OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL, OPENAI_API_TIMEOUT_MS
    // - AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_VERSION, AZURE_OPENAI_DEPLOYMENT_NAME
    // - TOGETHER_API_KEY, TOGETHER_MODEL
    // - API_TIMEOUT_MS, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
    // - Custom variables (DEEPSEEK_*, Z_AI_*, etc.)
    environmentVariables?: Record<string, string>;
    resume?: string;
    terminal?: TerminalSpawnOptions | null;
}

export type SpawnHappySessionRpcParams = {
    type: 'spawn-in-directory'
    directory: string
    approvedNewDirectoryCreation?: boolean
    token?: string
    agent?: 'codex' | 'claude' | 'gemini'
    profileId?: string
    environmentVariables?: Record<string, string>
    resume?: string
    terminal?: TerminalSpawnOptions
};

export function buildSpawnHappySessionRpcParams(options: SpawnSessionOptions): SpawnHappySessionRpcParams {
    const { directory, approvedNewDirectoryCreation = false, token, agent, environmentVariables, profileId, resume, terminal } = options;

    const params: SpawnHappySessionRpcParams = {
        type: 'spawn-in-directory',
        directory,
        approvedNewDirectoryCreation,
        token,
        agent,
        profileId,
        environmentVariables,
        resume,
    };

    if (terminal) {
        params.terminal = terminal;
    }

    return params;
}
