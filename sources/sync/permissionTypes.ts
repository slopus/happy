export type PermissionMode =
    | 'default'
    | 'acceptEdits'
    | 'bypassPermissions'
    | 'plan'
    | 'read-only'
    | 'safe-yolo'
    | 'yolo';

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
