type SpawnAgent = 'codex' | 'claude' | 'gemini' | 'openclaw' | undefined;

export function getClaudeTmuxSpawnEnvironment(input: {
    agent: SpawnAgent;
    claudeTmuxSessionName: string | null | undefined;
}): Record<string, string> | undefined {
    if (input.agent !== undefined && input.agent !== 'claude') {
        return undefined;
    }

    const sessionName = input.claudeTmuxSessionName?.trim();
    if (!sessionName) {
        return undefined;
    }

    return { TMUX_SESSION_NAME: sessionName };
}

export function isValidTmuxSessionName(value: string): boolean {
    return /^[a-zA-Z0-9._-]+$/.test(value);
}
