export type TaskPermissionLevel = 'confirm' | 'automatic' | 'full-access';

export type TaskPermissionAgent = 'claude' | 'codex' | 'gemini';

type TaskPermissionMapping = Partial<Record<TaskPermissionLevel, string>>;

const TASK_PERMISSION_MAPPINGS: Record<TaskPermissionAgent, TaskPermissionMapping> = {
    claude: {
        confirm: 'default',
        'full-access': 'bypassPermissions',
    },
    codex: {
        confirm: 'acceptEdits',
        automatic: 'safe-yolo',
        'full-access': 'yolo',
    },
    gemini: {
        confirm: 'default',
        'full-access': 'yolo',
    },
};

/**
 * Resolves legacy flavor aliases without claiming that every ACP-backed agent
 * supports the same two permission levels. A missing flavor follows the app's
 * existing compatibility convention and means Claude.
 */
export function resolveTaskPermissionAgent(
    flavor: string | null | undefined,
): TaskPermissionAgent | null {
    if (!flavor || flavor === 'claude') {
        return 'claude';
    }
    if (flavor === 'codex' || flavor === 'openai' || flavor === 'gpt') {
        return 'codex';
    }
    if (flavor === 'gemini') {
        return flavor;
    }
    return null;
}
export function getAgentPermissionModeForTaskLevel(
    flavor: string | null | undefined,
    level: TaskPermissionLevel,
): string | null {
    const agent = resolveTaskPermissionAgent(flavor);
    return agent ? TASK_PERMISSION_MAPPINGS[agent][level] ?? null : null;
}

/**
 * Collapses historical provider-specific modes into the two user-facing risk
 * levels. Only bypass-equivalent modes count as full access; every other known
 * mode remains in the confirmation tier instead of overstating its authority.
 */
export function getTaskPermissionLevelForAgentMode(
    flavor: string | null | undefined,
    mode: string | null | undefined,
): TaskPermissionLevel | null {
    const agent = resolveTaskPermissionAgent(flavor);
    if (!agent || !mode) {
        return null;
    }

    if (agent === 'codex' && (mode === 'default' || mode === 'read-only')) return null;
    if (agent === 'codex' && mode === 'safe-yolo') return 'automatic';
    return mode === 'yolo' || mode === 'bypassPermissions'
        ? 'full-access'
        : 'confirm';
}
