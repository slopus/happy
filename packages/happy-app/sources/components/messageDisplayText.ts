const HAPPY_SYSTEM_PROMPT_START = '<!-- happy:system-prompt:start -->';
const HAPPY_SYSTEM_PROMPT_END = '<!-- happy:system-prompt:end -->';

const happySystemPromptBlockPattern = new RegExp(
    `${escapeRegExp(HAPPY_SYSTEM_PROMPT_START)}[\\s\\S]*?${escapeRegExp(HAPPY_SYSTEM_PROMPT_END)}`,
    'g',
);

const legacyCodexRuntimeStatusPattern = new RegExp(
    '^Happy has already applied these Codex runtime settings for this turn: ' +
    '(?:(?:model|reasoning_effort)=[^\\n]+)\\. ' +
    'If the user asks to switch to one of these settings, acknowledge that it is already active; ' +
    'do not look for a tool or API to change it\\.(?:(?:\\r?\\n){2}|$)',
);

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Removes Happy-owned prompt context from user-facing message actions without
 * mutating the persisted message or the prompt sent to the agent.
 */
export function getUserMessageDisplayText(text: string): string {
    let changed = false;
    let displayText = text.replace(happySystemPromptBlockPattern, () => {
        changed = true;
        return '';
    });

    displayText = displayText.replace(legacyCodexRuntimeStatusPattern, () => {
        changed = true;
        return '';
    });

    return changed ? displayText.trim() : text;
}
