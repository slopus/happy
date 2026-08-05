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

export type CommandPaletteClose = (afterClose?: () => void) => void;

export interface CommandCategory {
    id: string;
    title: string;
    commands: Command[];
}

export const COMMAND_PALETTE_RESULTS_ID = 'command-palette-results';

export function getCommandPaletteOptionId(commandId: string): string {
    return `command-palette-option-${commandId}`;
}
