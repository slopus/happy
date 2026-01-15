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
});
