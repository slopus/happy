const TERMINAL_ENV_EXACT_ALLOWLIST = new Set([
    'ALL_PROXY',
    'API_TIMEOUT_MS',
    'COLORTERM',
    'HAPPY_CLAUDE_PATH',
    'HOME',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'LANG',
    'LOGNAME',
    'NO_PROXY',
    'NODE_EXTRA_CA_CERTS',
    'PATH',
    'SHELL',
    'SSH_AUTH_SOCK',
    'SSL_CERT_DIR',
    'SSL_CERT_FILE',
    'TERM',
    'TMPDIR',
    'USER',
    'all_proxy',
    'http_proxy',
    'https_proxy',
    'no_proxy',
]);

const TERMINAL_ENV_PREFIX_ALLOWLIST = [
    'ANTHROPIC_',
    'CLAUDE_',
    'LC_',
    'MCP_',
] as const;

const TMUX_CLIENT_ENV_EXACT_ALLOWLIST = new Set([
    'HOME',
    'LANG',
    'LOGNAME',
    'PATH',
    'SHELL',
    'TERM',
    'TMPDIR',
    'TMUX',
    'TMUX_TMPDIR',
    'USER',
]);

const TMUX_CLIENT_ENV_PREFIX_ALLOWLIST = [
    'LC_',
] as const;

export function sanitizeTerminalEnvironment(env: Record<string, string | undefined>): Record<string, string> {
    const sanitized: Record<string, string> = {};

    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined && isAllowedTerminalEnvironmentKey(key)) {
            sanitized[key] = value;
        }
    }

    return sanitized;
}

export function sanitizeTmuxClientEnvironment(env: Record<string, string | undefined>): Record<string, string> {
    const sanitized: Record<string, string> = {};

    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined && isAllowedTmuxClientEnvironmentKey(key)) {
            sanitized[key] = value;
        }
    }

    return sanitized;
}

function isAllowedTerminalEnvironmentKey(key: string): boolean {
    if (TERMINAL_ENV_EXACT_ALLOWLIST.has(key)) {
        return true;
    }

    return TERMINAL_ENV_PREFIX_ALLOWLIST.some((prefix) => key.startsWith(prefix));
}

function isAllowedTmuxClientEnvironmentKey(key: string): boolean {
    if (TMUX_CLIENT_ENV_EXACT_ALLOWLIST.has(key)) {
        return true;
    }

    return TMUX_CLIENT_ENV_PREFIX_ALLOWLIST.some((prefix) => key.startsWith(prefix));
}
