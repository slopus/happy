import { describe, expect, it } from 'vitest';
import {
    getAttachmentSupportForSession,
    getUnsupportedAttachmentTextKey,
    shouldSendTextAfterDroppingAttachments,
} from './attachmentSupport';

describe('getAttachmentSupportForSession', () => {
    it('allows normal Claude sessions to send attachments', () => {
        expect(getAttachmentSupportForSession({ metadata: { flavor: 'claude' } })).toEqual({
            supportsAttachments: true,
            unsupportedTextKey: 'imageUpload.notSupportedMessage',
        });
    });

    it('blocks attachments for interactive Claude remote sessions', () => {
        expect(getAttachmentSupportForSession({
            metadata: {
                flavor: 'claude',
                claudeRuntime: { kind: 'interactive', state: 'interactive', updatedAt: 1 },
            },
        })).toEqual({
            supportsAttachments: false,
            unsupportedTextKey: 'imageUpload.interactiveClaudeNotSupportedMessage',
        });
    });

    it('keeps non-Claude attachment behavior disabled', () => {
        expect(getAttachmentSupportForSession({ metadata: { flavor: 'codex' } })).toEqual({
            supportsAttachments: false,
            unsupportedTextKey: 'imageUpload.notSupportedMessage',
        });
    });

    it('does not send an empty text message after unsupported attachment-only sends', () => {
        expect(shouldSendTextAfterDroppingAttachments('')).toBe(false);
        expect(shouldSendTextAfterDroppingAttachments('   \n')).toBe(false);
        expect(shouldSendTextAfterDroppingAttachments('describe this')).toBe(true);
    });

    it('uses attachment-only copy when no text will be sent', () => {
        expect(getUnsupportedAttachmentTextKey({ metadata: { flavor: 'codex' } }, '')).toBe(
            'imageUpload.notSupportedAttachmentOnlyMessage',
        );
    });

    it('keeps text-sent copy when unsupported attachments are dropped from non-empty text', () => {
        expect(getUnsupportedAttachmentTextKey({ metadata: { flavor: 'codex' } }, 'describe this')).toBe(
            'imageUpload.notSupportedMessage',
        );
    });

    it('uses interactive Claude copy for attachment-only interactive remote sends', () => {
        expect(getUnsupportedAttachmentTextKey({
            metadata: {
                flavor: 'claude',
                claudeRuntime: { kind: 'interactive', state: 'interactive', updatedAt: 1 },
            },
        }, '')).toBe('imageUpload.interactiveClaudeNotSupportedMessage');
    });
});
