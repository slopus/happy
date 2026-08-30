import { describe, expect, it } from 'vitest';

import { BROWSER_STEP_REPORTING_INSTRUCTION } from '@/browser/browserStepReportingPrompt';
import { CHANGE_TITLE_INSTRUCTION } from '@/gemini/constants';
import {
    buildCodexTurnPrompt,
    CODEX_HAPPY_SYSTEM_PROMPT_END,
    CODEX_HAPPY_SYSTEM_PROMPT_START,
    hashCodexEnhancedMode,
    markPawsTurnOrigin,
    readPawsTurnOrigin,
    stripPawsTurnOrigin,
    type CodexEnhancedMode,
} from './codexPrompt';

describe('buildCodexTurnPrompt', () => {
    it('prepends Happy append system prompt before the first Codex user message', () => {
        const prompt = buildCodexTurnPrompt({
            message: 'pick an option',
            mode: {
                appendSystemPrompt: '<options><option>Yes</option></options>',
            },
            includeAppendSystemPrompt: true,
            includeBrowserStepInstruction: false,
            includeTitleInstruction: true,
        });

        expect(prompt).toBe(
            `${CODEX_HAPPY_SYSTEM_PROMPT_START}\n\n` +
            '<options><option>Yes</option></options>\n\n' +
            `${CODEX_HAPPY_SYSTEM_PROMPT_END}\n\n` +
            'pick an option\n\n' +
            `${CODEX_HAPPY_SYSTEM_PROMPT_START}\n\n` +
            `${CHANGE_TITLE_INSTRUCTION}\n\n` +
            CODEX_HAPPY_SYSTEM_PROMPT_END,
        );
    });

    it('preserves the existing first-turn title instruction when no append prompt is set', () => {
        const prompt = buildCodexTurnPrompt({
            message: 'hello',
            mode: {},
            includeAppendSystemPrompt: true,
            includeBrowserStepInstruction: false,
            includeTitleInstruction: true,
        });

        expect(prompt).toBe(
            `hello\n\n${CODEX_HAPPY_SYSTEM_PROMPT_START}\n\n` +
            `${CHANGE_TITLE_INSTRUCTION}\n\n${CODEX_HAPPY_SYSTEM_PROMPT_END}`,
        );
    });

    it('does not inject Happy preamble on normal follow-up turns', () => {
        const prompt = buildCodexTurnPrompt({
            message: 'continue',
            mode: {
                appendSystemPrompt: '<options><option>Yes</option></options>',
            },
            includeAppendSystemPrompt: false,
            includeBrowserStepInstruction: false,
            includeTitleInstruction: false,
        });

        expect(prompt).toBe('continue');
    });

    it('injects the Ego browser reporting contract without repeating the title instruction on a resumed thread', () => {
        const prompt = buildCodexTurnPrompt({
            message: 'continue the existing task',
            mode: {},
            includeAppendSystemPrompt: false,
            includeBrowserStepInstruction: true,
            includeTitleInstruction: false,
        });

        expect(prompt).toBe(
            `${CODEX_HAPPY_SYSTEM_PROMPT_START}\n\n` +
            `${BROWSER_STEP_REPORTING_INSTRUCTION}\n\n` +
            `${CODEX_HAPPY_SYSTEM_PROMPT_END}\n\n` +
            'continue the existing task',
        );
        expect(prompt).not.toContain(CHANGE_TITLE_INSTRUCTION);
    });

    it('can re-inject Happy append prompt without title instruction after a thread reset', () => {
        const prompt = buildCodexTurnPrompt({
            message: 'start fresh',
            mode: {
                appendSystemPrompt: '<options><option>Yes</option></options>',
            },
            includeAppendSystemPrompt: true,
            includeBrowserStepInstruction: false,
            includeTitleInstruction: false,
        });

        expect(prompt).toBe(
            `${CODEX_HAPPY_SYSTEM_PROMPT_START}\n\n` +
            '<options><option>Yes</option></options>\n\n' +
            `${CODEX_HAPPY_SYSTEM_PROMPT_END}\n\n` +
            'start fresh',
        );
    });

    it('tells Codex when Happy has already applied model and effort settings', () => {
        const prompt = buildCodexTurnPrompt({
            message: '切换 xhigh 模式',
            mode: {
                model: 'gpt-5.4',
                effort: 'xhigh',
            },
            includeAppendSystemPrompt: false,
            includeBrowserStepInstruction: false,
            includeTitleInstruction: false,
        });

        expect(prompt).toBe(
            `${CODEX_HAPPY_SYSTEM_PROMPT_START}\n\n` +
            'Happy has already applied these Codex runtime settings for this turn: model=gpt-5.4, reasoning_effort=xhigh. ' +
            'If the user asks to switch to one of these settings, acknowledge that it is already active; do not look for a tool or API to change it.\n\n' +
            `${CODEX_HAPPY_SYSTEM_PROMPT_END}\n\n` +
            '切换 xhigh 模式',
        );
    });
});

describe('Paws turn origin marker', () => {
    it('round-trips a session id while keeping the visible prompt recoverable', () => {
        const marked = markPawsTurnOrigin('continue the task', 'session/with spaces');

        expect(readPawsTurnOrigin(marked)).toBe('session/with spaces');
        expect(stripPawsTurnOrigin(marked).trim()).toBe('continue the task');
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
