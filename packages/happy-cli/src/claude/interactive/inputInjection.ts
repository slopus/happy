import type {
    InteractiveClaudeBatch,
    InteractiveClaudeBatchValidation,
    InteractiveClaudeTerminalBackend,
} from './types';

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

export function normalizePromptText(message: string): string {
    return message.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function hasUnsupportedControlCharacter(message: string): boolean {
    for (const ch of message) {
        const code = ch.charCodeAt(0);
        if (code < 0x20 && ch !== '\n' && ch !== '\t') {
            return true;
        }
    }
    return false;
}

export function buildInteractivePaste(message: string, backend: InteractiveClaudeTerminalBackend): string {
    const normalized = normalizePromptText(message);
    if (backend === 'tmux') {
        return normalized;
    }
    if (normalized.includes('\n')) {
        return `${BRACKETED_PASTE_START}${normalized}${BRACKETED_PASTE_END}\r`;
    }
    return `${normalized}\r`;
}

export function validateInteractiveBatch(input: {
    batch: InteractiveClaudeBatch;
    launchModeHash: string;
}): InteractiveClaudeBatchValidation {
    const message = normalizePromptText(input.batch.message);
    if (message.trim().length === 0 && !message.startsWith('/')) {
        return { ok: false, reason: 'empty-message', message: 'Claude interactive remote cannot send an empty prompt.' };
    }
    if (input.batch.attachments && input.batch.attachments.length > 0) {
        return { ok: false, reason: 'attachments', message: 'Claude interactive remote does not support image or file attachments yet.' };
    }
    if (input.batch.hash !== input.launchModeHash) {
        return {
            ok: false,
            reason: 'mode-change',
            message: 'Claude interactive remote cannot change model, effort, tools, prompts, or sandbox settings inside a running session.',
        };
    }
    if (hasUnsupportedControlCharacter(message)) {
        return { ok: false, reason: 'control-character', message: 'Claude interactive remote cannot send prompts with raw control characters.' };
    }
    if (message.includes('\n') && message.trimStart().startsWith('/')) {
        return { ok: false, reason: 'control-character', message: 'Claude slash commands must be sent as a single command line.' };
    }
    return { ok: true };
}
