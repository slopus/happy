/**
 * v3 Claude Mapper — converts RawJSONLines from Claude SDK into
 * the v3 Message + Parts canonical format.
 *
 * Unlike the v1 sessionProtocolMapper which emits a stream of SessionEnvelopes,
 * this mapper builds up MessageWithParts objects. Each assistant turn becomes
 * one AssistantMessage with ordered parts (step-start, reasoning, tool, text,
 * step-finish).
 *
 * The mapper is stateful — call `handleMessage()` for each SDK message.
 * When a turn completes (user message arrives or explicit close), the
 * accumulated assistant message is finalized and emitted.
 */

import { createId } from '@paralleldrive/cuid2';
import type { RawJSONLines } from '@/claude/types';
import type { v3 } from '@slopus/happy-wire';

type MessageWithParts = v3.MessageWithParts;
type Part = v3.Part;
type AssistantMessage = v3.AssistantMessage;
type TextPart = v3.TextPart;
type ReasoningPart = v3.ReasoningPart;
type ToolPart = v3.ToolPart;
type StepFinishPart = v3.StepFinishPart;
type MessageID = v3.MessageID;
type SessionID = v3.SessionID;
type PartID = v3.PartID;

// ─── ID helpers ───────────────────────────────────────────────────────────────

function msgId(): MessageID {
  return `msg_${createId()}` as MessageID;
}

function partId(): PartID {
  return `prt_${createId()}` as PartID;
}

// ─── State ────────────────────────────────────────────────────────────────────

export type V3MapperState = {
  sessionID: SessionID;
  agent: string;
  modelID: string;
  providerID: string;
  cwd: string;
  root: string;

  /** The current in-flight assistant message being built, or null if between turns. */
  currentAssistant: {
    info: AssistantMessage;
    parts: Part[];
  } | null;

  /** The user message that started the current turn. */
  currentUserMessageID: MessageID | null;

  /** Tracks provider tool_use_id → our ToolPart for updating state. */
  toolParts: Map<string, ToolPart>;

  /** Tracks provider subagent tool IDs (Task tool). */
  taskToolIds: Set<string>;

  /** Accumulated cost for the current turn. */
  turnCost: number;

  /** Accumulated tokens for the current turn. */
  turnTokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
};

