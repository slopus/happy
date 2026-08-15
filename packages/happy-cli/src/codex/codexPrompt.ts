import type { PermissionMode } from '@/api/types';
import { CHANGE_TITLE_INSTRUCTION } from '@/gemini/constants';
import { hashObject } from '@/utils/deterministicJson';

import type { ReasoningEffort } from './codexAppServerTypes';

export const CODEX_HAPPY_SYSTEM_PROMPT_START = '<!-- happy:system-prompt:start -->';
export const CODEX_HAPPY_SYSTEM_PROMPT_END = '<!-- happy:system-prompt:end -->';

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

export function buildCodexTurnPrompt(opts: {
    message: string;
    mode: Pick<CodexEnhancedMode, 'appendSystemPrompt' | 'model' | 'effort'>;
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
