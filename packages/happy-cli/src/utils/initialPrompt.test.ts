import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const happyHome = vi.hoisted(() => ({ dir: '' }))
vi.mock('@/configuration', () => ({ configuration: { get happyHomeDir() { return happyHome.dir } } }))

import {
  consumeConfirmedInitialPromptDelivery,
  INITIAL_PROMPT_INLINE_LIMIT_BYTES,
  consumePendingInitialAppendSystemPrompt,
  consumePendingInitialEffort,
  consumePendingInitialModel,
  consumePendingInitialPrompt,
  consumePendingInitialSaycodePromptBlocks,
  consumePendingInitialSaycodeSystemPromptEnabled,
  defaultClaudeModelForRuntime,
  normalizeClaudeModelForRuntime,
  stageInitialPromptEnvironment,
} from './initialPrompt'

// 2026-08-27 프로덕션 — AgentTask 리뷰가 diff 를 프롬프트에 인라인하는데, 그
// 프롬프트가 HAPPY_INITIAL_PROMPT 환경변수로 전달된다. Linux 의 단일 env 한도는
// MAX_ARG_STRLEN(32 * 4096 = 131072 바이트)이라, justin-work PR #17 의 143,500
// 바이트 diff 에서 spawn 이 E2BIG 으로 죽었다. 큰 프롬프트는 파일로 넘긴다.
describe('initial prompt staging (E2BIG)', () => {
  it('keeps a small prompt inline so the common spawn path is unchanged', async () => {
    const staged = await stageInitialPromptEnvironment('review this', {
      makeTempDir: () => mkdtemp(join(tmpdir(), 'happy-initial-prompt-test-')),
    })

    expect(staged.env).toEqual({ HAPPY_INITIAL_PROMPT: 'review this' })
    expect(staged.cleanup).toBeUndefined()
  })

  // Desktop specs/windows-build-support W0-5g: the OS temp directory is not guaranteed
  // private (a Windows user's %TEMP% can carry another principal's access); the Happy
  // home is the directory Desktop keeps owner-only.
  it('stages an oversized prompt inside the Happy home, not the OS temp directory', async () => {
    happyHome.dir = await mkdtemp(join(tmpdir(), 'happy-home-test-'))
    const staged = await stageInitialPromptEnvironment('x'.repeat(INITIAL_PROMPT_INLINE_LIMIT_BYTES + 1))
    const file = staged.env.HAPPY_INITIAL_PROMPT_FILE!
    expect(file.startsWith(join(happyHome.dir, 'tmp') + (process.platform === 'win32' ? '\\' : '/'))).toBe(true)
    await staged.cleanup?.()
    expect(existsSync(file)).toBe(false)
  })

  it('stages a prompt over the inline limit as a file instead of an env value', async () => {
    const big = 'x'.repeat(INITIAL_PROMPT_INLINE_LIMIT_BYTES + 1)
    const staged = await stageInitialPromptEnvironment(big, {
      makeTempDir: () => mkdtemp(join(tmpdir(), 'happy-initial-prompt-test-')),
    })

    expect(staged.env.HAPPY_INITIAL_PROMPT).toBeUndefined()
    const file = staged.env.HAPPY_INITIAL_PROMPT_FILE!
    expect(file).toBeTruthy()
    expect(await readFile(file, 'utf8')).toBe(big)
    await staged.cleanup?.()
  })

  // 문자 길이가 아니라 바이트 길이로 재야 한다 — 한국어는 UTF-8 로 3바이트다.
  it('measures the limit in utf-8 bytes, not string length', async () => {
    const multibyte = '가'.repeat(INITIAL_PROMPT_INLINE_LIMIT_BYTES - 10)
    expect(multibyte.length).toBeLessThan(INITIAL_PROMPT_INLINE_LIMIT_BYTES)
    expect(Buffer.byteLength(multibyte, 'utf8')).toBeGreaterThan(INITIAL_PROMPT_INLINE_LIMIT_BYTES)

    const staged = await stageInitialPromptEnvironment(multibyte, {
      makeTempDir: () => mkdtemp(join(tmpdir(), 'happy-initial-prompt-test-')),
    })

    expect(staged.env.HAPPY_INITIAL_PROMPT).toBeUndefined()
    expect(staged.env.HAPPY_INITIAL_PROMPT_FILE).toBeTruthy()
    await staged.cleanup?.()
  })

  it('stays under the kernel per-variable limit for an inline prompt', () => {
    // 한도 자체가 커널 상수(32 * 4096)보다 작아야 의미가 있다.
    expect(INITIAL_PROMPT_INLINE_LIMIT_BYTES).toBeLessThan(32 * 4096)
  })
})

