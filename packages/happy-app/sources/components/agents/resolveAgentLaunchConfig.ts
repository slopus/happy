import { agentKeys, resolveAgentDefaultConfig, type AgentDefaultOverrides } from '@/sync/agentDefaults';
import type { NewSessionAgentType } from '@/sync/persistence';
import { resolveAgentTypeForLaunch, type AgentLauncher } from './launchAgent';
import { isRetiredAgentFlavor } from '@/sync/retiredSessions';

type DraftLaunchConfig = {
    agentType?: unknown;
    permissionMode?: string;
    modelMode?: string;
    effortLevel?: string | null;
};

export type AgentLaunchConfigResult =
    | {
        type: 'success';
        agent: NewSessionAgentType;
        permissionMode: string;
        modelMode: string;
        effortLevel: string | null;
    }
    | { type: 'error'; message: string };

function isNewSessionAgentType(value: unknown): value is NewSessionAgentType {
    return typeof value === 'string' && (agentKeys as readonly string[]).includes(value);
}

export function resolveAgentLaunchConfig(args: {
    agent: AgentLauncher;
    draft: DraftLaunchConfig;
    defaults: AgentDefaultOverrides | null | undefined;
}): AgentLaunchConfigResult {
    if (isRetiredAgentFlavor(args.agent.agentType) || isRetiredAgentFlavor(args.draft.agentType)) {
        return { type: 'error', message: 'personal-agent-retired' };
    }
    const agentType = resolveAgentTypeForLaunch(args.agent) ?? args.draft.agentType;
    if (!isNewSessionAgentType(agentType)) {
        return { type: 'error', message: 'Invalid Agent type' };
    }

    const defaults = resolveAgentDefaultConfig(args.defaults, agentType);
    return {
        type: 'success',
        agent: agentType,
        permissionMode: args.agent.permissionMode ?? args.draft.permissionMode ?? defaults.permissionMode,
        modelMode: args.agent.modelMode ?? args.draft.modelMode ?? defaults.modelMode,
        effortLevel: args.agent.effortLevel !== undefined
            ? args.agent.effortLevel
            : args.draft.effortLevel !== undefined
                ? args.draft.effortLevel
                : defaults.effortLevel,
    };
}
