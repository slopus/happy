/* ─────────────────────────────────────────────────────────────────────────
 * Wire protocol between renderer / main / agent worker.
 *
 * The worker hosts @anthropic-ai/claude-agent-sdk. Sessions are streamed
 * via the SDK's "streaming input" mode so we can push follow-up messages
 * into a live conversation, interrupt the current turn, or stop entirely.
 *
 * Session ids are CALLER-PROVIDED UUIDs (the SDK's `options.sessionId`
 * accepts a caller UUID). That keeps the renderer in charge of identity
 * and removes the need for a clientId↔sdkId lookup table.
 * ──────────────────────────────────────────────────────────────────────── */

export type AgentEffort = 'low' | 'medium' | 'high' | 'max'
export type AgentPermissionMode =
    | 'default'
    | 'acceptEdits'
    | 'bypassPermissions'
    | 'plan'
    | 'dontAsk'

export interface AgentStartOptions {
    /** Anthropic API key. Optional — the worker falls back to whatever
     *  ANTHROPIC_API_KEY is in its own environment. The SDK has no other
     *  auth path. */
    apiKey?: string
    /** Optional Claude model id, e.g. `claude-opus-4-7`. */
    model?: string
    /** Optional reasoning effort. */
    effort?: AgentEffort
    /** Optional permission mode (defaults to `default`). */
    permissionMode?: AgentPermissionMode
    /** Optional working directory the SDK uses for built-in tools and
     *  session persistence (`~/.claude/projects/<encoded-cwd>`). */
    cwd?: string
    /** Custom system prompt, or omit to use the SDK default. */
    systemPrompt?: string
    /** When true, fork the resumed session into a new one (rare). */
    forkSession?: boolean
}

/* ─────────── Renderer → worker (via main) ─────────── */

export type ToWorker =
    /** Begin or resume a session.
     *
     *  - `resume=false` → a brand-new session pinned to `sessionId`
     *  - `resume=true`  → load history from `sessionId`, then send `prompt`
     *
     *  Either way, `prompt` is the first user message of this run. */
    | {
        kind: 'start'
        sessionId: string
        prompt: string
        resume: boolean
        options: AgentStartOptions
      }
    /** Push a new user message into a live session. Queues if the assistant
     *  is mid-turn; takes effect at the next turn boundary. */
    | { kind: 'send'; sessionId: string; text: string }
    /** Interrupt the current assistant turn. Session stays alive; further
     *  `send` calls continue the conversation. */
    | { kind: 'interrupt'; sessionId: string }
    /** End the session: closes the streaming-input iterable, the underlying
     *  CLI process exits, and the SDK's session file is finalized. */
    | { kind: 'stop'; sessionId: string }

/* ─────────── Worker → renderer (via main) ─────────── */

/** Normalized event the renderer cares about. The worker translates raw
 *  `SDKMessage` values into these so the renderer doesn't have to import
 *  the SDK types. Index identifies which content block of the current
 *  assistant turn the delta belongs to (text + thinking + tool_use
 *  interleave). */
export type AgentEvent =
    | { type: 'session_init'; sessionId: string; model?: string }
    /** A new assistant message is about to start. Lets the renderer split
     *  multi-step turns (text → tool → text) into discrete chat rows. */
    | { type: 'assistant_turn_started' }
    /** Token-level deltas during streaming. */
    | { type: 'text_delta'; index: number; delta: string }
    | { type: 'thinking_delta'; index: number; delta: string }
    /** Tool-use block start — id/name known, input still streaming. */
    | { type: 'tool_use_start'; id: string; name: string }
    /** Tool-use input arguments arriving as JSON deltas. The worker
     *  resolves Anthropic's per-message block index to the tool id so
     *  the renderer doesn't have to track message boundaries. */
    | { type: 'tool_use_input_delta'; toolId: string; delta: string }
    /** Authoritative snapshot of a completed assistant message. Sent
     *  once the SDK delivers the full message, AFTER all stream deltas.
     *  The renderer replaces the row's text/thinking/tool inputs with
     *  this — keeps streamed deltas and final state from coexisting at
     *  different block indices and double-rendering. */
    | {
        type: 'assistant_complete'
        text: string
        thinking?: string
        toolUses: { id: string; name: string; input: Record<string, unknown> }[]
      }
    | { type: 'tool_result'; toolUseId: string; output: string; isError?: boolean }
    | {
        type: 'turn_done'
        subtype: 'success' | 'error'
        result?: string
        costUsd?: number
        error?: string
      }
    | { type: 'error'; message: string }

export type FromWorker =
    | { kind: 'event'; sessionId: string; event: AgentEvent }
    /** Streaming input for this session has been closed (worker cleaned up). */
    | { kind: 'closed'; sessionId: string }
    /** Worker-level fatal (e.g. uncaught exception). Not session-scoped. */
    | { kind: 'fatal'; error: string }
