import { describe, expect, it } from 'vitest';
import { buildInteractivePaste, validateInteractiveBatch } from './inputInjection';

const mode = { permissionMode: 'default' as const, model: 'opus' };

describe('buildInteractivePaste', () => {
    it('sends single-line prompts as text plus carriage return', () => {
        expect(buildInteractivePaste('hello', 'pty')).toBe('hello\r');
    });

    it('wraps multiline PTY prompts in bracketed paste before enter', () => {
        expect(buildInteractivePaste('a\nb', 'pty')).toBe('\x1b[200~a\nb\x1b[201~\r');
    });

    it('normalizes CRLF before paste', () => {
        expect(buildInteractivePaste('a\r\nb', 'pty')).toBe('\x1b[200~a\nb\x1b[201~\r');
    });

    it('returns tmux paste text without bracket escape bytes', () => {
        expect(buildInteractivePaste('a\nb', 'tmux')).toBe('a\nb');
    });
});

describe('validateInteractiveBatch', () => {
    it('rejects attachments before terminal write', () => {
        expect(validateInteractiveBatch({
            batch: {
                message: 'describe this',
                mode,
                hash: 'h1',
                isolate: false,
                attachments: [{ data: new Uint8Array([1]), mimeType: 'image/png', name: 'x.png' }],
            },
            launchModeHash: 'h1',
        })).toEqual({
            ok: false,
            reason: 'attachments',
            message: 'Claude interactive remote does not support image or file attachments yet.',
        });
    });

    it('rejects mid-session mode changes', () => {
        expect(validateInteractiveBatch({
            batch: { message: 'hi', mode, hash: 'h2', isolate: false },
            launchModeHash: 'h1',
        })).toEqual({
            ok: false,
            reason: 'mode-change',
            message: 'Claude interactive remote cannot change model, effort, tools, prompts, or sandbox settings inside a running session.',
        });
    });

    it('rejects non-newline control characters', () => {
        expect(validateInteractiveBatch({
            batch: { message: 'bad\u0000input', mode, hash: 'h1', isolate: false },
            launchModeHash: 'h1',
        })).toMatchObject({ ok: false, reason: 'control-character' });
    });

    it('allows slash commands only when the entire message is the command', () => {
        expect(validateInteractiveBatch({
            batch: { message: '/clear', mode, hash: 'h1', isolate: true },
            launchModeHash: 'h1',
        })).toEqual({ ok: true });
    });
});
