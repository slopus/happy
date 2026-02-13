import type { QueryOptions } from '@/claude/sdk';
import type { PermissionMode } from '@/api/types';

/** Derived from SDK's QueryOptions - the modes Claude actually supports */
export type ClaudeSdkPermissionMode = NonNullable<QueryOptions['permissionMode']>;

/**
 * Map any PermissionMode (7 modes) to a Claude-compatible mode (4 modes)
 * This is the ONLY place where Codex modes are mapped to Claude equivalents.
 *
 * Mapping:
 * - yolo → bypassPermissions (both skip all permissions)
 * - safe-yolo → default (ask for permissions)
 * - read-only → default (Claude doesn't support read-only)
 *
 * Claude modes pass through unchanged:
 * - default, acceptEdits, bypassPermissions, plan
 */
export function mapToClaudeMode(mode: PermissionMode): ClaudeSdkPermissionMode {
    const codexToClaudeMap: Record<string, ClaudeSdkPermissionMode> = {
        'yolo': 'bypassPermissions',
        'safe-yolo': 'default',
        'read-only': 'default',
    };
    return codexToClaudeMap[mode] ?? (mode as ClaudeSdkPermissionMode);
}

const VALID_PERMISSION_MODES: readonly PermissionMode[] = [
    'default',
    'acceptEdits',
    'bypassPermissions',
    'plan',
    'read-only',
    'safe-yolo',
    'yolo',
] as const;

function isPermissionMode(value: string | undefined): value is PermissionMode {
    return !!value && VALID_PERMISSION_MODES.includes(value as PermissionMode);
}

/**
 * Extract permission mode override from Claude CLI args.
 * Supports both:
 * - --permission-mode VALUE
 * - --permission-mode=VALUE
 */
export function extractPermissionModeFromClaudeArgs(claudeArgs?: string[]): PermissionMode | undefined {
    if (!claudeArgs || claudeArgs.length === 0) {
        return undefined;
    }

    let found: PermissionMode | undefined = undefined;
    for (let i = 0; i < claudeArgs.length; i++) {
        const arg = claudeArgs[i];
        if (arg === '--permission-mode') {
            const next = claudeArgs[i + 1];
            if (isPermissionMode(next)) {
                found = next;
            }
            i += 1;
            continue;
        }

        if (arg.startsWith('--permission-mode=')) {
            const value = arg.slice('--permission-mode='.length);
            if (isPermissionMode(value)) {
                found = value;
            }
        }
    }

    return found;
}

/**
 * Resolve the initial permission mode for remote Claude execution.
 * `--dangerously-skip-permissions` takes precedence over all other modes.
 */
export function resolveInitialClaudePermissionMode(
    optionMode: PermissionMode | undefined,
    claudeArgs?: string[],
): PermissionMode | undefined {
    if (claudeArgs?.includes('--dangerously-skip-permissions')) {
        return 'bypassPermissions';
    }
    return extractPermissionModeFromClaudeArgs(claudeArgs) ?? optionMode;
}

/**
 * Enforce sandbox permission policy for Claude.
 * When sandbox is enabled, we always force bypass permissions.
 */
export function applySandboxPermissionPolicy(
    mode: PermissionMode | undefined,
    sandboxEnabled: boolean,
): PermissionMode | undefined {
    if (!sandboxEnabled) {
        return mode;
    }
    return 'bypassPermissions';
}
