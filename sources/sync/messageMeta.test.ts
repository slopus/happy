import { describe, it, expect } from 'vitest';
import { buildOutgoingMessageMeta } from './messageMeta';

describe('buildOutgoingMessageMeta', () => {
    it('does not include model fields by default', () => {
        const meta = buildOutgoingMessageMeta({
            sentFrom: 'web',
            permissionMode: 'default',
            appendSystemPrompt: 'PROMPT',
        });

        expect(meta.sentFrom).toBe('web');
        expect(meta.permissionMode).toBe('default');
        expect(meta.appendSystemPrompt).toBe('PROMPT');
        expect('model' in meta).toBe(false);
        expect('fallbackModel' in meta).toBe(false);
    });

    it('includes model when explicitly provided', () => {
        const meta = buildOutgoingMessageMeta({
            sentFrom: 'web',
            permissionMode: 'default',
            model: 'gemini-2.5-pro',
            appendSystemPrompt: 'PROMPT',
        });

        expect(meta.model).toBe('gemini-2.5-pro');
        expect('model' in meta).toBe(true);
    });

    it('includes displayText when explicitly provided (including empty string)', () => {
        const meta = buildOutgoingMessageMeta({
            sentFrom: 'web',
            permissionMode: 'default',
            appendSystemPrompt: 'PROMPT',
            displayText: '',
        });

        expect('displayText' in meta).toBe(true);
        expect(meta.displayText).toBe('');
    });

    it('includes fallbackModel when explicitly provided', () => {
        const meta = buildOutgoingMessageMeta({
            sentFrom: 'web',
            permissionMode: 'default',
            appendSystemPrompt: 'PROMPT',
            fallbackModel: 'gemini-2.5-flash',
        });

        expect('fallbackModel' in meta).toBe(true);
        expect(meta.fallbackModel).toBe('gemini-2.5-flash');
    });
});
