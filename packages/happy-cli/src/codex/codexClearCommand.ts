import { parseSpecialCommand, type SpecialCommandType } from '@/parsers/specialCommands';
import type { PendingAttachment } from '@/utils/MessageQueue2';

type CodexUserTextQueue<T> = {
    push: (message: string, mode: T, attachments?: PendingAttachment[]) => void;
    pushIsolateAndClear: (message: string, mode: T, attachments?: PendingAttachment[]) => PendingAttachment[];
};

export type CodexUserTextEnqueueResult = {
    status: SpecialCommandType | 'queued';
    displacedAttachments: PendingAttachment[];
};

export function isCodexClearText(text: string): boolean {
    return parseSpecialCommand(text).type === 'clear';
}

function getIsolatedCommand(text: string): SpecialCommandType | null {
    const type = parseSpecialCommand(text).type;
    return type;
}

export function enqueueCodexUserText<T>(opts: {
    text: string;
    mode: T;
    attachments?: PendingAttachment[];
    queue: CodexUserTextQueue<T>;
}): CodexUserTextEnqueueResult {
    const isolatedCommand = getIsolatedCommand(opts.text);
    if (isolatedCommand) {
        const displacedAttachments = opts.queue.pushIsolateAndClear(opts.text, opts.mode, opts.attachments) ?? [];
        return { status: isolatedCommand, displacedAttachments };
    }

    opts.queue.push(opts.text, opts.mode, opts.attachments);
    return { status: 'queued', displacedAttachments: [] };
}
