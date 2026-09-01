import { describe, expect, it } from 'vitest';
import { shouldPresentNotification } from './notificationPresentation';

describe('shouldPresentNotification', () => {
    it('shows a completed share notification while the app is active', () => {
        expect(shouldPresentNotification('share-ready', 'active')).toBe(true);
    });

    it('keeps ordinary notifications quiet while the app is active', () => {
        expect(shouldPresentNotification('ordinary', 'active')).toBe(false);
    });

    it('shows notifications when the app is in the background', () => {
        expect(shouldPresentNotification('ordinary', 'background')).toBe(true);
    });
});
