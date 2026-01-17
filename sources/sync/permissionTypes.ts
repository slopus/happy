export type PermissionMode =
    | 'default'
    | 'acceptEdits'
    | 'bypassPermissions'
    | 'plan'
    | 'read-only'
    | 'safe-yolo'
    | 'yolo';

export const CLAUDE_PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const;
export const CODEX_LIKE_PERMISSION_MODES = ['default', 'read-only', 'safe-yolo', 'yolo'] as const;

export type AgentFlavor = 'claude' | 'codex' | 'gemini';

export function normalizePermissionModeForAgentFlavor(mode: PermissionMode, flavor: AgentFlavor): PermissionMode {
    if (flavor === 'codex' || flavor === 'gemini') {
        return (CODEX_LIKE_PERMISSION_MODES as readonly string[]).includes(mode) ? mode : 'default';
    }
    return (CLAUDE_PERMISSION_MODES as readonly string[]).includes(mode) ? mode : 'default';
}

export type ModelMode =
    | 'default'
    | 'adaptiveUsage'
    | 'sonnet'
    | 'opus'
    | 'gpt-5-codex-high'
    | 'gpt-5-codex-medium'
    | 'gpt-5-codex-low'
    | 'gpt-5-minimal'
    | 'gpt-5-low'
    | 'gpt-5-medium'
    | 'gpt-5-high'
    | 'gemini-2.5-pro'
    | 'gemini-2.5-flash'
    | 'gemini-2.5-flash-lite';
