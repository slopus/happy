export interface CommandMetadata {
    icon: string;
    text: string;
}

export interface Command {
    id: string;
    title: string;
    subtitle?: string;
    metadata?: CommandMetadata[];
    keywords?: string[];
    icon?: string;
    shortcut?: string;
    category?: string;
    showWhenEmpty?: boolean;
    action: () => void | Promise<void>;
}

export interface CommandCategory {
    id: string;
    title: string;
    commands: Command[];
}
