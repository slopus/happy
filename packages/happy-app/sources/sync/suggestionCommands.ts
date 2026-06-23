/**
 * Suggestion commands functionality for slash commands
 * Reads commands directly from session metadata storage
 */

import Fuse from 'fuse.js';
import { storage } from './storage';

export interface CommandItem {
    command: string;        // The command without slash (e.g., "compact")
    description?: string;   // Optional description of what the command does
    source: 'agent' | 'skill' | 'happy';
    sourceLabel?: string;
}

interface SearchOptions {
    limit?: number;
    threshold?: number;
}

// Commands that are noisy enough to hide from the top-level empty "/" list,
// but still searchable if the user types them explicitly. Do not use this to
// block native agent commands from being sent.
export const LOW_PRIORITY_COMMANDS = [
    "add-dir",
    "agents",
    "config",
    "statusline",
    "bashes",
    "settings",
    "cost",
    "doctor",
    "exit",
    "help",
    "ide",
    "init",
    "install-github-app",
    "memory",
    "migrate-installer",
    "model",
    "pr-comments",
    "release-notes",
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

// Default agent commands always available as suggestions. They are still sent
// through to the agent; Happy does not intercept them.
const DEFAULT_COMMANDS = [
    { command: 'compact', description: 'Compact the conversation history' },
    { command: 'clear', description: 'Clear the conversation' },
    { command: 'mcp', description: 'Show connected MCP servers' },
    { command: 'skills', description: 'Show available skills' },
];

// Command descriptions for known tools/commands
const COMMAND_DESCRIPTIONS: Record<string, string> = {
    // Default commands
    compact: 'Compact the conversation history',
    
    // Common tool commands
    help: 'Show available commands',
    clear: 'Clear the conversation',
    resume: 'Resume a previous agent conversation',
    reset: 'Reset the session',
    export: 'Export conversation',
    debug: 'Show debug information',
    status: 'Show connection status',
    stop: 'Stop current operation',
    abort: 'Abort current operation',
    cancel: 'Cancel current operation',
    
    // Add more descriptions as needed
};

function commandKey(command: string, source: CommandItem['source'], sourceLabel?: string): string {
    return `${source}:${sourceLabel ?? ''}:${command}`;
}

function normalizeCommand(command: string): string {
    return command.replace(/^\/+/, '').trim();
}

function addCommand(commands: CommandItem[], item: CommandItem) {
    if (!item.command || commands.some(command => commandKey(command.command, command.source, command.sourceLabel) === commandKey(item.command, item.source, item.sourceLabel))) {
        return;
    }
    commands.push(item);
}

function getAgentSourceLabel(flavor?: string | null): string {
    switch (flavor) {
        case 'codex':
            return 'Codex';
        case 'gemini':
            return 'Gemini';
        case 'openclaw':
            return 'OpenClaw';
        default:
            return 'Claude';
    }
}

function getDefaultCommands(sourceLabel: string): CommandItem[] {
    return DEFAULT_COMMANDS.map(command => ({
        ...command,
        source: 'agent' as const,
        sourceLabel,
    }));
}

// Get commands from session metadata
function getCommandsFromSession(sessionId: string): CommandItem[] {
    const state = storage.getState();
    const session = state.sessions[sessionId];
    const agentSourceLabel = getAgentSourceLabel(session?.metadata?.flavor ?? session?.metadata?.agentType);
    if (!session || !session.metadata) {
        return getDefaultCommands(agentSourceLabel);
    }

    const commands: CommandItem[] = getDefaultCommands(agentSourceLabel);
    
    // Add native slash commands reported by the agent. Keep them discoverable
    // even when Happy has a command with the same name.
    if (session.metadata.slashCommands) {
        for (const cmd of session.metadata.slashCommands) {
            const command = normalizeCommand(cmd);
            addCommand(commands, {
                command,
                description: COMMAND_DESCRIPTIONS[command],
                source: 'agent',
                sourceLabel: agentSourceLabel,
            });
        }
    }

    // Claude skills are invoked through slash commands too. Expose them as a
    // separate source so the user can distinguish "native command" from "skill".
    if (session.metadata.skills) {
        for (const skill of session.metadata.skills) {
            const command = normalizeCommand(skill);
            addCommand(commands, {
                command,
                description: 'Run skill',
                source: 'skill',
                sourceLabel: 'Skill',
            });
        }
    }
    
    return commands;
}

// Main export: search commands with fuzzy matching
export async function searchCommands(
    sessionId: string,
    query: string,
    options: SearchOptions = {}
): Promise<CommandItem[]> {
    const { limit = 10, threshold = 0.3 } = options;
    
    // Get commands from session metadata (no caching)
    const commands = getCommandsFromSession(sessionId);
    
    // If query is empty, return all commands
    const normalizedQuery = query.trim();

    if (!normalizedQuery) {
        return commands
            .filter(command => !LOW_PRIORITY_COMMANDS.includes(command.command))
            .slice(0, limit);
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
    const exactMatches = commands.filter(command => command.command.startsWith(normalizedQuery));
    const fuzzyMatches = fuse.search(normalizedQuery, { limit }).map(result => result.item);
    const merged: CommandItem[] = [];
    for (const command of [...exactMatches, ...fuzzyMatches]) {
        addCommand(merged, command);
    }
    
    return merged.slice(0, limit);
}

// Get all available commands for a session
export function getAllCommands(sessionId: string): CommandItem[] {
    return getCommandsFromSession(sessionId);
}
