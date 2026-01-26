/**
 * Session Update Handlers for ACP Backend
 *
 * This module contains handlers for different types of ACP session updates.
 * Each handler is responsible for processing a specific update type and
 * emitting appropriate AgentMessages.
 *
 * Extracted from AcpBackend to improve maintainability and testability.
 */

import type { AgentMessage } from '../core';
import type { TransportHandler } from '../transport';
import { logger } from '@/ui/logger';
import { normalizeAcpToolArgs, normalizeAcpToolResult } from './toolNormalization';

/**
 * Default timeout for idle detection after message chunks (ms)
 * Used when transport handler doesn't provide getIdleTimeout()
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 500;

/**
 * Default timeout for tool calls if transport doesn't specify (ms)
 */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 120_000;

/**
 * Extended session update structure with all possible fields
 */
export interface SessionUpdate {
  sessionUpdate?: string;
  toolCallId?: string;
  status?: string;
  kind?: string | unknown;
  title?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  input?: unknown;
  output?: unknown;
  // Some ACP providers (notably Gemini CLI) may surface tool outputs in other fields.
  result?: unknown;
  liveContent?: unknown;
  live_content?: unknown;
  meta?: unknown;
  availableCommands?: Array<{ name?: string; description?: string } | unknown>;
  currentModeId?: string;
  entries?: unknown;
  content?: {
    text?: string;
    error?: string | { message?: string };
    type?: string;
    [key: string]: unknown;
  } | string | unknown;
  locations?: unknown[];
  messageChunk?: {
    textDelta?: string;
  };
  plan?: unknown;
  thinking?: unknown;
  [key: string]: unknown;
}

/**
 * Context for session update handlers
 */
export interface HandlerContext {
  /** Transport handler for agent-specific behavior */
  transport: TransportHandler;
  /** Set of active tool call IDs */
  activeToolCalls: Set<string>;
  /** Map of tool call ID to start time */
  toolCallStartTimes: Map<string, number>;
  /** Map of tool call ID to timeout handle */
  toolCallTimeouts: Map<string, NodeJS.Timeout>;
  /** Map of tool call ID to tool name */
  toolCallIdToNameMap: Map<string, string>;
  /** Map of tool call ID to the most-recent raw input (for permission prompts that omit args) */
  toolCallIdToInputMap: Map<string, Record<string, unknown>>;
  /** Current idle timeout handle */
  idleTimeout: NodeJS.Timeout | null;
  /** Tool call counter since last prompt */
  toolCallCountSincePrompt: number;
  /** Emit function to send agent messages */
  emit: (msg: AgentMessage) => void;
  /** Emit idle status helper */
  emitIdleStatus: () => void;
  /** Clear idle timeout helper */
  clearIdleTimeout: () => void;
  /** Set idle timeout helper */
  setIdleTimeout: (callback: () => void, ms: number) => void;
}

/**
 * Result of handling a session update
 */
export interface HandlerResult {
  /** Whether the update was handled */
  handled: boolean;
  /** Updated tool call counter */
  toolCallCountSincePrompt?: number;
}

/**
 * Parse args from update content (can be array or object)
 */
export function parseArgsFromContent(content: unknown): Record<string, unknown> {
  if (Array.isArray(content)) {
    return { items: content };
  }
  if (typeof content === 'string') {
    return { value: content };
  }
  if (content && typeof content === 'object' && content !== null) {
    return content as Record<string, unknown>;
  }
  return {};
}

function extractToolInput(update: SessionUpdate): unknown {
  if (update.rawInput !== undefined) return update.rawInput;
  if (update.input !== undefined) return update.input;
  return update.content;
}

