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

    it('collapses a /goal wrapper to a goal display', () => {
        const text =
            '<command-message>goal</command-message>' +
            '<command-name>/goal</command-name>' +
            '<command-args>проанализируй проект</command-args>';
        expect(parseLocalCommandMessage(text)).toEqual({
            kind: 'goal-run',
            goal: 'проанализируй проект',
        });
    });

    it('collapses a raw /goal command to a goal display', () => {
        expect(parseLocalCommandMessage('  /goal проанализируй проект  ')).toEqual({
            kind: 'goal-run',
            goal: 'проанализируй проект',
        });
    });

    it('collapses a raw skill slash command to a command display with args', () => {
        expect(parseLocalCommandMessage('  /superpowers:brainstorming привет давай спланируем что-нибудь  ')).toEqual({
            kind: 'command-run',
            commandName: 'superpowers:brainstorming',
            args: 'привет давай спланируем что-нибудь',
        });
    });

    it('collapses a trailing raw skill slash command to a command display with preceding args', () => {
        expect(parseLocalCommandMessage('  привет давай /maintain  ')).toEqual({
            kind: 'command-run',
            commandName: 'maintain',
            args: 'привет давай',
        });
    });

    it('collapses a middle raw skill slash command and preserves surrounding args', () => {
        expect(parseLocalCommandMessage('  привет /maintain давай  ')).toEqual({
            kind: 'command-run',
            commandName: 'maintain',
            args: 'привет давай',
        });
    });

    it('hides Claude local-command stdout for a successful /goal command', () => {
        const text = '<local-command-stdout>Goal set: проанализируй проект</local-command-stdout>';
        expect(parseLocalCommandMessage(text)).toEqual({
            kind: 'goal-confirmation',
            goal: 'проанализируй проект',
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
});

describe('isUserSlashCommandEcho', () => {
    it('detects a bare command echo with a localId', () => {
        expect(isUserSlashCommandEcho('/compact', true)).toBe(true);
    });

    it('detects a command-with-args echo with a localId', () => {
        expect(isUserSlashCommandEcho('/superpowers:brainstorming make me rich', true)).toBe(true);
    });

    it('detects a /goal echo with a localId', () => {
        expect(isUserSlashCommandEcho('/goal проанализируй проект', true)).toBe(true);
    });

    it('ignores echoes without a localId (SDK-originated, not user-sent)', () => {
        expect(isUserSlashCommandEcho('/compact', false)).toBe(false);
    });

    it('detects a trailing command echo with a localId', () => {
        expect(isUserSlashCommandEcho('привет давай /maintain', true)).toBe(true);
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
        expect(isUserSlashCommandEcho('please run / later', true)).toBe(false);
    });

    it('tolerates surrounding whitespace', () => {
        expect(isUserSlashCommandEcho('  /clear  ', true)).toBe(true);
    });
});
