import { describe, expect, it } from 'vitest';
import { computeAgentInputDefaultMaxHeight, computeNewSessionInputMaxHeight } from './inputMaxHeight';

describe('inputMaxHeight', () => {
    it('reduces default max height when keyboard is open (native)', () => {
        const closed = computeAgentInputDefaultMaxHeight({ platform: 'ios', screenHeight: 800, keyboardHeight: 0 });
        const open = computeAgentInputDefaultMaxHeight({ platform: 'ios', screenHeight: 800, keyboardHeight: 300 });
        expect(open).toBeLessThan(closed);
    });

    it('reduces default max height when keyboard is open (web)', () => {
        const closed = computeAgentInputDefaultMaxHeight({ platform: 'web', screenHeight: 900, keyboardHeight: 0 });
        const open = computeAgentInputDefaultMaxHeight({ platform: 'web', screenHeight: 900, keyboardHeight: 400 });
        expect(open).toBeLessThan(closed);
    });

    it('allocates less space to the input when enhanced wizard is enabled', () => {
        const simple = computeNewSessionInputMaxHeight({ useEnhancedSessionWizard: false, screenHeight: 900, keyboardHeight: 0 });
        const wizard = computeNewSessionInputMaxHeight({ useEnhancedSessionWizard: true, screenHeight: 900, keyboardHeight: 0 });
        expect(wizard).toBeLessThan(simple);
    });

    it('caps /new input more aggressively when keyboard is open (simple)', () => {
        const closed = computeNewSessionInputMaxHeight({ useEnhancedSessionWizard: false, screenHeight: 900, keyboardHeight: 0 });
        const open = computeNewSessionInputMaxHeight({ useEnhancedSessionWizard: false, screenHeight: 900, keyboardHeight: 400 });
        expect(open).toBeLessThan(closed);
        expect(open).toBeLessThanOrEqual(360);
    });

    it('keeps /new wizard input cap when keyboard is open', () => {
        const open = computeNewSessionInputMaxHeight({ useEnhancedSessionWizard: true, screenHeight: 900, keyboardHeight: 400 });
        expect(open).toBeLessThanOrEqual(240);
    });
});
