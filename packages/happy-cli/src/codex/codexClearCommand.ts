import { parseSpecialCommand } from '@/parsers/specialCommands';

type CodexUserTextQueue<T> = {
    push: (message: string, mode: T) => void;
    pushIsolateAndClear: (message: string, mode: T) => void;
};

export function isCodexClearText(text: string): boolean {
    return parseSpecialCommand(text).type === 'clear';
}

export function enqueueCodexUserText<T>(opts: {
    text: string;
    mode: T;
    queue: CodexUserTextQueue<T>;
}): 'clear' | 'queued' {
    if (isCodexClearText(opts.text)) {
        opts.queue.pushIsolateAndClear(opts.text, opts.mode);
        return 'clear';
    }

    opts.queue.push(opts.text, opts.mode);
    return 'queued';
}
