export type PermissionMode =
    | 'default'
    | 'acceptEdits'
    | 'bypassPermissions'
    | 'plan'
    | 'read-only'
    | 'safe-yolo'
    | 'yolo';

const ALL_PERMISSION_MODES = [
    'default',
    'acceptEdits',
    'bypassPermissions',
    'plan',
    'read-only',
    'safe-yolo',
    'yolo',
] as const;

export const CLAUDE_PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const;
export const CODEX_LIKE_PERMISSION_MODES = ['default', 'read-only', 'safe-yolo', 'yolo'] as const;

export type PermissionModeGroupId = 'claude' | 'codexLike';

export function isPermissionMode(value: unknown): value is PermissionMode {
    return typeof value === 'string' && (ALL_PERMISSION_MODES as readonly string[]).includes(value);
}

export function normalizePermissionModeForGroup(mode: PermissionMode, group: PermissionModeGroupId): PermissionMode {
    const allowed = group === 'codexLike' ? CODEX_LIKE_PERMISSION_MODES : CLAUDE_PERMISSION_MODES;
    return (allowed as readonly string[]).includes(mode) ? mode : 'default';
}

export function getNextPermissionModeForGroup(mode: PermissionMode, group: PermissionModeGroupId): PermissionMode {
    if (group === 'codexLike') {
        const normalized = normalizePermissionModeForGroup(mode, group) as (typeof CODEX_LIKE_PERMISSION_MODES)[number];
        const currentIndex = CODEX_LIKE_PERMISSION_MODES.indexOf(normalized);
        const safeIndex = currentIndex >= 0 ? currentIndex : 0;
        const nextIndex = (safeIndex + 1) % CODEX_LIKE_PERMISSION_MODES.length;
        return CODEX_LIKE_PERMISSION_MODES[nextIndex];
    }

    const normalized = normalizePermissionModeForGroup(mode, group) as (typeof CLAUDE_PERMISSION_MODES)[number];
    const currentIndex = CLAUDE_PERMISSION_MODES.indexOf(normalized);
    const safeIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = (safeIndex + 1) % CLAUDE_PERMISSION_MODES.length;
    return CLAUDE_PERMISSION_MODES[nextIndex];
}

export function normalizeProfileDefaultPermissionMode(mode: PermissionMode | null | undefined): PermissionMode {
    if (!mode) return 'default';
    return mode;
}

export const MODEL_MODES = [
    'default',
    'adaptiveUsage',
    'sonnet',
    'opus',
    'gpt-5-codex-high',
    'gpt-5-codex-medium',
    'gpt-5-codex-low',
    'gpt-5-minimal',
    'gpt-5-low',
    'gpt-5-medium',
    'gpt-5-high',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
] as const;

export type ModelMode = (typeof MODEL_MODES)[number];

export function isModelMode(value: unknown): value is ModelMode {
    return typeof value === 'string' && (MODEL_MODES as readonly string[]).includes(value);
}