export function createV3MapperState(opts: {
  sessionID: string;
  agent?: string;
  modelID?: string;
  providerID?: string;
  cwd?: string;
  root?: string;
}): V3MapperState {
  return {
    sessionID: opts.sessionID as SessionID,
    agent: opts.agent ?? 'build',
    modelID: opts.modelID ?? 'unknown',
    providerID: opts.providerID ?? 'anthropic',
    cwd: opts.cwd ?? process.cwd(),
    root: opts.root ?? process.cwd(),
    currentAssistant: null,
    currentUserMessageID: null,
    toolParts: new Map(),
    taskToolIds: new Set(),
    turnCost: 0,
    turnTokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

// ─── Result ───────────────────────────────────────────────────────────────────

export type V3MapperResult = {
  /** Finalized messages ready to send (completed turns). */
  messages: MessageWithParts[];
  /** The in-flight assistant message (partial, still accumulating parts). Updated in place. */
  currentAssistant: MessageWithParts | null;
};

// ─── Mapper ───────────────────────────────────────────────────────────────────

/**
 * Process one RawJSONLines message from the Claude SDK and return any
 * finalized v3 messages. Also returns the current in-flight assistant
 * message for live streaming to the app.
 */
export function handleClaudeMessage(
  message: RawJSONLines,
  state: V3MapperState,
): V3MapperResult {
  const result: V3MapperResult = { messages: [], currentAssistant: null };

  if (message.type === 'system') {
    // System messages may carry session ID updates
    const raw = message as { sessionId?: string };
    if (raw.sessionId) {
      state.sessionID = raw.sessionId as SessionID;
    }
    return result;
  }

  if (message.type === 'summary') {
    // Summaries don't produce v3 messages — handled separately as metadata
    return result;
  }

  if (message.type === 'user') {
    return handleUserMessage(message, state, result);
  }

  if (message.type === 'assistant') {
    return handleAssistantMessage(message, state, result);
  }

  return result;
}

// ─── User message ─────────────────────────────────────────────────────────────

function handleUserMessage(
  message: RawJSONLines & { type: 'user' },
  state: V3MapperState,
  result: V3MapperResult,
): V3MapperResult {
  const isSidechain = (message as { isSidechain?: boolean }).isSidechain === true;

  // Sidechain messages belong to subagents — skip for now (Phase 4)
  if (isSidechain) {
    return result;
  }

  // A non-sidechain user message means the previous turn ended.
  // Finalize any in-flight assistant message.
  if (state.currentAssistant) {
    finalizeAssistantMessage(state, result);
  }

  // Build the user message
  const textContent = typeof message.message.content === 'string'
    ? message.message.content
    : extractTextFromBlocks(message.message.content);

  // Check for tool_result blocks (these are tool outputs coming back)
  const blocks = Array.isArray(message.message.content) ? message.message.content : [];
  for (const block of blocks) {
    if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      const toolPart = state.toolParts.get(block.tool_use_id);
      if (toolPart) {
        const output = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((b: any) => typeof b.text === 'string' ? b.text : '').join('\n')
            : '';
        const isError = block.is_error === true;

        toolPart.state = isError
          ? {
              status: 'error',
              input: toolPart.state.input,
              error: output || 'Tool execution failed',
              time: { start: (toolPart.state as any).time?.start ?? Date.now(), end: Date.now() },
            }
          : {
              status: 'completed',
              input: toolPart.state.input,
              output,
              title: toolPart.state.status === 'running'
                ? ((toolPart.state as any).title ?? toolPart.tool)
                : toolPart.tool,
              metadata: toolPart.state.status === 'running'
                ? ((toolPart.state as any).metadata ?? {})
                : {},
              time: { start: (toolPart.state as any).time?.start ?? Date.now(), end: Date.now() },
            };
        state.toolParts.delete(block.tool_use_id);
      }
    }
  }

  if (textContent.trim().length > 0) {
    const userMsgId = msgId();
    state.currentUserMessageID = userMsgId;
    const userMsg: MessageWithParts = {
      info: {
        id: userMsgId,
        sessionID: state.sessionID,
        role: 'user',
        time: { created: Date.now() },
        agent: state.agent,
        model: { providerID: state.providerID, modelID: state.modelID },
      },
      parts: [{
        id: partId(),
        sessionID: state.sessionID,
        messageID: userMsgId,
        type: 'text',
        text: textContent,
      }],
    };
    result.messages.push(userMsg);
  }

  return result;
}

// ─── Assistant message ────────────────────────────────────────────────────────

function handleAssistantMessage(
  message: RawJSONLines & { type: 'assistant' },
  state: V3MapperState,
  result: V3MapperResult,
): V3MapperResult {
  // Extract usage if available
  if (message.message?.usage) {
    const u = message.message.usage;
    state.turnTokens.input += u.input_tokens ?? 0;
    state.turnTokens.output += u.output_tokens ?? 0;
    state.turnTokens.cache.read += u.cache_read_input_tokens ?? 0;
    state.turnTokens.cache.write += u.cache_creation_input_tokens ?? 0;
  }

  // Extract model if available
  if (message.message?.model && typeof message.message.model === 'string') {
    state.modelID = message.message.model;
  }

  // Ensure we have an assistant message being built
  if (!state.currentAssistant) {
    const asstId = msgId();
    state.currentAssistant = {
      info: {
        id: asstId,
        sessionID: state.sessionID,
        role: 'assistant',
        time: { created: Date.now() },
        parentID: state.currentUserMessageID ?? ('' as MessageID),
        modelID: state.modelID,
        providerID: state.providerID,
        agent: state.agent,
        path: { cwd: state.cwd, root: state.root },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [{
        id: partId(),
        sessionID: state.sessionID,
        messageID: asstId,
        type: 'step-start',
      }],
    };
  }

  const asst = state.currentAssistant;
  const blocks = Array.isArray(message.message?.content) ? message.message!.content : [];

  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      const textPart: TextPart = {
        id: partId(),
        sessionID: state.sessionID,
        messageID: asst.info.id,
        type: 'text',
        text: block.text,
        time: { start: Date.now() },
      };
      asst.parts.push(textPart);
      continue;
    }

    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      const reasoningPart: ReasoningPart = {
        id: partId(),
        sessionID: state.sessionID,
        messageID: asst.info.id,
        type: 'reasoning',
        text: block.thinking,
        time: { start: Date.now() },
      };
      asst.parts.push(reasoningPart);
      continue;
    }

    if (block.type === 'tool_use') {
      const callID = typeof block.id === 'string' ? block.id : createId();
      const toolName = typeof block.name === 'string' ? block.name : 'unknown';
      const input = (block.input && typeof block.input === 'object')
        ? block.input as Record<string, unknown>
        : {};

      // Task tool = subagent delegation. Record it but still create a tool part.
      if (toolName === 'Task') {
        state.taskToolIds.add(callID);
      }

      const toolPart: ToolPart = {
        id: partId(),
        sessionID: state.sessionID,
        messageID: asst.info.id,
        type: 'tool',
        callID,
        tool: toolName,
        state: {
          status: 'running',
          input,
          title: toolTitle(toolName, input),
          time: { start: Date.now() },
        },
      };
      asst.parts.push(toolPart);
      state.toolParts.set(callID, toolPart);
      continue;
    }
  }

  result.currentAssistant = {
    info: asst.info,
    parts: asst.parts,
  };

  return result;
}

// ─── Finalize ─────────────────────────────────────────────────────────────────

function finalizeAssistantMessage(state: V3MapperState, result: V3MapperResult): void {
  if (!state.currentAssistant) return;

  const asst = state.currentAssistant;

  // Determine finish reason
  const hasToolCalls = asst.parts.some(p => p.type === 'tool');
  const finish = hasToolCalls ? 'tool-calls' : 'stop';

  // Add step-finish
  const stepFinish: StepFinishPart = {
    id: partId(),
    sessionID: state.sessionID,
    messageID: asst.info.id,
    type: 'step-finish',
    reason: finish,
    cost: state.turnCost,
    tokens: { ...state.turnTokens },
  };
  asst.parts.push(stepFinish);

  // Update assistant info
  asst.info.time.completed = Date.now();
  asst.info.finish = finish;
  asst.info.cost = state.turnCost;
  asst.info.tokens = { ...state.turnTokens };

  result.messages.push({
    info: asst.info,
    parts: asst.parts,
  });

  // Reset turn state
  state.currentAssistant = null;
  state.turnCost = 0;
  state.turnTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
}

/**
 * Explicitly close the current turn. Call this when the session ends
 * or when you need to flush the in-flight assistant message.
 */
export function flushV3Turn(state: V3MapperState): MessageWithParts[] {
  const result: V3MapperResult = { messages: [], currentAssistant: null };
  finalizeAssistantMessage(state, result);
  return result.messages;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractTextFromBlocks(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => b.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text)
    .join('\n');
}

function toolTitle(name: string, input: unknown): string {
  if (input && typeof input === 'object') {
    const desc = (input as { description?: unknown }).description;
    if (typeof desc === 'string' && desc.trim().length > 0) {
      return desc.length > 80 ? `${desc.slice(0, 77)}...` : desc;
    }
  }
  return `${name} call`;
}
