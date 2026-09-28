import { describe, expect, it } from 'vitest'
import {
    buildManagedSessionSpawnEnvironment,
    buildResumedSessionSpawnEnvironment,
    buildSpawnRequestEnvironment,
    buildSessionSpawnEnvironment,
    captureSaycodeAgentEnvironment,
    stripManagedCredentialConflicts,
    scrubSessionLineageEnv,
    applyAppliedAiAuthSourceEnv,
    overlayManagedCredentialEnvironment,
    SESSION_LINEAGE_ENV_PREFIXES,
    AI_AUTH_SELECTION_KINDS,
    parseAiAuthSelection,
    honorsManagedAiCredentials,
    verifyAiAuthSelection,
} from './sessionEnv'
import { readAiAuthConnectionVersion } from '../usage/aiAuthSource'
import { expandEnvironmentVariables } from '../utils/expandEnvVars'

describe('scrubSessionLineageEnv', () => {
    it('removes reconnect and fork lineage variables while keeping everything else', () => {
        // 2026-07-19 incident: a resumed child restarted the daemon, the daemon
        // inherited HAPPY_RECONNECT_* from that child, and every subsequently
        // spawned session reconnected to the same happy session instead of
        // creating its own — chats from every project queued into one session.
        const env = {
            PATH: '/usr/bin',
            HAPPY_HOME_DIR: '/Users/u/.happy_remote',
            HAPPY_RECONNECT_SESSION_ID: 'cmr-poisoned',
            HAPPY_RECONNECT_ENCRYPTION_KEY: 'key',
            HAPPY_RECONNECT_ENCRYPTION_VARIANT: 'legacy',
            HAPPY_RECONNECT_SEQ: '119',
            HAPPY_RECONNECT_METADATA_VERSION: '3',
            HAPPY_RECONNECT_AGENT_STATE_VERSION: '4',
            HAPPY_RECONNECT_SNAPSHOT: 'snapshot',
            HAPPY_FORKED_FROM_SESSION_ID: 'cmr-parent',
            HAPPY_FORKED_FROM_MESSAGE_ID: 'msg-1',
            HAPPY_FORK_CLAUDE_SESSION_ID: 'claude-1',
            HAPPY_FORK_CODEX_THREAD_ID: 'codex-1',
            HAPPY_CREATED_BY_ACCOUNT_ID: 'acct-stale',
            HAPPY_CREATED_BY_DISPLAY_NAME: 'Stale Name',
            HAPPY_INITIAL_PROMPT: 'stale automation prompt',
            HAPPY_INITIAL_MODEL: 'stale-model',
            HAPPY_INITIAL_EFFORT: 'stale-effort',
            HAPPY_AUTOMATION_RUN_ONCE: '1',
            APLUS_SESSION_URL: 'https://saycode.ai/session/parent-session',
            APLUS_SESSION_ID: 'parent-session',
            SAYCODE_AGENT_ENV: '1',
            SAYCODE_AGENT_ROOT: '/parent',
            HAPPY_CHECKPOINT_SPAWN_CONTEXT: '{"schemaVersion":1,"projectId":"stale","worktreeId":null,"checkpointRoot":"/stale"}',
        }
        const scrubbed = scrubSessionLineageEnv(env)
        expect(scrubbed).toEqual({
            PATH: '/usr/bin',
            HAPPY_HOME_DIR: '/Users/u/.happy_remote',
        })
        // input is not mutated — resumeSession re-adds its own explicit values
        expect(env.HAPPY_RECONNECT_SESSION_ID).toBe('cmr-poisoned')
    })

    it('removes an inherited applied AI auth source so it cannot be re-reported', () => {
        // The daemon can be restarted by a child and then inherits that child's
        // whole environment. An un-scrubbed HAPPY_AI_AUTH_SOURCE means every
        // later session on that machine meters its tokens against somebody
        // else's credential.
        const scrubbed = scrubSessionLineageEnv({
            PATH: '/usr/bin',
            HAPPY_AI_AUTH_SOURCE: 'personal-subscription',
            HAPPY_AI_AUTH_CONNECTION_VERSION: '7',
        })
        expect(scrubbed).toEqual({ PATH: '/usr/bin' })
    })

    it('drops undefined values so the result is safe for spawn env', () => {
        const scrubbed = scrubSessionLineageEnv({ KEEP: 'x', GONE: undefined })
        expect(scrubbed).toEqual({ KEEP: 'x' })
    })

    it('covers every lineage prefix used by spawn/resume paths', () => {
        expect(SESSION_LINEAGE_ENV_PREFIXES).toContain('HAPPY_RECONNECT_')
        expect(SESSION_LINEAGE_ENV_PREFIXES).toContain('HAPPY_FORK')
        expect(SESSION_LINEAGE_ENV_PREFIXES).toContain('HAPPY_CREATED_BY')
        // HAPPY_INITIAL_ covers PROMPT(_LOCAL_ID) and the MODEL/EFFORT seeds.
        expect(SESSION_LINEAGE_ENV_PREFIXES).toContain('HAPPY_INITIAL_')
        expect(SESSION_LINEAGE_ENV_PREFIXES).toContain('HAPPY_AUTOMATION_')
        // APLUS_SESSION_* is rewritten after the child confirms its id, but the
        // daemon still scrubs stale lineage before process launch.
        expect(SESSION_LINEAGE_ENV_PREFIXES).toContain('APLUS_SESSION_')
        expect(SESSION_LINEAGE_ENV_PREFIXES).toContain('SAYCODE_AGENT_')
        expect(SESSION_LINEAGE_ENV_PREFIXES).toContain('HAPPY_CHECKPOINT_')
    })
})