function extractToolOutput(update: SessionUpdate): unknown {
  if (update.rawOutput !== undefined) return update.rawOutput;
  if (update.output !== undefined) return update.output;
  if (update.result !== undefined) return update.result;
  if (update.liveContent !== undefined) return update.liveContent;
  if (update.live_content !== undefined) return update.live_content;
  return update.content;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function extractMeta(update: SessionUpdate): Record<string, unknown> | null {
  const meta = update.meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  return meta as Record<string, unknown>;
}

function hasMeaningfulToolUpdate(update: SessionUpdate): boolean {
  if (typeof update.title === 'string' && update.title.trim().length > 0) return true;
  if (update.rawInput !== undefined) return true;
  if (update.input !== undefined) return true;
  if (update.content !== undefined) return true;
  if (Array.isArray(update.locations) && update.locations.length > 0) return true;
  const meta = extractMeta(update);
  if (meta) {
    if (meta.terminal_output) return true;
    if (meta.terminal_exit) return true;
  }
  return false;
}

function attachAcpMetadataToArgs(args: Record<string, unknown>, update: SessionUpdate, toolKind: string, rawInput: unknown): void {
  const meta = extractMeta(update);
  const acp: Record<string, unknown> = { kind: toolKind };

  if (typeof update.title === 'string' && update.title.trim().length > 0) {
    acp.title = update.title;
    // Prevent "empty tool" UIs when a provider omits rawInput/content but provides a title.
    if (typeof args.description !== 'string' || args.description.trim().length === 0) {
      args.description = update.title;
    }
  }

  if (rawInput !== undefined) acp.rawInput = rawInput;
  if (Array.isArray(update.locations) && update.locations.length > 0) acp.locations = update.locations;
  if (meta) acp.meta = meta;

  // Only attach when we have something beyond kind (keeps payloads small).
  if (Object.keys(acp).length > 1) {
    (args as any)._acp = { ...(asRecord((args as any)._acp) ?? {}), ...acp };
  }
}

function emitTerminalOutputFromMeta(update: SessionUpdate, ctx: HandlerContext): void {
  const meta = extractMeta(update);
  if (!meta) return;
  const entry = meta.terminal_output;
  const obj = asRecord(entry);
  if (!obj) return;
  const data = typeof obj.data === 'string' ? obj.data : null;
  if (!data) return;
  const toolCallId = update.toolCallId;
  if (!toolCallId) return;
  const toolKindStr = typeof update.kind === 'string' ? update.kind : undefined;
  const toolName =
    ctx.toolCallIdToNameMap.get(toolCallId)
    ?? ctx.transport.extractToolNameFromId?.(toolCallId)
    ?? toolKindStr
    ?? 'unknown';

  // Represent terminal output as a streaming tool-result update for the same toolCallId.
  // The UI reducer can append stdout/stderr without marking the tool as completed.
  ctx.emit({
    type: 'tool-result',
    toolName,
    callId: toolCallId,
    result: {
      stdoutChunk: data,
      _stream: true,
      _terminal: true,
    },
  });
}

function emitToolCallRefresh(
  toolCallId: string,
  toolKind: string | unknown,
  update: SessionUpdate,
  ctx: HandlerContext
): void {
  const toolKindStr = typeof toolKind === 'string' ? toolKind : undefined;

  const rawInput = extractToolInput(update);
  if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    ctx.toolCallIdToInputMap.set(toolCallId, rawInput as Record<string, unknown>);
  }

  const baseName =
    ctx.toolCallIdToNameMap.get(toolCallId)
    ?? ctx.transport.extractToolNameFromId?.(toolCallId)
    ?? toolKindStr
    ?? 'unknown';
  const realToolName = ctx.transport.determineToolName?.(
    baseName,
    toolCallId,
    (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput))
      ? (rawInput as Record<string, unknown>)
      : {},
    { recentPromptHadChangeTitle: false, toolCallCountSincePrompt: ctx.toolCallCountSincePrompt }
  ) ?? baseName;

  const parsedArgs = parseArgsFromContent(rawInput);
  const args = normalizeAcpToolArgs({
    toolKind: toolKindStr,
    toolName: realToolName,
    rawInput,
    args: parsedArgs,
  });

  if (update.locations && Array.isArray(update.locations)) {
    args.locations = update.locations;
  }
  attachAcpMetadataToArgs(args, update, toolKindStr || 'unknown', rawInput);

  ctx.emit({
    type: 'tool-call',
    toolName: realToolName,
    args,
    callId: toolCallId,
  });
}