describe('consumePendingInitialPrompt', () => {
  it('reads an inline prompt exactly once', () => {
    const env: NodeJS.ProcessEnv = { HAPPY_INITIAL_PROMPT: 'review this' }

    expect(consumePendingInitialPrompt(env)).toBe('review this')
    expect(env).not.toHaveProperty('HAPPY_INITIAL_PROMPT')
    expect(consumePendingInitialPrompt(env)).toBeNull()
  })

  it('reads a staged file, then removes both the variable and the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happy-initial-prompt-test-'))
    const file = join(dir, 'prompt.txt')
    await writeFile(file, 'a very large review prompt', 'utf8')
    const env: NodeJS.ProcessEnv = { HAPPY_INITIAL_PROMPT_FILE: file }

    expect(consumePendingInitialPrompt(env)).toBe('a very large review prompt')
    expect(env).not.toHaveProperty('HAPPY_INITIAL_PROMPT_FILE')
    expect(existsSync(file)).toBe(false)
  })

  it('removes the staging directory the daemon created once the prompt is read', async () => {
    happyHome.dir = await mkdtemp(join(tmpdir(), 'happy-home-test-'))
    const staged = await stageInitialPromptEnvironment('y'.repeat(INITIAL_PROMPT_INLINE_LIMIT_BYTES + 1))
    const file = staged.env.HAPPY_INITIAL_PROMPT_FILE!

    expect(consumePendingInitialPrompt({ ...staged.env })).toHaveLength(INITIAL_PROMPT_INLINE_LIMIT_BYTES + 1)
    expect(existsSync(dirname(file))).toBe(false)
    expect(existsSync(join(happyHome.dir, 'tmp'))).toBe(true)
  })

  it('never removes a directory that is not an empty prompt staging directory', async () => {
    const shared = await mkdtemp(join(tmpdir(), 'shared-'))
    const sharedFile = join(shared, 'prompt.txt')
    await writeFile(sharedFile, 'prompt', 'utf8')
    expect(consumePendingInitialPrompt({ HAPPY_INITIAL_PROMPT_FILE: sharedFile })).toBe('prompt')
    expect(existsSync(shared)).toBe(true)

    const busy = await mkdtemp(join(tmpdir(), 'happy-initial-prompt-busy-'))
    const busyFile = join(busy, 'initial-prompt.txt')
    await writeFile(busyFile, 'prompt', 'utf8')
    await writeFile(join(busy, 'other.txt'), 'keep', 'utf8')
    expect(consumePendingInitialPrompt({ HAPPY_INITIAL_PROMPT_FILE: busyFile })).toBe('prompt')
    expect(existsSync(join(busy, 'other.txt'))).toBe(true)
  })

  // 파일이 사라졌다고 세션 시작 자체가 죽으면 안 된다 — 프롬프트 없이 뜨는 게
  // 낫다. 던지면 spawn 이 통째로 실패한다.
  it('returns null instead of throwing when the staged file is gone', () => {
    const env: NodeJS.ProcessEnv = {
      HAPPY_INITIAL_PROMPT_FILE: join(tmpdir(), 'happy-initial-prompt-missing-file'),
    }

    expect(consumePendingInitialPrompt(env)).toBeNull()
    expect(env).not.toHaveProperty('HAPPY_INITIAL_PROMPT_FILE')
  })
})

describe('consumePendingInitialAppendSystemPrompt', () => {
  it('reads a recovered user/project prompt exactly once without trimming its contents', () => {
    const env: NodeJS.ProcessEnv = { HAPPY_INITIAL_APPEND_SYSTEM_PROMPT: ' USER CONTEXT ' }

    expect(consumePendingInitialAppendSystemPrompt(env)).toBe(' USER CONTEXT ')
    expect(env).not.toHaveProperty('HAPPY_INITIAL_APPEND_SYSTEM_PROMPT')
    expect(consumePendingInitialAppendSystemPrompt(env)).toBeUndefined()
  })

  it('treats an empty value as absent', () => {
    expect(consumePendingInitialAppendSystemPrompt({ HAPPY_INITIAL_APPEND_SYSTEM_PROMPT: '' }))
      .toBeUndefined()
  })
})

