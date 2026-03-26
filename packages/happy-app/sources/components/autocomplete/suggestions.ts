import { CommandSuggestion, FileMentionSuggestion } from '@/components/AgentInputSuggestionView';
import * as React from 'react';
import { searchFiles, FileItem } from '@/sync/suggestionFile';
import { searchCommands, CommandItem } from '@/sync/suggestionCommands';

export async function getCommandSuggestions(sessionId: string, query: string): Promise<{
    key: string;
    text: string;
    component: React.ComponentType;
}[]> {
    // Remove the "/" prefix for searching
    const searchTerm = query.slice(1);

    try {
        // Use the command search cache with fuzzy matching
        const commands = await searchCommands(sessionId, searchTerm, { limit: 5 });

        // Convert CommandItem to suggestion format
        return commands.map((cmd: CommandItem) => ({
            key: `cmd-${cmd.command}`,
            text: `/${cmd.command}`,
            component: () => React.createElement(CommandSuggestion, {
                command: cmd.command,
                description: cmd.description
            })
        }));
    } catch (error) {
        console.error('Error fetching command suggestions:', error);
        return [];
    }
}

export async function getFileMentionSuggestions(sessionId: string, query: string): Promise<{
    key: string;
    text: string;
    component: React.ComponentType;
}[]> {
    // Remove the "@" prefix for searching
    const searchTerm = query.slice(1);

    try {
        // Use the file search cache with fuzzy matching
        const files = await searchFiles(sessionId, searchTerm, { limit: 5 });

        // Convert FileItem to suggestion format
        return files.map((file: FileItem) => ({
            key: `file-${file.fullPath}`,
            text: `@${file.fullPath}`,
            component: () => React.createElement(FileMentionSuggestion, {
                fileName: file.fileName,
                filePath: file.filePath,
                fileType: file.fileType
            })
        }));
    } catch (error) {
        console.error('Error fetching file suggestions:', error);
        return [];
    }
}

export async function getSuggestions(sessionId: string, query: string): Promise<{
    key: string;
    text: string;
    component: React.ComponentType;
}[]> {
    if (!query || query.length === 0) {
        return [];
    }

    if (query.startsWith('/')) {
        return getCommandSuggestions(sessionId, query);
    }

    if (query.startsWith('@')) {
        return getFileMentionSuggestions(sessionId, query);
    }

    return [];
}
