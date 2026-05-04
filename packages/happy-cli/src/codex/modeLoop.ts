import type { CodexStartingMode } from './cliArgs';

export type CodexLauncherResult = { type: 'switch' } | { type: 'exit'; code: number };
export type CodexRemoteLauncherResult = 'switch' | 'exit';

export function resolveCodexStartingMode(opts: {
    startedBy?: 'daemon' | 'terminal';
    requestedMode?: CodexStartingMode;
}): CodexStartingMode {
    if (opts.startedBy === 'daemon') {
        return 'remote';
    }

    return opts.requestedMode ?? 'local';
}

export async function codexModeLoop(opts: {
    startedBy?: 'daemon' | 'terminal';
    requestedMode?: CodexStartingMode;
    onModeChange?: (mode: CodexStartingMode) => void;
    local: () => Promise<CodexLauncherResult>;
    remote: () => Promise<CodexRemoteLauncherResult>;
}): Promise<number> {
    let mode = resolveCodexStartingMode({
        startedBy: opts.startedBy,
        requestedMode: opts.requestedMode,
    });

    while (true) {
        opts.onModeChange?.(mode);

        if (mode === 'local') {
            const result = await opts.local();
            if (result.type === 'exit') {
                return result.code;
            }
            mode = 'remote';
            continue;
        }

        const result = await opts.remote();
        if (result === 'exit') {
            return 0;
        }
        mode = 'local';
    }
}
