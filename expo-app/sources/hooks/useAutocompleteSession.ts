import * as React from 'react';
import { useAutocomplete } from "./useAutocomplete";

/**
 * Extracts @ mention token from text at cursor position
 * Returns the token if found, null otherwise
 */
function extractMentionToken(text: string, cursorPosition: number): string | null {
    if (!text) return null;

    // Get text up to cursor position
    const textBeforeCursor = text.substring(0, cursorPosition);

    // Regex pattern to match @ mentions
    // Matches @[alphanumeric_-./\]* at the end of the string
    const mentionRegex = /@[a-zA-Z0-9_\-./\\]*$/;

    const match = textBeforeCursor.match(mentionRegex);
    if (!match || match.index === undefined) return null;

    // Return just the token (e.g., "@src/app")
    return match[0];
}

// Checks if text starts with a slash command
function extractSlashCommandToken(text: string, cursorPosition: number): string | null {
    if (text.startsWith('/')) {
        return text.substring(0, cursorPosition);
    }
    return null;
}

export function useAutocompleteSession(text: string, cursorPosition: number) {
    const query = React.useMemo(() => {
        const slashCommand = extractSlashCommandToken(text, cursorPosition);
        if (slashCommand !== null) {
            return slashCommand;
        }
        const mention = extractMentionToken(text, cursorPosition);
        if (mention !== null) {
            return mention;
        }
        return null;
    }, [text, cursorPosition]);
    return useAutocomplete(query, async (q) => {
        if (q.startsWith('/')) {
            if ('/compact'.startsWith(q.toLowerCase())) {
                return [{ text: '/compact' }];
            }
        }
        return [];
    });
}