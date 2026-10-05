import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { query } from '@/claude/sdk';
import { planProviderLaunch } from '@/launcher/providerLaunch';

import { claudeRemote } from './claudeRemote';
import type { EnhancedMode } from './loop';

vi.mock('@/claude/sdk', () => ({
    query: vi.fn(),
    AbortError: class AbortError extends Error {},
}));

/**
 * 이 파일이 보는 것은 **실제 소비 경계**다: `claudeRemote` 가 `query` 에 넘긴
 * 옵션. 중간 계층이 무엇을 하든, SDK 가 받는 값이 계획과 같아야 한다.
 */
const PLAN = planProviderLaunch({
    agent: 'claude',
    model: 'claude-opus-5',
    effort: 'low',
    brokerUrl: 'http://127.0.0.1:8731/',
    brokerToken: 'run-grant-token',
    brokerTools: ['read_file'],
    providerEnv: { PATH: '/usr/bin' },
});

/** BYOS 실행이 조립해 온 값들. 관리 실행이면 경계 항목이 전부 대체돼야 한다. */
const byosMode: EnhancedMode = {
    permissionMode: 'bypassPermissions',
    model: 'claude-sonnet-5',
    effort: 'high',
    allowedTools: ['Bash'],
};

/** 관리 실행에서 runner 가 들고 오는 모드: 모델은 봉투(=계획)의 것이다. */
const managedMode: EnhancedMode = { ...byosMode, model: 'claude-opus-5' };

/**
 * `query` 가 받은 옵션만 붙잡고 그 자리에서 멈춘다. 그 뒤의 대화 루프는 이
 * 테스트의 관심사가 아니고, 실제로 돌리면 스트림을 기다리며 끝나지 않는다.
 */
const SENTINEL = 'stop-after-query';
function stubQuery() {
    vi.mocked(query).mockImplementation(() => { throw new Error(SENTINEL); });
}

/**
 * `query` 호출까지만 본다. 그 뒤의 대화 루프는 이 테스트의 관심사가 아니므로
 * 호출이 관측되면 중단한다.
 */
async function runOnce(input: { managedRun: boolean; env: Record<string, string>; mode?: EnhancedMode; extra?: Record<string, unknown> }) {
    const previous = { ...process.env };
    Object.assign(process.env, input.env);
    try {
        return await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: ['mcp__happy__read'],
            mcpServers: { happy: { type: 'http', url: 'https://happy.example' } },
            hookSettingsPath: '/tmp/happy-test-settings.json',
            managedRun: input.managedRun,
            managedSettingsLockdown: input.managedRun,
            // 첫 턴만 준다. 두 번째부터 null 이면 루프가 스스로 끝난다.
            nextMessage: (() => {
                let served = false;
                const mode = input.mode ?? (input.managedRun ? managedMode : byosMode);
                return async () => (served ? null : ((served = true), { message: 'hello', mode }));
            })(),
            onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as never,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage: vi.fn(),
            ...input.extra,
        } as never);
    } finally {
        for (const key of Object.keys(input.env)) delete process.env[key];
        Object.assign(process.env, previous);
    }
}

describe('the managed boundary at the query call', () => {
    beforeEach(() => {
        vi.mocked(query).mockReset();
        stubQuery();
    });
    afterEach(() => { delete process.env.SAYCODE_PROVIDER_SDK_OPTIONS; });

    it('keeps a managed run’s launch away from the off-turn title bridge', async () => {
        vi.mocked(query).mockReset();
        vi.mocked(query).mockReturnValue({ async *[Symbol.asyncIterator]() { yield { type: 'result', subtype: 'success' }; } } as never);
        const offTurnTitle = { provide: vi.fn(), clear: vi.fn(), run: vi.fn() };
        await runOnce({ managedRun: true, env: PLAN.env as Record<string, string>, extra: { offTurnTitle } });
        expect(query).toHaveBeenCalled();
        expect(offTurnTitle.provide).not.toHaveBeenCalled();
    });

    it('gives the SDK exactly the plan’s boundary in a managed run', async () => {
        await expect(runOnce({ managedRun: true, env: PLAN.env as Record<string, string> }))
            .rejects.toThrow(SENTINEL);
        const options = vi.mocked(query).mock.calls[0]![0].options!;
        // 내장 도구는 여기서 꺼진다. 이 값이 없으면 SDK 는 전부 켠다.
        expect(options.tools).toEqual([]);
        expect(options.mcpServers).toEqual(PLAN.sdkOptions!.mcpServers);
        expect(options.allowedTools).toEqual(['mcp__saycode-broker__read_file']);
        expect(options.permissionMode).toBe('default');
        expect(options.settingSources).toEqual([]);
        // 모드가 들고 온 BYOS 모델·effort 가 아니라 run 이 확정한 값이어야 한다.
        expect(options.model).toBe('claude-opus-5');
        expect(options.effort).toBe('low');
        // 조용한 모델 전환이 남아 있으면 안 된다.
        expect(options.fallbackModel).toBeUndefined();
    });

    it('fails closed when the runner carries a model the plan did not choose', async () => {
        // 봉투와 계획이 갈라진 실행 — 한 모델로 청구하고 다른 모델을 돌리게 된다.
        await expect(runOnce({
            managedRun: true, env: PLAN.env as Record<string, string>, mode: byosMode,
        })).rejects.toThrow(/model/);
        expect(query).not.toHaveBeenCalled();
    });

    it('leaves a BYOS run untouched', async () => {
        await expect(runOnce({ managedRun: false, env: {} })).rejects.toThrow(SENTINEL);
        const options = vi.mocked(query).mock.calls[0]![0].options!;
        expect(options.tools).toBeUndefined();
        expect(Object.keys(options.mcpServers ?? {})).toEqual(['happy']);
        expect(options.model).toBe('claude-sonnet-5');
        expect(options.effort).toBe('high');
        expect(options.permissionMode).toBe('bypassPermissions');
        expect(options.allowedTools).toEqual(['Bash', 'mcp__happy__read']);
    });

    it('fails closed when a managed run has no verified plan', async () => {
        await expect(runOnce({ managedRun: true, env: {} })).rejects.toThrow(/managed run/);
        expect(query).not.toHaveBeenCalled();
    });

    it('fails closed when the plan lost its boundary', async () => {
        const broken = JSON.stringify({ ...PLAN.sdkOptions, tools: ['Bash'] });
        await expect(runOnce({
            managedRun: true, env: { SAYCODE_PROVIDER_SDK_OPTIONS: broken },
        })).rejects.toThrow(/managed run/);
        expect(query).not.toHaveBeenCalled();
    });
});
