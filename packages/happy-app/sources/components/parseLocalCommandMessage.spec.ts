import { describe, it, expect } from 'vitest';
import { parseLocalCommandMessage, isUserSlashCommandEcho } from './parseLocalCommandMessage';

describe('parseLocalCommandMessage', () => {
    it('hides the local-command caveat wrapper', () => {
        const text = '<local-command-caveat>The user typed a slash command.</local-command-caveat>';
        expect(parseLocalCommandMessage(text)).toEqual({ kind: 'caveat' });
    });

    it('collapses a no-arg command to a chip', () => {
        const text = '<command-message>compact</command-message><command-name>/compact</command-name>';
        expect(parseLocalCommandMessage(text)).toEqual({
            kind: 'command-run',
            commandName: 'compact',
            args: undefined,
        });
    });

    it('collapses a command WITH args to a chip and surfaces the args', () => {
        const text =
            '<command-message>brainstorming is running</command-message>' +
            '<command-name>/superpowers:brainstorming</command-name>' +
            '<command-args>think of a feature so I can charge money</command-args>';
        expect(parseLocalCommandMessage(text)).toEqual({
            kind: 'command-run',
            commandName: 'superpowers:brainstorming',
            args: 'think of a feature so I can charge money',
        });
    });

    it('trims surrounding whitespace inside command-args', () => {
        const text =
            '<command-message>x</command-message><command-name>/x</command-name>' +
            '<command-args>   spaced arg   </command-args>';
        const parsed = parseLocalCommandMessage(text);
        expect(parsed).toEqual({ kind: 'command-run', commandName: 'x', args: 'spaced arg' });
    });

    it('treats an empty command-args as no args', () => {
        const text =
            '<command-message>x</command-message><command-name>/x</command-name><command-args></command-args>';
        expect(parseLocalCommandMessage(text)).toEqual({
            kind: 'command-run',
            commandName: 'x',
            args: undefined,
        });
    });

    it('keeps real text but drops the wrapper tags for mixed content', () => {
        const text =
            'Please run this:\n<command-message>x</command-message><command-name>/x</command-name><command-args>a</command-args>';
        expect(parseLocalCommandMessage(text)).toEqual({
            kind: 'text',
            text: 'Please run this:',
        });
    });

    it('passes ordinary user text through untouched', () => {
        const text = 'just a normal message';
        expect(parseLocalCommandMessage(text)).toEqual({ kind: 'text', text });
    });

    it('collapses a command whose skill body contains nested command-message examples', () => {
        // Reproduces #1340: a /go skill whose markdown body references other
        // commands ends up with nested <command-message>/<command-name> tags
        // inside the outer SDK wrapper. The old lazy regex stopped at the
        // inner closer and rendered the whole skill body as plain text.
        const text =
            '<command-message>\n' +
            'You are the /go skill. Available examples:\n' +
            '<command-message>compact</command-message><command-name>/compact</command-name>\n' +
            'more skill body content here\n' +
            '</command-message>' +
            '<command-name>/go</command-name>' +
            '<command-args>deploy</command-args>';
        expect(parseLocalCommandMessage(text)).toEqual({
            kind: 'command-run',
            commandName: 'go',
            args: 'deploy',
        });
    });
});

describe('isUserSlashCommandEcho', () => {
    it('detects a bare command echo with a localId', () => {
        expect(isUserSlashCommandEcho('/compact', true)).toBe(true);
    });

    it('detects a command-with-args echo with a localId', () => {
        expect(isUserSlashCommandEcho('/superpowers:brainstorming make me rich', true)).toBe(true);
    });

    it('ignores echoes without a localId (SDK-originated, not user-sent)', () => {
        expect(isUserSlashCommandEcho('/compact', false)).toBe(false);
    });

    it('does not treat the SDK wrapper itself as a raw echo', () => {
        const wrapper =
            '<command-message>x</command-message><command-name>/x</command-name><command-args>a</command-args>';
        expect(isUserSlashCommandEcho(wrapper, true)).toBe(false);
    });

    it('does not match unix-style paths', () => {
        expect(isUserSlashCommandEcho('/etc/hosts is the file', true)).toBe(false);
        expect(isUserSlashCommandEcho('/usr/local/bin', true)).toBe(false);
    });

    it('does not match a lone slash or ordinary text', () => {
        expect(isUserSlashCommandEcho('/', true)).toBe(false);
        expect(isUserSlashCommandEcho('please run /compact later', true)).toBe(false);
    });

    it('tolerates surrounding whitespace', () => {
        expect(isUserSlashCommandEcho('  /clear  ', true)).toBe(true);
    });
});
