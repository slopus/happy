import { randomUUID } from 'node:crypto'
import { readFileSync, rmdirSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type { RawJSONLines } from '@/claude/types'
import { configuration } from '@/configuration'
import type { PermissionMode } from '@/api/types'
import { ZAI_CLAUDE_DEFAULT_MODEL } from '@/managed/zaiClaudeEnvironment'

/**
 * Largest prompt we still pass inline as an environment value.
 *
 * Linux caps a *single* argv/env entry at MAX_ARG_STRLEN (32 * PAGE_SIZE =
 * 131072 bytes on a 4K-page system) independently of the much larger ARG_MAX
 * total. AgentTask review prompts inline the PR diff, so a normal-sized change
 * blows past that and `spawn` fails with E2BIG — observed 2026-08-27 with a
 * 143,500-byte diff. Anything at or over this limit is staged to a file
 * instead. Kept well under the kernel constant so the other spawn variables
 * (and non-Linux limits) still have room.
 */
export const INITIAL_PROMPT_INLINE_LIMIT_BYTES = 64 * 1024

export type StagedInitialPrompt = {
  env: { HAPPY_INITIAL_PROMPT?: string; HAPPY_INITIAL_PROMPT_FILE?: string }
  /** Removes a staged file when the spawn never consumed it. */
  cleanup?: () => Promise<void>
}

/**
 * Chooses how a daemon-provided initial prompt reaches the spawned agent.
 *
 * Small prompts keep the original inline path untouched — that is the path
 * that works today, and a filesystem failure must not be able to break it.
 * Only oversized prompts, which currently fail 100% of the time, take the
 * file path.
 */
const STAGING_DIRECTORY_PREFIX = 'happy-initial-prompt-'

export async function stageInitialPromptEnvironment(
  prompt: string,
  deps: { makeTempDir?: () => Promise<string> } = {},
): Promise<StagedInitialPrompt> {
  if (Buffer.byteLength(prompt, 'utf8') < INITIAL_PROMPT_INLINE_LIMIT_BYTES) {
    return { env: { HAPPY_INITIAL_PROMPT: prompt } }
  }
  // Inside the Happy home, which Desktop keeps owner-only on Windows; the OS temp
  // directory can grant other principals access (specs/windows-build-support W0-5g).
  const makeTempDir = deps.makeTempDir ?? (async () => {
    const root = join(configuration.happyHomeDir, 'tmp')
    await mkdir(root, { recursive: true })
    return mkdtemp(join(root, STAGING_DIRECTORY_PREFIX))
  })
  const directory = await makeTempDir()
  const file = join(directory, 'initial-prompt.txt')
  // 0600: the prompt carries untrusted repository text and project context.
  await writeFile(file, prompt, { encoding: 'utf8', mode: 0o600 })
  return {
    env: { HAPPY_INITIAL_PROMPT_FILE: file },
    cleanup: async () => { await rm(directory, { recursive: true, force: true }) },
  }
}

/**
 * Read a daemon-provided initial prompt exactly once without leaking it to
 * children. Accepts both the inline value and a staged file (see
 * `stageInitialPromptEnvironment`); a staged file is deleted after reading.
 */
export function consumePendingInitialPrompt(env: NodeJS.ProcessEnv): string | null {
  const raw = env.HAPPY_INITIAL_PROMPT
  delete env.HAPPY_INITIAL_PROMPT
  const file = env.HAPPY_INITIAL_PROMPT_FILE
  delete env.HAPPY_INITIAL_PROMPT_FILE
  if (typeof file === 'string' && file.length > 0) {
    // A missing or unreadable file must not abort the session — starting
    // without the prompt beats failing the spawn outright.
    let staged: string | null = null
    try {
      staged = readFileSync(file, 'utf8')
    } catch {
      staged = null
    }
    try {
      rmSync(file, { force: true })
      // The daemon staged it in its own mkdtemp directory; drop that too, or the
      // directories pile up. Non-recursive: only ever an emptied staging directory.
      const directory = dirname(file)
      if (basename(directory).startsWith(STAGING_DIRECTORY_PREFIX)) rmdirSync(directory)
    } catch {
      // best-effort cleanup
    }
    if (staged !== null) {
      const text = staged.trim()
      return text.length > 0 ? text : null
    }
  }
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  return text.length > 0 ? text : null
}

/** Read the daemon-provided initial model seed exactly once (HAPPY_INITIAL_MODEL). */
export function consumePendingInitialModel(env: NodeJS.ProcessEnv): string | null {
  const raw = env.HAPPY_INITIAL_MODEL
  delete env.HAPPY_INITIAL_MODEL
  if (typeof raw !== 'string') return null
  const model = raw.trim()
  return model.length > 0 ? model : null
}

function isZaiClaudeRuntime(env: NodeJS.ProcessEnv): boolean {
  return env.ANTHROPIC_BASE_URL === 'https://api.z.ai/api/anthropic'
}

export function normalizeClaudeModelForRuntime(
  model: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (!isZaiClaudeRuntime(env) || !model) return model
  if (model === 'fable' || model.startsWith('claude-fable-')) return undefined
  if (model === 'default') return ZAI_CLAUDE_DEFAULT_MODEL
  if (model.startsWith('claude-opus-')) return 'opus'
  if (model.startsWith('claude-sonnet-')) return 'sonnet'
  if (model.startsWith('claude-haiku-')) return 'haiku'
  return model
}

/**
 * The model a session runs when the spawn named none.
 *
 * This — not the 'default' string — is the real Default path: the web UI omits
 * meta.model entirely for a Default selection and its spawn RPC has no model
 * parameter at all, so nothing reaches normalizeClaudeModelForRuntime. Letting
 * the plain CLI fallback ('opus') stand would resolve to glm-5.3 on Z.AI, ~18x
 * the input price of the flash model the product defaults to. The caller keeps
 * owning the non-Z.AI fallback so ordinary Claude sessions are untouched.
 */
export function defaultClaudeModelForRuntime(
  env: NodeJS.ProcessEnv,
  fallback: string | undefined,
): string | undefined {
  return isZaiClaudeRuntime(env) ? ZAI_CLAUDE_DEFAULT_MODEL : fallback
}

/**
 * Read the daemon-provided initial effort seed exactly once
 * (HAPPY_INITIAL_EFFORT). Validation against the agent's accepted set is the
 * caller's job — accepted values differ per agent (Claude vs Codex).
 */
export function consumePendingInitialEffort(env: NodeJS.ProcessEnv): string | null {
  const raw = env.HAPPY_INITIAL_EFFORT
  delete env.HAPPY_INITIAL_EFFORT
  if (typeof raw !== 'string') return null
  const effort = raw.trim()
  return effort.length > 0 ? effort : null
}

export function consumePendingInitialSaycodeSystemPromptEnabled(
  env: NodeJS.ProcessEnv,
): boolean | undefined {
  const raw = env.HAPPY_INITIAL_SAYCODE_SYSTEM_PROMPT_ENABLED
  delete env.HAPPY_INITIAL_SAYCODE_SYSTEM_PROMPT_ENABLED
  if (raw === 'true') return true
  if (raw === 'false') return false
  return undefined
}

/**
 * Per-block Saycode overrides for a daemon-seeded first turn, as JSON in
 * HAPPY_INITIAL_SAYCODE_PROMPT_BLOCKS. Consumed exactly once (read + delete) like
 * every other HAPPY_INITIAL_* seed so children never inherit it. A malformed value
 * degrades to undefined — legacy master inheritance — mirroring MessageMetaSchema's
 * catch(undefined) on the wire; non-boolean entries are dropped so one bad value
 * cannot flip a block.
 */
export function consumePendingInitialSaycodePromptBlocks(
  env: NodeJS.ProcessEnv,
): Record<string, boolean> | undefined {
  const raw = env.HAPPY_INITIAL_SAYCODE_PROMPT_BLOCKS
  delete env.HAPPY_INITIAL_SAYCODE_PROMPT_BLOCKS
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const blocks = Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'),
    )
    return Object.keys(blocks).length > 0 ? blocks : undefined
  } catch {
    return undefined
  }
}