describe('consumePendingInitialModel', () => {
  it('reads the seed exactly once and scrubs it from the environment', () => {
    const env: NodeJS.ProcessEnv = { HAPPY_INITIAL_MODEL: ' opus ' }

    expect(consumePendingInitialModel(env)).toBe('opus')
    expect(env).not.toHaveProperty('HAPPY_INITIAL_MODEL')
    expect(consumePendingInitialModel(env)).toBeNull()
  })

  it('treats a blank value as absent', () => {
    expect(consumePendingInitialModel({ HAPPY_INITIAL_MODEL: '   ' })).toBeNull()
    expect(consumePendingInitialModel({})).toBeNull()
  })
})

describe('normalizeClaudeModelForRuntime', () => {
  it('maps Claude model families to Z.AI aliases and removes Fable', () => {
    expect(normalizeClaudeModelForRuntime('claude-fable-5', {
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
    })).toBeUndefined()
    expect(normalizeClaudeModelForRuntime('fable', {
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
    })).toBeUndefined()
    expect(normalizeClaudeModelForRuntime('claude-opus-5', {
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
    })).toBe('opus')
    expect(normalizeClaudeModelForRuntime('claude-sonnet-5', {
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
    })).toBe('sonnet')
    expect(normalizeClaudeModelForRuntime('claude-haiku-4-5', {
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
    })).toBe('haiku')
    expect(normalizeClaudeModelForRuntime('claude-fable-5', {})).toBe('claude-fable-5')
  })

  it('resolves an unpicked Default to GLM-5.3-Flash on the Z.AI runtime', () => {
    expect(normalizeClaudeModelForRuntime('default', {
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
    })).toBe('glm-5.3-flash')
    // 비 z.ai 런타임에서는 'default' 를 그대로 둔다 — CLI 자신의 기본 해석에 맡긴다.
    expect(normalizeClaudeModelForRuntime('default', {})).toBe('default')
  })

  it('passes an explicitly picked GLM model id straight through unchanged', () => {
    expect(normalizeClaudeModelForRuntime('glm-5.3-flash', {
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
    })).toBe('glm-5.3-flash')
  })
})

// web-ui 는 'Default' 선택 시 meta.model 을 **아예 싣지 않고**(sync/index.ts:
// `resolvedModel !== 'default' ? { model } : {}`), spawn RPC 에는 model 파라미터
// 자체가 없다. 그래서 실제 "기본값" 경로는 'default' 문자열이 아니라 **모델 부재**다.
// 여기서 opus 로 떨어지면 z.ai 에서 glm-5.3 (flash 대비 input 약 18배) 이 걸린다.
describe('defaultClaudeModelForRuntime', () => {
  it('falls back to GLM-5.3-Flash when a Z.AI spawn named no model', () => {
    expect(defaultClaudeModelForRuntime({
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
    }, 'opus')).toBe('glm-5.3-flash')
  })

  // happy-app(모바일/데스크탑)은 'Default' 를 meta.model = null 로 보낸다
  // (sources/sync/messageMeta.ts:27). CLI 는 그것을 undefined 로 normalize 하는데,
  // z.ai 에서 undefined 로 두면 CLI 기본 tier(sonnet) = glm-4.7 로 가버린다.
  it('also covers a cleared model, which has no string fallback', () => {
    expect(defaultClaudeModelForRuntime({
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
    }, undefined)).toBe('glm-5.3-flash')
    // 일반 Claude 세션의 '기본값으로 리셋' 은 그대로 undefined 여야 한다.
    expect(defaultClaudeModelForRuntime({}, undefined)).toBeUndefined()
  })

  it('leaves the plain Claude fallback untouched', () => {
    expect(defaultClaudeModelForRuntime({}, 'opus')).toBe('opus')
    expect(defaultClaudeModelForRuntime({
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    }, 'opus')).toBe('opus')
  })
})

