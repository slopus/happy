import { maybeParseJson } from './parseJson';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as UnknownRecord;
}

function extractCommandArrayLike(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    const parts: string[] = [];
    for (const item of value) {
        if (typeof item !== 'string') return null;
        parts.push(item);
    }
    return parts;
}

export function extractShellCommand(input: unknown): string | null {
    const parsed = maybeParseJson(input);
    const obj = asRecord(parsed);
    if (!obj) return null;

    // Common: { command: string }
    const command = obj.command;
    if (typeof command === 'string' && command.trim().length > 0) {
        return command.trim();
    }

    // Common: { command: string[] }
    const cmdArray = extractCommandArrayLike(command);
    if (cmdArray && cmdArray.length > 0) {
        // Remove shell wrapper prefix if present (bash/zsh with -lc flag)
        if (
            cmdArray.length >= 3
            && (cmdArray[0] === 'bash' || cmdArray[0] === '/bin/bash' || cmdArray[0] === 'zsh' || cmdArray[0] === '/bin/zsh')
            && cmdArray[1] === '-lc'
            && typeof cmdArray[2] === 'string'
        ) {
            return cmdArray[2];
        }
        return cmdArray.join(' ');
    }

    // Common: { cmd: string | string[] }
    const cmd = obj.cmd;
    if (typeof cmd === 'string' && cmd.trim().length > 0) {
        return cmd.trim();
    }
    const cmdArray2 = extractCommandArrayLike(cmd);
    if (cmdArray2 && cmdArray2.length > 0) {
        return extractShellCommand({ command: cmdArray2 });
    }

    // Common: { argv: string[] }
    const argvArray = extractCommandArrayLike(obj.argv);
    if (argvArray && argvArray.length > 0) {
        return extractShellCommand({ command: argvArray });
    }

    // Our ACP parser wraps raw arrays as { items: [...] }
    const itemsArray = extractCommandArrayLike(obj.items);
    if (itemsArray && itemsArray.length > 0) {
        return extractShellCommand({ command: itemsArray });
    }

    // Nested: { toolCall: { rawInput: { command } } }
    const toolCall = asRecord(obj.toolCall);
    const rawInput = toolCall ? asRecord(toolCall.rawInput) : null;
    if (rawInput) {
        return extractShellCommand(rawInput);
    }

    return null;
}
