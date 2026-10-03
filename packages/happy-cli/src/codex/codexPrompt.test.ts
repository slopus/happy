import { SAYCODE_API_GATEWAY_PROMPT } from '@/prompt/saycodeApiGatewayPrompt';
import { describe, expect, it } from 'vitest';

import { CHANGE_TITLE_INSTRUCTION } from '@/gemini/constants';
import {
    buildCodexDeveloperInstructions,
    buildCodexTurnPrompt,
    hashCodexEnhancedMode,
    isSupportedCodexReasoningEffort,
    resolveCodexSaycodePromptBlocks,
    type CodexEnhancedMode,
} from './codexPrompt';

describe('isSupportedCodexReasoningEffort', () => {
    it.each(['max', 'ultra'])('accepts the GPT-5.6 effort advertised by the spawn facade: %s', (effort) => {
        expect(isSupportedCodexReasoningEffort(effort)).toBe(true);
    });

    it('rejects an unknown effort instead of poisoning the next turn', () => {
        expect(isSupportedCodexReasoningEffort('maximum')).toBe(false);
    });
});

describe('resolveCodexSaycodePromptBlocks', () => {
    it('applies an explicit block override and preserves it on later absent turns', () => {
        const disabled = resolveCodexSaycodePromptBlocks(undefined, {
            saycodePromptBlocks: { agentOrchestration: false },
        });
        expect(disabled).toEqual({ agentOrchestration: false });
        expect(resolveCodexSaycodePromptBlocks(disabled, undefined)).toBe(disabled);
    });

    it('resets cached block overrides only for an explicit null', () => {
        expect(resolveCodexSaycodePromptBlocks(
            { agentOrchestration: false },
            { saycodePromptBlocks: null },
        )).toBeUndefined();
    });
});

describe('buildCodexDeveloperInstructions', () => {
    it('uses replaceable developer instructions for explicit-policy clients', () => {
        expect(buildCodexDeveloperInstructions({
            connectorGuidance: 'CONNECTOR FACTS',
            agentOrchestrationPrompt: 'AGENT ORCHESTRATION: happy agent spawn',
            mode: {
                appendSystemPrompt: 'USER AND PROJECT CONTEXT',
                saycodeSystemPromptEnabled: false,
            },
        })).toBe('CONNECTOR FACTS\n\nAGENT ORCHESTRATION: happy agent spawn\n\nUSER AND PROJECT CONTEXT');
    });

    it('keeps legacy client append prompts in the original user-turn position', () => {
        expect(buildCodexDeveloperInstructions({
            connectorGuidance: 'CONNECTOR FACTS',
            agentOrchestrationPrompt: 'AGENT ORCHESTRATION: happy agent spawn',
            mode: { appendSystemPrompt: 'LEGACY APPEND' },
        })).toBe('CONNECTOR FACTS\n\nAGENT ORCHESTRATION: happy agent spawn\n\n' + SAYCODE_API_GATEWAY_PROMPT);
    });

    it('keeps default-on orchestration when Saycode prompts are off', () => {
        expect(buildCodexDeveloperInstructions({
            connectorGuidance: 'CONNECTOR FACTS',
            agentOrchestrationPrompt: 'AGENT ORCHESTRATION: happy agent spawn',
            mode: { saycodeSystemPromptEnabled: false },
        })).toBe('CONNECTOR FACTS\n\nAGENT ORCHESTRATION: happy agent spawn');
    });

    it('does not inject orchestration when its block is explicitly off', () => {
        expect(buildCodexDeveloperInstructions({
            connectorGuidance: 'CONNECTOR FACTS',
            agentOrchestrationPrompt: 'AGENT ORCHESTRATION: happy agent spawn',
            mode: {
                saycodeSystemPromptEnabled: true,
                saycodePromptBlocks: { agentOrchestration: false },
            },
        })).toBe('CONNECTOR FACTS\n\n' + SAYCODE_API_GATEWAY_PROMPT);
    });
});