/**
 * Extract error detail from update content
 */
export function extractErrorDetail(content: unknown): string | undefined {
  if (!content) return undefined;

  if (typeof content === 'string') {
    return content;
  }

  if (typeof content === 'object' && content !== null && !Array.isArray(content)) {
    const obj = content as Record<string, unknown>;

    if (obj.error) {
      const error = obj.error;
      if (typeof error === 'string') return error;
      if (error && typeof error === 'object' && 'message' in error) {
        const errObj = error as { message?: unknown };
        if (typeof errObj.message === 'string') return errObj.message;
      }
      return JSON.stringify(error);
    }

    if (typeof obj.message === 'string') return obj.message;

    const status = typeof obj.status === 'string' ? obj.status : undefined;
    const reason = typeof obj.reason === 'string' ? obj.reason : undefined;
    return status || reason || JSON.stringify(obj).substring(0, 500);
  }

  return undefined;
}

export function extractTextFromContentBlock(content: unknown): string | null {
  if (!content) return null;
  if (typeof content === 'string') return content;
  if (typeof content !== 'object' || Array.isArray(content)) return null;
  const obj = content as Record<string, unknown>;
  if (typeof obj.text === 'string') return obj.text;
  if (obj.type === 'text' && typeof obj.text === 'string') return obj.text;
  return null;
}

/**
 * Format duration for logging
 */
export function formatDuration(startTime: number | undefined): string {
  if (!startTime) return 'unknown';
  const duration = Date.now() - startTime;
  return `${(duration / 1000).toFixed(2)}s`;
}

/**
 * Format duration in minutes for logging
 */
export function formatDurationMinutes(startTime: number | undefined): string {
  if (!startTime) return 'unknown';
  const duration = Date.now() - startTime;
  return (duration / 1000 / 60).toFixed(2);
}

/**
 * Handle agent_message_chunk update (text output from model)
 */
export function handleAgentMessageChunk(
  update: SessionUpdate,
  ctx: HandlerContext
): HandlerResult {
  const text = extractTextFromContentBlock(update.content);
  if (typeof text !== 'string' || text.length === 0) return { handled: false };
  // Some ACP providers emit whitespace-only chunks (often "\n") as keepalives.
  // Dropping these avoids spammy blank lines and reduces unnecessary UI churn.
  if (!text.trim()) return { handled: true };

  // Filter out "thinking" messages (start with **...**)
  const isThinking = /^\*\*[^*]+\*\*\n/.test(text);

  if (isThinking) {
    ctx.emit({
      type: 'event',
      name: 'thinking',
      payload: { text },
    });
  } else {
    logger.debug(`[AcpBackend] Received message chunk (length: ${text.length}): ${text.substring(0, 50)}...`);
    ctx.emit({
      type: 'model-output',
      textDelta: text,
    });

    // Reset idle timeout - more chunks are coming
    ctx.clearIdleTimeout();

    // Set timeout to emit 'idle' after a short delay when no more chunks arrive
    const idleTimeoutMs = ctx.transport.getIdleTimeout?.() ?? DEFAULT_IDLE_TIMEOUT_MS;
    ctx.setIdleTimeout(() => {
      if (ctx.activeToolCalls.size === 0) {
        logger.debug('[AcpBackend] No more chunks received, emitting idle status');
        ctx.emitIdleStatus();
      } else {
        logger.debug(`[AcpBackend] Delaying idle status - ${ctx.activeToolCalls.size} active tool calls`);
      }
    }, idleTimeoutMs);
  }

  return { handled: true };
}

/**
 * Handle agent_thought_chunk update (Gemini's thinking/reasoning)
 */
