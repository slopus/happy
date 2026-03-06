export type ToolResultKind = 'command' | 'structured' | 'text';

export interface TrimmedToolOutputMarker {
    _outputTrimmed: true;
    _callId: string;
    _toolResultKind: ToolResultKind;
}

export type ToolOutputContentModel =
    | {
        kind: 'command';
        command: string;
        stdout: string | null;
        stderr: string | null;
        error: string | null;
    }
    | {
        kind: 'text';
        text: string;
    }
    | {
        kind: 'structured';
        data: unknown;
    };

interface FormatToolOutputContentOptions {
    toolName: string;
    toolInput: unknown;
    result: unknown;
    kind: ToolResultKind;
}

export function isTrimmedToolOutput(data: unknown): data is TrimmedToolOutputMarker {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return false;
    }

    const candidate = data as Record<string, unknown>;
    return candidate._outputTrimmed === true
        && typeof candidate._callId === 'string'
        && isToolResultKind(candidate._toolResultKind);
}

export function formatToolOutputContent(options: FormatToolOutputContentOptions): ToolOutputContentModel {
    if (options.kind === 'command') {
        return formatCommandOutput(options.toolName, options.toolInput, options.result);
    }

    if (options.kind === 'structured') {
        return {
            kind: 'structured',
            data: options.result,
        };
    }

    const text = getPreferredTextOutput(options.toolName, options.result);
    if (text !== null) {
        return {
            kind: 'text',
            text,
        };
    }

    return {
        kind: 'structured',
        data: options.result,
    };
}

function isToolResultKind(value: unknown): value is ToolResultKind {
    return value === 'command' || value === 'structured' || value === 'text';
}

function formatCommandOutput(toolName: string, toolInput: unknown, result: unknown): ToolOutputContentModel {
    const data = isPlainObject(result) ? result : {};

    return {
        kind: 'command',
        command: getCommandDisplay(toolName, toolInput),
        stdout: getCommandText(data.stdout) ?? getCommandText(data.formatted_output),
        stderr: getCommandText(data.stderr),
        error: getCommandText(data.error),
    };
}

function getCommandDisplay(toolName: string, toolInput: unknown): string {
    const input = isPlainObject(toolInput) ? toolInput : {};

    if (toolName === 'CodexBash') {
        const parsedCmd = Array.isArray(input.parsed_cmd) ? input.parsed_cmd : [];
        const firstParsed = parsedCmd[0];
        if (isPlainObject(firstParsed) && typeof firstParsed.cmd === 'string' && firstParsed.cmd.trim()) {
            return firstParsed.cmd;
        }
    }

    if (Array.isArray(input.command)) {
        return stringifyCommandArray(input.command);
    }

    if (typeof input.command === 'string') {
        return input.command;
    }

    return '';
}

function stringifyCommandArray(command: unknown[]): string {
    const values = command.filter((value): value is string => typeof value === 'string');
    if (
        values.length >= 3
        && (values[0] === 'bash' || values[0] === '/bin/bash' || values[0] === 'zsh' || values[0] === '/bin/zsh')
        && values[1] === '-lc'
    ) {
        return values[2];
    }
    return values.join(' ');
}

function getPreferredTextOutput(toolName: string, result: unknown): string | null {
    switch (toolName) {
        case 'Read':
        case 'NotebookRead':
            return getReadText(result);
        case 'Grep':
            return getObjectTextField(result, 'content');
        case 'Glob':
            return getGlobText(result);
        case 'LS':
            return getLsText(result);
        case 'WebFetch':
            return getWebFetchText(result);
        default:
            return getGenericText(result);
    }
}

function getReadText(result: unknown): string | null {
    if (!isPlainObject(result) || !isPlainObject(result.file)) {
        return null;
    }
    return typeof result.file.content === 'string' ? result.file.content : null;
}

function getGlobText(result: unknown): string | null {
    if (Array.isArray(result)) {
        return result.filter((item): item is string => typeof item === 'string').join('\n');
    }

    if (isPlainObject(result) && Array.isArray(result.filenames)) {
        return result.filenames.filter((item): item is string => typeof item === 'string').join('\n');
    }

    return getGenericText(result);
}

function getLsText(result: unknown): string | null {
    if (typeof result === 'string') {
        return result;
    }

    if (isPlainObject(result) && Array.isArray(result.files)) {
        return result.files.filter((item): item is string => typeof item === 'string').join('\n');
    }

    return getGenericText(result);
}

function getWebFetchText(result: unknown): string | null {
    if (typeof result === 'string') {
        return result;
    }

    if (!isPlainObject(result)) {
        return null;
    }

    for (const key of ['content', 'text', 'body', 'markdown', 'html']) {
        if (typeof result[key] === 'string') {
            return result[key];
        }
    }

    return null;
}

function getGenericText(result: unknown): string | null {
    if (typeof result === 'string') {
        return result;
    }

    if (Array.isArray(result)) {
        const values = result.filter((item): item is string => typeof item === 'string');
        if (values.length === result.length) {
            return values.join('\n');
        }
        return safeStringify(result);
    }

    if (isPlainObject(result)) {
        for (const key of ['content', 'text', 'body']) {
            if (typeof result[key] === 'string') {
                return result[key];
            }
        }
        return safeStringify(result);
    }

    if (result == null) {
        return null;
    }

    return String(result);
}

function getObjectTextField(result: unknown, field: string): string | null {
    if (!isPlainObject(result)) {
        return null;
    }
    return typeof result[field] === 'string' ? result[field] : null;
}

function getCommandText(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function safeStringify(value: unknown): string | null {
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return null;
    }
}

function isPlainObject(value: unknown): value is Record<string, any> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
