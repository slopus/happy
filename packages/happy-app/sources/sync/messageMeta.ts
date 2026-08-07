import type { Session, SessionAgentModesPatch } from './storageTypes';
import type { Settings } from './settings';
import { getAgentDefaultOverride } from './agentDefaults';
import type { PermissionModeKey } from '@/components/PermissionModeSelector';
import {
    getRigCurrentModel,
    getRigModels,
    getRigReasoningLevels,
    getRigReasoningSelection,
    getRigSelectedModelKey,
    isRigMetadataV1,
} from './rig';

export type MessageModeMeta = {
    permissionMode?: PermissionModeKey;
    model?: string | null;
    modelProviderId?: string;
    effort?: string | null;
};

export function resolveMessageModeMeta(
    session: Pick<Session, 'permissionMode' | 'modelMode' | 'metadata' | 'effortLevel'>,
    settings?: Pick<Settings, 'agentDefaultOverrides'>,
): MessageModeMeta {
    if (isRigMetadataV1(session.metadata)) {
        const meta: MessageModeMeta = {};
        const permissionMode = session.permissionMode
            ?? session.metadata?.currentOperatingModeCode
            ?? session.metadata?.permissionMode
            ?? session.metadata?.session?.permissionMode;
        if (permissionMode) meta.permissionMode = permissionMode;

        const selectedKey = session.modelMode ?? getRigSelectedModelKey(session.metadata);
        const selectedModel = getRigModels(session.metadata).find((model) => model.key === selectedKey)
            ?? (selectedKey === getRigSelectedModelKey(session.metadata) ? getRigCurrentModel(session.metadata) : null);
        if (selectedModel) {
            meta.model = selectedModel.id;
            meta.modelProviderId = selectedModel.providerId;
        } else if (selectedKey?.includes(':')) {
            const separator = selectedKey.indexOf(':');
            meta.modelProviderId = selectedKey.slice(0, separator);
            meta.model = selectedKey.slice(separator + 1);
        }

        const levels = getRigReasoningLevels(session.metadata, selectedKey);
        const localEffort = session.effortLevel;
        const effort = localEffort && levels.includes(localEffort)
            ? localEffort
            : getRigReasoningSelection(session.metadata, selectedKey);
        if (effort) meta.effort = effort;
        return meta;
    }

    const agentOverrides = getAgentDefaultOverride(settings?.agentDefaultOverrides, session.metadata?.flavor);
    const meta: MessageModeMeta = {};

    if (session.permissionMode !== null && session.permissionMode !== undefined) {
        meta.permissionMode = session.permissionMode;
    } else if (agentOverrides.permissionMode !== undefined) {
        meta.permissionMode = agentOverrides.permissionMode;
    }

    const modelMode = session.modelMode ?? agentOverrides.modelMode;
    if (modelMode !== undefined) {
        meta.model = modelMode === 'default' ? null : modelMode;
    }

    const effort = session.effortLevel ?? agentOverrides.effortLevel;
    if (effort !== undefined) {
        meta.effort = effort;
    }

    return meta;
}

/**
 * The picks a session should adopt as its own the first time it falls back to
 * the settings-level agent defaults.
 *
 * `resolveMessageModeMeta` reads those defaults live, so without this a session
 * that never got an explicit pick keeps re-resolving them on every turn — and
 * editing the default in Settings retroactively re-models sessions that are
 * already running. Freezing the fallback onto the session on first use keeps
 * the default doing its job (seeding sessions that have no pick of their own)
 * while scoping it to the moment the session first uses it.
 *
 * Returns only fields the session is missing; Rig sessions are excluded because
 * their model/reasoning state is carried by the agent's own metadata.
 */
export function resolveAgentDefaultPin(
    session: Pick<Session, 'permissionMode' | 'modelMode' | 'metadata' | 'effortLevel'>,
    settings?: Pick<Settings, 'agentDefaultOverrides'>,
): SessionAgentModesPatch {
    if (isRigMetadataV1(session.metadata)) {
        return {};
    }

    const agentOverrides = getAgentDefaultOverride(settings?.agentDefaultOverrides, session.metadata?.flavor);
    const pin: SessionAgentModesPatch = {};

    const isUnset = (value: string | null | undefined): boolean => value === null || value === undefined;

    if (isUnset(session.permissionMode) && agentOverrides.permissionMode !== undefined) {
        pin.permissionMode = agentOverrides.permissionMode;
    }
    if (isUnset(session.modelMode) && agentOverrides.modelMode !== undefined) {
        pin.modelMode = agentOverrides.modelMode;
    }
    if (isUnset(session.effortLevel) && agentOverrides.effortLevel !== undefined) {
        pin.effortLevel = agentOverrides.effortLevel;
    }

    return pin;
}
