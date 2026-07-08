type AgentPickerSource = {
    key: string;
    label: string;
};

type ModePickerSource = {
    key: string;
    name: string;
    description?: string | null;
};

export type NewSessionPickerItem = {
    key: string;
    label: string;
    subtitle?: string;
};

export function getAgentPickerItems(agents: AgentPickerSource[]): NewSessionPickerItem[] {
    return agents.map((agent) => ({
        key: agent.key,
        label: agent.label,
    }));
}

export function getModePickerItems(options: ModePickerSource[]): NewSessionPickerItem[] {
    return options.map((option) => ({
        key: option.key,
        label: option.name,
        ...(option.description ? { subtitle: option.description } : {}),
    }));
}