export function handleAgentThoughtChunk(
  update: SessionUpdate,
  ctx: HandlerContext
): HandlerResult {
  const text = extractTextFromContentBlock(update.content);
  if (typeof text !== 'string' || text.length === 0) return { handled: false };
  if (!text.trim()) return { handled: true };

  // Log thinking chunks when tool calls are active
  if (ctx.activeToolCalls.size > 0) {
    const activeToolCallsList = Array.from(ctx.activeToolCalls);
    logger.debug(`[AcpBackend] 💭 Thinking chunk received (${text.length} chars) during active tool calls: ${activeToolCallsList.join(', ')}`);
  }

  ctx.emit({
    type: 'event',
    name: 'thinking',
    payload: { text },
  });

  return { handled: true };
}

export function handleUserMessageChunk(
  update: SessionUpdate,
  ctx: HandlerContext
): HandlerResult {
  const text = extractTextFromContentBlock(update.content);
  if (typeof text !== 'string' || text.length === 0) return { handled: false };
  ctx.emit({
    type: 'event',
    name: 'user_message_chunk',
    payload: { text },
  });
  return { handled: true };
}

export function handleAvailableCommandsUpdate(
  update: SessionUpdate,
  ctx: HandlerContext
): HandlerResult {
  const commands = Array.isArray(update.availableCommands) ? update.availableCommands : null;
  if (!commands) return { handled: false };
  ctx.emit({
    type: 'event',
    name: 'available_commands_update',
    payload: { availableCommands: commands },
  });
  return { handled: true };
}

export function handleCurrentModeUpdate(
  update: SessionUpdate,
  ctx: HandlerContext
): HandlerResult {
  const modeId = typeof update.currentModeId === 'string' ? update.currentModeId : null;
  if (!modeId) return { handled: false };
  ctx.emit({
    type: 'event',
    name: 'current_mode_update',
    payload: { currentModeId: modeId },
  });
  return { handled: true };
}

/**
 * Start tracking a new tool call
 */
