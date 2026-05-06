import { describe, expect, it } from 'vitest';

import { extractCodexNameFlag, extractCodexResumeFlag } from './cliArgs';

describe('extractCodexResumeFlag', () => {
    it('returns null and preserves args when resume flag is absent', () => {
        const parsed = extractCodexResumeFlag(['--started-by', 'terminal']);

        expect(parsed.resumeThreadId).toBeNull();
        expect(parsed.args).toEqual(['--started-by', 'terminal']);
    });

    it('extracts an explicit resume thread ID', () => {
        const parsed = extractCodexResumeFlag(['--resume', 'thread-123', '--started-by', 'daemon']);

        expect(parsed.resumeThreadId).toBe('thread-123');
        expect(parsed.args).toEqual(['--started-by', 'daemon']);
    });

    it('supports equals syntax', () => {
        const parsed = extractCodexResumeFlag(['--resume=thread-456', '--started-by', 'terminal']);

        expect(parsed.resumeThreadId).toBe('thread-456');
        expect(parsed.args).toEqual(['--started-by', 'terminal']);
    });

    it('throws when resume flag is missing a thread ID', () => {
        expect(() => extractCodexResumeFlag(['--resume'])).toThrow(
            'Codex resume requires a thread ID: happy codex --resume <thread-id>',
        );
    });
});

describe('extractCodexNameFlag', () => {
    it('returns null and preserves args when name flag is absent', () => {
        const parsed = extractCodexNameFlag(['--started-by', 'terminal']);

        expect(parsed.initialName).toBeNull();
        expect(parsed.args).toEqual(['--started-by', 'terminal']);
    });

    it('extracts an explicit initial session name', () => {
        const parsed = extractCodexNameFlag(['--name', 'ship happy codex pr', '--started-by', 'daemon']);

        expect(parsed.initialName).toBe('ship happy codex pr');
        expect(parsed.args).toEqual(['--started-by', 'daemon']);
    });

    it('supports equals syntax', () => {
        const parsed = extractCodexNameFlag(['--name=triage issue 1127', '--started-by', 'terminal']);

        expect(parsed.initialName).toBe('triage issue 1127');
        expect(parsed.args).toEqual(['--started-by', 'terminal']);
    });

    it('throws when name flag is missing a value', () => {
        expect(() => extractCodexNameFlag(['--name'])).toThrow(
            'Codex name requires a title: happy codex --name <title>',
        );
    });
});
