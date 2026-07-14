import { describe, expect, it } from 'vitest';

import { CHANGE_TITLE_INSTRUCTION } from '@/gemini/constants';
import {
    buildCodexTurnPrompt,
    hashCodexEnhancedMode,
    stripHappySystemBlocks,
    type CodexEnhancedMode,
} from './codexPrompt';

const APPEND = '<options><option>Yes</option></options>';
const wrapped = (text: string) => `<happy-system>\n${text}\n</happy-system>`;

describe('buildCodexTurnPrompt', () => {
    it('prepends Happy append system prompt (wrapped) before the first Codex user message', () => {
        const prompt = buildCodexTurnPrompt({
            message: 'pick an option',
            mode: { appendSystemPrompt: APPEND },
            includeAppendSystemPrompt: true,
            includeTitleInstruction: true,
        });

        expect(prompt).toBe(
            `${wrapped(APPEND)}\n\n` +
            'pick an option\n\n' +
            wrapped(CHANGE_TITLE_INSTRUCTION),
        );
    });

    it('preserves the existing first-turn title instruction (wrapped) when no append prompt is set', () => {
        const prompt = buildCodexTurnPrompt({
            message: 'hello',
            mode: {},
            includeAppendSystemPrompt: true,
            includeTitleInstruction: true,
        });

        expect(prompt).toBe(`hello\n\n${wrapped(CHANGE_TITLE_INSTRUCTION)}`);
    });

    it('does not inject Happy preamble on normal follow-up turns', () => {
        const prompt = buildCodexTurnPrompt({
            message: 'continue',
            mode: { appendSystemPrompt: APPEND },
            includeAppendSystemPrompt: false,
            includeTitleInstruction: false,
        });

        expect(prompt).toBe('continue');
    });

    it('can re-inject Happy append prompt without title instruction after a thread reset', () => {
        const prompt = buildCodexTurnPrompt({
            message: 'start fresh',
            mode: { appendSystemPrompt: APPEND },
            includeAppendSystemPrompt: true,
            includeTitleInstruction: false,
        });

        expect(prompt).toBe(`${wrapped(APPEND)}\n\nstart fresh`);
    });
});

describe('stripHappySystemBlocks', () => {
    it('recovers the user message from a fully-scaffolded first turn (fork backfill)', () => {
        const prompt = buildCodexTurnPrompt({
            message: 'приветик',
            mode: { appendSystemPrompt: APPEND },
            includeAppendSystemPrompt: true,
            includeTitleInstruction: true,
        });

        expect(stripHappySystemBlocks(prompt)).toBe('приветик');
    });

    it('recovers a multi-line user message wrapped only by the title instruction', () => {
        const prompt = buildCodexTurnPrompt({
            message: 'line one\n\nline two',
            mode: {},
            includeAppendSystemPrompt: false,
            includeTitleInstruction: true,
        });

        expect(stripHappySystemBlocks(prompt)).toBe('line one\n\nline two');
    });

    it('leaves plain text without markers untouched', () => {
        expect(stripHappySystemBlocks('just a normal message')).toBe('just a normal message');
    });
});

describe('hashCodexEnhancedMode', () => {
    it('separates queued Codex messages with different append system prompts', () => {
        const baseMode: CodexEnhancedMode = {
            permissionMode: 'default',
            model: 'gpt-5.5',
            effort: 'medium',
        };

        expect(hashCodexEnhancedMode({
            ...baseMode,
            appendSystemPrompt: 'options A',
        })).not.toBe(hashCodexEnhancedMode({
            ...baseMode,
            appendSystemPrompt: 'options B',
        }));
    });
});
