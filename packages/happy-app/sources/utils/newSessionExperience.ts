import type { NewSessionAgentType } from '@/sync/persistence';

type AgentPickerItem<T extends string = NewSessionAgentType> = {
    key: T;
    label: string;
};

export type NewSessionTopLevelMode = 'ask' | 'agent';

export type SessionConfigExperience = {
    isAskMode: boolean;
    showPath: boolean;
    showModeDetails: boolean;
    showPermission: boolean;
    showWorktree: boolean;
};

export type RunningSessionInfoExperience = {
    isAskMode: boolean;
    showPath: boolean;
    showModelDetails: boolean;
    showPermission: boolean;
};

export type ComposeHomeExperience = {
    displayAgentType: NewSessionAgentType;
    canAttach: boolean;
    showCreationRail: boolean;
};

export type HeaderModeSwitchExperience = {
    visible: boolean;
    selectedMode: NewSessionTopLevelMode;
};

export function getSessionConfigExperience(agentType: NewSessionAgentType): SessionConfigExperience {
    const isAskMode = agentType === 'ask';
    return {
        isAskMode,
        showPath: !isAskMode,
        showModeDetails: true,
        showPermission: !isAskMode,
        showWorktree: !isAskMode,
    };
}

export function getRunningSessionInfoExperience(agentType: string | null | undefined): RunningSessionInfoExperience {
    const isAskMode = agentType === 'ask';
    return {
        isAskMode,
        showPath: !isAskMode,
        showModelDetails: true,
        showPermission: !isAskMode,
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
        canAttach: activeImageAgent || agentType === 'claude' || agentType === 'codex',
        showCreationRail: imagePluginInstalled && !activeImageAgent && agentType !== 'ask',
    };
}

export function getHeaderModeSwitchExperience(args: {
    agentType: NewSessionAgentType;
    activeImageAgent: boolean;
    askConfigured: boolean;
}): HeaderModeSwitchExperience {
    if (args.activeImageAgent || !args.askConfigured) {
        return {
            visible: false,
            selectedMode: 'agent',
        };
    }
    return {
        visible: true,
        selectedMode: getTopLevelModeForAgent(args.agentType),
    };
}

export function getTopLevelModeForAgent(agentType: NewSessionAgentType): NewSessionTopLevelMode {
    return agentType === 'ask' ? 'ask' : 'agent';
}

export function getCodingAgentPickerItems<T extends AgentPickerItem>(agents: T[]): Array<Exclude<T, { key: 'ask' }>> {
    return agents.filter((agent) => agent.key !== 'ask') as Array<Exclude<T, { key: 'ask' }>>;
}

export function selectAgentForTopLevelMode(args: {
    mode: NewSessionTopLevelMode;
    currentAgent: NewSessionAgentType;
    availableCodingAgents: AgentPickerItem[];
}): NewSessionAgentType {
    const { mode, currentAgent, availableCodingAgents } = args;
    if (mode === 'ask') {
        return 'ask';
    }
    if (currentAgent !== 'ask' && availableCodingAgents.some((agent) => agent.key === currentAgent)) {
        return currentAgent;
    }
    return (availableCodingAgents[0]?.key as NewSessionAgentType | undefined) ?? 'opencode';
}
