import type { AIBackendProfile } from '@/sync/settings';
import { buildProfileGroups, type ProfileGroups } from '@/sync/profileGrouping';
import { t } from '@/text';

export interface ProfileListStrings {
    builtInLabel: string;
    customLabel: string;
    agentClaude: string;
    agentCodex: string;
    agentGemini: string;
}

export function getDefaultProfileListStrings(): ProfileListStrings {
    return {
        builtInLabel: t('profiles.builtIn'),
        customLabel: t('profiles.custom'),
        agentClaude: t('agentInput.agent.claude'),
        agentCodex: t('agentInput.agent.codex'),
        agentGemini: t('agentInput.agent.gemini'),
    };
}

export function getProfileBackendSubtitle(params: {
    profile: Pick<AIBackendProfile, 'compatibility'>;
    experimentsEnabled: boolean;
    strings: ProfileListStrings;
}): string {
    const parts: string[] = [];
    if (params.profile.compatibility?.claude) parts.push(params.strings.agentClaude);
    if (params.profile.compatibility?.codex) parts.push(params.strings.agentCodex);
    if (params.experimentsEnabled && params.profile.compatibility?.gemini) parts.push(params.strings.agentGemini);
    return parts.length > 0 ? parts.join(' • ') : '';
}

export function getProfileSubtitle(params: {
    profile: Pick<AIBackendProfile, 'compatibility' | 'isBuiltIn'>;
    experimentsEnabled: boolean;
    strings: ProfileListStrings;
}): string {
    const backend = getProfileBackendSubtitle({
        profile: params.profile,
        experimentsEnabled: params.experimentsEnabled,
        strings: params.strings,
    });

    const label = params.profile.isBuiltIn ? params.strings.builtInLabel : params.strings.customLabel;
    return backend ? `${label} · ${backend}` : label;
}

export function buildProfilesListGroups(params: {
    customProfiles: AIBackendProfile[];
    favoriteProfileIds: string[];
}): ProfileGroups {
    return buildProfileGroups({
        customProfiles: params.customProfiles,
        favoriteProfileIds: params.favoriteProfileIds,
    });
}