export function startToolCall(
  toolCallId: string,
  toolKind: string | unknown,
  update: SessionUpdate,
  ctx: HandlerContext,
  source: 'tool_call' | 'tool_call_update'
): void {
  const startTime = Date.now();
  const toolKindStr = typeof toolKind === 'string' ? toolKind : undefined;
  const isInvestigation = ctx.transport.isInvestigationTool?.(toolCallId, toolKindStr) ?? false;

  const rawInput = extractToolInput(update);
  if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    ctx.toolCallIdToInputMap.set(toolCallId, rawInput as Record<string, unknown>);
  }

  // Determine a stable tool name (never use `update.title`, which is human-readable and can vary per call).
  const extractedName = ctx.transport.extractToolNameFromId?.(toolCallId);
  const baseName = extractedName ?? toolKindStr ?? 'unknown';
  const toolName = ctx.transport.determineToolName?.(
    baseName,
    toolCallId,
    (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput))
      ? (rawInput as Record<string, unknown>)
      : {},
    { recentPromptHadChangeTitle: false, toolCallCountSincePrompt: ctx.toolCallCountSincePrompt }
  ) ?? baseName;

  // Store mapping for permission requests
  ctx.toolCallIdToNameMap.set(toolCallId, toolName);

  ctx.activeToolCalls.add(toolCallId);
  ctx.toolCallStartTimes.set(toolCallId, startTime);

  logger.debug(`[AcpBackend] ⏱️ Set startTime for ${toolCallId} at ${new Date(startTime).toISOString()} (from ${source})`);
  logger.debug(`[AcpBackend] 🔧 Tool call START: ${toolCallId} (${toolKind} -> ${toolName})${isInvestigation ? ' [INVESTIGATION TOOL]' : ''}`);

  if (isInvestigation) {
    logger.debug(`[AcpBackend] 🔍 Investigation tool detected - extended timeout (10min) will be used`);
  }

  // Set timeout for tool call completion.
  // Some ACP providers send `status: pending` while waiting for a user permission response. Do not start
  // the execution timeout until the tool is actually in progress, otherwise long permission waits can
  // cause spurious timeouts and confusing UI state.
  if (update.status !== 'pending') {
    const timeoutMs = ctx.transport.getToolCallTimeout?.(toolCallId, toolKindStr) ?? DEFAULT_TOOL_CALL_TIMEOUT_MS;

    if (!ctx.toolCallTimeouts.has(toolCallId)) {
      const timeout = setTimeout(() => {
        const duration = formatDuration(ctx.toolCallStartTimes.get(toolCallId));
        logger.debug(`[AcpBackend] ⏱️ Tool call TIMEOUT (from ${source}): ${toolCallId} (${toolKind}) after ${(timeoutMs / 1000).toFixed(0)}s - Duration: ${duration}, removing from active set`);

        ctx.activeToolCalls.delete(toolCallId);
        ctx.toolCallStartTimes.delete(toolCallId);
        ctx.toolCallTimeouts.delete(toolCallId);
        ctx.toolCallIdToNameMap.delete(toolCallId);
        ctx.toolCallIdToInputMap.delete(toolCallId);

        if (ctx.activeToolCalls.size === 0) {
          logger.debug('[AcpBackend] No more active tool calls after timeout, emitting idle status');
          ctx.emitIdleStatus();
        }
      }, timeoutMs);

      ctx.toolCallTimeouts.set(toolCallId, timeout);
      logger.debug(`[AcpBackend] ⏱️ Set timeout for ${toolCallId}: ${(timeoutMs / 1000).toFixed(0)}s${isInvestigation ? ' (investigation tool)' : ''}`);
    } else {
      logger.debug(`[AcpBackend] Timeout already set for ${toolCallId}, skipping`);
    }
  } else {
    logger.debug(`[AcpBackend] Tool call ${toolCallId} is pending permission; skipping execution timeout setup`);
  }

  // Clear idle timeout - tool call is starting
  ctx.clearIdleTimeout();

  // Emit running status
  ctx.emit({ type: 'status', status: 'running' });

  // Parse args and emit tool-call event
  const parsedArgs = parseArgsFromContent(rawInput);
  const args = normalizeAcpToolArgs({
    toolKind: toolKindStr,
    toolName,
    rawInput,
    args: parsedArgs,
  });

  // Extract locations if present
  if (update.locations && Array.isArray(update.locations)) {
    args.locations = update.locations;
  }

  attachAcpMetadataToArgs(args, update, toolKindStr || 'unknown', rawInput);

  // Log investigation tool objective
  if (isInvestigation && args.objective) {
    logger.debug(`[AcpBackend] 🔍 Investigation tool objective: ${String(args.objective).substring(0, 100)}...`);
  }

  ctx.emit({
    type: 'tool-call',
    toolName,
    args,
    callId: toolCallId,
  });
}

/**
 * Complete a tool call successfully
 */
