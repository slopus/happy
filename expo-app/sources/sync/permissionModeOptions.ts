import { t } from '@/text';
import type { TranslationKey } from '@/text';
import type { AgentType } from './modelOptions';
import type { PermissionMode } from './permissionTypes';
import { CLAUDE_PERMISSION_MODES, CODEX_LIKE_PERMISSION_MODES, normalizePermissionModeForGroup } from './permissionTypes';
import { DEFAULT_AGENT_ID, getAgentCore, resolveAgentIdFromFlavor } from '@/agents/catalog';

export type PermissionModeOption = Readonly<{
    value: PermissionMode;
    label: string;
    description: string;
    icon: string;
}>;

const PERMISSION_MODE_KEY_SEGMENT: Record<PermissionMode, string> = {
    default: 'default',
    acceptEdits: 'acceptEdits',
    bypassPermissions: 'bypassPermissions',
    plan: 'plan',
    'read-only': 'readOnly',
    'safe-yolo': 'safeYolo',
    yolo: 'yolo',
};

const BADGE_KEY_SEGMENT_CLAUDE: Partial<Record<PermissionMode, string>> = {
    acceptEdits: 'badgeAccept',
    plan: 'badgePlan',
    bypassPermissions: 'badgeYolo',
};

const BADGE_KEY_SEGMENT_CODEX_LIKE: Partial<Record<PermissionMode, string>> = {
    'read-only': 'badgeReadOnly',
    'safe-yolo': 'badgeSafeYolo',
    yolo: 'badgeYolo',
};

function getAgentPermissionModeI18nPrefix(agentType: AgentType): string {
    const agentId = resolveAgentIdFromFlavor(agentType) ?? DEFAULT_AGENT_ID;
    return getAgentCore(agentId).permissionModeI18nPrefix;
}

export function getPermissionModeTitleForAgentType(agentType: AgentType): string {
    const prefix = getAgentPermissionModeI18nPrefix(agentType);
    return t(`${prefix}.title` as TranslationKey);
}

export function getPermissionModeLabelForAgentType(agentType: AgentType, mode: PermissionMode): string {
    const prefix = getAgentPermissionModeI18nPrefix(agentType);
    const seg = PERMISSION_MODE_KEY_SEGMENT[mode] ?? 'default';
    return t(`${prefix}.${seg}` as TranslationKey);
}

export function getPermissionModesForAgentType(agentType: AgentType): readonly PermissionMode[] {
    const agentId = resolveAgentIdFromFlavor(agentType) ?? DEFAULT_AGENT_ID;
    const group = getAgentCore(agentId).permissions.modeGroup;
    return group === 'codexLike' ? CODEX_LIKE_PERMISSION_MODES : CLAUDE_PERMISSION_MODES;
}

export function getPermissionModeOptionsForAgentType(agentType: AgentType): readonly PermissionModeOption[] {
    const agentId = resolveAgentIdFromFlavor(agentType) ?? DEFAULT_AGENT_ID;
    const group = getAgentCore(agentId).permissions.modeGroup;
    if (group === 'codexLike') {
        return [
            { value: 'default', label: getPermissionModeLabelForAgentType(agentType, 'default'), description: 'Use CLI permission settings', icon: 'shield-outline' },
            { value: 'read-only', label: getPermissionModeLabelForAgentType(agentType, 'read-only'), description: 'Read-only mode', icon: 'eye-outline' },
            { value: 'safe-yolo', label: getPermissionModeLabelForAgentType(agentType, 'safe-yolo'), description: 'Workspace write with approval', icon: 'shield-checkmark-outline' },
            { value: 'yolo', label: getPermissionModeLabelForAgentType(agentType, 'yolo'), description: 'Full access, skip permissions', icon: 'flash-outline' },
        ];
    }

    return [
        { value: 'default', label: getPermissionModeLabelForAgentType(agentType, 'default'), description: 'Ask for permissions', icon: 'shield-outline' },
        { value: 'acceptEdits', label: getPermissionModeLabelForAgentType(agentType, 'acceptEdits'), description: 'Auto-approve edits', icon: 'checkmark-outline' },
        { value: 'plan', label: getPermissionModeLabelForAgentType(agentType, 'plan'), description: 'Plan before executing', icon: 'list-outline' },
        { value: 'bypassPermissions', label: getPermissionModeLabelForAgentType(agentType, 'bypassPermissions'), description: 'Skip all permissions', icon: 'flash-outline' },
    ];
}

export function normalizePermissionModeForAgentType(mode: PermissionMode, agentType: AgentType): PermissionMode {
    const agentId = resolveAgentIdFromFlavor(agentType) ?? DEFAULT_AGENT_ID;
    const group = getAgentCore(agentId).permissions.modeGroup;
    return normalizePermissionModeForGroup(mode, group);
}

export function getPermissionModeBadgeLabelForAgentType(agentType: AgentType, mode: PermissionMode): string {
    const agentId = resolveAgentIdFromFlavor(agentType) ?? DEFAULT_AGENT_ID;
    const core = getAgentCore(agentId);
    const group = core.permissions.modeGroup;
    const normalized = normalizePermissionModeForAgentType(mode, agentType);
    if (normalized === 'default') return '';

    const seg = group === 'codexLike'
        ? BADGE_KEY_SEGMENT_CODEX_LIKE[normalized]
        : BADGE_KEY_SEGMENT_CLAUDE[normalized];
    if (!seg) return '';

    return t(`${core.permissionModeI18nPrefix}.${seg}` as TranslationKey);
}
