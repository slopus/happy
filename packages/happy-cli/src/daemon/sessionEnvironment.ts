/**
 * Environment variables that identify one particular Happy or provider
 * session. A daemon can live much longer than the session that created it, so
 * these must never flow from an ambient daemon environment into a new child.
 */
export const SESSION_SCOPED_ENV_KEYS = [
    'HAPPY_RECONNECT_SESSION_ID',
    'HAPPY_RECONNECT_ENCRYPTION_KEY',
    'HAPPY_RECONNECT_ENCRYPTION_VARIANT',
    'HAPPY_RECONNECT_SEQ',
    'HAPPY_RECONNECT_METADATA_VERSION',
    'HAPPY_RECONNECT_AGENT_STATE_VERSION',
    'HAPPY_FORKED_FROM_SESSION_ID',
    'HAPPY_FORKED_FROM_MESSAGE_ID',
    'HAPPY_FORK_CLAUDE_SESSION_ID',
    'HAPPY_FORK_CODEX_THREAD_ID',
    'HAPPY_SIDE_CHAT',
    'CODEX_THREAD_ID',
] as const;

/**
 * Remove session-scoped state inherited from a parent process without
 * modifying the source environment.
 */
export function sanitizeSessionEnvironment<T extends Record<string, string>>(env: T): T;
export function sanitizeSessionEnvironment(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function sanitizeSessionEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const sanitized = { ...env };
    for (const key of SESSION_SCOPED_ENV_KEYS) {
        delete sanitized[key];
    }
    return sanitized;
}

/**
 * Build a child environment from clean ambient values plus explicit values for
 * the session being launched. Explicit values deliberately win so fork and
 * resume requests continue to work.
 */
export function buildSessionChildEnvironment(
    ambientEnv: NodeJS.ProcessEnv = process.env,
    explicitEnv: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
    return {
        ...sanitizeSessionEnvironment(ambientEnv),
        ...explicitEnv,
    };
}

/**
 * tmux windows inherit their server environment, including keys omitted from
 * `new-window -e`. These are the keys the shell must explicitly unset before
 * starting a child, unless this launch intentionally supplies a replacement.
 */
export function sessionEnvironmentKeysToUnset(explicitEnv: NodeJS.ProcessEnv = {}): string[] {
    return SESSION_SCOPED_ENV_KEYS.filter((key) => explicitEnv[key] === undefined);
}

export function wrapTmuxCommandWithSessionEnvironmentSanitizer(
    command: string,
    explicitEnv: NodeJS.ProcessEnv = {},
): string {
    const keysToUnset = sessionEnvironmentKeysToUnset(explicitEnv);
    if (keysToUnset.length === 0) {
        return command;
    }
    return `unset ${keysToUnset.join(' ')}; ${command}`;
}
