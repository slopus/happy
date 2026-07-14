import type { PermissionMode } from '@/api/types';
import { CHANGE_TITLE_INSTRUCTION } from '@/gemini/constants';
import { hashObject } from '@/utils/deterministicJson';

import type { ReasoningEffort } from './codexAppServerTypes';

export interface CodexEnhancedMode {
    permissionMode: PermissionMode;
    model?: string;
    /** Happy app instructions appended to the first Codex prompt for option chips. */
    appendSystemPrompt?: string;
    /** Reasoning effort passed through to Codex's sendTurnAndWait. */
    effort?: ReasoningEffort;
}

export function hashCodexEnhancedMode(mode: CodexEnhancedMode): string {
    return hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model,
        appendSystemPrompt: mode.appendSystemPrompt,
        effort: mode.effort,
    });
}

/**
 * Happy wraps its own injected instructions (the option-chips system prompt and
 * the change-title instruction) in these sentinel markers inside the Codex turn
 * text. Codex still reads the instructions normally, but the markers let the app
 * strip this scaffolding back out when it reconstructs a conversation from a
 * Codex thread (fork / duplicate / side chat backfill) — otherwise the raw
 * instructions leak into the chat as if the user had typed them. See
 * `stripHappySystemBlocks`.
 */
export const HAPPY_SYSTEM_BLOCK_OPEN = '<happy-system>';
export const HAPPY_SYSTEM_BLOCK_CLOSE = '</happy-system>';

function wrapHappySystem(text: string): string {
    return `${HAPPY_SYSTEM_BLOCK_OPEN}\n${text}\n${HAPPY_SYSTEM_BLOCK_CLOSE}`;
}

/**
 * Remove any `<happy-system>…</happy-system>` blocks (and the blank lines that
 * join them to the user's text) from a Codex turn string, leaving only what the
 * user actually wrote. Safe to call on text that has no markers.
 */
export function stripHappySystemBlocks(text: string): string {
    const open = HAPPY_SYSTEM_BLOCK_OPEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const close = HAPPY_SYSTEM_BLOCK_CLOSE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\s*${open}[\\s\\S]*?${close}\\s*`, 'g');
    return text.replace(re, '\n\n').trim();
}

export function buildCodexTurnPrompt(opts: {
    message: string;
    mode: Pick<CodexEnhancedMode, 'appendSystemPrompt'>;
    includeAppendSystemPrompt: boolean;
    includeTitleInstruction: boolean;
}): string {
    const parts: string[] = [];

    if (opts.includeAppendSystemPrompt && opts.mode.appendSystemPrompt) {
        parts.push(wrapHappySystem(opts.mode.appendSystemPrompt));
    }

    parts.push(opts.message);

    if (opts.includeTitleInstruction) {
        parts.push(wrapHappySystem(CHANGE_TITLE_INSTRUCTION));
    }

    return parts.join('\n\n');
}
