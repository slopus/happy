import { parseSpecialCommand } from '@/parsers/specialCommands';
import type { PendingAttachment } from '@/utils/MessageQueue2';
import type { MessageMeta } from '@slopus/happy-wire';

type CodexUserTextQueue<T> = {
    push: (message: string, mode: T, attachments?: PendingAttachment[], sendMode?: MessageMeta['sendMode']) => void;
    pushIsolateAndClear: (message: string, mode: T, attachments?: PendingAttachment[]) => void;
};

export function isCodexClearText(text: string): boolean {
    return parseSpecialCommand(text).type === 'clear';
}

export function enqueueCodexUserText<T>(opts: {
    text: string;
    mode: T;
    queue: CodexUserTextQueue<T>;
    attachments?: PendingAttachment[];
    sendMode?: MessageMeta['sendMode'];
}): 'clear' | 'queued' {
    if (isCodexClearText(opts.text)) {
        opts.queue.pushIsolateAndClear(opts.text, opts.mode, opts.attachments);
        return 'clear';
    }

    opts.queue.push(opts.text, opts.mode, opts.attachments, opts.sendMode);
    return 'queued';
}
