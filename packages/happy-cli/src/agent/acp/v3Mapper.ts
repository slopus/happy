import { createId } from '@paralleldrive/cuid2';
import { v3 } from '@slopus/happy-sync';
import type { AgentMessage } from '@/agent/core';

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

function msgId(): MessageID { return `msg_${createId()}` as MessageID; }
function partId(): PartID { return `prt_${createId()}` as PartID; }

type PendingType = 'thinking' | 'output' | null;

export type V3AcpMapperState = {
  sessionID: SessionID;
  agent: string;
  modelID: string;
  providerID: string;
  cwd: string;
  root: string;
  currentAssistant: {
    info: AssistantMessage;
    parts: Part[];
  } | null;
  currentUserMessageID: MessageID | null;
  toolParts: Map<string, ToolPart>;
  pendingText: string;
  pendingType: PendingType;
};

export type V3AcpMapperResult = {
  messages: MessageWithParts[];
  currentAssistant: MessageWithParts | null;
};

export function createV3AcpMapperState(opts: {
  sessionID: string;
  agent: string;
  modelID?: string;
  providerID?: string;
  cwd?: string;
  root?: string;
}): V3AcpMapperState {
  return {
    sessionID: opts.sessionID as SessionID,
    agent: opts.agent,
    modelID: opts.modelID ?? opts.agent,
    providerID: opts.providerID ?? opts.agent,
    cwd: opts.cwd ?? process.cwd(),
    root: opts.root ?? process.cwd(),
    currentAssistant: null,
    currentUserMessageID: null,
    toolParts: new Map(),
    pendingText: '',
    pendingType: null,
  };
}

export function startAcpTurn(state: V3AcpMapperState): V3AcpMapperResult {
  const result: V3AcpMapperResult = { messages: [], currentAssistant: null };
  if (state.currentAssistant) {
    finalizeAssistant(state, result, 'stop');
  }
  startAssistant(state);
  result.currentAssistant = snapshot(state);
  return result;
}

export function endAcpTurn(
  state: V3AcpMapperState,
  status: 'completed' | 'failed' | 'cancelled',
): V3AcpMapperResult {
  const result: V3AcpMapperResult = { messages: [], currentAssistant: null };
  if (!state.currentAssistant) {
    return result;
  }
  finalizeAssistant(
    state,
    result,
    status === 'failed' ? 'error' : status === 'cancelled' ? 'cancelled' : 'stop',
  );
  return result;
}

