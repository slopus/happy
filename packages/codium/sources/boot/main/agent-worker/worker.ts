/* ─────────────────────────────────────────────────────────────────────────
 * Agent worker — runs in a node:worker_threads child spawned by main.
 *
 * Hosts @anthropic-ai/claude-agent-sdk and exposes a small session-oriented
 * API to the renderer (start / send / interrupt / stop). Each session uses
 * the SDK's streaming-input mode so we can:
 *   - push follow-up user messages mid-conversation,
 *   - call query.interrupt() to abort the current turn without ending
 *     the session,
 *   - close the input stream to wind the session down cleanly.
 *
 * Session ids are caller-provided UUIDs forwarded as `options.sessionId`.
 * The SDK persists each session's transcript to ~/.claude/projects/<cwd>/
 * keyed on that id, so resuming just means starting a new query() with
 * `resume: sessionId`.
 * ──────────────────────────────────────────────────────────────────────── */
import { parentPort } from 'node:worker_threads'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { query, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent, AgentStartOptions, FromWorker, ToWorker } from '../../../shared/agent-protocol'
import { buildCodexExecArgs } from './codex-cli'

if (!parentPort) {
    throw new Error('agent worker must be started via worker_threads')
}
const port = parentPort
const send = (m: FromWorker) => port.postMessage(m)
const nodeRequire = createRequire(import.meta.url)

type SessionState = ClaudeSessionState | CodexSessionState

interface ClaudeSessionState {
    engine: 'claude'
    /** SDK Query for this session; lets us call .interrupt() and iterate. */
    q: Query
    /** Push end of the streaming-input iterable. Resolves the next pending
     *  pull, or buffers when nothing is waiting. */
    pushInput: (msg: SDKUserMessage) => void
    /** Call to close the streaming-input iterable (wind session down). */
    closeInput: () => void
    /** Promise that resolves when the consume loop ends. */
    consumed: Promise<void>
    /** content_block index → tool_use id, for the currently streaming
     *  assistant message. Each new content_block_start for a tool_use
     *  overwrites its slot, so we don't need explicit message-boundary
     *  resets — entries are stale only until the next tool_use lands. */
    toolIndex: Map<number, string>
}

interface CodexSessionState {
    engine: 'codex'
    child: ChildProcessWithoutNullStreams
    stop(): void
}

const sessions = new Map<string, SessionState>()

port.on('message', (msg: ToWorker) => {
    Promise.resolve()
        .then(() => handle(msg))
        .catch((err) => {
            // Per-session errors are reported as session events; anything that
            // escapes here is treated as a worker fatal (the worker stays up).
            // eslint-disable-next-line no-console
            console.error('[agent-worker] handler error:', err)
            send({ kind: 'fatal', error: err instanceof Error ? err.message : String(err) })
        })
})

async function handle(msg: ToWorker): Promise<void> {
    if (msg.kind === 'start') {
        await startSession(msg.sessionId, msg.prompt, msg.resume, msg.options)
        return
    }
    if (msg.kind === 'send') {
        const s = sessions.get(msg.sessionId)
        if (!s) {
            emit(msg.sessionId, {
                type: 'error',
                message: 'send: session is not active. Call start with resume:true first.',
            })
            return
        }
        if (s.engine !== 'claude') {
            emit(msg.sessionId, {
                type: 'error',
                message: 'Codex CLI turns are one-shot. Start a new turn after the current process closes.',
            })
            return
        }
        s.pushInput(makeUserMessage(msg.sessionId, msg.text))
        return
    }
    if (msg.kind === 'interrupt') {
        const s = sessions.get(msg.sessionId)
        if (!s) return
        if (s.engine === 'codex') {
            s.stop()
            return
        }
        try {
            await s.q.interrupt()
        } catch (err) {
            emit(msg.sessionId, {
                type: 'error',
                message: `interrupt failed: ${errString(err)}`,
            })
        }
        return
    }
    if (msg.kind === 'stop') {
        const s = sessions.get(msg.sessionId)
        if (!s) return
        if (s.engine === 'codex') {
            s.stop()
            return
        }
        s.closeInput()
        // Don't await `consumed` here — the consume loop will emit `closed`
        // itself when the SDK actually winds down. Keeping handle() snappy
        // matters because all sessions share this thread.
    }
}

/* ─────────── session lifecycle ─────────── */

