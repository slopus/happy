/**
 * Agy AgentBackend Implementation
 *
 * Agy's print-mode stream contains response fragments, a complete terminal
 * response, and tool lifecycle records. Happy needs fragments buffered into
 * complete progress messages, without replaying the terminal aggregate, and
 * tool calls translated to its native card schemas.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { PermissionMode } from '@/api/types';
import type {
  AgentBackend,
  AgentMessage,
  AgentMessageHandler,
  SessionId,
  StartSessionResult,
} from '@/agent/core/AgentBackend';
import { CHANGE_TITLE_INSTRUCTION } from '@/gemini/constants';
import { resolveAgyBin, AGY_PRINT_TIMEOUT } from './constants';
import { agySkipsPermissions, buildAgyArgs } from './cliArgs';
import { readAgyConversationId } from './conversationStore';

/** Signature of node's `spawn`, injectable so tests can supply a fake process. */
export type SpawnFn = typeof spawn;

export interface AgyBackendOptions {
  /** Working directory the agy process runs in (and the conversation cache key). */
  cwd: string;
  /** Initial permission mode; updated per turn from message meta. */
  permissionMode: PermissionMode;
  /** Initial model display name; updated per turn from message meta. */
  model?: string;
  /** Value for `--print-timeout`. Defaults to AGY_PRINT_TIMEOUT. */
  printTimeout?: string;
  /** Optional logger. */
  log?: (msg: string) => void;
  /** Injectable spawn (defaults to node's child_process.spawn). */
  spawnFn?: SpawnFn;
  /** Optional override for resolving the resume conversation id (tests). */
  resolveConversationId?: (cwd: string) => string | null;
  /** Environment inherited by each agy child process. */
  env?: NodeJS.ProcessEnv;
  /** Sets a safe fallback title when sandbox mode cannot approve the MCP call. */
  onTitle?: (title: string) => void;
}

type DisplayTool = {
  toolName: string;
  args: Record<string, unknown>;
};

const MAX_STREAM_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_TOOL_CALLS_PER_TURN = 512;
const MAX_AGENT_RESPONSE_STEPS = 512;
const MAX_TOOL_NAME_BYTES = 128;
const MAX_TOOL_STEP_INDEX = 1_000_000;
const MAX_TOOL_ARG_BYTES = 4096;
const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;
const VISIBLE_OUTPUT_TOOLS = new Set([
  'call_mcp_tool',
  'manage_task',
  'run_command',
  'search_web',
]);
const TITLE_ALREADY_SET_INSTRUCTION =
  'Happy has already set the session title for this turn. Do not call happy.change_title or any other title tool.';
const MAX_FALLBACK_TITLE_CHARS = 60;

function fallbackTitle(prompt: string): string | null {
  const compact = prompt.replace(/\s+/g, ' ').trim();
  if (!compact) return null;
  const chars = [...compact];
  if (chars.length <= MAX_FALLBACK_TITLE_CHARS) return compact.replace(/[.!?]+$/, '');
  const prefix = chars.slice(0, MAX_FALLBACK_TITLE_CHARS - 1).join('');
  const wordBoundary = prefix.lastIndexOf(' ');
  const shortened = wordBoundary >= 30 ? prefix.slice(0, wordBoundary) : prefix;
  return `${shortened.replace(/[\s.!?,;:]+$/, '')}…`;
}

const CREDENTIAL_CARRIER_PATTERNS = [
  /\b(?:Bearer|Basic)\s+\S+/i,
  /\b[a-z0-9_-]*(?:authorization|cookie|credential|password|private[-_]?key|secret|token|api[-_]?key)[a-z0-9_-]*["']?\s*(?:=|:)\s*\S+/i,
  /(?:^|\s)--?[a-z0-9_-]*(?:authorization|cookie|credential|password|private[-_]?key|secret|token|api[-_]?key)[a-z0-9_-]*\s+\S+/i,
  /(?:^|\s)(?:-u|--user)(?:=|\s)\s*\S+/i,
  /[a-z][a-z0-9+.-]*:\/\/[^/\s@]+@/i,
];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function truncateUtf8(value: string, maxBytes = MAX_TOOL_ARG_BYTES): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const prefix = Buffer.from(value)
    .subarray(0, maxBytes - 3)
    .toString('utf8')
    .replace(/\uFFFD$/, '');
  return `${prefix}...`;
}

