import type { Session } from './storageTypes';
import type { Settings } from './settings';
import { getAgentDefaultOverride, getCodeAgentDefaults } from './agentDefaults';
import type { PermissionModeKey } from '@/components/PermissionModeSelector';
import { resolveTaskPermissionAgent } from '@/utils/taskPermissionModes';
import { supportsCodexFast } from '@/utils/codexFast';

export type MessageModeMeta = {
    permissionMode?: PermissionModeKey;
    permissionModeExplicit?: true;
    model?: string | null;
    effort?: string | null;
    fast?: boolean;
};

export function resolveMessageModeMeta(
    session: Pick<Session, 'permissionMode' | 'modelMode' | 'metadata' | 'effortLevel' | 'fastMode'>,
    settings?: Pick<Settings, 'agentDefaultOverrides'>,
): MessageModeMeta {
    const flavor = session.metadata?.flavor;
    const taskPermissionAgent = resolveTaskPermissionAgent(flavor);
    const agentOverrides = getAgentDefaultOverride(settings?.agentDefaultOverrides, flavor);
    const permissionOverrides = getAgentDefaultOverride(
        settings?.agentDefaultOverrides,
        taskPermissionAgent ?? flavor,
    );
    const codeDefaults = getCodeAgentDefaults(flavor);
    const permissionDefaults = getCodeAgentDefaults(taskPermissionAgent ?? flavor);
    const meta: MessageModeMeta = {};

    if (session.permissionMode !== null && session.permissionMode !== undefined) {
        meta.permissionMode = session.permissionMode;
        meta.permissionModeExplicit = true;
    } else if (permissionOverrides.permissionMode !== undefined) {
        meta.permissionMode = permissionOverrides.permissionMode;
    } else if (taskPermissionAgent) {
        meta.permissionMode = permissionDefaults.permissionMode;
    }

    const modelMode = session.modelMode
        ?? session.metadata?.currentModelCode
        ?? agentOverrides.modelMode
        ?? codeDefaults.modelMode;
    if (modelMode !== undefined) {
        meta.model = modelMode === 'default' ? null : modelMode;
    }

    const effort = session.effortLevel
        ?? session.metadata?.currentThoughtLevelCode
        ?? agentOverrides.effortLevel
        ?? codeDefaults.effortLevel;
    const supportsEffort = !flavor
        || flavor === 'claude'
        || flavor === 'codex';
    if (supportsEffort && effort !== undefined) {
        meta.effort = effort === 'default' ? null : effort;
    }

    if (supportsCodexFast(session.metadata, modelMode) && session.fastMode !== undefined && session.fastMode !== null) {
        meta.fast = session.fastMode;
    }

    return meta;
}