async function startSession(
    sessionId: string,
    initialPrompt: string,
    resume: boolean,
    options: AgentStartOptions,
): Promise<void> {
    if (sessions.has(sessionId)) {
        emit(sessionId, {
            type: 'error',
            message: 'start: session already active. Send instead, or stop first.',
        })
        return
    }
    if (options.engine === 'codex') {
        await startCodexTurn(sessionId, initialPrompt, options)
        return
    }

    // Streaming-input plumbing: an async iterable backed by a tiny push
    // queue so the renderer can drop messages in at any point.
    const input = createInputStream()
    input.push(makeUserMessage(sessionId, initialPrompt))

    // Auth: by default, defer to whatever the bundled Claude Code CLI is
    // already configured with (system `claude login` credentials, or
    // ANTHROPIC_API_KEY in the inherited env). Only override the key when
    // the renderer explicitly passes one in.
    if (options.apiKey) {
        process.env.ANTHROPIC_API_KEY = options.apiKey
    }

    const q = query({
        prompt: input.iterable,
        options: {
            // Caller-provided UUID is the SDK session id (when not resuming).
            ...(resume ? { resume: sessionId } : { sessionId }),
            model: options.model,
            effort: options.effort,
            // Bypass permissions so chat tool calls fire end-to-end without
            // a permission UI. The companion `allowDangerouslySkipPermissions`
            // flag is required by the SDK as a deliberate ack.
            permissionMode: options.permissionMode ?? 'bypassPermissions',
            allowDangerouslySkipPermissions: true,
            cwd: options.cwd,
            // No filesystem settings — keep the SDK isolated from any
            // ~/.claude/settings the user may have. This also avoids loading
            // CLAUDE.md from random project dirs.
            settingSources: [],
            // Full Claude Code toolset (Read/Write/Bash/Edit/etc.). Required
            // for the agent to actually do anything beyond plain chat.
            tools: { type: 'preset', preset: 'claude_code' },
            ...(options.systemPrompt !== undefined
                ? { systemPrompt: options.systemPrompt }
                : {}),
            ...(resume && options.forkSession ? { forkSession: true } : {}),
            // Token-level streaming for text + thinking. Without this we
            // only see whole-block messages at the end of a turn.
            includePartialMessages: true,
            pathToClaudeCodeExecutable: resolveClaudeExecutable(),
        },
    })

    const state: ClaudeSessionState = {
        engine: 'claude',
        q,
        pushInput: input.push,
        closeInput: input.close,
        // Filled in below.
        consumed: Promise.resolve(),
        toolIndex: new Map(),
    }
    sessions.set(sessionId, state)
    state.consumed = consume(sessionId, state).finally(() => {
        sessions.delete(sessionId)
        send({ kind: 'closed', sessionId })
    })
}

async function startCodexTurn(
    sessionId: string,
    prompt: string,
    options: AgentStartOptions,
): Promise<void> {
    const tmp = await mkdtemp(join(tmpdir(), 'codium-codex-'))
    const outputPath = join(tmp, 'last-message.txt')
    const { executable, extraPathDirs } = resolveCodexExecutable()
    const args = buildCodexExecArgs({
        prompt,
        outputPath,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.model ? { model: options.model } : {}),
    })
    emit(sessionId, { type: 'assistant_turn_started' })
    const child = spawn(executable, args, {
        cwd: options.cwd,
        env: {
            ...process.env,
            PATH: withPrependedPath(extraPathDirs),
        },
    })
    const state: CodexSessionState = {
        engine: 'codex',
        child,
        stop() {
            try {
                child.kill('SIGINT')
            } catch {
                /* ignored */
            }
        },
    }
    sessions.set(sessionId, state)

    let stderr = ''
    child.stdout.on('data', () => {
        // Codex --json can be verbose. Drain stdout so the child cannot
        // block on a full pipe; the final assistant text is read from
        // --output-last-message for a stable renderer contract.
    })
    child.stderr.on('data', (chunk) => {
        stderr += chunk.toString()
    })

    child.on('error', (err) => {
        emit(sessionId, { type: 'error', message: errString(err) })
    })

    child.on('exit', async (code, signal) => {
        sessions.delete(sessionId)
        try {
            if (existsSync(outputPath)) {
                const text = await readFile(outputPath, 'utf8')
                if (text.trim().length > 0) {
                    emit(sessionId, {
                        type: 'assistant_complete',
                        text,
                        toolUses: [],
                    })
                }
            }
            if (code === 0) {
                emit(sessionId, { type: 'turn_done', subtype: 'success' })
            } else {
                emit(sessionId, {
                    type: 'turn_done',
                    subtype: 'error',
                    error: stderr.trim() || (signal ? `Codex exited via ${signal}` : `Codex exited with code ${code}`),
                })
            }
        } catch (err) {
            emit(sessionId, { type: 'error', message: errString(err) })
        } finally {
            await rm(tmp, { recursive: true, force: true }).catch(() => {})
            send({ kind: 'closed', sessionId })
        }
    })
}

