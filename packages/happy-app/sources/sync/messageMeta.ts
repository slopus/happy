import type { Session } from './storageTypes';
import type { Settings } from './settings';
import { getAgentDefaultOverride, resolveAgentDefaultConfig, retirePermissionMode } from './agentDefaults';
import { permissionModeSupportedByCli } from '@/components/modelModeOptions';
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

/**
 * The session or a saved default carries a permission mode the session's CLI
 * cannot parse. Thrown instead of substituting another mode: swapping in the
 * code default would silently change what the agent is allowed to do — for
 * Claude it would escalate a user who chose reviewed Auto into yolo. Callers
 * surface the message and do not send.
 */
export class UnsupportedPermissionModeError extends Error {
    readonly mode: string;
    readonly cliVersion: string;

    constructor(mode: string, cliVersion: string) {
        super(
            `This session's Happy CLI (v${cliVersion}) does not support the '${mode}' permission mode. `
            + 'Pick a different mode for this session, or update the Happy CLI on that machine.',
        );
        this.name = 'UnsupportedPermissionModeError';
        this.mode = mode;
        this.cliVersion = cliVersion;
        Object.setPrototypeOf(this, UnsupportedPermissionModeError.prototype);
    }
}

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

    const flavor = session.metadata?.flavor;
    const agentOverrides = getAgentDefaultOverride(settings?.agentDefaultOverrides, flavor);
    const meta: MessageModeMeta = {};
    // The happy-cli version running this session. A mode key saved before the
    // session's CLI learned it (an old session's `auto`, or a global default of
    // `auto` applied to an old CLI) must not reach the wire: the old CLI's
    // schema rejects it and drops the whole message. It is refused here, not
    // mapped: substituting a mode would silently change permissions.
    const cliVersion = session.metadata?.version;
    const supported = (mode: PermissionModeKey | undefined) => {
        if (mode !== undefined && !permissionModeSupportedByCli(mode, cliVersion)) {
            throw new UnsupportedPermissionModeError(mode, cliVersion ?? 'unknown');
        }
        return mode;
    };

    // Codex app-server turns always run with a concrete permission, model, and
    // effort. Send the same effective defaults the composer displays instead
    // of omitting them: the CLI resets permission to its launch mode during an
    // abort safety window, and legacy/unset session fields previously made a
    // visible app fallback silently execute as a different mode or effort.
    // Keep this Codex-only so fixing that app-server invariant does not change
    // the established default semantics of other harnesses.
    if (flavor === 'codex') {
        const defaults = resolveAgentDefaultConfig(settings?.agentDefaultOverrides, flavor, cliVersion);
        meta.permissionMode = supported(retirePermissionMode(session.permissionMode ?? defaults.permissionMode));

        const modelMode = session.modelMode ?? defaults.modelMode;
        meta.model = modelMode === 'default' ? null : modelMode;

        meta.effort = session.effortLevel ?? defaults.effortLevel;
        return meta;
    }

    if (session.permissionMode !== null && session.permissionMode !== undefined) {
        // A session picked before a mode was retired still carries the old key,
        // and the CLI rejects the whole message envelope on an unknown one.
        meta.permissionMode = supported(retirePermissionMode(session.permissionMode));
    } else if (agentOverrides.permissionMode !== undefined) {
        meta.permissionMode = supported(agentOverrides.permissionMode);
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
