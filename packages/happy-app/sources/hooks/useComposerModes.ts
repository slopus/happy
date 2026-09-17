import * as React from 'react';
import {
    getAvailableModels,
    getAvailablePermissionModes,
    getEffortLevelsForModel,
    getRigCurrentModelOptionKey,
    resolveCurrentOption,
    type EffortLevel,
} from '@/components/modelModeOptions';
import type { ModelMode, PermissionMode } from '@/components/PermissionModeSelector';
import { resolveAgentDefaultConfig } from '@/sync/agentDefaults';
import { getRigReasoningSelection, isRigMetadata } from '@/sync/rig';
import { useSetting } from '@/sync/storage';
import type { Session } from '@/sync/storageTypes';
import { t } from '@/text';

export interface ComposerModes {
    availableModes: PermissionMode[];
    permissionMode: PermissionMode | null;
    availableModels: ModelMode[];
    modelMode: ModelMode | null;
    availableEffortLevels: EffortLevel[];
    effortLevel: EffortLevel | null;
}

/**
 * What the composer's permission, model and effort chips show for a session.
 *
 * A pick can be recorded in three places — on the session, in the agent's own
 * metadata, or nowhere at all, leaving the account default to stand for it —
 * and the order they are consulted in is the difference between showing what
 * the agent will actually do and showing a guess. That order lives here so the
 * chat and the chat that has not started yet cannot drift apart.
 *
 * A null session is one that does not exist yet: every option falls back to the
 * defaults, which is exactly what a new chat starts with.
 */
export function useComposerModes(session: Session | null | undefined): ComposerModes {
    const metadata = session?.metadata;
    const flavor = metadata?.flavor;
    const cliVersion = metadata?.version;
    const isRig = isRigMetadata(metadata);
    const agentDefaultOverrides = useSetting('agentDefaultOverrides');
    const effectiveAgentDefaults = React.useMemo(() => (
        resolveAgentDefaultConfig(agentDefaultOverrides, flavor, cliVersion)
    ), [agentDefaultOverrides, cliVersion, flavor]);

    const availableModels = React.useMemo(() => (
        getAvailableModels(
            flavor,
            metadata,
            t,
            session?.modelMode ?? (isRig ? null : effectiveAgentDefaults.modelMode),
        )
    ), [flavor, metadata, session?.modelMode, effectiveAgentDefaults.modelMode, isRig]);
    const availableModes = React.useMemo(() => (
        getAvailablePermissionModes(flavor, metadata, t, session?.permissionMode)
    ), [flavor, metadata, session?.permissionMode]);

    const permissionMode = React.useMemo<PermissionMode | null>(() => (
        resolveCurrentOption(availableModes, [
            session?.permissionMode,
            ...(isRig ? [
                metadata?.currentOperatingModeCode,
                metadata?.permissionMode,
                metadata?.session?.permissionMode,
            ] : [
                effectiveAgentDefaults.permissionMode,
                metadata?.currentOperatingModeCode,
            ]),
        ])
    ), [availableModes, session?.permissionMode, effectiveAgentDefaults.permissionMode, metadata?.currentOperatingModeCode, metadata?.permissionMode, metadata?.session?.permissionMode, isRig]);

    const modelMode = React.useMemo<ModelMode | null>(() => (
        resolveCurrentOption(availableModels, [
            session?.modelMode,
            isRig ? getRigCurrentModelOptionKey(metadata) : effectiveAgentDefaults.modelMode,
            isRig ? undefined : metadata?.currentModelCode,
        ])
    ), [availableModels, session?.modelMode, effectiveAgentDefaults.modelMode, metadata, isRig]);

    const modelKey = modelMode?.key ?? 'default';
    const availableEffortLevels = React.useMemo<EffortLevel[]>(() => (
        getEffortLevelsForModel(flavor, modelKey, metadata)
    ), [flavor, modelKey, metadata]);
    const effortLevel = React.useMemo<EffortLevel | null>(() => (
        resolveCurrentOption(availableEffortLevels, [
            session?.effortLevel,
            isRig ? getRigReasoningSelection(metadata, modelKey) : effectiveAgentDefaults.effortLevel,
        ])
    ), [availableEffortLevels, session?.effortLevel, effectiveAgentDefaults.effortLevel, metadata, modelKey, isRig]);

    return {
        availableModes,
        permissionMode,
        availableModels,
        modelMode,
        availableEffortLevels,
        effortLevel,
    };
}
