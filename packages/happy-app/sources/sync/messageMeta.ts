import type { Session } from './storageTypes';
import type { Settings } from './settings';
import { getAgentDefaultOverride, getCodeAgentDefaults } from './agentDefaults';
import type { PermissionModeKey } from '@/components/PermissionModeSelector';

export type MessageModeMeta = {
    permissionMode?: PermissionModeKey;
    model?: string | null;
    effort?: string | null;
};

export function resolveMessageModeMeta(
    session: Pick<Session, 'permissionMode' | 'modelMode' | 'metadata' | 'effortLevel'>,
    settings?: Pick<Settings, 'agentDefaultOverrides'>,
): MessageModeMeta {
    const agentOverrides = getAgentDefaultOverride(settings?.agentDefaultOverrides, session.metadata?.flavor);
    const codeDefaults = getCodeAgentDefaults(session.metadata?.flavor);
    const meta: MessageModeMeta = {};

    if (session.permissionMode !== null && session.permissionMode !== undefined) {
        meta.permissionMode = session.permissionMode;
    } else if (agentOverrides.permissionMode !== undefined) {
        meta.permissionMode = agentOverrides.permissionMode;
    } else if (session.metadata?.flavor === 'codex') {
        meta.permissionMode = getCodeAgentDefaults('codex').permissionMode;
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
    const flavor = session.metadata?.flavor;
    const supportsEffort = !flavor
        || flavor === 'claude'
        || flavor === 'codex'
        || (session.metadata?.thoughtLevels?.length ?? 0) > 0;
    if (supportsEffort && effort !== undefined) {
        meta.effort = effort === 'default' ? null : effort;
    }

    return meta;
}