export function consumePendingInitialAppendSystemPrompt(
  env: NodeJS.ProcessEnv,
): string | undefined {
  const raw = env.HAPPY_INITIAL_APPEND_SYSTEM_PROMPT
  delete env.HAPPY_INITIAL_APPEND_SYSTEM_PROMPT
  return raw && raw.trim().length > 0 ? raw : undefined
}

/**
 * Whether this launch was asked for confirmed delivery of its initial prompt.
 *
 * The daemon sets this on a managed spawn, after the caller's environment has
 * been merged, and the caller's own `HAPPY_MANAGED_` keys are stripped before
 * that — so an external RPC cannot turn it on or off.
 *
 * It is a **behaviour switch only**. It grants no identity, ACL or fencing
 * authority, and nothing downstream may treat its presence as proof of
 * anything about the runtime. A trusted launch descriptor is T09's work.
 */
export function consumeConfirmedInitialPromptDelivery(env: NodeJS.ProcessEnv): boolean {
  const raw = env.HAPPY_MANAGED_REQUIRE_PROMPT_ACK
  // Consumed like the prompt itself: a child this session spawns must not
  // inherit a delivery guarantee that was decided for its parent.
  delete env.HAPPY_MANAGED_REQUIRE_PROMPT_ACK
  return raw === '1'
}

export function consumePendingInitialPromptLocalId(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.HAPPY_INITIAL_PROMPT_LOCAL_ID
  delete env.HAPPY_INITIAL_PROMPT_LOCAL_ID
  if (typeof raw !== 'string') return undefined
  const localId = raw.trim()
  return localId.length > 0 ? localId : undefined
}

export function resolveInitialPromptPermissionMode(
  currentMode: PermissionMode,
  automationResume: boolean,
): PermissionMode {
  return automationResume ? 'bypassPermissions' : currentMode
}

/** Build the synthetic user record used to make a daemon prompt visible in history. */
export function buildInitialPromptUserRecord(text: string, happySessionId: string | null): RawJSONLines {
  return {
    type: 'user',
    uuid: randomUUID(),
    parentUuid: null,
    isSidechain: false,
    sessionId: happySessionId ?? 'unknown',
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: text },
  } as RawJSONLines
}

/**
 * Begins waiting for one enqueued message to be durably acknowledged.
 *
 * Called **before** the message is enqueued: the returned promise must already
 * be registered when the send happens, or a flush that starts immediately
 * afterwards resolves the acknowledgement with nobody listening.
 *
 * `ok: false` means the acknowledgement was not observed — durability is
 * unknown, which is not the same as the message having been lost.
 */
export type ConfirmInitialPromptDelivery = (localId: string) => Promise<{ ok: boolean; reason?: string }>

export class InitialPromptNotDurableError extends Error {
  constructor(readonly reason: string) {
    super(`initial prompt durability unknown (${reason}); refusing to start the turn`)
    this.name = 'InitialPromptNotDurableError'
  }
}