export function handleAcpMessage(
  msg: AgentMessage,
  state: V3AcpMapperState,
): V3AcpMapperResult {
  const result: V3AcpMapperResult = { messages: [], currentAssistant: null };

  if (msg.type === 'status') {
    result.currentAssistant = snapshot(state);
    return result;
  }

  if (msg.type === 'event' && msg.name === 'thinking') {
    const asst = ensureAssistant(state);
    const { text, streaming } = parseThinkingPayload(msg.payload);
    if (!text) {
      result.currentAssistant = snapshot(state);
      return result;
    }
    if (streaming) {
      flushIfTypeChanged(state, 'thinking', asst);
      state.pendingType = 'thinking';
      state.pendingText += text;
    } else {
      flushPending(state, asst);
      const trimmed = text.replace(/^\n+|\n+$/g, '');
      if (trimmed) {
        asst.parts.push({
          id: partId(),
          sessionID: state.sessionID,
          messageID: asst.info.id,
          type: 'reasoning',
          text: trimmed,
          time: { start: Date.now() },
        } satisfies ReasoningPart);
      }
    }
    result.currentAssistant = snapshot(state);
    return result;
  }

  if (msg.type === 'model-output') {
    const asst = ensureAssistant(state);
    const text = msg.textDelta ?? msg.fullText ?? '';
    if (text) {
      flushIfTypeChanged(state, 'output', asst);
      state.pendingType = 'output';
      state.pendingText += text;
    }
    result.currentAssistant = snapshot(state);
    return result;
  }

  if (msg.type === 'tool-call') {
    const asst = ensureAssistant(state);
    flushPending(state, asst);

    const callID = msg.callId || `call_${createId()}`;
    const toolName = msg.toolName || 'tool';
    const existing = state.toolParts.get(callID);
    if (existing) {
      existing.tool = toolName;
      existing.state = {
        status: 'running',
        input: msg.args ?? existing.state.input ?? {},
        title: getToolTitle(existing, toolName),
        metadata: getToolMetadata(existing),
        time: { start: getToolStartTime(existing) },
      };
      result.currentAssistant = snapshot(state);
      return result;
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
        input: msg.args ?? {},
        title: toolName,
        time: { start: Date.now() },
      },
    };
    asst.parts.push(toolPart);
    state.toolParts.set(callID, toolPart);
    result.currentAssistant = snapshot(state);
    return result;
  }

  if (msg.type === 'permission-request') {
    const asst = ensureAssistant(state);
    flushPending(state, asst);

    const payload = toRecord(msg.payload);
    const callID = msg.id || `perm_${createId()}`;
    const toolName = getPermissionToolName(payload, msg.reason);
    const existing = state.toolParts.get(callID);
    const start = existing ? getToolStartTime(existing) : Date.now();
    const blocked: ToolPart = existing ?? {
      id: partId(),
      sessionID: state.sessionID,
      messageID: asst.info.id,
      type: 'tool',
      callID,
      tool: toolName,
      state: {
        status: 'running',
        input: getPermissionInput(payload),
        title: toolName,
        time: { start },
      },
    };

    blocked.tool = toolName;
    blocked.state = {
      status: 'blocked',
      input: getPermissionInput(payload) ?? blocked.state.input ?? {},
      title: getToolTitle(blocked, toolName),
      metadata: getToolMetadata(blocked),
      block: {
        type: 'permission',
        id: callID,
        permission: toolName,
        patterns: [],
        always: [],
        metadata: payload ?? {},
      },
      time: { start },
    };

    if (!existing) {
      asst.parts.push(blocked);
    }
    state.toolParts.set(callID, blocked);
    result.currentAssistant = snapshot(state);
    return result;
  }

  if (msg.type === 'tool-result') {
    const asst = ensureAssistant(state);
    flushPending(state, asst);

    const callID = msg.callId || '';
    const toolPart = state.toolParts.get(callID);
    if (!toolPart) {
      result.currentAssistant = snapshot(state);
      return result;
    }

    const time = { start: getToolStartTime(toolPart), end: Date.now() };
    const resultRecord = toRecord(msg.result);
    const resultStatus = typeof resultRecord?.status === 'string' ? resultRecord.status : null;
    if (toolPart.state.status === 'blocked' && resultStatus === 'approved') {
      toolPart.state = {
        status: 'running',
        input: toolPart.state.input,
        title: getToolTitle(toolPart, toolPart.tool),
        metadata: getToolMetadata(toolPart),
        time: { start: toolPart.state.time.start },
      };
      result.currentAssistant = snapshot(state);
      return result;
    }

    if (resultStatus === 'denied' || resultStatus === 'cancelled') {
      toolPart.state = {
        status: 'error',
        input: toolPart.state.input,
        error: stringifyToolResult(msg.result),
        metadata: getToolMetadata(toolPart),
        time,
      };
      state.toolParts.delete(callID);
      result.currentAssistant = snapshot(state);
      return result;
    }

    const output = stringifyToolResult(msg.result);
    const isError = resultRecord?.error !== undefined;
    toolPart.state = isError ? {
      status: 'error',
      input: toolPart.state.input,
      error: output,
      metadata: getToolMetadata(toolPart),
      time,
    } : {
      status: 'completed',
      input: toolPart.state.input,
      output,
      title: getToolTitle(toolPart, toolPart.tool),
      metadata: getToolMetadata(toolPart),
      time,
    };
    state.toolParts.delete(callID);
    result.currentAssistant = snapshot(state);
    return result;
  }

  if (msg.type === 'terminal-output') {
    const asst = ensureAssistant(state);
    flushPending(state, asst);
    if (msg.data) {
      asst.parts.push({
        id: partId(),
        sessionID: state.sessionID,
        messageID: asst.info.id,
        type: 'text',
        text: msg.data,
        synthetic: true,
        time: { start: Date.now() },
      } satisfies TextPart);
    }
    result.currentAssistant = snapshot(state);
    return result;
  }

  result.currentAssistant = snapshot(state);
  return result;
}