describe('buildSessionSpawnEnvironment', () => {
    it('lets daemon-managed credentials override inherited and caller-supplied auth fields', () => {
        expect(buildManagedSessionSpawnEnvironment({
            PATH: '/usr/bin',
            ANTHROPIC_API_KEY: 'inherited-api-key',
            CLAUDE_CODE_OAUTH_TOKEN: 'inherited-oauth-token',
            ANTHROPIC_MODEL: 'claude-opus-5',
            ANTHROPIC_SMALL_FAST_MODEL: 'claude-haiku-4-5',
            CLAUDE_CODE_USE_BEDROCK: '1',
            ANTHROPIC_CUSTOM_HEADERS: 'x-api-key: inherited-key',
        }, {
            SAFE: 'value',
            ANTHROPIC_AUTH_TOKEN: 'caller-token',
            ANTHROPIC_BASE_URL: 'https://caller.invalid',
            CLAUDE_CODE_USE_VERTEX: '1',
            CLAUDE_CODE_USE_FOUNDRY: '1',
            ANTHROPIC_CUSTOM_HEADERS: 'x-api-key: caller-key',
        }, {
            ANTHROPIC_AUTH_TOKEN: 'managed-token',
            ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
        })).toEqual({
            PATH: '/usr/bin',
            SAFE: 'value',
            ANTHROPIC_AUTH_TOKEN: 'managed-token',
            ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
        })
    })

    it('keeps caller model overrides for native Claude credentials', () => {
        expect(buildManagedSessionSpawnEnvironment({}, {
            ANTHROPIC_MODEL: 'claude-opus-5',
            ANTHROPIC_SMALL_FAST_MODEL: 'claude-haiku-4-5',
        }, {
            CLAUDE_CODE_OAUTH_TOKEN: 'managed-oauth-token',
        })).toMatchObject({
            ANTHROPIC_MODEL: 'claude-opus-5',
            ANTHROPIC_SMALL_FAST_MODEL: 'claude-haiku-4-5',
        })
    })

    it('keeps managed credential secrets out of caller variable expansion', () => {
        const managed = {
            ANTHROPIC_AUTH_TOKEN: 'managed-${MUST_STAY_LITERAL}',
            ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
        }
        const requested = stripManagedCredentialConflicts({
            SAFE: '${EXPAND_ME}',
            ANTHROPIC_AUTH_TOKEN: '${MISSING_CALLER_TOKEN}',
            ANTHROPIC_API_KEY: '${MISSING_NATIVE_KEY}',
            CLAUDE_CODE_OAUTH_TOKEN: '${MISSING_NATIVE_OAUTH}',
        }, managed)

        expect(expandEnvironmentVariables(requested, { EXPAND_ME: 'expanded' })).toEqual({
            SAFE: 'expanded',
        })
        expect(buildManagedSessionSpawnEnvironment({}, requested, managed)).toMatchObject({
            ANTHROPIC_AUTH_TOKEN: 'managed-${MUST_STAY_LITERAL}',
        })
    })

    it('scrubs inherited lineage before applying the explicit spawn environment', () => {
        expect(buildSessionSpawnEnvironment(
            {
                PATH: '/usr/bin',
                HAPPY_RECONNECT_SESSION_ID: 'stale-session',
                APLUS_SESSION_ID: 'parent-session',
            },
            {
                HAPPY_RECONNECT_SESSION_ID: 'target-session',
                TASK_TOKEN: 'task-token',
            },
        )).toEqual({
            PATH: '/usr/bin',
            HAPPY_RECONNECT_SESSION_ID: 'target-session',
            TASK_TOKEN: 'task-token',
        })
    })
})

