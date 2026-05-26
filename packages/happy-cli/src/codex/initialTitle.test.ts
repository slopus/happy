import { describe, expect, it, vi } from 'vitest';

import { CHANGE_TITLE_INSTRUCTION } from '@/gemini/constants';

import { applyInitialCodexSessionTitle, buildInitialCodexTurnPrompt } from './initialTitle';

describe('applyInitialCodexSessionTitle', () => {
    it('writes a summary message when an initial title is provided', () => {
        const sendClaudeSessionMessage = vi.fn();

        const applied = applyInitialCodexSessionTitle(
            { sendClaudeSessionMessage },
            '  happy codex name support  ',
        );

        expect(applied).toBe('happy codex name support');
        expect(sendClaudeSessionMessage).toHaveBeenCalledTimes(1);
        expect(sendClaudeSessionMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'summary',
                summary: 'happy codex name support',
            }),
        );
    });

    it('skips blank initial titles', () => {
        const sendClaudeSessionMessage = vi.fn();

        const applied = applyInitialCodexSessionTitle(
            { sendClaudeSessionMessage },
            '   ',
        );

        expect(applied).toBeNull();
        expect(sendClaudeSessionMessage).not.toHaveBeenCalled();
    });
});

describe('buildInitialCodexTurnPrompt', () => {
    it('uses the default change-title instruction when no initial title is set', () => {
        expect(buildInitialCodexTurnPrompt('fix the failing test')).toBe(
            `fix the failing test\n\n${CHANGE_TITLE_INSTRUCTION}`,
        );
    });

    it('pins the first title exactly when an initial title is provided', () => {
        const prompt = buildInitialCodexTurnPrompt(
            'review the codex flow',
            'Codex PR Review',
        );

        expect(prompt).toContain('review the codex flow');
        expect(prompt).toContain(
            'set the chat session title exactly to "Codex PR Review"',
        );
        expect(prompt).toContain('Unless the task changes dramatically later, keep using this title.');
    });
});
