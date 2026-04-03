const SHELL_WRAPPERS = new Set([
    'bash',
    '/bin/bash',
    'sh',
    '/bin/sh',
    'zsh',
    '/bin/zsh',
]);

export function stringifyToolCommand(command: unknown): string | null {
    if (typeof command === 'string') {
        const trimmed = command.trim();
        return trimmed.length > 0 ? trimmed : null;
    }

    if (!Array.isArray(command)) {
        return null;
    }

    const parts = command
        .filter((part): part is string => typeof part === 'string')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);

    if (parts.length === 0) {
        return null;
    }

    if (parts.length >= 3 && SHELL_WRAPPERS.has(parts[0]) && (parts[1] === '-c' || parts[1] === '-lc')) {
        const wrappedCommand = parts.slice(2).join(' ').trim();
        return wrappedCommand.length > 0 ? wrappedCommand : null;
    }

    return parts.join(' ');
}
