import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import type { QueryOptions } from './sdk/types';
import {
    buildClaudeTitleQueryOptions,
    createClaudeTitleBridge,
    extractTitleJson,
} from './claudeOffTurnTitle';

const base: QueryOptions = {
    cwd: '/work/project',
    model: 'claude-opus-5-5',
    effort: 'high',
    settingSources: ['user', 'project'],
    sandbox: { enabled: true },
    permissionsDeny: ['Read(./.env)'],
    resume: 'previous-session',
    mcpServers: { happy: { type: 'http', url: 'http://127.0.0.1:1/mcp' } },
    appendSystemPrompt: 'BIG SAYCODE PROMPT',
    allowedTools: ['mcp__happy__change_title'],
    settingsPath: '/tmp/hook-settings.json',
    spawnClaudeCodeProcess: () => { throw new Error('main provider spawn must not be reused'); },
};

describe('buildClaudeTitleQueryOptions', () => {
    it('shouldKeepThePayerAndSandboxInputsOfTheMainQuery', () => {
        const signal = new AbortController().signal;
        const options = buildClaudeTitleQueryOptions(base, { model: 'claude-haiku-4-5', settingsPath: '/tmp/title.json', signal });
        expect(options.cwd).toBe('/work/project');
        expect(options.settingSources).toEqual(['user', 'project']);
        expect(options.sandbox).toEqual({ enabled: true });
        expect(options.permissionsDeny).toEqual(['Read(./.env)']);
        expect(options.model).toBe('claude-haiku-4-5');
        expect(options.abort).toBe(signal);
    });

    it('shouldRunATooLessHookLessUnpersistedSingleTurnAtLowEffort', () => {
        const options = buildClaudeTitleQueryOptions(base, { settingsPath: '/tmp/title.json', signal: new AbortController().signal });
        expect(options.tools).toEqual([]);
        expect(options.mcpServers).toBeUndefined();
        expect(options.strictMcpConfig).toBe(true);
        expect(options.maxTurns).toBe(1);
        expect(options.persistSession).toBe(false);
        expect(options.effort).toBe('low');
        expect(options.settingsPath).toBe('/tmp/title.json');
        expect(options.customSystemPrompt).toBeTruthy();
        expect(options.appendSystemPrompt).toBeUndefined();
        expect(options.resume).toBeUndefined();
        expect(options.allowedTools).toBeUndefined();
        expect(options.spawnClaudeCodeProcess).toBeUndefined();
        expect(options.model).toBe('claude-opus-5-5');
    });
});

describe('extractTitleJson', () => {
    it('shouldReturnTheJsonObjectFromPlainFencedOrWrappedText', () => {
        expect(extractTitleJson('{"title":"T","branchSlug":"a-b"}')).toBe('{"title":"T","branchSlug":"a-b"}');
        expect(extractTitleJson('```json\n{"title":"T"}\n```')).toBe('{"title":"T"}');
        expect(extractTitleJson('Here: {"title":"T"} done')).toBe('{"title":"T"}');
    });

    it('shouldReturnNullWithoutAnObject', () => {
        expect(extractTitleJson('OK')).toBeNull();
        expect(extractTitleJson(null)).toBeNull();
    });
});

function fakeQuery(messages: unknown[]) {
    const calls: { prompt: unknown; options: QueryOptions; settings: string | null }[] = [];
    const runQuery = vi.fn((params: { prompt: unknown; options?: QueryOptions }) => {
        const options = params.options!;
        calls.push({ prompt: params.prompt, options, settings: options.settingsPath && existsSync(options.settingsPath) ? readFileSync(options.settingsPath, 'utf8') : null });
        return (async function* () { for (const message of messages) yield message; })();
    });
    return { runQuery, calls };
}

describe('createClaudeTitleBridge', () => {
    it('shouldWaitForTheMainQueryOptionsThenReturnTheTitleJson', async () => {
        const { runQuery, calls } = fakeQuery([{ type: 'result', subtype: 'success', result: '```json\n{"title":"T","branchSlug":"a-b"}\n```' }]);
        const bridge = createClaudeTitleBridge({ runQuery: runQuery as never });
        const pending = bridge.run({ prompt: 'TITLE PROMPT', model: 'claude-haiku-4-5', signal: new AbortController().signal });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(runQuery).not.toHaveBeenCalled();
        bridge.provide(base);
        await expect(pending).resolves.toBe('{"title":"T","branchSlug":"a-b"}');
        expect(calls[0].prompt).toBe('TITLE PROMPT');
        expect(calls[0].options.model).toBe('claude-haiku-4-5');
        expect(JSON.parse(calls[0].settings!)).toEqual({ disableAllHooks: true });
        expect(existsSync(calls[0].options.settingsPath!)).toBe(false);
    });

    it('shouldFailWhenTheMainQueryNeverProvidesOptions', async () => {
        const { runQuery } = fakeQuery([]);
        const bridge = createClaudeTitleBridge({ runQuery: runQuery as never, waitMs: 20 });
        await expect(bridge.run({ prompt: 'P', signal: new AbortController().signal })).rejects.toThrow('unavailable');
        expect(runQuery).not.toHaveBeenCalled();
    });

    it('shouldStopWaitingWhenAborted', async () => {
        const { runQuery } = fakeQuery([]);
        const bridge = createClaudeTitleBridge({ runQuery: runQuery as never });
        const controller = new AbortController();
        const pending = bridge.run({ prompt: 'P', signal: controller.signal });
        controller.abort();
        await expect(pending).rejects.toThrow();
        expect(runQuery).not.toHaveBeenCalled();
    });

    it('shouldRejectAnErrorResult', async () => {
        const { runQuery } = fakeQuery([{ type: 'result', subtype: 'error_during_execution', errors: ['boom'] }]);
        const bridge = createClaudeTitleBridge({ runQuery: runQuery as never });
        bridge.provide(base);
        await expect(bridge.run({ prompt: 'P', signal: new AbortController().signal })).rejects.toThrow('error_during_execution');
    });

    it('shouldNotUseOptionsThatWereClearedByAnEndedMainQuery', async () => {
        const { runQuery } = fakeQuery([{ type: 'result', subtype: 'success', result: '{"title":"T"}' }]);
        const bridge = createClaudeTitleBridge({ runQuery: runQuery as never, waitMs: 20 });
        bridge.provide(base);
        bridge.clear();
        await expect(bridge.run({ prompt: 'P', signal: new AbortController().signal })).rejects.toThrow('unavailable');
    });
});
