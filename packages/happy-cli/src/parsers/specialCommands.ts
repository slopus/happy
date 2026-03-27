/**
 * Parsers for special commands that require dedicated remote session handling
 */

export interface CompactCommandResult {
    isCompact: boolean;
    originalMessage: string;
}

export interface ClearCommandResult {
    isClear: boolean;
}

export interface ShellCommandResult {
    isShell: boolean;
    command?: string;
}

export interface SpecialCommandResult {
    type: 'compact' | 'clear' | 'shell' | null;
    originalMessage?: string;
    shellCommand?: string;
}

/**
 * Parse /compact command
 * Matches messages starting with "/compact " or exactly "/compact"
 */
export function parseCompact(message: string): CompactCommandResult {
    const trimmed = message.trim();
    
    if (trimmed === '/compact') {
        return {
            isCompact: true,
            originalMessage: trimmed
        };
    }
    
    if (trimmed.startsWith('/compact ')) {
        return {
            isCompact: true,
            originalMessage: trimmed
        };
    }
    
    return {
        isCompact: false,
        originalMessage: message
    };
}

/**
 * Parse /clear command
 * Only matches exactly "/clear"
 */
export function parseClear(message: string): ClearCommandResult {
    const trimmed = message.trim();

    return {
        isClear: trimmed === '/clear'
    };
}

/**
 * Parse shell command with $ or ! prefix
 * Matches messages starting with "$ " or "! " followed by a command
 * Examples: "$ ls -la", "! pwd", "$ cat file.txt"
 */
export function parseShellCommand(message: string): ShellCommandResult {
    const trimmed = message.trim();

    // Support "$ command" format
    if (trimmed.startsWith('$ ') && trimmed.length > 2) {
        return {
            isShell: true,
            command: trimmed.slice(2).trim()
        };
    }

    // Support "! command" format (alternative)
    if (trimmed.startsWith('! ') && trimmed.length > 2) {
        return {
            isShell: true,
            command: trimmed.slice(2).trim()
        };
    }

    return { isShell: false };
}

/**
 * Unified parser for special commands
 * Returns the type of command and original message if applicable
 */
export function parseSpecialCommand(message: string): SpecialCommandResult {
    // Check for shell command first ($ or ! prefix)
    const shellResult = parseShellCommand(message);
    if (shellResult.isShell) {
        return {
            type: 'shell',
            shellCommand: shellResult.command
        };
    }

    const compactResult = parseCompact(message);
    if (compactResult.isCompact) {
        return {
            type: 'compact',
            originalMessage: compactResult.originalMessage
        };
    }

    const clearResult = parseClear(message);
    if (clearResult.isClear) {
        return {
            type: 'clear'
        };
    }

    return {
        type: null
    };
}