async function consume(sessionId: string, state: ClaudeSessionState): Promise<void> {
    try {
        for await (const msg of state.q) {
            const events = mapSdkMessage(msg, state)
            for (const ev of events) emit(sessionId, ev)
        }
    } catch (err) {
        emit(sessionId, { type: 'error', message: errString(err) })
    }
}

/* ─────────── streaming input plumbing ─────────── */

interface InputStream {
    iterable: AsyncIterable<SDKUserMessage>
    push(msg: SDKUserMessage): void
    close(): void
}

function createInputStream(): InputStream {
    const buffer: SDKUserMessage[] = []
    let pending: ((r: IteratorResult<SDKUserMessage>) => void) | null = null
    let closed = false

    const iterable: AsyncIterable<SDKUserMessage> = {
        [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
            return {
                next(): Promise<IteratorResult<SDKUserMessage>> {
                    if (buffer.length > 0) {
                        return Promise.resolve({ value: buffer.shift()!, done: false })
                    }
                    if (closed) return Promise.resolve({ value: undefined, done: true })
                    return new Promise((resolve) => {
                        pending = resolve
                    })
                },
                return(): Promise<IteratorResult<SDKUserMessage>> {
                    closed = true
                    return Promise.resolve({ value: undefined, done: true })
                },
            }
        },
    }

    return {
        iterable,
        push(msg) {
            if (closed) return
            if (pending) {
                const p = pending
                pending = null
                p({ value: msg, done: false })
            } else {
                buffer.push(msg)
            }
        },
        close() {
            if (closed) return
            closed = true
            if (pending) {
                const p = pending
                pending = null
                p({ value: undefined, done: true })
            }
        },
    }
}

function makeUserMessage(sessionId: string, text: string): SDKUserMessage {
    return {
        type: 'user',
        session_id: sessionId,
        parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'text', text }] },
    }
}

/* ─────────── SDK → renderer event normalization ─────────── */

