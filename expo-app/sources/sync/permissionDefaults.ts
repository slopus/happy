import type { PermissionMode } from './permissionTypes';
import { CLAUDE_PERMISSION_MODES, CODEX_LIKE_PERMISSION_MODES, normalizePermissionModeForGroup } from './permissionTypes';
import { mapPermissionModeAcrossAgents } from './permissionMapping';
import { AGENT_IDS, getAgentCore, type AgentId } from '@/agents/catalog';
import { isPermissionMode } from './permissionTypes';

export type AccountPermissionDefaults = Readonly<Partial<Record<AgentId, PermissionMode>>>;

export function readAccountPermissionDefaults(
    raw: unknown,
    enabledAgentIds: readonly AgentId[],
): AccountPermissionDefaults {
    const input = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const out: Partial<Record<AgentId, PermissionMode>> = {};
    for (const agentId of enabledAgentIds) {
        const v = input[agentId];
        out[agentId] = isPermissionMode(v) ? v : 'default';
    }
    return out;
}

function normalizeForAgentType(mode: PermissionMode, agentType: AgentId): PermissionMode {
    const group = getAgentCore(agentType).permissions.modeGroup;
    return normalizePermissionModeForGroup(mode, group);
}

export function inferSourceModeGroupForPermissionMode(mode: PermissionMode): 'claude' | 'codexLike' {
    // Modes unique to Codex/Gemini should map as codex-like; modes unique to Claude map as Claude.
    // For shared 'default', the source agent doesn't matter.
    if ((CODEX_LIKE_PERMISSION_MODES as readonly string[]).includes(mode) && !(CLAUDE_PERMISSION_MODES as readonly string[]).includes(mode)) {
        return 'codexLike';
    }
    return 'claude';
}

export function resolveNewSessionDefaultPermissionMode(params: Readonly<{
    agentType: AgentId;
    accountDefaults: AccountPermissionDefaults;
    profileDefaults?: Partial<Record<AgentId, PermissionMode | undefined>> | null;
    legacyProfileDefaultPermissionMode?: PermissionMode | null | undefined;
}>): PermissionMode {
    const { agentType, accountDefaults, profileDefaults, legacyProfileDefaultPermissionMode } = params;

    const directProfileMode = profileDefaults?.[agentType];
    if (directProfileMode) {
        return normalizeForAgentType(directProfileMode, agentType);
    }

    if (legacyProfileDefaultPermissionMode) {
        const fromGroup = inferSourceModeGroupForPermissionMode(legacyProfileDefaultPermissionMode);
        const from =
            AGENT_IDS.find((id) => getAgentCore(id).permissions.modeGroup === fromGroup) ??
            agentType;
        const mapped = mapPermissionModeAcrossAgents(legacyProfileDefaultPermissionMode, from, agentType);
        return normalizeForAgentType(mapped, agentType);
    }

    const raw = accountDefaults[agentType] ?? 'default';
    return normalizeForAgentType(raw, agentType);
}