describe('buildSpawnRequestEnvironment', () => {
    it('rejects request-controlled continuation and lineage variables', () => {
        expect(buildSpawnRequestEnvironment(
            {
                HAPPY_HOME_DIR: '/trusted/home',
                CODEX_HOME: '/trusted/codex',
                CLAUDE_CODE_OAUTH_TOKEN: 'trusted-claude-token',
            },
            {
                PROJECT_TOKEN: 'project-token',
                HAPPY_DEFERRED_CONTINUATION_CONTEXT_FILE: '/private/secret',
                HAPPY_FORK_CLAUDE_SESSION_ID: 'attacker-session',
                HAPPY_HOME_DIR: '/attacker/home',
                CODEX_HOME: '/attacker/codex',
                CLAUDE_CODE_OAUTH_TOKEN: 'attacker-claude-token',
            },
        )).toEqual({
            HAPPY_HOME_DIR: '/trusted/home',
            CODEX_HOME: '/trusted/codex',
            CLAUDE_CODE_OAUTH_TOKEN: 'trusted-claude-token',
            PROJECT_TOKEN: 'project-token',
        })
    })

    it('keeps a complete agent capability grant the spawn request supplies', () => {
        // 2026-09-13: the lineage scrub also ate SAYCODE_AGENT_*, which the
        // requester (Desktop root seed, `happy agent spawn` child seed) supplies
        // per spawn. Every session then came up without the capability and
        // `happy agent whoami` answered not_agent_env.
        expect(buildSpawnRequestEnvironment({}, {
            SAYCODE_AGENT_ENV: '1',
            SAYCODE_AGENT_ROOT: '/repo/app/.aplus/worktrees/w1',
            SAYCODE_AGENT_SCOPE: '/repo/app',
            SAYCODE_AGENT_DEPTH: '1',
            SAYCODE_AGENT_MAX_SPAWN: '8',
            SAYCODE_AGENT_ID: 'ac-child-1',
        })).toEqual({
            SAYCODE_AGENT_ENV: '1',
            SAYCODE_AGENT_ROOT: '/repo/app/.aplus/worktrees/w1',
            SAYCODE_AGENT_SCOPE: '/repo/app',
            SAYCODE_AGENT_DEPTH: '1',
            SAYCODE_AGENT_MAX_SPAWN: '8',
            SAYCODE_AGENT_ID: 'ac-child-1',
        })
    })

    it('keeps the capability while still rejecting session-hijacking lineage', () => {
        expect(buildSpawnRequestEnvironment({}, {
            SAYCODE_AGENT_ENV: '1',
            SAYCODE_AGENT_ROOT: '/repo/app',
            HAPPY_RECONNECT_SESSION_ID: 'victim-session',
            APLUS_SESSION_ID: 'victim-session',
            HAPPY_CHECKPOINT_SPAWN_CONTEXT: '{"schemaVersion":1}',
            HAPPY_CREATED_BY_ACCOUNT_ID: 'someone-else',
        })).toEqual({
            SAYCODE_AGENT_ENV: '1',
            SAYCODE_AGENT_ROOT: '/repo/app',
        })
    })

    it('accepts a root seed that carries no depth, budget or id', () => {
        // The web/Desktop root seed omits MAX_SPAWN so saycode-cli derives it
        // from machine capacity; the optional fields must not be required.
        expect(buildSpawnRequestEnvironment({}, {
            SAYCODE_AGENT_ENV: '1',
            SAYCODE_AGENT_ROOT: '/repo/app',
            SAYCODE_AGENT_DEPTH: '0',
        })).toEqual({
            SAYCODE_AGENT_ENV: '1',
            SAYCODE_AGENT_ROOT: '/repo/app',
            SAYCODE_AGENT_DEPTH: '0',
        })
    })

    it.each([
        ['flag is not the literal 1', { SAYCODE_AGENT_ENV: 'true', SAYCODE_AGENT_ROOT: '/repo/app' }],
        ['root is missing', { SAYCODE_AGENT_ENV: '1', SAYCODE_AGENT_DEPTH: '0' }],
        ['root is blank', { SAYCODE_AGENT_ENV: '1', SAYCODE_AGENT_ROOT: '   ' }],
        ['root is relative', { SAYCODE_AGENT_ENV: '1', SAYCODE_AGENT_ROOT: 'repo/app' }],
        ['scope is relative', { SAYCODE_AGENT_ENV: '1', SAYCODE_AGENT_ROOT: '/repo/app', SAYCODE_AGENT_SCOPE: '../..' }],
        ['depth is not a number', { SAYCODE_AGENT_ENV: '1', SAYCODE_AGENT_ROOT: '/repo/app', SAYCODE_AGENT_DEPTH: 'deep' }],
        ['max spawn is negative', { SAYCODE_AGENT_ENV: '1', SAYCODE_AGENT_ROOT: '/repo/app', SAYCODE_AGENT_MAX_SPAWN: '-1' }],
        ['id carries shell metacharacters', { SAYCODE_AGENT_ENV: '1', SAYCODE_AGENT_ROOT: '/repo/app', SAYCODE_AGENT_ID: 'a b;rm -rf /' }],
    ])('drops the whole grant when the %s', (_reason, requested) => {
        // A partial grant is worse than none: SAYCODE_AGENT_ENV without a usable
        // root fails isAgentEnv anyway, and a narrowed scope silently shrinks the
        // tree the session can see.
        expect(buildSpawnRequestEnvironment({ HAPPY_HOME_DIR: '/trusted/home' }, {
            ...requested,
            PROJECT_TOKEN: 'project-token',
        })).toEqual({
            HAPPY_HOME_DIR: '/trusted/home',
            PROJECT_TOKEN: 'project-token',
        })
    })

    it('never lets the request overwrite daemon-owned auth', () => {
        expect(buildSpawnRequestEnvironment(
            { CLAUDE_CODE_OAUTH_TOKEN: 'trusted' },
            { SAYCODE_AGENT_ENV: '1', SAYCODE_AGENT_ROOT: '/repo/app', CLAUDE_CODE_OAUTH_TOKEN: 'attacker' },
        ).CLAUDE_CODE_OAUTH_TOKEN).toBe('trusted')
    })
})

