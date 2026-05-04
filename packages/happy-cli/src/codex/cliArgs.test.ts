import { describe, expect, it } from 'vitest';

import { parseCodexStartupArgs } from './cliArgs';

describe('parseCodexStartupArgs', () => {
    it('returns null and preserves args when resume flag is absent', () => {
        const parsed = parseCodexStartupArgs(['--started-by', 'terminal']);

        expect(parsed.resumeThreadId).toBeNull();
        expect(parsed.args).toEqual(['--started-by', 'terminal']);
    });

    it('extracts an explicit resume thread ID', () => {
        const parsed = parseCodexStartupArgs(['--resume', 'thread-123', '--started-by', 'daemon']);

        expect(parsed.resumeThreadId).toBe('thread-123');
        expect(parsed.args).toEqual(['--started-by', 'daemon']);
    });

    it('supports equals syntax', () => {
        const parsed = parseCodexStartupArgs(['--resume=thread-456', '--started-by', 'terminal']);

        expect(parsed.resumeThreadId).toBe('thread-456');
        expect(parsed.args).toEqual(['--started-by', 'terminal']);
    });

    it('throws when resume flag is missing a thread ID', () => {
        expect(() => parseCodexStartupArgs(['--resume'])).toThrow(
            'Codex resume requires a thread ID: happy codex --resume <thread-id>',
        );
    });

    it('parses model flag with separate and equals syntax', () => {
        expect(parseCodexStartupArgs(['--model', 'gpt-5.5']).model).toBe('gpt-5.5');
        expect(parseCodexStartupArgs(['--model=gpt-5.4']).model).toBe('gpt-5.4');
    });

    it('parses effort flag with separate and equals syntax', () => {
        expect(parseCodexStartupArgs(['--effort', 'medium']).effort).toBe('medium');
        expect(parseCodexStartupArgs(['--effort=xhigh']).effort).toBe('xhigh');
    });

    it('parses permission mode flag with separate and equals syntax', () => {
        expect(parseCodexStartupArgs(['--permission-mode', 'read-only']).permissionMode).toBe('read-only');
        expect(parseCodexStartupArgs(['--permission-mode=safe-yolo']).permissionMode).toBe('safe-yolo');
    });

    it('parses yolo sugar as yolo permission mode', () => {
        expect(parseCodexStartupArgs(['--yolo']).permissionMode).toBe('yolo');
    });

    it('parses resume combined with model, effort, and permission flags', () => {
        const parsed = parseCodexStartupArgs([
            '--resume',
            'thread-789',
            '--model=gpt-5.5',
            '--effort',
            'high',
            '--permission-mode',
            'safe-yolo',
            '--started-by',
            'daemon',
        ]);

        expect(parsed).toEqual({
            resumeThreadId: 'thread-789',
            model: 'gpt-5.5',
            effort: 'high',
            permissionMode: 'safe-yolo',
            args: ['--started-by', 'daemon'],
        });
    });

    it('throws for invalid effort', () => {
        expect(() => parseCodexStartupArgs(['--effort', 'huge'])).toThrow(
            'Invalid Codex effort "huge". Expected one of: none, minimal, low, medium, high, xhigh.',
        );
    });

    it('throws when startup flags using equals syntax have empty values', () => {
        expect(() => parseCodexStartupArgs(['--model='])).toThrow(
            'Codex model requires a value: happy codex --model <model>',
        );
        expect(() => parseCodexStartupArgs(['--effort='])).toThrow(
            'Codex effort requires a value: happy codex --effort <level>',
        );
        expect(() => parseCodexStartupArgs(['--permission-mode='])).toThrow(
            'Codex permission mode requires a value: happy codex --permission-mode <mode>',
        );
    });

    it('throws for invalid permission mode', () => {
        expect(() => parseCodexStartupArgs(['--permission-mode', 'bypassPermissions'])).toThrow(
            'Invalid Codex permission mode "bypassPermissions". Expected one of: default, read-only, safe-yolo, yolo.',
        );
    });

    it('throws for conflicting permission flags', () => {
        expect(() => parseCodexStartupArgs(['--permission-mode', 'read-only', '--yolo'])).toThrow(
            'Codex permission mode can only be provided once.',
        );
    });

    it('throws for conflicting permission flags using equals syntax', () => {
        expect(() => parseCodexStartupArgs(['--yolo', '--permission-mode=read-only'])).toThrow(
            'Codex permission mode can only be provided once.',
        );
        expect(() => parseCodexStartupArgs(['--permission-mode=yolo', '--permission-mode=read-only'])).toThrow(
            'Codex permission mode can only be provided once.',
        );
    });
});
