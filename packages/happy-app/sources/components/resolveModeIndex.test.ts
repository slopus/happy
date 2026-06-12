import { describe, it, expect } from 'vitest';
import { resolveModeIndex, type ModeOption } from './modelModeOptions';

const modes: ModeOption[] = [
    { key: 'default', name: 'default model' },
    { key: 'opus', name: 'opus 4.8' },
    { key: 'sonnet', name: 'sonnet 4.6' },
    { key: 'haiku', name: 'haiku 4.5' },
];

describe('resolveModeIndex', () => {
    it('restores the saved draft pick when it is still available', () => {
        // User explicitly picked sonnet last time; agent default is opus.
        expect(resolveModeIndex(modes, 'sonnet', 'opus')).toBe(2);
    });

    it('restores an explicit "default model" pick (not the same as unset)', () => {
        // Picking the literal default-model entry must survive, even though
        // the agent default is opus.
        expect(resolveModeIndex(modes, 'default', 'opus')).toBe(0);
    });

    it('falls back to the agent default when there is no saved pick', () => {
        // null draftKey means "never picked" → use agent default (opus).
        expect(resolveModeIndex(modes, null, 'opus')).toBe(1);
        expect(resolveModeIndex(modes, undefined, 'opus')).toBe(1);
    });

    it('falls back to the agent default when the saved pick is not available for this agent', () => {
        // Draft holds a model from a different agent that this agent lacks.
        expect(resolveModeIndex(modes, 'gpt-5.5', 'opus')).toBe(1);
    });

    it('falls back to index 0 when neither pick nor default is available', () => {
        expect(resolveModeIndex(modes, 'nope', 'also-nope')).toBe(0);
        expect(resolveModeIndex(modes, null, null)).toBe(0);
    });
});
