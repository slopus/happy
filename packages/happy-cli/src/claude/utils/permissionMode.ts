import type { QueryOptions } from '@/claude/sdk';
import type { PermissionMode } from '@/api/types';
import { logger } from '@/ui/logger';

/** Derived from SDK's QueryOptions - the modes Claude actually supports */
export type ClaudeSdkPermissionMode = NonNullable<QueryOptions['permissionMode']>;

/**
 * Map any PermissionMode (8 modes) to a Claude-compatible mode (5 modes)
 * This is the ONLY place where Codex modes are mapped to Claude equivalents.
 *
 * Mapping:
 * - yolo → bypassPermissions (both skip all permissions)
 * - safe-yolo → default (ask for permissions)
 * - read-only → default (Claude doesn't support read-only)
 *
 * Claude modes pass through unchanged:
 * - auto, default, acceptEdits, bypassPermissions, plan
 *
 * `auto` is a first-class mode in the Agent SDK's own PermissionMode union,
 * so it passes straight through rather than being mapped onto `default`.
 */
export function mapToClaudeMode(mode: undefined): undefined;
export function mapToClaudeMode(mode: PermissionMode): ClaudeSdkPermissionMode;
export function mapToClaudeMode(mode: PermissionMode | undefined): ClaudeSdkPermissionMode | undefined;
export function mapToClaudeMode(mode: PermissionMode | undefined): ClaudeSdkPermissionMode | undefined {
    // Undefined is a meaningful value, not a missing one: it is how "Default"
    // reaches the SDK, which then applies Claude's own configuration.
    if (mode === undefined) {
        return undefined;
    }
    const codexToClaudeMap: Record<string, ClaudeSdkPermissionMode> = {
        'yolo': 'bypassPermissions',
        'safe-yolo': 'default',
        'read-only': 'default',
    };
    return codexToClaudeMap[mode] ?? (mode as ClaudeSdkPermissionMode);
}

const VALID_PERMISSION_MODES: readonly PermissionMode[] = [
    'auto',
    'default',
    'acceptEdits',
    'bypassPermissions',
    'plan',
    'read-only',
    'safe-yolo',
    'yolo',
] as const;

export function isPermissionMode(value: string | undefined): value is PermissionMode {
    return !!value && VALID_PERMISSION_MODES.includes(value as PermissionMode);
}

/**
 * Narrow a permission mode that arrived over the wire. The message schema
 * accepts any string so a newer app can name a mode this CLI does not know
 * yet; an unknown one is dropped here with a warning, keeping the message
 * itself deliverable and the session on its current mode.
 */
export function normalizeRemotePermissionMode(value: string | undefined): PermissionMode | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (isPermissionMode(value)) {
        return value;
    }
    logger.info(`[permissionMode] Ignoring unknown permission mode '${value}' from app; this CLI version does not support it`);
    return undefined;
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

export function isClaudeBypassEquivalent(mode: PermissionMode | undefined): boolean {
    return mode === 'bypassPermissions' || mode === 'yolo';
}

/**
 * Resolve permission mode overrides from remote app messages.
 *
 * Happy app versions can send `permissionMode: "default"` with every message
 * even when the CLI process was started in yolo/bypass mode. Since Claude maps
 * both `yolo` and `bypassPermissions` to bypass at the SDK boundary, do not let
 * that ambient default downgrade either mode, but still allow explicit modes
 * such as plan to take effect.
 */
export function resolveRemoteClaudePermissionMode(
    currentMode: PermissionMode | undefined,
    incomingMode: PermissionMode | undefined,
    sandboxEnabled: boolean,
): PermissionMode | undefined {
    if (!incomingMode) {
        return currentMode;
    }

    const nextMode = applySandboxPermissionPolicy(incomingMode, sandboxEnabled);
    if (isClaudeBypassEquivalent(currentMode) && nextMode === 'default') {
        return currentMode;
    }

    return nextMode;
}
