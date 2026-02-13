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

export interface ExportCommandResult {
    isExport: boolean;
    options?: ExportOptions;
}

export interface ExportOptions {
    format: 'markdown' | 'json';
    destination: 'mobile' | 'cli';
}

export interface SpecialCommandResult {
    type: 'compact' | 'clear' | 'export' | null;
    originalMessage?: string;
    exportOptions?: ExportOptions;
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
 * Parse /export command
 * Matches: /export, /export json, /export cli, /export json cli
 * Options:
 * - format: "json" for JSON, default is "markdown"
 * - destination: "cli" to save to file, default is "mobile" to display
 */
export function parseExportCommand(message: string): ExportCommandResult {
    const trimmed = message.trim();

    if (trimmed === '/export' || trimmed.startsWith('/export ')) {
        const parts = trimmed.toLowerCase().split(/\s+/);
        const options: ExportOptions = {
            format: 'markdown',
            destination: 'mobile'
        };

        for (let i = 1; i < parts.length; i++) {
            const part = parts[i];
            if (part === 'json') {
                options.format = 'json';
            } else if (part === 'md' || part === 'markdown') {
                options.format = 'markdown';
            } else if (part === 'cli' || part === 'local' || part === 'file') {
                options.destination = 'cli';
            }
        }

        return { isExport: true, options };
    }

    return { isExport: false };
}

/**
 * Unified parser for special commands
 * Returns the type of command and original message if applicable
 */
export function parseSpecialCommand(message: string): SpecialCommandResult {
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

    const exportResult = parseExportCommand(message);
    if (exportResult.isExport) {
        return {
            type: 'export',
            exportOptions: exportResult.options
        };
    }

    return {
        type: null
    };
}