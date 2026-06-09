import { describe, expect, it } from 'vitest';
import { resolveCodexTurnErrorDisposition } from './codexTurnErrorPolicy';

describe('resolveCodexTurnErrorDisposition', () => {
    it('treats errors after a user abort as aborts while the session stays alive', () => {
        expect(resolveCodexTurnErrorDisposition({
            abortRequested: true,
            shouldExit: false,
        })).toBe('user-abort');
    });

    it('keeps normal turn errors classified as unexpected exits', () => {
        expect(resolveCodexTurnErrorDisposition({
            abortRequested: false,
            shouldExit: false,
        })).toBe('unexpected-exit');
    });

    it('does not suppress errors while exiting the whole session', () => {
        expect(resolveCodexTurnErrorDisposition({
            abortRequested: true,
            shouldExit: true,
        })).toBe('unexpected-exit');
    });
});