describe('Saycode agent resume environment', () => {
    it('captures the granted additional directories so a resume keeps and can replace them', () => {
        expect(captureSaycodeAgentEnvironment({
            HAPPY_ADDITIONAL_DIRECTORIES: '["/repo/app"]',
        })).toEqual({ HAPPY_ADDITIONAL_DIRECTORIES: '["/repo/app"]' })
        expect(captureSaycodeAgentEnvironment({
            HAPPY_ADDITIONAL_DIRECTORIES: 'not-json',
        })).toBeUndefined()
    })

    it('captures the Chat(beta) browser continuation mark so a resumed turn keeps its guidance', () => {
        const captured = captureSaycodeAgentEnvironment({ HAPPY_AUTOMATION_BROWSER_CONTINUATION: '1', HAPPY_AUTOMATION_RUN_ONCE: '1' })
        expect(captured).toEqual({ HAPPY_AUTOMATION_BROWSER_CONTINUATION: '1' })
        expect(captureSaycodeAgentEnvironment({ HAPPY_AUTOMATION_BROWSER_CONTINUATION: 'yes' })).toBeUndefined()
        expect(buildResumedSessionSpawnEnvironment({
            inherited: { PATH: '/usr/bin' }, explicit: {}, agentEnvironment: captured, sessionId: 'session-2',
        })).toMatchObject({ HAPPY_AUTOMATION_BROWSER_CONTINUATION: '1' })
    })

    it('captures only the validated Saycode agent capability fields', () => {
        expect(captureSaycodeAgentEnvironment({
            SAYCODE_AGENT_ENV: '1',
            SAYCODE_AGENT_ROOT: '/repo/app',
            SAYCODE_AGENT_DEPTH: '1',
            SAYCODE_AGENT_MAX_SPAWN: '4',
            SAYCODE_AGENT_ID: 'child-1',
            SECRET: 'must-not-be-captured',
        })).toEqual({
            SAYCODE_AGENT_ENV: '1',
            SAYCODE_AGENT_ROOT: '/repo/app',
            SAYCODE_AGENT_DEPTH: '1',
            SAYCODE_AGENT_MAX_SPAWN: '4',
            SAYCODE_AGENT_ID: 'child-1',
        })
    })

    it('captures the discovery scope so a resumed session keeps seeing sibling worktrees', () => {
        // SAYCODE_AGENT_SCOPE (saycode-cli 0.4.0, Desktop ADR-061) widens ls/read/steer to the
        // project tree. Dropping it on resume silently shrinks a hub back to its own worktree.
        expect(captureSaycodeAgentEnvironment({
            SAYCODE_AGENT_ENV: '1',
            SAYCODE_AGENT_ROOT: '/repo/.aplus/worktrees/p/a',
            SAYCODE_AGENT_SCOPE: '/repo',
            SAYCODE_AGENT_DEPTH: '0',
        })).toEqual({
            SAYCODE_AGENT_ENV: '1',
            SAYCODE_AGENT_ROOT: '/repo/.aplus/worktrees/p/a',
            SAYCODE_AGENT_SCOPE: '/repo',
            SAYCODE_AGENT_DEPTH: '0',
        })
    })

    it('restores the captured capability and current session id on resume', () => {
        expect(buildResumedSessionSpawnEnvironment({
            inherited: {
                PATH: '/usr/bin',
                SAYCODE_AGENT_ROOT: '/stale',
                APLUS_SESSION_ID: 'parent-session',
            },
            explicit: { HAPPY_RECONNECT_SESSION_ID: 'session-2' },
            agentEnvironment: {
                SAYCODE_AGENT_ENV: '1',
                SAYCODE_AGENT_ROOT: '/repo/app',
                SAYCODE_AGENT_DEPTH: '1',
                SAYCODE_AGENT_MAX_SPAWN: '4',
                SAYCODE_AGENT_ID: 'child-1',
            },
            sessionId: 'session-2',
        })).toEqual({
            PATH: '/usr/bin',
            HAPPY_RECONNECT_SESSION_ID: 'session-2',
            SAYCODE_AGENT_ENV: '1',
            SAYCODE_AGENT_ROOT: '/repo/app',
            SAYCODE_AGENT_DEPTH: '1',
            SAYCODE_AGENT_MAX_SPAWN: '4',
            SAYCODE_AGENT_ID: 'child-1',
            APLUS_SESSION_ID: 'session-2',
        })
    })

    it('captures and restores a validated checkpoint binding without unrelated environment', () => {
        const encoded = JSON.stringify({
            schemaVersion: 1,
            projectId: 'project-1',
            worktreeId: null,
            checkpointRoot: '/machine/checkpoints',
        })
        const captured = captureSaycodeAgentEnvironment({
            HAPPY_CHECKPOINT_SPAWN_CONTEXT: encoded,
            SECRET: 'must-not-be-captured',
        })

        expect(captured).toEqual({ HAPPY_CHECKPOINT_SPAWN_CONTEXT: encoded })
        expect(buildResumedSessionSpawnEnvironment({
            inherited: { HAPPY_CHECKPOINT_SPAWN_CONTEXT: 'stale' },
            explicit: { HAPPY_RECONNECT_SESSION_ID: 'session-2' },
            agentEnvironment: captured,
            sessionId: 'session-2',
        })).toEqual({
            HAPPY_RECONNECT_SESSION_ID: 'session-2',
            HAPPY_CHECKPOINT_SPAWN_CONTEXT: encoded,
            APLUS_SESSION_ID: 'session-2',
        })
    })

    it('does not invent agent capability for a legacy session', () => {
        expect(buildResumedSessionSpawnEnvironment({
            inherited: { SAYCODE_AGENT_ENV: '1', SAYCODE_AGENT_ROOT: '/stale' },
            explicit: { HAPPY_RECONNECT_SESSION_ID: 'legacy-session' },
            sessionId: 'legacy-session',
        })).toEqual({
            HAPPY_RECONNECT_SESSION_ID: 'legacy-session',
            APLUS_SESSION_ID: 'legacy-session',
        })
    })
})

