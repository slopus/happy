import { logger } from '@/ui/logger';
import type { PermissionMode } from '@/api/types';

/**
 * New-session defaults for Claude, overridable per machine via environment
 * variables. This is the daemon/CLI-side counterpart to picking values in the
 * app: headless machines (a daemon spawning sessions on a remote VM, CI, tmux)
 * have no picker, so without these variables every session silently falls
 * back to the hardcoded defaults.
 *
 * - HAPPY_CLAUDE_EFFORT: low | medium | high | xhigh | max
 * - HAPPY_CLAUDE_PERMISSION_MODE: default | acceptEdits | bypassPermissions | plan | read-only | safe-yolo | yolo
 * - HAPPY_CLAUDE_MODEL: any model name Claude accepts
 *
 * Invalid values are ignored with a debug log rather than failing startup.
 */

export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const CLAUDE_EFFORTS: readonly ClaudeEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const PERMISSION_MODES: readonly PermissionMode[] = [
    'default',
    'acceptEdits',
    'bypassPermissions',
    'plan',
    'read-only',
    'safe-yolo',
    'yolo',
];

function readEnvChoice<T extends string>(
    name: string,
    allowed: readonly T[],
    fallback: T,
    env: NodeJS.ProcessEnv,
): T {
    const raw = env[name]?.trim();
    if (!raw) {
        return fallback;
    }
    if ((allowed as readonly string[]).includes(raw)) {
        return raw as T;
    }
    logger.debug(`[startupDefaults] Ignoring ${name}="${raw}" (expected one of: ${allowed.join(', ')})`);
    return fallback;
}

export function defaultClaudeEffort(env: NodeJS.ProcessEnv = process.env): ClaudeEffort {
    return readEnvChoice('HAPPY_CLAUDE_EFFORT', CLAUDE_EFFORTS, 'medium', env);
}

export function defaultClaudePermissionMode(env: NodeJS.ProcessEnv = process.env): PermissionMode {
    return readEnvChoice('HAPPY_CLAUDE_PERMISSION_MODE', PERMISSION_MODES, 'yolo', env);
}

export function defaultClaudeModel(env: NodeJS.ProcessEnv = process.env): string {
    return env.HAPPY_CLAUDE_MODEL?.trim() || 'opus';
}
