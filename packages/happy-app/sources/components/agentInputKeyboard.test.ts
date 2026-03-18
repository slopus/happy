import { describe, expect, it } from 'vitest';
import { shouldSendOnEnter } from './agentInputKeyboard';

describe('shouldSendOnEnter', () => {
    it('returns true when enter-to-send is enabled and text is non-empty', () => {
        expect(shouldSendOnEnter({
            key: 'Enter',
            shiftKey: false,
            enterToSendEnabled: true,
            textSnapshot: 'hello',
            isSending: false,
            isSendDisabled: false,
        })).toBe(true);
    });

    it('returns false while a send is already in progress', () => {
        expect(shouldSendOnEnter({
            key: 'Enter',
            shiftKey: false,
            enterToSendEnabled: true,
            textSnapshot: 'hello',
            isSending: true,
            isSendDisabled: false,
        })).toBe(false);
    });

    it('returns false when send is disabled', () => {
        expect(shouldSendOnEnter({
            key: 'Enter',
            shiftKey: false,
            enterToSendEnabled: true,
            textSnapshot: 'hello',
            isSending: false,
            isSendDisabled: true,
        })).toBe(false);
    });
});
