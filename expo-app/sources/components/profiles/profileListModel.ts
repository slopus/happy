import type { AIBackendProfile } from '@/sync/settings';
import { buildProfileGroups, type ProfileGroups } from '@/sync/profileGrouping';
import { t } from '@/text';
import { getAgentCore, type AgentId } from '@/agents/catalog';
import { isProfileCompatibleWithAgent } from '@/sync/settings';

export interface ProfileListStrings {
    builtInLabel: string;
    customLabel: string;
    agentLabelById: Readonly<Record<AgentId, string>>;
}

export function getDefaultProfileListStrings(enabledAgentIds: readonly AgentId[]): ProfileListStrings {
    const agentLabelById: Record<AgentId, string> = {} as any;
    for (const agentId of enabledAgentIds) {
        agentLabelById[agentId] = t(getAgentCore(agentId).displayNameKey);
    }
    return {
        builtInLabel: t('profiles.builtIn'),
        customLabel: t('profiles.custom'),
        agentLabelById,
    };
}

export function getProfileBackendSubtitle(params: {
    profile: Pick<AIBackendProfile, 'compatibility' | 'isBuiltIn'>;
    enabledAgentIds: readonly AgentId[];
    strings: ProfileListStrings;
}): string {
    const parts: string[] = [];
    for (const agentId of params.enabledAgentIds) {
        if (isProfileCompatibleWithAgent(params.profile, agentId)) {
            const label = params.strings.agentLabelById[agentId];
            if (label) parts.push(label);
        }
    }
    return parts.length > 0 ? parts.join(' • ') : '';
}

export function getProfileSubtitle(params: {
    profile: Pick<AIBackendProfile, 'compatibility' | 'isBuiltIn'>;
    enabledAgentIds: readonly AgentId[];
    strings: ProfileListStrings;
}): string {
    const backend = getProfileBackendSubtitle({
        profile: params.profile,
        enabledAgentIds: params.enabledAgentIds,
        strings: params.strings,
    });

    const label = params.profile.isBuiltIn ? params.strings.builtInLabel : params.strings.customLabel;
    return backend ? `${label} · ${backend}` : label;
}

export function buildProfilesListGroups(params: {
    customProfiles: AIBackendProfile[];
    favoriteProfileIds: string[];
    enabledAgentIds?: readonly AgentId[];
}): ProfileGroups {
    return buildProfileGroups({
        customProfiles: params.customProfiles,
        favoriteProfileIds: params.favoriteProfileIds,
        enabledAgentIds: params.enabledAgentIds,
    });
}