export function completeToolCall(
  toolCallId: string,
  toolKind: string | unknown,
  update: SessionUpdate,
  ctx: HandlerContext
): void {
  const startTime = ctx.toolCallStartTimes.get(toolCallId);
  const duration = formatDuration(startTime);
  const toolKindStr = typeof toolKind === 'string' ? toolKind : 'unknown';
  const resolvedToolName = ctx.toolCallIdToNameMap.get(toolCallId) ?? toolKindStr;

  ctx.activeToolCalls.delete(toolCallId);
  ctx.toolCallStartTimes.delete(toolCallId);
  ctx.toolCallIdToNameMap.delete(toolCallId);
  ctx.toolCallIdToInputMap.delete(toolCallId);

  const timeout = ctx.toolCallTimeouts.get(toolCallId);
  if (timeout) {
    clearTimeout(timeout);
    ctx.toolCallTimeouts.delete(toolCallId);
  }

  logger.debug(`[AcpBackend] ✅ Tool call COMPLETED: ${toolCallId} (${resolvedToolName}) - Duration: ${duration}. Active tool calls: ${ctx.activeToolCalls.size}`);

  const normalized = normalizeAcpToolResult(extractToolOutput(update));
  const record = asRecord(normalized);
  if (record) {
    const meta = extractMeta(update);
    const acp: Record<string, unknown> = { kind: toolKindStr };
    if (typeof update.title === 'string' && update.title.trim().length > 0) acp.title = update.title;
    if (Array.isArray(update.locations) && update.locations.length > 0) acp.locations = update.locations;
    if (meta) acp.meta = meta;
    record._acp = { ...(asRecord(record._acp) ?? {}), ...acp };
  }

  ctx.emit({
    type: 'tool-result',
    toolName: resolvedToolName,
    result: normalized,
    callId: toolCallId,
  });

  // If no more active tool calls, emit idle
  if (ctx.activeToolCalls.size === 0) {
    ctx.clearIdleTimeout();
    logger.debug('[AcpBackend] All tool calls completed, emitting idle status');
    ctx.emitIdleStatus();
  }
}

/**
 * Fail a tool call
 */
export function failToolCall(
  toolCallId: string,
  status: 'failed' | 'cancelled',
  toolKind: string | unknown,
  update: SessionUpdate,
  ctx: HandlerContext
): void {
  const startTime = ctx.toolCallStartTimes.get(toolCallId);
  const duration = startTime ? Date.now() - startTime : null;
  const toolKindStr = typeof toolKind === 'string' ? toolKind : 'unknown';
  const resolvedToolName = ctx.toolCallIdToNameMap.get(toolCallId) ?? toolKindStr;
  const isInvestigation = ctx.transport.isInvestigationTool?.(toolCallId, toolKindStr) ?? false;
  const hadTimeout = ctx.toolCallTimeouts.has(toolCallId);

  // Log detailed timing for investigation tools BEFORE cleanup
  if (isInvestigation) {
    const durationStr = formatDuration(startTime);
    const durationMinutes = formatDurationMinutes(startTime);
    logger.debug(`[AcpBackend] 🔍 Investigation tool ${status.toUpperCase()} after ${durationMinutes} minutes (${durationStr})`);

    // Check for 3-minute timeout pattern (Gemini CLI internal timeout)
    if (duration) {
      const threeMinutes = 3 * 60 * 1000;
      const tolerance = 5000;
      if (Math.abs(duration - threeMinutes) < tolerance) {
        logger.debug(`[AcpBackend] 🔍 ⚠️ Investigation tool failed at ~3 minutes - likely Gemini CLI timeout, not our timeout`);
      }
    }

    logger.debug(`[AcpBackend] 🔍 Investigation tool FAILED - full content:`, JSON.stringify(extractToolOutput(update), null, 2));
    logger.debug(`[AcpBackend] 🔍 Investigation tool timeout status BEFORE cleanup: ${hadTimeout ? 'timeout was set' : 'no timeout was set'}`);
    logger.debug(`[AcpBackend] 🔍 Investigation tool startTime status BEFORE cleanup: ${startTime ? `set at ${new Date(startTime).toISOString()}` : 'not set'}`);
  }

  // Cleanup
  ctx.activeToolCalls.delete(toolCallId);
  ctx.toolCallStartTimes.delete(toolCallId);
  ctx.toolCallIdToNameMap.delete(toolCallId);
  ctx.toolCallIdToInputMap.delete(toolCallId);

  const timeout = ctx.toolCallTimeouts.get(toolCallId);
  if (timeout) {
    clearTimeout(timeout);
    ctx.toolCallTimeouts.delete(toolCallId);
    logger.debug(`[AcpBackend] Cleared timeout for ${toolCallId} (tool call ${status})`);
  } else {
    logger.debug(`[AcpBackend] No timeout found for ${toolCallId} (tool call ${status}) - timeout may not have been set`);
  }

  const durationStr = formatDuration(startTime);
  logger.debug(`[AcpBackend] ❌ Tool call ${status.toUpperCase()}: ${toolCallId} (${resolvedToolName}) - Duration: ${durationStr}. Active tool calls: ${ctx.activeToolCalls.size}`);

  // Extract error detail
  const errorDetail = extractErrorDetail(extractToolOutput(update));
  if (errorDetail) {
    logger.debug(`[AcpBackend] ❌ Tool call error details: ${errorDetail.substring(0, 500)}`);
  } else {
    logger.debug(`[AcpBackend] ❌ Tool call ${status} but no error details in content`);
  }

  // Emit tool-result with error
  ctx.emit({
    type: 'tool-result',
    toolName: resolvedToolName,
    result: (() => {
      const base = errorDetail
        ? { error: errorDetail, status }
        : { error: `Tool call ${status}`, status };
      const meta = extractMeta(update);
      const acp: Record<string, unknown> = { kind: toolKindStr };
      if (typeof update.title === 'string' && update.title.trim().length > 0) acp.title = update.title;
      if (Array.isArray(update.locations) && update.locations.length > 0) acp.locations = update.locations;
      if (meta) acp.meta = meta;
      return { ...base, _acp: acp };
    })(),
    callId: toolCallId,
  });

  // If no more active tool calls, emit idle
  if (ctx.activeToolCalls.size === 0) {
    ctx.clearIdleTimeout();
    logger.debug('[AcpBackend] All tool calls completed/failed, emitting idle status');
    ctx.emitIdleStatus();
  }
}

