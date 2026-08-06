import { describe, expect, it } from 'vitest';
import { MessageMetaSchema } from './typesMessageMeta';

describe('MessageMetaSchema', () => {
    it('accepts arbitrary permission mode keys', () => {
        const parsed = MessageMetaSchema.parse({
            permissionMode: 'team-custom-mode',
            permissionModeExplicit: true,
            model: 'custom-model',
        });

        expect(parsed.permissionMode).toBe('team-custom-mode');
        expect(parsed.permissionModeExplicit).toBe(true);
        expect(parsed.model).toBe('custom-model');
    });

    it('preserves the user message replaced by an edited resend', () => {
        const parsed = MessageMetaSchema.parse({ editedFromMessageId: 'message-1' });

        expect(parsed.editedFromMessageId).toBe('message-1');
    });
});
