import { t } from '@/text';
import type { AgentType } from './modelOptions';
import type { PermissionMode } from './permissionTypes';
import { CLAUDE_PERMISSION_MODES, CODEX_LIKE_PERMISSION_MODES, normalizePermissionModeForAgentFlavor } from './permissionTypes';

export type PermissionModeOption = Readonly<{
    value: PermissionMode;
    label: string;
    description: string;
    icon: string;
}>;

export function getPermissionModeTitleForAgentType(agentType: AgentType): string {
    if (agentType === 'codex') return t('agentInput.codexPermissionMode.title');
    if (agentType === 'gemini') return t('agentInput.geminiPermissionMode.title');
    return t('agentInput.permissionMode.title');
}

export function getPermissionModeLabelForAgentType(agentType: AgentType, mode: PermissionMode): string {
    if (agentType === 'codex') {
        switch (mode) {
            case 'default': return t('agentInput.codexPermissionMode.default');
            case 'read-only': return t('agentInput.codexPermissionMode.readOnly');
            case 'safe-yolo': return t('agentInput.codexPermissionMode.safeYolo');
            case 'yolo': return t('agentInput.codexPermissionMode.yolo');
            default: return t('agentInput.codexPermissionMode.default');
        }
    }
    if (agentType === 'gemini') {
        switch (mode) {
            case 'default': return t('agentInput.geminiPermissionMode.default');
            case 'read-only': return t('agentInput.geminiPermissionMode.readOnly');
            case 'safe-yolo': return t('agentInput.geminiPermissionMode.safeYolo');
            case 'yolo': return t('agentInput.geminiPermissionMode.yolo');
            default: return t('agentInput.geminiPermissionMode.default');
        }
    }
    switch (mode) {
        case 'default': return t('agentInput.permissionMode.default');
        case 'acceptEdits': return t('agentInput.permissionMode.acceptEdits');
        case 'plan': return t('agentInput.permissionMode.plan');
        case 'bypassPermissions': return t('agentInput.permissionMode.bypassPermissions');
        default: return t('agentInput.permissionMode.default');
    }
}

export function getPermissionModesForAgentType(agentType: AgentType): readonly PermissionMode[] {
    if (agentType === 'codex' || agentType === 'gemini') {
        return CODEX_LIKE_PERMISSION_MODES;
    }
    return CLAUDE_PERMISSION_MODES;
}

export function getPermissionModeOptionsForAgentType(agentType: AgentType): readonly PermissionModeOption[] {
    if (agentType === 'codex' || agentType === 'gemini') {
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
    return normalizePermissionModeForAgentFlavor(mode, agentType === 'claude' ? 'claude' : agentType === 'gemini' ? 'gemini' : 'codex');
}