/**
 * Handle tool_call_update session update
 */
export function handleToolCallUpdate(
  update: SessionUpdate,
  ctx: HandlerContext
): HandlerResult {
  const status = update.status;
  const toolCallId = update.toolCallId;

  if (!toolCallId) {
    logger.debug('[AcpBackend] Tool call update without toolCallId:', update);
    return { handled: false };
  }

  const toolKind =
    typeof update.kind === 'string'
      ? update.kind
      : (ctx.transport.extractToolNameFromId?.(toolCallId) ?? 'unknown');
  let toolCallCountSincePrompt = ctx.toolCallCountSincePrompt;

  // Some ACP providers stream terminal output via tool_call_update.meta.
  emitTerminalOutputFromMeta(update, ctx);

  const isTerminalStatus = status === 'completed' || status === 'failed' || status === 'cancelled';
  // Some ACP providers (notably Gemini CLI) can emit a terminal tool_call_update without ever sending an
  // in_progress/pending update first. Seed a synthetic tool-call so the UI has enough context to render
  // the tool input/locations, and so tool-result can attach a non-"unknown" kind.
  if (isTerminalStatus && !ctx.toolCallIdToNameMap.has(toolCallId)) {
    startToolCall(
      toolCallId,
      toolKind,
      { ...update, status: 'pending' },
      ctx,
      'tool_call_update'
    );
  }

  if (status === 'in_progress' || status === 'pending') {
    if (!ctx.activeToolCalls.has(toolCallId)) {
      toolCallCountSincePrompt++;
      startToolCall(toolCallId, toolKind, update, ctx, 'tool_call_update');
    } else {
      // If the tool call was previously pending permission, it may not have an execution timeout yet.
      // Arm the timeout as soon as it transitions to in_progress.
      if (status === 'in_progress' && !ctx.toolCallTimeouts.has(toolCallId)) {
        const toolKindStr = typeof toolKind === 'string' ? toolKind : undefined;
        const timeoutMs = ctx.transport.getToolCallTimeout?.(toolCallId, toolKindStr) ?? DEFAULT_TOOL_CALL_TIMEOUT_MS;
        const timeout = setTimeout(() => {
          const duration = formatDuration(ctx.toolCallStartTimes.get(toolCallId));
          logger.debug(`[AcpBackend] ⏱️ Tool call TIMEOUT (from tool_call_update): ${toolCallId} (${toolKind}) after ${(timeoutMs / 1000).toFixed(0)}s - Duration: ${duration}, removing from active set`);

          ctx.activeToolCalls.delete(toolCallId);
          ctx.toolCallStartTimes.delete(toolCallId);
          ctx.toolCallTimeouts.delete(toolCallId);
          ctx.toolCallIdToNameMap.delete(toolCallId);
          ctx.toolCallIdToInputMap.delete(toolCallId);

          if (ctx.activeToolCalls.size === 0) {
            logger.debug('[AcpBackend] No more active tool calls after timeout, emitting idle status');
            ctx.emitIdleStatus();
          }
        }, timeoutMs);
        ctx.toolCallTimeouts.set(toolCallId, timeout);
        logger.debug(`[AcpBackend] ⏱️ Set timeout for ${toolCallId}: ${(timeoutMs / 1000).toFixed(0)}s (armed on in_progress)`);
      }

      if (hasMeaningfulToolUpdate(update)) {
        // Refresh the existing tool call message with updated title/rawInput/locations (without
        // resetting timeouts/start times).
        emitToolCallRefresh(toolCallId, toolKind, update, ctx);
      } else {
        logger.debug(`[AcpBackend] Tool call ${toolCallId} already tracked, status: ${status}`);
      }
    }
  } else if (status === 'completed') {
    completeToolCall(toolCallId, toolKind, update, ctx);
  } else if (status === 'failed' || status === 'cancelled') {
    failToolCall(toolCallId, status, toolKind, update, ctx);
  }

  return { handled: true, toolCallCountSincePrompt };
}

