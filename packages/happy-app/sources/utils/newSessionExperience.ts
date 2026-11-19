import type { NewSessionAgentType } from '@/sync/persistence';

export type SessionConfigExperience = {
    showPath: boolean;
    showModeDetails: boolean;
    showPermission: boolean;
    showWorktree: boolean;
};

export type RunningSessionInfoExperience = {
    showPath: boolean;
    showModelDetails: boolean;
    showPermission: boolean;
};

export type ComposeHomeExperience = {
    displayAgentType: NewSessionAgentType;
    canAttach: boolean;
    showCreationRail: boolean;
};

export function getSessionConfigExperience(agentType: NewSessionAgentType): SessionConfigExperience {
    return {
        showPath: true,
        showModeDetails: true,
        showPermission: true,
        showWorktree: true,
    };
}

export function getRunningSessionInfoExperience(agentType: string | null | undefined): RunningSessionInfoExperience {
    return {
        showPath: true,
        showModelDetails: true,
        showPermission: true,
    };
}

export function getComposeHomeExperience(args: {
    agentType: NewSessionAgentType;
    activeImageAgent: boolean;
    imagePluginInstalled: boolean;
}): ComposeHomeExperience {
    const { agentType, activeImageAgent, imagePluginInstalled } = args;
    const displayAgentType = activeImageAgent ? 'codex' : agentType;
    return {
        displayAgentType,
        canAttach: activeImageAgent || agentType === 'claude' || agentType === 'codex' || agentType === 'opencode',
        showCreationRail: imagePluginInstalled && !activeImageAgent,
    };
}
