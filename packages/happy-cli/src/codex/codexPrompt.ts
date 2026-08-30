import type { PermissionMode } from '@/api/types';
import { CHANGE_TITLE_INSTRUCTION } from '@/gemini/constants';
import { hashObject } from '@/utils/deterministicJson';

import type { ReasoningEffort } from './codexAppServerTypes';

export const CODEX_HAPPY_SYSTEM_PROMPT_START = '<!-- happy:system-prompt:start -->';
export const CODEX_HAPPY_SYSTEM_PROMPT_END = '<!-- happy:system-prompt:end -->';
const CODEX_PAWS_ORIGIN_PREFIX = '<!-- happy:paws-origin:';
const CODEX_PAWS_ORIGIN_SUFFIX = ' -->';

/**
 * Persist an opaque Paws origin token inside the Codex Thread itself.
 *
 * The marker is deliberately an HTML comment: it survives app-server
 * thread/read, while the history mapper removes it from the user-visible text.
 * The random token is stored in encrypted session metadata and is not the
 * Paws session ID. On reconnect it suppresses only that session's already
 * stored user message, without hiding Desktop-originated turns.
 */
export function markPawsTurnOrigin(prompt: string, originToken: string): string {
    return `${CODEX_PAWS_ORIGIN_PREFIX}${encodeURIComponent(originToken)}${CODEX_PAWS_ORIGIN_SUFFIX}\n${prompt}`;
}

export function readPawsTurnOrigin(text: string): string | null {
    const start = text.indexOf(CODEX_PAWS_ORIGIN_PREFIX);
    if (start < 0) return null;
    const valueStart = start + CODEX_PAWS_ORIGIN_PREFIX.length;
    const end = text.indexOf(CODEX_PAWS_ORIGIN_SUFFIX, valueStart);
    if (end < 0) return null;
    try {
        return decodeURIComponent(text.slice(valueStart, end));
    } catch {
        return null;
    }
}

export function stripPawsTurnOrigin(text: string): string {
    let result = text;
    while (true) {
        const start = result.indexOf(CODEX_PAWS_ORIGIN_PREFIX);
        if (start < 0) return result;
        const end = result.indexOf(CODEX_PAWS_ORIGIN_SUFFIX, start + CODEX_PAWS_ORIGIN_PREFIX.length);
        if (end < 0) return result;
        result = result.slice(0, start) + result.slice(end + CODEX_PAWS_ORIGIN_SUFFIX.length);
    }
}

export interface CodexEnhancedMode {
    permissionMode: PermissionMode;
    model?: string;
    /** Happy app instructions appended to the first Codex prompt for option chips. */
    appendSystemPrompt?: string;
    /** Reasoning effort passed through to Codex's sendTurnAndWait. */
    effort?: ReasoningEffort;
    /** Uses Codex's Fast service tier for this session. */
    fast?: boolean;
}

export function hashCodexEnhancedMode(mode: CodexEnhancedMode): string {
    return hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model,
        appendSystemPrompt: mode.appendSystemPrompt,
        effort: mode.effort,
        fast: mode.fast,
    });
}

export function buildCodexTurnPrompt(opts: {
    message: string;
    mode: Pick<CodexEnhancedMode, 'appendSystemPrompt' | 'model' | 'effort' | 'fast'>;
    includeAppendSystemPrompt: boolean;
    includeTitleInstruction: boolean;
}): string {
    const parts: string[] = [];

    if (opts.includeAppendSystemPrompt && opts.mode.appendSystemPrompt) {
        parts.push(
            CODEX_HAPPY_SYSTEM_PROMPT_START,
            opts.mode.appendSystemPrompt,
            CODEX_HAPPY_SYSTEM_PROMPT_END,
        );
    }

    const modeStatus: string[] = [];
    if (opts.mode.model) modeStatus.push(`model=${opts.mode.model}`);
    if (opts.mode.effort) modeStatus.push(`reasoning_effort=${opts.mode.effort}`);
    if (opts.mode.fast) modeStatus.push('service_tier=fast');
    if (modeStatus.length > 0) {
        parts.push(
            CODEX_HAPPY_SYSTEM_PROMPT_START,
            `Happy has already applied these Codex runtime settings for this turn: ${modeStatus.join(', ')}. ` +
            `If the user asks to switch to one of these settings, acknowledge that it is already active; do not look for a tool or API to change it.`,
            CODEX_HAPPY_SYSTEM_PROMPT_END,
        );
    }

    parts.push(opts.message);

    if (opts.includeTitleInstruction) {
        parts.push(
            CODEX_HAPPY_SYSTEM_PROMPT_START,
            CHANGE_TITLE_INSTRUCTION,
            CODEX_HAPPY_SYSTEM_PROMPT_END,
        );
    }

    return parts.join('\n\n');
}