function safeString(value: unknown, redacted = '[redacted]'): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const truncated = truncateUtf8(value);
  return CREDENTIAL_CARRIER_PATTERNS.some((pattern) => pattern.test(truncated))
    ? redacted
    : truncated;
}

function safeToolOutput(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const truncated = truncateUtf8(value, MAX_TOOL_OUTPUT_BYTES);
  return CREDENTIAL_CARRIER_PATTERNS.some((pattern) => pattern.test(truncated))
    ? '[redacted output]'
    : truncated;
}

function safeLine(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function safeToolName(value: string): string {
  if (Buffer.byteLength(value, 'utf8') > MAX_TOOL_NAME_BYTES) return 'agy_tool';
  return /^[a-zA-Z0-9_.:-]+$/.test(value) ? value : 'agy_tool';
}

/** Copy only known scalar inputs and translate them to Happy's native cards. */
function displayTool(toolName: string, parameters: unknown): DisplayTool {
  const values = isPlainRecord(parameters) ? parameters : {};
  const fallback = { toolName: safeToolName(toolName), args: {} };

  switch (toolName.toLowerCase()) {
    case 'list_dir': {
      const path = safeString(values.DirectoryPath);
      return { toolName: 'LS', args: path ? { path } : {} };
    }
    case 'view_file':
    case 'sed_file': {
      const filePath = safeString(values.AbsolutePath);
      const offset = safeLine(values.StartLine);
      const endLine = safeLine(values.EndLine);
      const limit = offset !== undefined && endLine !== undefined && endLine >= offset
        ? endLine - offset + 1
        : undefined;
      return {
        toolName: 'Read',
        args: {
          ...(filePath ? { file_path: filePath } : {}),
          ...(offset !== undefined ? { offset } : {}),
          ...(limit !== undefined ? { limit } : {}),
        },
      };
    }
    case 'run_command': {
      const command = safeString(values.CommandLine, '[redacted command]');
      return { toolName: 'Bash', args: command ? { command } : {} };
    }
    case 'replace_file_content': {
      const filePath = safeString(values.TargetFile);
      return { toolName: 'Edit', args: filePath ? { file_path: filePath } : {} };
    }
    case 'write_to_file': {
      const filePath = safeString(values.TargetFile);
      return { toolName: 'Write', args: filePath ? { file_path: filePath } : {} };
    }
    case 'manage_task': {
      const action = values.Action === 'status' || values.Action === 'kill' ? values.Action : undefined;
      const taskId = safeString(values.TaskId)?.split('/').filter(Boolean).at(-1);
      const command = ['manage_task', action, taskId].filter(Boolean).join(' ');
      return { toolName: 'Bash', args: { command } };
    }
    case 'call_mcp_tool': {
      const server = safeString(values.ServerName);
      const tool = safeString(values.ToolName);
      const target = [server, tool].filter(Boolean).join('.');
      return { toolName: 'Bash', args: { command: target ? `mcp ${target}` : 'mcp tool' } };
    }
    case 'search_web': {
      const query = safeString(values.query);
      return { toolName: 'WebSearch', args: query ? { query } : {} };
    }
    case 'grep_search': {
      const pattern = safeString(values.Query);
      const path = safeString(values.SearchPath);
      return {
        toolName: 'Grep',
        args: { ...(pattern ? { pattern } : {}), ...(path ? { path } : {}) },
      };
    }
    case 'find_by_name': {
      const pattern = safeString(values.Pattern);
      const path = safeString(values.SearchDirectory);
      return {
        toolName: 'Glob',
        args: { ...(pattern ? { pattern } : {}), ...(path ? { path } : {}) },
      };
    }
    case 'open_browser_url':
    case 'read_url_content': {
      const url = safeString(values.Url);
      return { toolName: 'WebFetch', args: url ? { url } : {} };
    }
    default:
      return fallback;
  }
}

/** Parse an agy duration string ("10m", "30s", "1h") to milliseconds; defaults to 10m. */
function parsePrintTimeoutMs(value: string): number {
  const m = /^(\d+)\s*(s|m|h)$/.exec(value.trim());
  if (!m) return 10 * 60_000;
  const n = Number(m[1]);
  return m[2] === 'h' ? n * 3_600_000 : m[2] === 'm' ? n * 60_000 : n * 1_000;
}

export class AgyBackend implements AgentBackend {
  private readonly handlers = new Set<AgentMessageHandler>();
  private readonly cwd: string;
  private readonly printTimeout: string;
  private readonly log: (msg: string) => void;
  private readonly spawnFn: SpawnFn;
  private readonly resolveConversationId: (cwd: string) => string | null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly onTitle?: (title: string) => void;

  private permissionMode: PermissionMode;
  private model?: string;
  private conversationId: string | null = null;
  private child: ChildProcess | null = null;
  private turnSequence = 0;

  constructor(opts: AgyBackendOptions) {
    this.cwd = opts.cwd;
    this.permissionMode = opts.permissionMode;
    this.model = opts.model;
    this.printTimeout = opts.printTimeout ?? AGY_PRINT_TIMEOUT;
    this.log = opts.log ?? (() => {});
    this.spawnFn = opts.spawnFn ?? spawn;
    this.resolveConversationId = opts.resolveConversationId ?? readAgyConversationId;
    this.env = opts.env ?? process.env;
    this.onTitle = opts.onTitle;
  }

  /** Update the permission mode applied to subsequent turns. */
  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
  }

  /** Update the model applied to subsequent turns. */
  setModel(model: string | undefined): void {
    this.model = model;
  }

  async startSession(): Promise<StartSessionResult> {
    // agy spawns lazily per prompt; there is nothing long-lived to start.
    // Deliberately do NOT seed from the cwd conversation cache: it holds whatever
    // conversation last ran in this cwd — possibly another live session's — so
    // seeding would cross-resume it. A fresh session starts a fresh conversation;
    // resuming a specific one across restarts needs explicit id plumbing (follow-up).
    return { sessionId: this.cwd };
  }

  async sendPrompt(_sessionId: SessionId, prompt: string): Promise<void> {
    const turnNumber = ++this.turnSequence;
    let turnPrompt = prompt;
    if (turnNumber === 1) {
      if (agySkipsPermissions(this.permissionMode)) {
        turnPrompt = `${prompt}\n\n${CHANGE_TITLE_INSTRUCTION}`;
      } else {
        const title = fallbackTitle(prompt);
        if (title) this.onTitle?.(title);
        turnPrompt = `${prompt}\n\n${TITLE_ALREADY_SET_INSTRUCTION}`;
      }
    }
    const args = buildAgyArgs({
      prompt: turnPrompt,
      model: this.model,
      conversationId: this.conversationId,
      permissionMode: this.permissionMode,
      addDirs: [this.cwd],
      printTimeout: this.printTimeout,
    });

    this.emit({ type: 'status', status: 'running' });

    // Until we have pinned our own conversation, snapshot the cwd cache so we can
    // tell after the turn whether the entry is ours (changed → our turn wrote it)
    // or a leftover from another session (unchanged → not ours to adopt).
    const preTurnCacheId =
      this.conversationId === null ? this.resolveConversationId(this.cwd) : null;

    await new Promise<void>((resolve, reject) => {
      const child = this.spawnFn(resolveAgyBin(), args, {
        cwd: this.cwd,
        env: this.env,
        windowsHide: true,
        // agy --print blocks until stdin reaches EOF. We never write stdin, so
        // give the child an empty stdin (immediate EOF) instead of an open pipe;
        // otherwise it hangs forever and the turn never completes.
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.child = child;

      let streamBuffer = '';
      let discardingOversizedRecord = false;
      let streamFailure: string | null = null;
      let resultSeen = false;
      let stderrBytes = 0;
      const startedToolCalls = new Set<string>();
      const endedToolCalls = new Set<string>();
      const agentResponseBuffers = new Map<number, string>();
      let streamedResponseText = '';
      let agentResponseBytes = 0;

      const emitAgentResponse = (stepIndex: number) => {
        const text = agentResponseBuffers.get(stepIndex);
        agentResponseBuffers.delete(stepIndex);
        if (!text) return;
        streamedResponseText += text;
        this.emit({ type: 'model-output', textDelta: text });
      };

      const handleRecord = (line: string) => {
        let record: unknown;
        try {
          record = JSON.parse(line) as unknown;
        } catch {
          this.log(`ignored malformed agy stream-json record (${Buffer.byteLength(line, 'utf8')} bytes)`);
          return;
        }
        if (!isPlainRecord(record)) {
          this.log(`ignored non-object agy stream-json record (${Buffer.byteLength(line, 'utf8')} bytes)`);
          return;
        }

        if (record.event === 'init') return;
        if (record.event === 'result') {
          if (resultSeen) return;
          resultSeen = true;
          for (const stepIndex of [...agentResponseBuffers.keys()].sort((a, b) => a - b)) {
            emitAgentResponse(stepIndex);
          }
          const result = isPlainRecord(record.result) ? record.result : {};
          if (result.status !== 'SUCCESS') {
            streamFailure = 'agy stream reported failure';
          } else if (typeof result.response === 'string' && result.response) {
            const remaining = result.response.startsWith(streamedResponseText)
              ? result.response.slice(streamedResponseText.length)
              : streamedResponseText
                ? ''
                : result.response;
            if (remaining) this.emit({ type: 'model-output', textDelta: remaining });
          }
          return;
        }
        if (record.event !== 'step_update' || !isPlainRecord(record.step_update)) return;

        const update = record.step_update;
        if (update.step_type === 'agent_response') {
          if (
            typeof update.step_index !== 'number'
            || !Number.isSafeInteger(update.step_index)
            || update.step_index < 0
            || update.step_index > MAX_TOOL_STEP_INDEX
          ) return;
          if (typeof update.text_delta === 'string' && update.text_delta) {
            if (
              !agentResponseBuffers.has(update.step_index)
              && agentResponseBuffers.size >= MAX_AGENT_RESPONSE_STEPS
            ) return;
            const deltaBytes = Buffer.byteLength(update.text_delta, 'utf8');
            if (agentResponseBytes + deltaBytes > MAX_STREAM_RECORD_BYTES) return;
            const current = agentResponseBuffers.get(update.step_index) ?? '';
            agentResponseBuffers.set(update.step_index, current + update.text_delta);
            agentResponseBytes += deltaBytes;
          }
          if (update.state === 'DONE') emitAgentResponse(update.step_index);
          return;
        }
        if (
          update.step_type !== 'tool'
          || typeof update.step_index !== 'number'
          || !Number.isSafeInteger(update.step_index)
          || update.step_index < 0
          || update.step_index > MAX_TOOL_STEP_INDEX
          || typeof update.tool_name !== 'string'
        ) return;

        const callId = `agy:${turnNumber}:${update.step_index}`;
        const toolInfo = isPlainRecord(update.tool_info) ? update.tool_info : {};
        const display = displayTool(update.tool_name, toolInfo.parameters);

        if (update.state === 'ACTIVE') {
          if (startedToolCalls.has(callId) || startedToolCalls.size >= MAX_TOOL_CALLS_PER_TURN) return;
          startedToolCalls.add(callId);
          this.emit({ type: 'tool-call', ...display, callId });
          return;
        }

        if (update.state !== 'DONE' && update.state !== 'ERROR') return;
        if (endedToolCalls.has(callId)) return;
        if (!startedToolCalls.has(callId)) {
          if (startedToolCalls.size >= MAX_TOOL_CALLS_PER_TURN) return;
          startedToolCalls.add(callId);
          this.emit({ type: 'tool-call', ...display, callId });
        }
        endedToolCalls.add(callId);
        const normalizedToolName = update.tool_name.toLowerCase();
        const toolOutput = VISIBLE_OUTPUT_TOOLS.has(normalizedToolName)
          ? safeToolOutput(toolInfo.output)
          : undefined;
        const toolResult: Record<string, unknown> = { status: update.state };
        if (toolOutput) {
          toolResult[update.state === 'ERROR' ? 'stderr' : 'stdout'] = toolOutput;
          this.emit({
            type: 'event',
            name: 'thinking',
            payload: { text: toolOutput, streaming: false },
          });
        }
        this.emit({
          type: 'tool-result',
          toolName: display.toolName,
          callId,
          result: toolResult,
        });
      };

      const handleStdoutChunk = (chunk: string) => {
        let remaining = chunk;
        while (remaining) {
          if (discardingOversizedRecord) {
            const newline = remaining.indexOf('\n');
            if (newline === -1) return;
            discardingOversizedRecord = false;
            remaining = remaining.slice(newline + 1);
            continue;
          }

          const newline = remaining.indexOf('\n');
          if (newline === -1) {
            const combinedBytes = Buffer.byteLength(streamBuffer, 'utf8')
              + Buffer.byteLength(remaining, 'utf8');
            if (combinedBytes > MAX_STREAM_RECORD_BYTES) {
              this.log(`ignored oversized agy stream-json record (>${MAX_STREAM_RECORD_BYTES} bytes)`);
              streamBuffer = '';
              discardingOversizedRecord = true;
            } else {
              streamBuffer += remaining;
            }
            return;
          }

          const prefix = remaining.slice(0, newline);
          const recordBytes = Buffer.byteLength(streamBuffer, 'utf8')
            + Buffer.byteLength(prefix, 'utf8');
          if (recordBytes > MAX_STREAM_RECORD_BYTES) {
            this.log(`ignored oversized agy stream-json record (${recordBytes} bytes)`);
          } else {
            const record = streamBuffer + prefix;
            if (record.trim()) handleRecord(record);
          }
          streamBuffer = '';
          remaining = remaining.slice(newline + 1);
        }
      };

      // Node can fire both 'error' and 'close' on spawn failure; act on the first only.
      let settled = false;
      const watchdog = setTimeout(() => {
        this.log(`agy turn exceeded ${this.printTimeout}; killing process`);
        child.kill('SIGKILL');
      }, parsePrintTimeoutMs(this.printTimeout) + 30_000);
      const cleanup = () => {
        clearTimeout(watchdog);
        if (this.child === child) {
          this.child = null;
        }
      };

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', handleStdoutChunk);

      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        stderrBytes += Buffer.byteLength(chunk, 'utf8');
      });

      child.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (stderrBytes > 0) this.log(`agy stderr suppressed (${stderrBytes} bytes)`);
        const detail = (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? `agy executable not found. Install the Antigravity CLI, or set HAPPY_AGY_PATH to its absolute path (tried 'agy' on PATH and ~/.local/bin/agy).`
          : err.message;
        this.emit({ type: 'status', status: 'error', detail });
        reject(err);
      });

      child.on('close', (code: number | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (stderrBytes > 0) this.log(`agy stderr suppressed (${stderrBytes} bytes)`);
        if (streamBuffer.trim()) {
          this.log(`ignored unterminated agy stream-json record (${Buffer.byteLength(streamBuffer, 'utf8')} bytes)`);
        }
        if (!resultSeen) {
          for (const stepIndex of [...agentResponseBuffers.keys()].sort((a, b) => a - b)) {
            emitAgentResponse(stepIndex);
          }
        }

        // Pin the conversation our first turn created so later turns resume it.
        // Once pinned, never re-read the cache: another session in the same cwd
        // may have updated it since, and adopting that id would cross-resume.
        // Best effort while unpinned: any concurrent same-cwd write that differs
        // from the pre-turn snapshot (another session's turn, or bare interactive
        // agy) would be adopted just the same — agy doesn't echo the id it
        // created, so we cannot attribute the cache entry more precisely.
        // Deliberately runs on failed turns too: agy may have created the
        // conversation before the turn errored, and resuming it keeps context.
        if (this.conversationId === null) {
          const cid = this.resolveConversationId(this.cwd);
          if (cid && cid !== preTurnCacheId) {
            this.conversationId = cid;
            this.log(`pinned agy conversation ${cid}`);
          } else {
            this.log('agy conversation cache unchanged after turn; not adopting (will retry next turn)');
          }
        }

        const detail = streamFailure
          ?? (code === 0 ? null : `agy exited with code ${code ?? 'null'}`);
        if (!detail) {
          this.emit({ type: 'status', status: 'idle' });
          resolve();
        } else {
          this.emit({ type: 'status', status: 'error', detail });
          reject(new Error(detail));
        }
      });
    });
  }

  async cancel(_sessionId?: SessionId): Promise<void> {
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
    }
  }

  onMessage(handler: AgentMessageHandler): void {
    this.handlers.add(handler);
  }

  offMessage(handler: AgentMessageHandler): void {
    this.handlers.delete(handler);
  }

  async dispose(): Promise<void> {
    await this.cancel();
    this.handlers.clear();
  }

  private emit(msg: AgentMessage): void {
    for (const handler of this.handlers) {
      handler(msg);
    }
  }
}