/**
 * Handle tool_call session update (direct tool call)
 */
export function handleToolCall(
  update: SessionUpdate,
  ctx: HandlerContext
): HandlerResult {
  const toolCallId = update.toolCallId;
  const status = update.status;

  logger.debug(`[AcpBackend] Received tool_call: toolCallId=${toolCallId}, status=${status}, kind=${update.kind}`);

  // tool_call can come without explicit status, assume 'in_progress' if missing
  const isInProgress = !status || status === 'in_progress' || status === 'pending';

  if (!toolCallId || !isInProgress) {
    logger.debug(`[AcpBackend] Tool call ${toolCallId} not in progress (status: ${status}), skipping`);
    return { handled: false };
  }

  if (ctx.activeToolCalls.has(toolCallId)) {
    logger.debug(`[AcpBackend] Tool call ${toolCallId} already in active set, skipping`);
    return { handled: true };
  }

  startToolCall(toolCallId, update.kind, update, ctx, 'tool_call');
  return { handled: true };
}

/**
 * Handle legacy messageChunk format
 */
export function handleLegacyMessageChunk(
  update: SessionUpdate,
  ctx: HandlerContext
): HandlerResult {
  if (!update.messageChunk) {
    return { handled: false };
  }

  const chunk = update.messageChunk;
  if (chunk.textDelta) {
    ctx.emit({
      type: 'model-output',
      textDelta: chunk.textDelta,
    });
    return { handled: true };
  }

  return { handled: false };
}

/**
 * Handle plan update
 */
export function handlePlanUpdate(
  update: SessionUpdate,
  ctx: HandlerContext
): HandlerResult {
  if (update.sessionUpdate === 'plan' && update.entries !== undefined) {
    ctx.emit({
      type: 'event',
      name: 'plan',
      payload: { entries: update.entries },
    });
    return { handled: true };
  }

  if (update.plan !== undefined) {
    ctx.emit({
      type: 'event',
      name: 'plan',
      payload: update.plan,
    });
    return { handled: true };
  }

  return { handled: false };
}

/**
 * Handle explicit thinking field
 */
export function handleThinkingUpdate(
  update: SessionUpdate,
  ctx: HandlerContext
): HandlerResult {
  if (!update.thinking) {
    return { handled: false };
  }

  ctx.emit({
    type: 'event',
    name: 'thinking',
    payload: update.thinking,
  });

  return { handled: true };
}
