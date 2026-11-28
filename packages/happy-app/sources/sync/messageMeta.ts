import { normalizeModelEffortKey, resolveSessionModelKey } from '@/components/modelModeOptions';
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

    if (flavor === 'antigravity' && session.metadata?.acpPermissionMode) {
        meta.permissionMode = session.metadata.acpPermissionMode;
    } else if (session.permissionMode !== null && session.permissionMode !== undefined) {
        meta.permissionMode = session.permissionMode;
        meta.permissionModeExplicit = true;
    } else if (taskPermissionAgent === 'codex' && session.metadata?.currentOperatingModeCode) {
        // Continue the policy displayed by the running session. Scheduled
        // sessions can use a different policy from the app's new-chat defaults.
        meta.permissionMode = session.metadata.currentOperatingModeCode;
    } else if (permissionOverrides.permissionMode !== undefined) {
        meta.permissionMode = permissionOverrides.permissionMode;
    } else if (taskPermissionAgent) {
        meta.permissionMode = permissionDefaults.permissionMode;
    }

    const modelMode = resolveSessionModelKey(session, agentOverrides.modelMode ?? codeDefaults.modelMode);
    if (modelMode !== undefined) {
        meta.model = modelMode === 'default' ? null : modelMode;
    }

    const requestedEffort = session.effortLevel
        ?? session.metadata?.currentThoughtLevelCode
        ?? agentOverrides.effortLevel
        ?? codeDefaults.effortLevel;
    // Effort resets independently of model selection. Keep the explicit null on
    // the wire so the executor can distinguish reset from an absent override.
    // A new ACP worker can hydrate before its per-model effort options. Keep the explicit
    // first-message choice until that model's capabilities can confirm or reject it.
    const antigravityEffortPending = flavor === 'antigravity' && !!session.effortLevel && session.effortLevel !== 'default'
        && !(session.metadata?.currentModelCode === modelMode && session.metadata.thoughtLevels !== undefined)
        && session.metadata?.models?.find(model => model.code === modelMode)?.supportedEffortLevels === undefined;
    const effort = antigravityEffortPending ? session.effortLevel : flavor === 'codex' && requestedEffort === 'default'
        ? 'default'
        : normalizeModelEffortKey(flavor, modelMode ?? 'default', requestedEffort, session.metadata);
    const supportsEffort = !flavor
        || flavor === 'claude'
        || flavor === 'codex'
        || flavor === 'antigravity';
    if (supportsEffort && effort !== undefined) {
        meta.effort = effort === 'default' ? null : effort;
    }

    // A new session can be hydrated before its model catalog arrives. Keep the
    // explicit selection made against the machine catalog instead of silently
    // sending the first turn at Standard speed. A loaded catalog remains authoritative.
    const fastCatalogPending = flavor === 'codex' && !session.metadata?.models?.length;
    if ((fastCatalogPending || supportsCodexFast(session.metadata, modelMode)) && session.fastMode !== undefined && session.fastMode !== null) {
        meta.fast = session.fastMode;
    }

    return meta;
}
