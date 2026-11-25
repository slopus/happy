import { describe, expect, it } from 'vitest';
import library from './frameworks.json';
import { METHOD_IDS, THINKING_METHODS } from './catalog';
import { buildThinkingPrompt, buildFollowUpPrompt } from './prompts';
import { parseComposerDraft, serializeComposerDraft } from '@/sync/composerReferences';
import { thinkingDisplayText } from './submission';

describe('thinking method delivery', () => {
    it('keeps image-only hidden prompts out of the visible user bubble and preserves file/annotation labels', () => {
        expect(thinkingDisplayText('', '', undefined, 'Attachments')).toBe('Attachments');
        expect(thinkingDisplayText('', '', '/workspace/example.md', 'Attachments')).toBe('@ example.md');
        expect(thinkingDisplayText('draft', 'selected quote', '/workspace/example.md', 'Attachments')).toBe('selected quote');
        expect(thinkingDisplayText('draft', '', undefined, 'Attachments')).toBe('draft');
    });
    it('retains the 12 numbered bilingual originals separately from Teach Me', () => {
        expect(library.frameworks.map(item => item.number)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
        expect(THINKING_METHODS).toHaveLength(13);
        expect(new Set(METHOD_IDS).size).toBe(13);
        for (const original of library.frameworks) {
            const method = THINKING_METHODS.find(item => item.id === original.id)!;
            expect(method.originalPrompt).toBe(original.originalPrompt);
            expect(method.originalPromptEn).toBe(original.originalPromptEn);
            expect(buildThinkingPrompt('MY MATERIAL', method.id, true)).toContain(original.originalPrompt);
            expect(buildThinkingPrompt('MY MATERIAL', method.id, false)).toContain(original.originalPromptEn);
        }
    });
    it('preserves CLI commands and reference resolution rather than hiding metadata in a template', () => {
        expect(buildThinkingPrompt(' /compact', 'two-layer', false)).toBe(' /compact');
        const ref = { kind: 'session' as const, id: 'selected-session', title: 'Reference' };
        const prompt = buildThinkingPrompt(serializeComposerDraft('Explain this', [ref]), 'two-layer', true);
        expect(parseComposerDraft(prompt).references).toEqual([ref]);
        expect(parseComposerDraft(prompt).text).toContain('Explain this');
    });
    it('continues learning without restarting onboarding or requiring a quiz', () => {
        const prompt = buildThinkingPrompt('Continue from feedback loops', 'teach-me', false);
        expect(prompt).toContain('Continue the same learning topic across turns');
        expect(prompt).toContain('Do not impose quizzes');
        expect(prompt).toContain('Continue from feedback loops');
    });
    it('binds all one-turn actions to the full clicked old reply, never the newest reply', () => {
        const reply = { id: 'old-stable-id', text: 'Unique old answer\n\n' + 'long material '.repeat(1500) };
        for (const action of ['draw', 'example', 'continue', 'why', 'action'] as const) {
            const prompt = buildFollowUpPrompt(action, reply);
            const reference = JSON.parse(prompt.split('Referenced assistant reply (JSON):\n')[1]);
            expect(reference).toEqual({ messageId: reply.id, text: reply.text });
            expect(prompt).toContain('do not change the conversation');
        }
        expect(buildFollowUpPrompt('draw', reply)).toContain('Mermaid');
    });
});