describe('mergeResumeSessionEnvironment', () => {
    it('strips lineage keys from inherited and runtime env while preserving trusted resume values', () => {
        expect(buildResumedSessionSpawnEnvironment({
            inherited: { KEEP_INHERITED: 'yes', HAPPY_RECONNECT_SESSION_ID: 'stale' },
            runtime: { KEEP_RUNTIME: 'yes', APLUS_SESSION_ID: 'forged' },
            automation: { KEEP_AUTOMATION: 'yes', HAPPY_AUTOMATION_ID: 'forged' },
            explicit: { HAPPY_RECONNECT_SESSION_ID: 'session-1' },
            sessionId: 'session-1',
        })).toEqual({
            KEEP_INHERITED: 'yes',
            KEEP_RUNTIME: 'yes',
            KEEP_AUTOMATION: 'yes',
            HAPPY_RECONNECT_SESSION_ID: 'session-1',
            APLUS_SESSION_ID: 'session-1',
        })
    })
})

describe('resumed agent sandbox policy', () => {
    const key = 'HAPPY_PROJECT_SANDBOX_CONFIG'
    const policy = JSON.stringify({ enabled: true, extraWritePaths: ['/repo/.aplus/agent-lineage.jsonl'], denyWritePaths: ['/repo/private'] })
    const agentEnvironment = () => captureSaycodeAgentEnvironment({
        SAYCODE_AGENT_ENV: '1', SAYCODE_AGENT_ROOT: '/repo/.aplus/worktrees/task', [key]: policy,
    })

    it('restores the original file grant and deny policy without Desktop resending environment', () => {
        expect(buildResumedSessionSpawnEnvironment({
            inherited: { [key]: 'unrelated-daemon-policy' }, explicit: {}, agentEnvironment: agentEnvironment(), sessionId: 'child',
        })[key]).toBe(policy)
    })

    it('preserves a non-agent session policy through capture and resume', () => {
        const captured = captureSaycodeAgentEnvironment({ [key]: policy })
        expect(captured).toEqual({ [key]: policy })
        expect(buildResumedSessionSpawnEnvironment({
            inherited: {}, explicit: {}, agentEnvironment: captured, sessionId: 'ordinary',
        })[key]).toBe(policy)
    })

    it('preserves an explicit policy update on resume', () => {
        expect(buildResumedSessionSpawnEnvironment({
            inherited: {}, explicit: {}, runtime: { [key]: 'updated-policy' }, agentEnvironment: agentEnvironment(), sessionId: 'child',
        })[key]).toBe('updated-policy')
    })

    it('does not give a legacy session an unrelated daemon policy', () => {
        expect(buildResumedSessionSpawnEnvironment({
            inherited: { [key]: policy }, explicit: {}, sessionId: 'legacy',
        })).not.toHaveProperty(key)
    })
})

