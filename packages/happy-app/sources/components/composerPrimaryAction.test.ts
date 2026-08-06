import { describe, expect, it } from 'vitest';
import { resolveComposerPrimaryAction } from './composerPrimaryAction';

describe('resolveComposerPrimaryAction', () => {
    it('shows abort for an empty running session composer', () => {
        expect(resolveComposerPrimaryAction({
            mode: 'session',
            showAbortButton: true,
            hasAbortHandler: true,
            hasPayload: false,
        })).toBe('abort');
    });

    it('switches a running session back to send when text or attachments are present', () => {
        expect(resolveComposerPrimaryAction({
            mode: 'session',
            showAbortButton: true,
            hasAbortHandler: true,
            hasPayload: true,
        })).toBe('send');
    });

    it('uses send outside an abortable running session', () => {
        expect(resolveComposerPrimaryAction({
            mode: 'session',
            showAbortButton: false,
            hasAbortHandler: true,
            hasPayload: false,
        })).toBe('send');

        expect(resolveComposerPrimaryAction({
            mode: 'home',
            showAbortButton: true,
            hasAbortHandler: true,
            hasPayload: false,
        })).toBe('send');
    });
});
