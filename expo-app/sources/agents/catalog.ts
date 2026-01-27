import { AGENT_IDS, DEFAULT_AGENT_ID, type AgentId } from '@happy/agents';

import type { AgentCoreConfig, MachineLoginKey } from './registryCore';
import {
    getAgentCore as getExpoAgentCore,
    isAgentId,
    resolveAgentIdFromCliDetectKey,
    resolveAgentIdFromConnectedServiceId,
    resolveAgentIdFromFlavor,
} from './registryCore';

import type { AgentUiConfig } from './registryUi';
type RegistryUiModule = typeof import('./registryUi');
type AgentIconTintTheme = Parameters<RegistryUiModule['getAgentIconTintColor']>[1];

import type { AgentUiBehavior } from './registryUiBehavior';
import {
    AGENTS_UI_BEHAVIOR,
    buildResumeCapabilityOptionsFromMaps,
    buildResumeCapabilityOptionsFromUiState,
    buildNewSessionOptionsFromUiState,
    getNewSessionAgentInputExtraActionChips,
    buildSpawnEnvironmentVariablesFromUiState,
    buildResumeSessionExtrasFromUiState,
    buildSpawnSessionExtrasFromUiState,
    buildWakeResumeExtras,
    getAgentResumeExperimentsFromSettings,
    getAllowExperimentalResumeByAgentIdFromUiState,
    getAllowRuntimeResumeByAgentIdFromResults,
    getNewSessionPreflightIssues,
    getNewSessionRelevantInstallableDepKeys,
    getResumePreflightIssues,
    getResumePreflightPrefetchPlan,
    getResumeRuntimeSupportPrefetchPlan,
} from './registryUiBehavior';

export { AGENT_IDS, DEFAULT_AGENT_ID };
export type { AgentId, MachineLoginKey };

export type AgentCatalogEntry = Readonly<{
    id: AgentId;
    core: AgentCoreConfig;
    ui: AgentUiConfig;
    behavior: AgentUiBehavior;
}>;

function registryUi() {
    // Lazily load UI assets so Node-side tests can import `@/agents/catalog`
    // without requiring image files.
    return require('./registryUi') as typeof import('./registryUi');
}

export function getAgentCore(id: AgentId): AgentCoreConfig {
    return getExpoAgentCore(id);
}

export function getAgentUi(id: AgentId): AgentUiConfig {
    return registryUi().AGENTS_UI[id];
}

export function getAgentIconSource(agentId: AgentId): ReturnType<RegistryUiModule['getAgentIconSource']> {
    return registryUi().getAgentIconSource(agentId);
}

export function getAgentIconTintColor(
    agentId: AgentId,
    theme: AgentIconTintTheme,
): ReturnType<RegistryUiModule['getAgentIconTintColor']> {
    return registryUi().getAgentIconTintColor(agentId, theme);
}

export function getAgentAvatarOverlaySizes(
    agentId: AgentId,
    size: number,
): ReturnType<RegistryUiModule['getAgentAvatarOverlaySizes']> {
    return registryUi().getAgentAvatarOverlaySizes(agentId, size);
}

export function getAgentCliGlyph(agentId: AgentId): ReturnType<RegistryUiModule['getAgentCliGlyph']> {
    return registryUi().getAgentCliGlyph(agentId);
}

export function getAgentBehavior(id: AgentId): AgentUiBehavior {
    return AGENTS_UI_BEHAVIOR[id];
}

export function getAgent(id: AgentId): AgentCatalogEntry {
    return {
        id,
        core: getAgentCore(id),
        ui: getAgentUi(id),
        behavior: getAgentBehavior(id),
    };
}

export {
    isAgentId,
    resolveAgentIdFromFlavor,
    resolveAgentIdFromCliDetectKey,
    resolveAgentIdFromConnectedServiceId,
    getAgentResumeExperimentsFromSettings,
    getAllowExperimentalResumeByAgentIdFromUiState,
    getAllowRuntimeResumeByAgentIdFromResults,
    buildResumeCapabilityOptionsFromUiState,
    buildResumeCapabilityOptionsFromMaps,
    getResumeRuntimeSupportPrefetchPlan,
    getResumePreflightPrefetchPlan,
    getNewSessionPreflightIssues,
    getResumePreflightIssues,
    buildNewSessionOptionsFromUiState,
    getNewSessionAgentInputExtraActionChips,
    getNewSessionRelevantInstallableDepKeys,
    buildSpawnEnvironmentVariablesFromUiState,
    buildSpawnSessionExtrasFromUiState,
    buildResumeSessionExtrasFromUiState,
    buildWakeResumeExtras,
};
