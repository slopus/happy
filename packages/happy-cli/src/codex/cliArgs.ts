export function extractCodexResumeFlag(args: string[]): { resumeThreadId: string | null; args: string[] } {
    const remainingArgs: string[] = [];
    let resumeThreadId: string | null = null;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === '--resume' || arg === '-r') {
            if (resumeThreadId !== null) {
                throw new Error('Codex resume flag can only be provided once.');
            }

            const nextArg = args[i + 1];
            if (!nextArg || nextArg.startsWith('-')) {
                throw new Error('Codex resume requires a thread ID: happy codex --resume <thread-id>');
            }

            resumeThreadId = nextArg;
            i++;
            continue;
        }

        if (arg.startsWith('--resume=')) {
            if (resumeThreadId !== null) {
                throw new Error('Codex resume flag can only be provided once.');
            }

            const value = arg.slice('--resume='.length).trim();
            if (!value) {
                throw new Error('Codex resume requires a thread ID: happy codex --resume <thread-id>');
            }

            resumeThreadId = value;
            continue;
        }

        remainingArgs.push(arg);
    }

    return {
        resumeThreadId,
        args: remainingArgs,
    };
}

export function extractCodexNameFlag(args: string[]): { initialName: string | null; args: string[] } {
    const remainingArgs: string[] = [];
    let initialName: string | null = null;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === '--name') {
            if (initialName !== null) {
                throw new Error('Codex name flag can only be provided once.');
            }

            const nextArg = args[i + 1];
            if (!nextArg || nextArg.startsWith('-')) {
                throw new Error('Codex name requires a title: happy codex --name <title>');
            }

            initialName = nextArg;
            i++;
            continue;
        }

        if (arg.startsWith('--name=')) {
            if (initialName !== null) {
                throw new Error('Codex name flag can only be provided once.');
            }

            const value = arg.slice('--name='.length).trim();
            if (!value) {
                throw new Error('Codex name requires a title: happy codex --name <title>');
            }

            initialName = value;
            continue;
        }

        remainingArgs.push(arg);
    }

    return {
        initialName,
        args: remainingArgs,
    };
}
