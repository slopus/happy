import { findActiveWord } from './findActiveWord';

interface Selection {
    start: number;
    end: number;
}

/**
 * Applies a suggestion by replacing the active word with the provided suggestion text
 * @param content The full text content
 * @param selection The current cursor position/selection
 * @param suggestion The suggestion text to insert (e.g., "@john_smith")
 * @param prefixes Array of prefix characters to look for (e.g., ['@', ':', '/'])
 * @param addSpace Whether to add a space after the suggestion (default: true)
 * @returns An object containing the new text and cursor position
 */
export function applySuggestion(
    content: string,
    selection: Selection,
    suggestion: string,
    prefixes: string[] = ['@', ':', '/'],
    addSpace: boolean = true
): { text: string; cursorPosition: number } {
    // Find the active word at the current position
    const activeWord = findActiveWord(content, selection, prefixes);
    
    if (!activeWord) {
        // No active word found, just insert the suggestion at cursor position
        const beforeCursor = content.substring(0, selection.start);
        const afterCursor = content.substring(selection.end);
        const suggestionWithSpace = addSpace ? suggestion + ' ' : suggestion;
        
        return {
            text: beforeCursor + suggestionWithSpace + afterCursor,
            cursorPosition: selection.start + suggestionWithSpace.length
        };
    }
    
    // Replace the complete word (from offset to endOffset) with the suggestion
    const beforeWord = content.substring(0, activeWord.offset);
    const afterWord = content.substring(activeWord.endOffset);
    
    // Add space after suggestion if requested
    let suggestionToInsert = suggestion;
    if (addSpace) {
        // Add space if:
        // 1. There's no text after (end of string)
        // 2. There's text after but no space
        if (afterWord.length === 0 || afterWord[0] !== ' ') {
            suggestionToInsert += ' ';
        }
    }
    
    const newText = beforeWord + suggestionToInsert + afterWord;
    const newCursorPosition = activeWord.offset + suggestionToInsert.length;
    
    return {
        text: newText,
        cursorPosition: newCursorPosition
    };
}