describe('applyAppliedAiAuthSourceEnv', () => {
    const glmEnvironment = {
        ANTHROPIC_AUTH_TOKEN: 'zai-key',
        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
    }

    it('reports the leased GLM route when the managed credential is the final one applied', () => {
        const child = applyAppliedAiAuthSourceEnv(buildManagedSessionSpawnEnvironment(
            { PATH: '/usr/bin' },
            { ANTHROPIC_API_KEY: 'caller-key' },
            glmEnvironment,
        ), true)
        expect(child.HAPPY_AI_AUTH_SOURCE).toBe('platform-glm')
    })

    it('같은 Z.AI 환경이라도 임대를 적용하지 않았으면 플랫폼이라고 하지 않는다', () => {
        // 개인 GLM 키가 같은 주소를 쓴다. 임대 여부는 daemon 만 안다.
        const child = applyAppliedAiAuthSourceEnv(buildManagedSessionSpawnEnvironment(
            { PATH: '/usr/bin' },
            glmEnvironment,
            {},
        ))
        expect(child.HAPPY_AI_AUTH_SOURCE).toBe('unknown')
    })

    it('does not claim a credential it cannot name when no managed credential applies', () => {
        const child = applyAppliedAiAuthSourceEnv(buildManagedSessionSpawnEnvironment(
            { PATH: '/usr/bin' },
            { ANTHROPIC_API_KEY: 'caller-key' },
            {},
        ))
        expect(child.HAPPY_AI_AUTH_SOURCE).toBe('unknown')
    })

    it('decides from the final environment, not the one the managed credential overwrote', () => {
        // overlayManagedCredentialEnvironment runs last: a decision taken before
        // it would record the credential the child never got to spend.
        const beforeOverlay = { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }
        const child = applyAppliedAiAuthSourceEnv(
            overlayManagedCredentialEnvironment(beforeOverlay, glmEnvironment),
            true,
        )
        expect(child.HAPPY_AI_AUTH_SOURCE).toBe('platform-glm')
    })

    it('never inherits a stale source from the daemon environment', () => {
        const child = applyAppliedAiAuthSourceEnv(buildManagedSessionSpawnEnvironment(
            { PATH: '/usr/bin', HAPPY_AI_AUTH_SOURCE: 'personal-subscription' },
            {},
            {},
        ))
        expect(child.HAPPY_AI_AUTH_SOURCE).toBe('unknown')
    })
})

