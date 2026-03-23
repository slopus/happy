export type ResumeCommandMetadata = {
    path?: string | null;
    os?: string | null;
    flavor?: string | null;
    claudeSessionId?: string | null;
    codexThreadId?: string | null;
};

export type ResumeCommandBlock = {
    lines: string[];
    copyText: string;
};

function quotePosixPath(path: string): string {
    return `'${path.replace(/'/g, `'\\''`)}'`;
}

function quotePowerShellPath(path: string): string {
    return `'${path.replace(/'/g, `''`)}'`;
}

function isWindows(metadata: ResumeCommandMetadata): boolean {
    return metadata.os?.toLowerCase() === 'win32';
}

function buildResumeInvocation(metadata: ResumeCommandMetadata): string | null {
    if ((metadata.flavor === 'codex' || metadata.flavor === 'openai' || metadata.flavor === 'gpt') && metadata.codexThreadId) {
        return `happy codex --resume ${metadata.codexThreadId}`;
    }
    if (metadata.claudeSessionId) {
        return `happy claude --resume ${metadata.claudeSessionId}`;
    }
    return null;
}

function buildChangeDirectoryCommand(metadata: ResumeCommandMetadata): string | null {
    const path = metadata.path?.trim();
    if (!path) {
        return null;
    }

    return isWindows(metadata)
        ? `Set-Location -LiteralPath ${quotePowerShellPath(path)}`
        : `cd ${quotePosixPath(path)}`;
}

export function buildResumeCommandBlock(metadata: ResumeCommandMetadata): ResumeCommandBlock | null {
    const invocation = buildResumeInvocation(metadata);
    if (!invocation) {
        return null;
    }

    const changeDirectoryCommand = buildChangeDirectoryCommand(metadata);
    const lines = changeDirectoryCommand
        ? [changeDirectoryCommand, invocation]
        : [invocation];

    return {
        lines,
        copyText: lines.join('\n'),
    };
}

export function buildResumeCommand(metadata: ResumeCommandMetadata): string | null {
    const commandBlock = buildResumeCommandBlock(metadata);
    if (!commandBlock) {
        return null;
    }
    return commandBlock.lines.join(isWindows(metadata) ? '; ' : ' && ');
}
