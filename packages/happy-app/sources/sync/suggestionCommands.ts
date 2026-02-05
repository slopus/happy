/**
 * Suggestion commands functionality for slash commands
 * Reads commands directly from session metadata storage
 */

import Fuse from 'fuse.js';
import { storage } from './storage';

export interface CommandItem {
    command: string;        // The command without slash (e.g., "compact")
    description?: string;   // Optional description of what the command does
    source?: 'builtin' | 'sdk' | 'app';  // Command source (builtin = default, sdk = from Claude, app = navigation)
}

interface SearchOptions {
    limit?: number;
    threshold?: number;
}

// Commands to ignore/filter out
export const IGNORED_COMMANDS = [
    "add-dir",
    "agents",
    "config",
    "statusline",
    "bashes",
    "settings",
    "cost",
    "doctor",
    "exit",
    // "help" - removed because we provide it as app command
    "ide",
    "init",
    "install-github-app",
    "mcp",
    "memory",
    "migrate-installer",
    "model",
    "pr-comments",
    "release-notes",
    "resume",
    "status",
    "bug",
    "review",
    "security-review",
    "terminal-setup",
    "upgrade",
    "vim",
    "permissions",
    "hooks",
    "export",
    "logout",
    "login"
];

// Command name constants for type safety and reusability
export const APP_COMMAND_NAMES = ['home', 'sessions', 'profiles', 'settings', 'help'] as const;
export const BUILTIN_COMMAND_NAMES = ['compact', 'clear'] as const;

// Default commands always available
const DEFAULT_COMMANDS: CommandItem[] = [
    { command: 'compact', description: 'Compact the conversation history', source: 'builtin' },
    { command: 'clear', description: 'Clear the conversation', source: 'builtin' }
];

// App navigation commands (available in web app and Telegram)
const APP_COMMANDS: CommandItem[] = [
    { command: 'home', description: 'Navigate to home screen', source: 'app' },
    { command: 'sessions', description: 'View all active sessions', source: 'app' },
    { command: 'profiles', description: 'Manage your profiles', source: 'app' },
    { command: 'settings', description: 'Open settings', source: 'app' },
    { command: 'help', description: 'Show help and documentation', source: 'app' }
];

// Command descriptions for known tools/commands
const COMMAND_DESCRIPTIONS: Record<string, string> = {
    // Default commands
    compact: 'Compact the conversation history',
    
    // Common tool commands
    help: 'Show available commands',
    clear: 'Clear the conversation',
    reset: 'Reset the session',
    export: 'Export conversation',
    debug: 'Show debug information',
    status: 'Show connection status',
    stop: 'Stop current operation',
    abort: 'Abort current operation',
    cancel: 'Cancel current operation',
    
    // Add more descriptions as needed
};

// Get commands from session metadata
function getCommandsFromSession(sessionId: string, options?: { includeAppCommands?: boolean }): CommandItem[] {
    const state = storage.getState();
    const session = state.sessions[sessionId];
    if (!session || !session.metadata) {
        return DEFAULT_COMMANDS;
    }

    const commands: CommandItem[] = [...DEFAULT_COMMANDS];

    // Add app navigation commands if requested (for web app / Telegram)
    if (options?.includeAppCommands) {
        commands.push(...APP_COMMANDS);
    }

    // Add commands from metadata.slashCommands (filter with ignore list)
    if (session.metadata.slashCommands) {
        for (const cmd of session.metadata.slashCommands) {
            // Skip if in ignore list
            if (IGNORED_COMMANDS.includes(cmd)) continue;

            // Check if command already exists (in any existing commands)
            const existingCommand = commands.find(c => c.command === cmd);
            if (!existingCommand) {
                commands.push({
                    command: cmd,
                    description: COMMAND_DESCRIPTIONS[cmd],  // Optional description
                    source: 'sdk'
                });
            }
        }
    }

    return commands;
}

// Main export: search commands with fuzzy matching
export async function searchCommands(
    sessionId: string,
    query: string,
    options: SearchOptions & { includeAppCommands?: boolean } = {}
): Promise<CommandItem[]> {
    const { limit = 10, threshold = 0.3, includeAppCommands = false } = options;

    // Get commands from session metadata (no caching)
    const commands = getCommandsFromSession(sessionId, { includeAppCommands });

    // If query is empty, return all commands
    if (!query || query.trim().length === 0) {
        return commands.slice(0, limit);
    }

    // Setup Fuse for fuzzy search
    const fuseOptions = {
        keys: [
            { name: 'command', weight: 0.7 },
            { name: 'description', weight: 0.3 }
        ],
        threshold,
        includeScore: true,
        shouldSort: true,
        minMatchCharLength: 1,
        ignoreLocation: true,
        useExtendedSearch: true
    };

    const fuse = new Fuse(commands, fuseOptions);
    const results = fuse.search(query, { limit });

    return results.map(result => result.item);
}

// Get all available commands for a session
export function getAllCommands(sessionId: string, options?: { includeAppCommands?: boolean }): CommandItem[] {
    return getCommandsFromSession(sessionId, options);
}