describe('부모 리뷰 수정: 연결 버전 잔재', () => {
    it('연결 버전 키를 생략하지 않고 **명시적으로 비운다** — tmux 는 생략 키를 안 지운다', () => {
        // tmux 는 전달한 키만 `-e` 로 덮고, 넘기지 않은 키는 tmux 서버 환경에
        // 그대로 남긴다. 객체에서 delete 하면 평범한 spawn 에서는 사라지지만
        // tmux 경로에서는 이전 세션 값이 새 child 에 그대로 상속된다.
        const child = applyAppliedAiAuthSourceEnv({ PATH: '/usr/bin' })
        expect(Object.prototype.hasOwnProperty.call(child, 'HAPPY_AI_AUTH_CONNECTION_VERSION')).toBe(true)
        expect(child.HAPPY_AI_AUTH_CONNECTION_VERSION).toBe('')
    })

    it('비운 값은 읽기 측에서 버전 없음으로 읽힌다', () => {
        const child = applyAppliedAiAuthSourceEnv({ HAPPY_AI_AUTH_CONNECTION_VERSION: '99' })
        expect(readAiAuthConnectionVersion(child)).toBeNull()
    })

    it('원천을 새로 적을 때 이전 연결 버전이 새 child 로 넘어가지 않는다', () => {
        const child = applyAppliedAiAuthSourceEnv({
            PATH: '/usr/bin',
            HAPPY_AI_AUTH_CONNECTION_VERSION: '99',
        })
        expect(child.HAPPY_AI_AUTH_SOURCE).toBe('unknown')
        expect(readAiAuthConnectionVersion(child)).toBeNull()
        expect(child.PATH).toBe('/usr/bin')
    })
})

/**
 * BYOS 인증 원천 선택 (P3 증분 1).
 *
 * 검증 신호는 **최종 child env 의 `HAPPY_AI_AUTH_SOURCE`** 하나다. 그 값은
 * daemon 이 `applyAppliedAiAuthSourceEnv` 로 직접 심은 자기 진술이고, 원장이
 * 기록하는 값과 같은 값이다. 다른 신호(파일·프로세스 탐지)를 새로 만들면
 * 원장과 다른 답을 낼 수 있다.
 */
describe('parseAiAuthSelection', () => {
    it('선택이 없으면 undefined 를 돌려준다', () => {
        expect(parseAiAuthSelection(undefined)).toBeUndefined()
    })

    it.each(AI_AUTH_SELECTION_KINDS)('닫힌 집합의 %s 를 받는다', (kind) => {
        expect(parseAiAuthSelection({ kind })).toEqual({ kind })
    })

    it.each([
        { label: '닫힌 집합 밖의 종류', value: { kind: 'platform-gateway' } },
        { label: '대소문자만 다른 값', value: { kind: 'Machine-Personal' } },
        { label: 'kind 누락', value: {} },
        { label: '문자열', value: 'machine-personal' },
        { label: '배열', value: [{ kind: 'machine-personal' }] },
        { label: 'null', value: null },
    ])('$label 은 거절한다 — 조용히 무시하면 선택이 없는 것처럼 돈다', ({ value }) => {
        expect(() => parseAiAuthSelection(value)).toThrow(/AI auth selection/)
    })
})

describe('honorsManagedAiCredentials', () => {
    it('선택이 없으면 기존 동작 그대로 관리 자격이 이긴다', () => {
        expect(honorsManagedAiCredentials(undefined)).toBe(true)
    })

    it('org-bundle 을 고르면 관리 자격을 그대로 덮는다', () => {
        expect(honorsManagedAiCredentials({ kind: 'org-bundle' })).toBe(true)
    })

    it('machine-personal 을 고르면 관리 자격을 덮지 않는다', () => {
        expect(honorsManagedAiCredentials({ kind: 'machine-personal' })).toBe(false)
    })
})

