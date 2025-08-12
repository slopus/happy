/**
 * Finds the active word at the cursor position that starts with one of the given prefixes
 * @param content The full text content
 * @param selection The current cursor position/selection
 * @param prefixes Array of prefix characters to look for (e.g., ['@', ':', '/'])
 * @returns An object containing:
 *   - word: The complete word from prefix to end (e.g., "@username")
 *   - activeWord: The part from prefix to cursor position (e.g., "@use")
 *   - offset: Starting position of the word
 *   - length: Total length of the complete word
 *   - activeLength: Length from prefix to cursor position
 *   - endOffset: Position where the word ends (offset + length)
 *   Returns undefined if no prefixed word is found at cursor position
 */

// Characters that stop the active word search
const STOP_CHARACTERS = ['\n', ',', '(', ')', '[', ']', '{', '}', '<', '>', ';', '!', '?', '.'];

interface Selection {
    start: number;
    end: number;
}

export interface ActiveWord {
    word: string;           // Full word from prefix to end (e.g., "@username")
    activeWord: string;     // Part from prefix to cursor (e.g., "@use")
    offset: number;         // Starting position of the word
    length: number;         // Total length of the complete word
    activeLength: number;   // Length from prefix to cursor
    endOffset: number;      // Position where the word ends (offset + length)
}

function findActiveWordStart(
    content: string,
    selection: Selection,
    prefixes: string[]
): number {
    let startIndex = selection.start - 1;
    let spaceIndex = -1;
    let foundPrefix = false;
    let prefixIndex = -1;

    while (startIndex >= 0) {
        const char = content.charAt(startIndex);

        // Check if we hit a space
        if (char === ' ') {
            if (foundPrefix) {
                // We found a prefix earlier, return its position
                return prefixIndex;
            }
            if (spaceIndex >= 0) {
                // Multiple spaces, stop here
                return spaceIndex + 1;
            } else {
                spaceIndex = startIndex;
                startIndex--;
            }
        }
        // Check if this is a prefix character at word boundary
        else if (
            prefixes.includes(char) &&
            (startIndex === 0 || content.charAt(startIndex - 1) === ' ' || content.charAt(startIndex - 1) === '\n')
        ) {
            // For @ prefix, continue searching backwards to include the entire file path
            if (char === '@') {
                foundPrefix = true;
                prefixIndex = startIndex;
                // Return immediately for @ at word boundary
                return startIndex;
            } else {
                return startIndex;
            }
        }
        // Check if we hit a stop character
        else if (STOP_CHARACTERS.includes(char)) {
            if (foundPrefix) {
                return prefixIndex;
            }
            return startIndex + 1;
        }
        // Continue searching backwards
        else {
            startIndex--;
        }
    }

    // Reached beginning of text
    if (foundPrefix) {
        return prefixIndex;
    }
    return (spaceIndex >= 0 ? spaceIndex : startIndex) + 1;
}

function findActiveWordEnd(
    content: string,
    cursorPos: number,
    wordStartPos?: number
): number {
    let endIndex = cursorPos;
    
    // Check if this is a file path (starts with @ and may contain /)
    let isFilePath = false;
    if (wordStartPos !== undefined && wordStartPos >= 0 && wordStartPos < content.length) {
        isFilePath = content.charAt(wordStartPos) === '@';
    }
    
    while (endIndex < content.length) {
        const char = content.charAt(endIndex);
        
        // For file paths starting with @, don't stop at / or .
        if (isFilePath && (char === '/' || char === '.')) {
            endIndex++;
            continue;
        }
        
        // Stop at spaces or stop characters
        if (char === ' ' || STOP_CHARACTERS.includes(char)) {
            break;
        }
        endIndex++;
    }
    
    return endIndex;
}

export function findActiveWord(
    content: string,
    selection: Selection,
    prefixes: string[] = ['@', ':', '/']
): ActiveWord | undefined {
    // Only detect when cursor is at a single point (no text selected)
    if (selection.start !== selection.end) {
        return undefined;
    }

    // Don't detect if cursor is at the very beginning
    if (selection.start === 0) {
        return undefined;
    }

    const startIndex = findActiveWordStart(content, selection, prefixes);
    const activeWordPart = content.substring(startIndex, selection.end);

    // Check if the active word ends with a space - if so, no active word
    if (activeWordPart.endsWith(' ')) {
        return undefined;
    }

    // Check if the word starts with one of our prefixes
    if (activeWordPart.length > 0) {
        const firstChar = activeWordPart.charAt(0);
        if (prefixes.includes(firstChar)) {
            // Find where the word ends after the cursor
            // Pass the start position to help determine if this is a file path
            const endIndex = findActiveWordEnd(content, selection.end, startIndex);
            const fullWord = content.substring(startIndex, endIndex);
            
            // Don't return just the prefix character alone
            if (activeWordPart.length === 1 && fullWord.length === 1) {
                return {
                    word: fullWord,
                    activeWord: activeWordPart,
                    offset: startIndex,
                    length: fullWord.length,
                    activeLength: activeWordPart.length,
                    endOffset: endIndex
                }; // Return single prefix to show suggestions immediately
            }
            return {
                word: fullWord,
                activeWord: activeWordPart,
                offset: startIndex,
                length: fullWord.length,
                activeLength: activeWordPart.length,
                endOffset: endIndex
            };
        }
    }

    return undefined;
}

/**
 * Backward-compatible wrapper that returns just the word string
 * @deprecated Use findActiveWord instead which returns more information
 */
export function findActiveWordString(
    content: string,
    selection: Selection,
    prefixes: string[] = ['@', ':', '/']
): string | undefined {
    const result = findActiveWord(content, selection, prefixes);
    return result?.activeWord; // Return the active part for backward compatibility
}

/**
 * Extracts just the query part without the prefix
 * @param activeWord The active word including prefix
 * @returns The query string without prefix
 */
export function getActiveWordQuery(activeWord: string): string {
    if (activeWord.length > 1) {
        return activeWord.substring(1);
    }
    return '';
}