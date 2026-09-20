import { describe, expect, it } from 'vitest';

import { BOT_NAME_MAX_LENGTH, describeBotNameProblem, isValidBotName, sanitizeBotName } from './botName';

describe('bot names', () => {
    it('accepts what the daemon accepts and refuses what it refuses', () => {
        expect(isValidBotName('Release Captain')).toBe(true);
        expect(isValidBotName('  Release Captain  ')).toBe(true);
        expect(isValidBotName('a'.repeat(BOT_NAME_MAX_LENGTH))).toBe(true);
        expect(isValidBotName('')).toBe(false);
        expect(isValidBotName('   ')).toBe(false);
        expect(isValidBotName('a'.repeat(BOT_NAME_MAX_LENGTH + 1))).toBe(false);
        expect(isValidBotName('line\nbreak')).toBe(false);
        expect(isValidBotName('tab\tbed')).toBe(false);
        expect(isValidBotName('del\x7f')).toBe(false);
    });

    it('turns a pasted line break into a space and keeps the daemon ceiling', () => {
        expect(sanitizeBotName('Release\nCaptain')).toBe('Release Captain');
        expect(sanitizeBotName('a'.repeat(BOT_NAME_MAX_LENGTH + 10))).toHaveLength(BOT_NAME_MAX_LENGTH);
        expect(isValidBotName(sanitizeBotName('Release\r\nCaptain\t'))).toBe(true);
    });

    it('says why a name is refused', () => {
        expect(describeBotNameProblem('Release Captain')).toBeNull();
        expect(describeBotNameProblem('  ')).toBe('Give the bot a name');
        expect(describeBotNameProblem('a'.repeat(BOT_NAME_MAX_LENGTH + 1))).toContain('at most');
        expect(describeBotNameProblem('a\nb')).toContain('line breaks');
    });
});
