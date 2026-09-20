/*
 * The daemon's rule for what a bot may be called, kept here so the composer
 * refuses a name before a request is spent on it: nonblank, at most 256
 * characters, and free of ASCII control characters. Mirrors `botNameSchema`
 * in Happy Agent's client protocol.
 */

export const BOT_NAME_MAX_LENGTH = 256;

const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;
const CONTROL_CHARACTERS_ALL = /[\x00-\x1f\x7f]/g;

/**
 * What the name field keeps of what was typed or pasted. A newline or tab in
 * a pasted name becomes a space, since the field is one line whatever the
 * clipboard held, and the daemon's ceiling is applied so the field cannot
 * hold a name the daemon would refuse.
 */
export function sanitizeBotName(input: string): string {
    return input.replace(CONTROL_CHARACTERS_ALL, ' ').slice(0, BOT_NAME_MAX_LENGTH);
}

/** True when the trimmed name is one the daemon accepts. */
export function isValidBotName(name: string): boolean {
    const trimmed = name.trim();
    return trimmed.length > 0
        && trimmed.length <= BOT_NAME_MAX_LENGTH
        && !CONTROL_CHARACTERS.test(trimmed);
}

/** Why a name is refused, for the person, or null when it is fine. */
export function describeBotNameProblem(name: string): string | null {
    const trimmed = name.trim();
    if (trimmed.length === 0) return 'Give the bot a name';
    if (trimmed.length > BOT_NAME_MAX_LENGTH) return `A bot's name is at most ${BOT_NAME_MAX_LENGTH} characters`;
    if (CONTROL_CHARACTERS.test(trimmed)) return "A bot's name cannot contain line breaks or control characters";
    return null;
}
