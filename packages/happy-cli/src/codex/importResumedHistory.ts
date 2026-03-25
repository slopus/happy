type ImportedHistoryMessage = {
    role: 'user' | 'assistant';
    text: string;
};

type ImportTargetSession = {
    sendImportedCodexHistoryMessage: (entry: {
        role: 'user' | 'assistant';
        text: string;
        uuid: string;
    }) => void;
    flush: () => Promise<void>;
};

type ImportTargetMessageBuffer = {
    addMessage: (message: string, type: 'user' | 'assistant' | 'status') => void;
};

const PREVIEW_MESSAGES = 12;
const IMPORT_FLUSH_BATCH_SIZE = 20;

function parseRolloutHistoryMessages(file: string): ImportedHistoryMessage[] {
    const messages: ImportedHistoryMessage[] = [];

    for (const line of file.split('\n')) {
        if (!line.trim()) {
            continue;
        }

        let parsed: any;
        try {
            parsed = JSON.parse(line);
        } catch {
            continue;
        }

        if (parsed?.type !== 'event_msg') {
            continue;
        }

        const payload = parsed.payload;
        if (payload?.type === 'user_message' && typeof payload.message === 'string' && payload.message.trim()) {
            messages.push({
                role: 'user',
                text: payload.message.trimEnd(),
            });
            continue;
        }

        if (payload?.type === 'agent_message' && typeof payload.message === 'string' && payload.message.trim()) {
            messages.push({
                role: 'assistant',
                text: payload.message.trimEnd(),
            });
        }
    }

    return messages;
}

export async function importResumedCodexHistory(opts: {
    rolloutPath: string;
    session: ImportTargetSession;
    messageBuffer: ImportTargetMessageBuffer;
}): Promise<{ importedCount: number }> {
    const { readFile } = await import('node:fs/promises');
    const file = await readFile(opts.rolloutPath, 'utf8');
    const parsedMessages = parseRolloutHistoryMessages(file);
    if (parsedMessages.length === 0) {
        return { importedCount: 0 };
    }

    for (let start = 0; start < parsedMessages.length; start += IMPORT_FLUSH_BATCH_SIZE) {
        const batch = parsedMessages.slice(start, start + IMPORT_FLUSH_BATCH_SIZE);
        for (const [offset, message] of batch.entries()) {
            const index = start + offset;
            opts.session.sendImportedCodexHistoryMessage({
                role: message.role,
                text: message.text,
                uuid: `codex-resume-import-${index}`,
            });
        }
        await opts.session.flush();
    }

    opts.messageBuffer.addMessage(
        `Restored ${parsedMessages.length} chat messages from saved Codex session.`,
        'status',
    );

    for (const message of parsedMessages.slice(-PREVIEW_MESSAGES)) {
        opts.messageBuffer.addMessage(message.text, message.role === 'user' ? 'user' : 'assistant');
    }

    return {
        importedCount: parsedMessages.length,
    };
}
