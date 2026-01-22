export interface Command {
    id: string;
    title: string;
    subtitle?: string;
    icon?: string;
    shortcut?: string;
    category?: string;
    action: () => void | Promise<void>;
}

export interface CommandCategory {
    id: string;
    title: string;
    commands: Command[];
}