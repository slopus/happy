export type ResumeCommandMetadata = {
    path?: string | null;
    os?: string | null;
    flavor?: string | null;
    claudeSessionId?: string | null;
    codexThreadId?: string | null;
};

function quotePosixPath(path: string): string {
    return `'${path.replace(/'/g, `'\\''`)}'`;
}

function quoteWindowsPath(path: string): string {
    return `"${path.replace(/"/g, '""')}"`;
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

export function buildResumeCommand(metadata: ResumeCommandMetadata): string | null {
    const invocation = buildResumeInvocation(metadata);
    if (!invocation) {
        return null;
    }

    const path = metadata.path?.trim();
    if (!path) {
        return invocation;
    }

    const changeDirectoryCommand = metadata.os === 'win32'
        ? `cd /d ${quoteWindowsPath(path)}`
        : `cd ${quotePosixPath(path)}`;

    return `${changeDirectoryCommand} && ${invocation}`;
}
