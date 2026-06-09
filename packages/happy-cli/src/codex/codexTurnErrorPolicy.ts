export type CodexTurnErrorDisposition = 'user-abort' | 'unexpected-exit';

export function resolveCodexTurnErrorDisposition(opts: {
    abortRequested: boolean;
    shouldExit: boolean;
}): CodexTurnErrorDisposition {
    if (opts.abortRequested && !opts.shouldExit) {
        return 'user-abort';
    }
    return 'unexpected-exit';
}