function startAssistant(state: V3AcpMapperState): void {
  const id = msgId();
  state.currentAssistant = {
    info: {
      id,
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
      messageID: id,
      type: 'step-start',
    }],
  };
}

function ensureAssistant(state: V3AcpMapperState): { info: AssistantMessage; parts: Part[] } {
  if (!state.currentAssistant) {
    startAssistant(state);
  }
  return state.currentAssistant!;
}

function finalizeAssistant(
  state: V3AcpMapperState,
  result: V3AcpMapperResult,
  reason: string,
): void {
  const asst = state.currentAssistant;
  if (!asst) return;

  flushPending(state, asst);

  const finish: StepFinishPart = {
    id: partId(),
    sessionID: state.sessionID,
    messageID: asst.info.id,
    type: 'step-finish',
    reason,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  asst.parts.push(finish);
  asst.info.time.completed = Date.now();
  result.messages.push(v3.MessageWithPartsSchema.parse({ info: asst.info, parts: asst.parts }));
  state.currentAssistant = null;
  state.toolParts.clear();
}

function snapshot(state: V3AcpMapperState): MessageWithParts | null {
  if (!state.currentAssistant) return null;
  return {
    info: state.currentAssistant.info,
    parts: state.currentAssistant.parts,
  };
}

function flushPending(
  state: V3AcpMapperState,
  asst: { info: AssistantMessage; parts: Part[] },
): void {
  if (!state.pendingText || !state.pendingType) return;

  const text = state.pendingText.replace(/^\n+|\n+$/g, '');
  const type = state.pendingType;
  state.pendingText = '';
  state.pendingType = null;

  if (!text) return;

  if (type === 'thinking') {
    asst.parts.push({
      id: partId(),
      sessionID: state.sessionID,
      messageID: asst.info.id,
      type: 'reasoning',
      text,
      time: { start: Date.now() },
    } satisfies ReasoningPart);
  } else {
    asst.parts.push({
      id: partId(),
      sessionID: state.sessionID,
      messageID: asst.info.id,
      type: 'text',
      text,
      time: { start: Date.now() },
    } satisfies TextPart);
  }
}

function flushIfTypeChanged(
  state: V3AcpMapperState,
  newType: Exclude<PendingType, null>,
  asst: { info: AssistantMessage; parts: Part[] },
): void {
  if (state.pendingType && state.pendingType !== newType) {
    flushPending(state, asst);
  }
}

function parseThinkingPayload(payload: unknown): { text: string; streaming: boolean } {
  if (typeof payload === 'string') {
    return { text: payload, streaming: false };
  }
  if (!payload || typeof payload !== 'object') {
    return { text: '', streaming: false };
  }
  const text = typeof (payload as { text?: unknown }).text === 'string'
    ? (payload as { text: string }).text
    : '';
  const streaming = (payload as { streaming?: unknown }).streaming === true;
  return { text, streaming };
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }
  if (result == null) {
    return '';
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function getPermissionToolName(payload: Record<string, unknown> | null, fallback: string): string {
  const toolName = payload?.toolName;
  return typeof toolName === 'string' && toolName.length > 0 ? toolName : fallback || 'tool';
}

function getPermissionInput(payload: Record<string, unknown> | null): Record<string, unknown> {
  const input = payload?.input;
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
}

function getToolTitle(tool: ToolPart, fallback: string): string {
  return 'title' in tool.state && typeof tool.state.title === 'string' && tool.state.title.length > 0
    ? tool.state.title
    : fallback;
}

function getToolMetadata(tool: ToolPart): Record<string, unknown> {
  if ('metadata' in tool.state && tool.state.metadata) {
    return tool.state.metadata;
  }
  return {};
}

function getToolStartTime(tool: ToolPart): number {
  if ('time' in tool.state && tool.state.time && typeof tool.state.time.start === 'number') {
    return tool.state.time.start;
  }
  return Date.now();
}