function mapSdkMessage(msg: SDKMessage, state: ClaudeSessionState): AgentEvent[] {
    if (msg.type === 'system' && msg.subtype === 'init') {
        return [{ type: 'session_init', sessionId: msg.session_id, model: msg.model }]
    }
    if (msg.type === 'stream_event') {
        // Token-level streaming. Anthropic's raw event shape:
        //   content_block_start { index, content_block: { type, ... } }
        //   content_block_delta { index, delta: { type, text|thinking|partial_json|... } }
        // We forward text/thinking deltas and tool_use start + input deltas;
        // everything else (signatures, citations, message_*) is metadata
        // we don't render yet.
        const ev = msg.event as {
            type: string
            index?: number
            content_block?: { type: string; id?: string; name?: string }
            delta?: { type: string; text?: string; thinking?: string; partial_json?: string }
        }
        if (ev.type === 'message_start') {
            return [{ type: 'assistant_turn_started' }]
        }
        if (ev.type === 'content_block_start' && typeof ev.index === 'number' && ev.content_block) {
            if (ev.content_block.type === 'tool_use' && ev.content_block.id && ev.content_block.name) {
                state.toolIndex.set(ev.index, ev.content_block.id)
                return [
                    {
                        type: 'tool_use_start',
                        id: ev.content_block.id,
                        name: ev.content_block.name,
                    },
                ]
            }
            return []
        }
        if (ev.type === 'content_block_delta' && typeof ev.index === 'number' && ev.delta) {
            if (ev.delta.type === 'text_delta' && typeof ev.delta.text === 'string') {
                return [{ type: 'text_delta', index: ev.index, delta: ev.delta.text }]
            }
            if (ev.delta.type === 'thinking_delta' && typeof ev.delta.thinking === 'string') {
                return [{ type: 'thinking_delta', index: ev.index, delta: ev.delta.thinking }]
            }
            if (ev.delta.type === 'input_json_delta' && typeof ev.delta.partial_json === 'string') {
                const toolId = state.toolIndex.get(ev.index)
                if (!toolId) return []
                return [{ type: 'tool_use_input_delta', toolId, delta: ev.delta.partial_json }]
            }
        }
        return []
    }
    if (msg.type === 'assistant') {
        // Full assistant message — fire ONE authoritative snapshot. The
        // renderer uses this to replace any partial state it accumulated
        // from stream deltas, so we don't double-render content.
        const text: string[] = []
        const thinking: string[] = []
        const toolUses: { id: string; name: string; input: Record<string, unknown> }[] = []
        for (const block of msg.message.content) {
            if (block.type === 'text') {
                text.push(block.text)
            } else if (block.type === 'thinking') {
                thinking.push(block.thinking)
            } else if (block.type === 'tool_use') {
                toolUses.push({
                    id: block.id,
                    name: block.name,
                    input: (block.input as Record<string, unknown>) ?? {},
                })
            }
        }
        const joinedThinking = thinking.join('')
        return [
            {
                type: 'assistant_complete',
                text: text.join(''),
                ...(joinedThinking ? { thinking: joinedThinking } : {}),
                toolUses,
            },
        ]
    }
    if (msg.type === 'user') {
        // Surface tool_result content from the user-echo stream so the
        // renderer can render tool outcomes inline.
        const content = msg.message.content
        if (typeof content === 'string') return []
        const out: AgentEvent[] = []
        for (const block of content) {
            if (block.type === 'tool_result') {
                const c = block.content
                let text = ''
                if (typeof c === 'string') text = c
                else if (Array.isArray(c)) {
                    for (const part of c) {
                        if (part.type === 'text') text += part.text
                    }
                }
                out.push({
                    type: 'tool_result',
                    toolUseId: block.tool_use_id,
                    output: text,
                    isError: block.is_error === true,
                })
            }
        }
        return out
    }
    if (msg.type === 'result') {
        if (msg.subtype === 'success') {
            return [
                {
                    type: 'turn_done',
                    subtype: 'success',
                    result: msg.result,
                    costUsd: msg.total_cost_usd,
                },
            ]
        }
        return [
            {
                type: 'turn_done',
                subtype: 'error',
                error: msg.errors?.join('; ') || msg.subtype,
                costUsd: msg.total_cost_usd,
            },
        ]
    }
    return []
}

function emit(sessionId: string, event: AgentEvent): void {
    send({ kind: 'event', sessionId, event })
}

function resolveClaudeExecutable(): string {
    if (process.platform !== 'darwin') {
        throw new Error('Bundled Claude Agent SDK binary is currently configured for macOS only.')
    }
    const pkg = process.arch === 'arm64'
        ? '@anthropic-ai/claude-agent-sdk-darwin-arm64'
        : '@anthropic-ai/claude-agent-sdk-darwin-x64'
    const packageJson = nodeRequire.resolve(`${pkg}/package.json`)
    return join(dirname(packageJson), 'claude')
}

function resolveCodexExecutable(): { executable: string; extraPathDirs: string[] } {
    if (process.platform !== 'darwin') {
        throw new Error('Bundled Codex binary is currently configured for macOS only.')
    }
    const targetTriple = process.arch === 'arm64'
        ? 'aarch64-apple-darwin'
        : 'x86_64-apple-darwin'
    const pkg = process.arch === 'arm64'
        ? '@openai/codex-darwin-arm64'
        : '@openai/codex-darwin-x64'
    const packageJson = nodeRequire.resolve(`${pkg}/package.json`)
    const vendorRoot = join(dirname(packageJson), 'vendor', targetTriple)
    return {
        executable: join(vendorRoot, 'codex', 'codex'),
        extraPathDirs: [join(vendorRoot, 'path')],
    }
}

function withPrependedPath(dirs: string[]): string {
    const separator = process.platform === 'win32' ? ';' : ':'
    return [
        ...dirs.filter((dir) => existsSync(dir)),
        ...(process.env.PATH ?? '').split(separator).filter(Boolean),
    ].join(separator)
}

function errString(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}

process.on('uncaughtException', (err) => {
    send({ kind: 'fatal', error: errString(err) })
})