describe('consumePendingInitialEffort', () => {
  it('reads the seed exactly once and scrubs it from the environment', () => {
    const env: NodeJS.ProcessEnv = { HAPPY_INITIAL_EFFORT: 'high' }

    expect(consumePendingInitialEffort(env)).toBe('high')
    expect(env).not.toHaveProperty('HAPPY_INITIAL_EFFORT')
    expect(consumePendingInitialEffort(env)).toBeNull()
  })

  it('treats a blank value as absent', () => {
    expect(consumePendingInitialEffort({ HAPPY_INITIAL_EFFORT: '' })).toBeNull()
    expect(consumePendingInitialEffort({})).toBeNull()
  })
})

describe('consumePendingInitialSaycodeSystemPromptEnabled', () => {
  it('reads an explicit recovery policy exactly once', () => {
    const env: NodeJS.ProcessEnv = {
      HAPPY_INITIAL_SAYCODE_SYSTEM_PROMPT_ENABLED: 'false',
    }

    expect(consumePendingInitialSaycodeSystemPromptEnabled(env)).toBe(false)
    expect(env).not.toHaveProperty('HAPPY_INITIAL_SAYCODE_SYSTEM_PROMPT_ENABLED')
    expect(consumePendingInitialSaycodeSystemPromptEnabled(env)).toBeUndefined()
  })

  it('preserves legacy enabled behavior for absent or invalid values', () => {
    expect(consumePendingInitialSaycodeSystemPromptEnabled({})).toBeUndefined()
    expect(consumePendingInitialSaycodeSystemPromptEnabled({
      HAPPY_INITIAL_SAYCODE_SYSTEM_PROMPT_ENABLED: 'invalid',
    })).toBeUndefined()
  })
})

describe('consumePendingInitialSaycodePromptBlocks', () => {
  it('reads a JSON block override map exactly once', () => {
    const env: NodeJS.ProcessEnv = {
      HAPPY_INITIAL_SAYCODE_PROMPT_BLOCKS: '{"workerDelegation":false,"axBase":true}',
    }

    expect(consumePendingInitialSaycodePromptBlocks(env)).toEqual({
      workerDelegation: false,
      axBase: true,
    })
    expect(env).not.toHaveProperty('HAPPY_INITIAL_SAYCODE_PROMPT_BLOCKS')
    expect(consumePendingInitialSaycodePromptBlocks(env)).toBeUndefined()
  })

  it('degrades malformed values to no-override instead of poisoning the session', () => {
    // A recovery seed is machine-produced but still crosses a process boundary —
    // a broken value must fall back to the legacy master inheritance, mirroring
    // MessageMetaSchema's catch(undefined) on the wire.
    expect(consumePendingInitialSaycodePromptBlocks({})).toBeUndefined()
    expect(consumePendingInitialSaycodePromptBlocks({
      HAPPY_INITIAL_SAYCODE_PROMPT_BLOCKS: 'not json',
    })).toBeUndefined()
    expect(consumePendingInitialSaycodePromptBlocks({
      HAPPY_INITIAL_SAYCODE_PROMPT_BLOCKS: '["array"]',
    })).toBeUndefined()
    // Non-boolean entries are dropped, boolean ones survive.
    expect(consumePendingInitialSaycodePromptBlocks({
      HAPPY_INITIAL_SAYCODE_PROMPT_BLOCKS: '{"workerDelegation":"no","axBase":false}',
    })).toEqual({ axBase: false })
  })
})

describe('consumeConfirmedInitialPromptDelivery', () => {
  it('is on only for the exact daemon-set value', () => {
    expect(consumeConfirmedInitialPromptDelivery({ HAPPY_MANAGED_REQUIRE_PROMPT_ACK: '1' })).toBe(true)
  })

  it('is off when absent or set to anything else', () => {
    for (const value of [undefined, '', '0', 'false', 'true', 'yes']) {
      const env = value === undefined ? {} : { HAPPY_MANAGED_REQUIRE_PROMPT_ACK: value }
      expect(consumeConfirmedInitialPromptDelivery(env)).toBe(false)
    }
  })

  it('removes the key so a child this session spawns does not inherit it', () => {
    const env: NodeJS.ProcessEnv = { HAPPY_MANAGED_REQUIRE_PROMPT_ACK: '1' }
    expect(consumeConfirmedInitialPromptDelivery(env)).toBe(true)
    expect('HAPPY_MANAGED_REQUIRE_PROMPT_ACK' in env).toBe(false)
    // A second read finds nothing — the decision belonged to this launch only.
    expect(consumeConfirmedInitialPromptDelivery(env)).toBe(false)
  })
})
