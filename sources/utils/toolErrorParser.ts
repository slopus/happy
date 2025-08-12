/**
 * Parses error messages that contain <tool_use_error> tags
 * 
 * Example:
 * Input: "<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>"
 * Output: { isToolUseError: true, errorMessage: "File has not been read yet. Read it first before writing to it." }
 */
export function parseToolUseError(message: string): {
    isToolUseError: boolean;
    errorMessage: string | null;
} {
    // Check if the message is a string
    if (typeof message !== 'string') {
        return {
            isToolUseError: false,
            errorMessage: null
        };
    }

    // Match <tool_use_error> tags with content inside
    // The 's' flag allows . to match newlines
    const regex = /<tool_use_error>(.*?)<\/tool_use_error>/s;
    const match = message.match(regex);

    if (match && match[1]) {
        return {
            isToolUseError: true,
            errorMessage: match[1].trim()
        };
    }

    return {
        isToolUseError: false,
        errorMessage: null
    };
}

/**
 * Extracts all tool use errors from a message that might contain multiple
 */
export function parseAllToolUseErrors(message: string): string[] {
    if (typeof message !== 'string') {
        return [];
    }

    // Global regex to find all occurrences
    const regex = /<tool_use_error>(.*?)<\/tool_use_error>/gs;
    const matches = message.matchAll(regex);
    
    const errors: string[] = [];
    for (const match of matches) {
        if (match[1]) {
            errors.push(match[1].trim());
        }
    }
    
    return errors;
}

/**
 * Checks if a message contains any tool use error
 */
export function hasToolUseError(message: string): boolean {
    return parseToolUseError(message).isToolUseError;
}