describe('buildCodexTurnPrompt', () => {
    it('includes independent host event memory and lessons before the original request', () => {
        expect(buildCodexTurnPrompt({
            message: 'original request', mode: { appendSystemPrompt: 'system context' },
            includeAppendSystemPrompt: true, hasTitle: true,
            lessonBlock: 'lesson references', memoryBlock: 'event memory references',
        })).toBe('system context\n\nlesson references\n\nevent memory references\n\noriginal request');
    });
    it('prepends Happy append system prompt before the first Codex user message', () => {
        const prompt = buildCodexTurnPrompt({
            message: 'pick an option',
            mode: {
                appendSystemPrompt: '<options><option>Yes</option></options>',
            },
            includeAppendSystemPrompt: true,
            hasTitle: false,
        });

        expect(prompt).toBe(
            '<options><option>Yes</option></options>\n\n' +
            'pick an option\n\n' +
            CHANGE_TITLE_INSTRUCTION,
        );
    });

    it('keeps the title instruction when Saycode prompts are disabled', () => {
        expect(buildCodexTurnPrompt({
            message: 'hello',
            mode: {
                appendSystemPrompt: 'USER AND PROJECT CONTEXT',
                saycodeSystemPromptEnabled: false,
            },
            includeAppendSystemPrompt: true,
            hasTitle: false,
        })).toBe(`USER AND PROJECT CONTEXT\n\nhello\n\n${CHANGE_TITLE_INSTRUCTION}`);
    });

    it('preserves the existing first-turn title instruction when no append prompt is set', () => {
        const prompt = buildCodexTurnPrompt({
            message: 'hello',
            mode: {},
            includeAppendSystemPrompt: true,
            hasTitle: false,
        });

        expect(prompt).toBe(`hello\n\n${CHANGE_TITLE_INSTRUCTION}`);
        expect(CHANGE_TITLE_INSTRUCTION).toContain('generate a concise chat session title');
        expect(CHANGE_TITLE_INSTRUCTION).toContain('once');
        expect(CHANGE_TITLE_INSTRUCTION).toContain('do not call this function again');
        expect(CHANGE_TITLE_INSTRUCTION).toContain('branchSlug');
    });

    it('does not inject Happy preamble on normal follow-up turns', () => {
        const prompt = buildCodexTurnPrompt({
            message: 'continue',
            mode: {
                appendSystemPrompt: '<options><option>Yes</option></options>',
            },
            includeAppendSystemPrompt: false,
            hasTitle: true,
        });

        expect(prompt).toBe('continue');
    });

    it('keeps nudging on follow-up turns while the chat is untitled', () => {
        const prompt = buildCodexTurnPrompt({
            message: 'continue',
            mode: {},
            includeAppendSystemPrompt: false,
            hasTitle: false,
        });

        expect(prompt).toBe(`continue\n\n${CHANGE_TITLE_INSTRUCTION}`);
    });

    it('can re-inject Happy append prompt without title instruction after a thread reset', () => {
        const prompt = buildCodexTurnPrompt({
            message: 'start fresh',
            mode: {
                appendSystemPrompt: '<options><option>Yes</option></options>',
            },
            includeAppendSystemPrompt: true,
            hasTitle: true,
        });

        expect(prompt).toBe(
            '<options><option>Yes</option></options>\n\n' +
            'start fresh',
        );
    });

    it('keeps external-service guidance out of user messages on first and follow-up turns', () => {
        const first = buildCodexTurnPrompt({
            message: 'check KNOI',
            mode: {},
            includeAppendSystemPrompt: false,
            hasTitle: true,
        });
        const followUp = buildCodexTurnPrompt({
            message: 'continue',
            mode: {},
            includeAppendSystemPrompt: false,
            hasTitle: true,
        });

        expect(first).toBe('check KNOI');
        expect(followUp).toBe('continue');
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

    it('separates queued messages when the Saycode prompt policy changes', () => {
        const baseMode: CodexEnhancedMode = { permissionMode: 'default' };

        expect(hashCodexEnhancedMode({
            ...baseMode,
            saycodeSystemPromptEnabled: true,
        })).not.toBe(hashCodexEnhancedMode({
            ...baseMode,
            saycodeSystemPromptEnabled: false,
        }));
    });
});


describe('Saycode API gateway developer guidance', () => {
    it.each([true, undefined])('keeps discovery in developer instructions (master=%s)', (enabled) => {
        const prompt = buildCodexDeveloperInstructions({ mode: { saycodeSystemPromptEnabled: enabled } });
        expect(prompt).toContain('{NAME}_SAYCODE_API_URL');
        expect(prompt).toContain('registered API contract');
        expect(buildCodexTurnPrompt({ message: 'continue', mode: {}, includeAppendSystemPrompt: false, hasTitle: true })).toBe('continue');
    });

    it('omits the guidance when master is off', () => {
        expect(buildCodexDeveloperInstructions({ mode: { saycodeSystemPromptEnabled: false } })).toBeUndefined();
    });
});


it('adds active checkpoint facts to Codex developer instructions without changing client context', () => {
    const active = buildCodexDeveloperInstructions({ checkpointGuidance: 'ACTIVE CHECKPOINT FACTS', mode: { saycodeSystemPromptEnabled: true, appendSystemPrompt: 'USER CONTEXT' } });
    expect(active).toContain('ACTIVE CHECKPOINT FACTS'); expect(active).toContain('USER CONTEXT');
    expect(buildCodexDeveloperInstructions({ checkpointGuidance: '', mode: {} })).not.toContain('CHECKPOINT');
});
