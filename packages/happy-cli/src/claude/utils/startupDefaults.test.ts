import { describe, expect, it } from 'vitest';

import { defaultClaudeEffort, defaultClaudeModel, defaultClaudePermissionMode } from './startupDefaults';

describe('defaultClaudeEffort', () => {
    it('returns medium when HAPPY_CLAUDE_EFFORT is not set', () => {
        expect(defaultClaudeEffort({})).toBe('medium');
    });

    it.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)('honors HAPPY_CLAUDE_EFFORT=%s', (effort) => {
        expect(defaultClaudeEffort({ HAPPY_CLAUDE_EFFORT: effort })).toBe(effort);
    });

    it('trims surrounding whitespace', () => {
        expect(defaultClaudeEffort({ HAPPY_CLAUDE_EFFORT: ' xhigh ' })).toBe('xhigh');
    });

    it('falls back to medium on invalid values', () => {
        expect(defaultClaudeEffort({ HAPPY_CLAUDE_EFFORT: 'turbo' })).toBe('medium');
        expect(defaultClaudeEffort({ HAPPY_CLAUDE_EFFORT: 'XHIGH' })).toBe('medium');
        expect(defaultClaudeEffort({ HAPPY_CLAUDE_EFFORT: '' })).toBe('medium');
    });
});

describe('defaultClaudePermissionMode', () => {
    it('returns yolo when HAPPY_CLAUDE_PERMISSION_MODE is not set', () => {
        expect(defaultClaudePermissionMode({})).toBe('yolo');
    });

    it('honors a valid mode', () => {
        expect(defaultClaudePermissionMode({ HAPPY_CLAUDE_PERMISSION_MODE: 'plan' })).toBe('plan');
        expect(defaultClaudePermissionMode({ HAPPY_CLAUDE_PERMISSION_MODE: 'safe-yolo' })).toBe('safe-yolo');
    });

    it('falls back to yolo on invalid values', () => {
        expect(defaultClaudePermissionMode({ HAPPY_CLAUDE_PERMISSION_MODE: 'YOLO' })).toBe('yolo');
        expect(defaultClaudePermissionMode({ HAPPY_CLAUDE_PERMISSION_MODE: 'nonsense' })).toBe('yolo');
    });
});

describe('defaultClaudeModel', () => {
    it('returns opus when HAPPY_CLAUDE_MODEL is not set', () => {
        expect(defaultClaudeModel({})).toBe('opus');
    });

    it('passes through any non-empty model name', () => {
        expect(defaultClaudeModel({ HAPPY_CLAUDE_MODEL: 'claude-fable-5' })).toBe('claude-fable-5');
        expect(defaultClaudeModel({ HAPPY_CLAUDE_MODEL: ' sonnet ' })).toBe('sonnet');
    });

    it('falls back to opus on empty or whitespace-only values', () => {
        expect(defaultClaudeModel({ HAPPY_CLAUDE_MODEL: '' })).toBe('opus');
        expect(defaultClaudeModel({ HAPPY_CLAUDE_MODEL: '   ' })).toBe('opus');
    });
});