describe('verifyAiAuthSelection', () => {
    const envWith = (source?: string): Record<string, string> => (
        source === undefined ? {} : { HAPPY_AI_AUTH_SOURCE: source }
    )

    it('선택이 없으면 무엇이 적용됐든 통과한다 (기존 동작)', () => {
        for (const source of [undefined, 'platform-glm', 'org-bundle', 'personal-api-key']) {
            expect(verifyAiAuthSelection(undefined, envWith(source)).rejection).toBeUndefined()
        }
    })

    it('적용된 원천을 그대로 보고한다', () => {
        expect(verifyAiAuthSelection(undefined, envWith('platform-glm')).appliedSource).toBe('platform-glm')
        expect(verifyAiAuthSelection(undefined, envWith()).appliedSource).toBe('unknown')
    })

    it.each(['platform-glm', 'platform-gateway', 'org-bundle'])(
        'machine-personal 인데 %s 가 적용됐으면 거절한다',
        (source) => {
            const verdict = verifyAiAuthSelection({ kind: 'machine-personal' }, envWith(source))
            expect(verdict.rejection).toBeDefined()
            expect(verdict.rejection).toContain(source)
            expect(verdict.rejection).toContain('machine-personal')
        },
    )

    // 이 테스트는 원래 `undefined`·`personal-api-key` 도 통과시켰다. 음성 확인이
    // 개인 자격의 증거라는 전제였는데, 상속 키·프로젝트 주입 키·cswap 이 갈아끼운
    // 머신 전역 자격이 전부 그 검사에 안 걸리는 것으로 반증됐다. 이제 daemon 이
    // 개인 구독을 적용했다고 **진술한 경우에만** 통과한다.
    it('machine-personal 은 daemon 이 개인 구독 적용을 진술했을 때만 통과한다', () => {
        expect(verifyAiAuthSelection({ kind: 'machine-personal' }, envWith('personal-subscription')).rejection)
            .toBeUndefined()
    })

    it.each([undefined, 'personal-api-key'])(
        'machine-personal 은 확인되지 않은 상태(%s)에서 거절한다',
        (source) => {
            expect(verifyAiAuthSelection({ kind: 'machine-personal' }, envWith(source)).rejection)
                .toBeDefined()
        },
    )

    it.each([undefined, 'platform-glm', 'personal-api-key'])(
        'org-bundle 인데 그 자격이 확인되지 않으면(%s) 거절한다 — 대체하지 않는다',
        (source) => {
            const verdict = verifyAiAuthSelection({ kind: 'org-bundle' }, envWith(source))
            expect(verdict.rejection).toBeDefined()
            expect(verdict.rejection).toContain('org-bundle')
        },
    )

    it('org-bundle 이 실제로 적용됐다고 daemon 이 진술하면 통과한다', () => {
        expect(verifyAiAuthSelection({ kind: 'org-bundle' }, envWith('org-bundle')).rejection)
            .toBeUndefined()
    })
})

describe('리뷰 수정: 확인할 수 없는 선택은 통과시키지 않는다', () => {
    it('machine-personal 은 상속된 남의 API 키 위에서 통과하면 안 된다', () => {
        // 음성 확인("내가 안 덮었다")은 개인 자격의 증거가 아니다. 상속 env·프로젝트
        // 주입 키·cswap 이 갈아끼운 머신 전역 자격이 전부 보이지 않는다.
        const verdict = verifyAiAuthSelection({ kind: 'machine-personal' }, {
            HAPPY_AI_AUTH_SOURCE: 'unknown',
            ANTHROPIC_API_KEY: 'sk-ant-somebody-elses',
        })
        expect(verdict.rejection).toBeDefined()
    })

    it('machine-personal 은 조직 자격이 머신 전역에 있을 때도 통과하면 안 된다', () => {
        // cswap import 는 번들에 없는 계정을 제거한다 — 조직 번들이 배포된 머신에는
        // 개인 로그인이 남아 있지 않다. env 에는 아무 흔적도 없다.
        const verdict = verifyAiAuthSelection({ kind: 'machine-personal' }, {
            HAPPY_AI_AUTH_SOURCE: 'unknown',
        })
        expect(verdict.rejection).toBeDefined()
    })

    it('org-bundle 도 확인 신호가 없어 거절된다', () => {
        const verdict = verifyAiAuthSelection({ kind: 'org-bundle' }, {
            HAPPY_AI_AUTH_SOURCE: 'unknown',
        })
        expect(verdict.rejection).toBeDefined()
    })

    it('선택이 없으면 기존 동작 그대로 통과한다', () => {
        expect(verifyAiAuthSelection(undefined, { HAPPY_AI_AUTH_SOURCE: 'unknown' }).rejection)
            .toBeUndefined()
    })
})
