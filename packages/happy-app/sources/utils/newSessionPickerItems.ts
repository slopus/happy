type AgentPickerSource = {
    key: string;
    label: string;
};

type ModePickerSource = {
    key: string;
    name: string;
    description?: string | null;
    providerId?: string;
    providerName?: string;
};

export type NewSessionPickerItem = {
    key: string;
    label: string;
    subtitle?: string;
    section?: string;
};

export function getAgentPickerItems(agents: AgentPickerSource[]): NewSessionPickerItem[] {
    return agents.map((agent) => ({
        key: agent.key,
        label: agent.label,
    }));
}

export function getModePickerItems(options: ModePickerSource[]): NewSessionPickerItem[] {
    const hasProviders = options.some((option) => option.providerId || option.providerName);
    const ordered = hasProviders
        ? [...options.reduce((groups, option) => {
            const groupKey = option.providerId || option.providerName || '__models__';
            const group = groups.get(groupKey) ?? [];
            group.push(option);
            groups.set(groupKey, group);
            return groups;
        }, new Map<string, ModePickerSource[]>()).values()].flat()
        : options;

    return ordered.map((option) => ({
        key: option.key,
        label: option.name,
        ...(option.description && option.description !== option.providerName
            ? { subtitle: option.description }
            : {}),
        ...(option.providerName || option.providerId
            ? { section: option.providerName || option.providerId }
            : {}),
    }));
}
