import { randomUUID } from 'node:crypto';

import { CHANGE_TITLE_INSTRUCTION } from '@/gemini/constants';
import { trimIdent } from '@/utils/trimIdent';

function normalizeInitialName(initialName?: string | null): string | null {
    const trimmed = initialName?.trim();
    return trimmed ? trimmed : null;
}

export function applyInitialCodexSessionTitle(
    session: {
        sendClaudeSessionMessage: (body: {
            type: 'summary';
            summary: string;
            leafUuid: string;
        }) => void;
    },
    initialName?: string | null,
): string | null {
    const normalized = normalizeInitialName(initialName);
    if (!normalized) {
        return null;
    }

    session.sendClaudeSessionMessage({
        type: 'summary',
        summary: normalized,
        leafUuid: randomUUID(),
    });

    return normalized;
}

export function buildInitialCodexTurnPrompt(
    message: string,
    initialName?: string | null,
): string {
    const normalized = normalizeInitialName(initialName);
    const titleInstruction = normalized
        ? trimIdent(
            `Before continuing, call functions.happy__change_title and set the chat session title exactly to ${JSON.stringify(normalized)}. Unless the task changes dramatically later, keep using this title.`,
        )
        : CHANGE_TITLE_INSTRUCTION;

    return `${message}\n\n${titleInstruction}`;
}
