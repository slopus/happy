import type { AgentMessage } from '@/agent/core';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { ApiSessionClient } from '@/api/apiSession';

type AgentKey = Parameters<ApiSessionClient['sendAgentMessage']>[0];
type AgentPayload = Parameters<ApiSessionClient['sendAgentMessage']>[1];
type SessionWithKeepAlive = Pick<ApiSessionClient, 'keepAlive' | 'sendAgentMessage'>;
type SessionWithSendOnly = Pick<ApiSessionClient, 'sendAgentMessage'>;

export function handleAcpModelOutputDelta(params: {
  delta: string;
  messageBuffer: MessageBuffer;
  getIsResponseInProgress: () => boolean;
  setIsResponseInProgress: (value: boolean) => void;
  appendToAccumulatedResponse: (delta: string) => void;
}): void {
  const delta = params.delta ?? '';
  if (!delta) return;

  if (!params.getIsResponseInProgress()) {
    params.messageBuffer.removeLastMessage('system');
    params.messageBuffer.addMessage(delta, 'assistant');
    params.setIsResponseInProgress(true);
  } else {
    params.messageBuffer.updateLastMessage(delta, 'assistant');
  }

  params.appendToAccumulatedResponse(delta);
}

export function handleAcpStatusRunning(params: {
  session: SessionWithKeepAlive;
  agent: AgentKey;
  messageBuffer: MessageBuffer;
  onThinkingChange: (thinking: boolean) => void;
  getTaskStartedSent: () => boolean;
  setTaskStartedSent: (value: boolean) => void;
  makeId: () => string;
}): void {
  params.onThinkingChange(true);
  params.session.keepAlive(true, 'remote');

  if (!params.getTaskStartedSent()) {
    const payload: AgentPayload = { type: 'task_started', id: params.makeId() };
    params.session.sendAgentMessage(params.agent, payload);
    params.setTaskStartedSent(true);
  }

  params.messageBuffer.addMessage('Thinking...', 'system');
}

export function forwardAcpPermissionRequest(params: {
  msg: AgentMessage;
  session: SessionWithSendOnly;
  agent: AgentKey;
}): void {
  if (params.msg.type !== 'permission-request') return;
  const payload = (params.msg as any).payload || {};

  const hasMeaningfulInput = (input: unknown): boolean => {
    if (Array.isArray(input)) return input.length > 0;
    if (!input || typeof input !== 'object') return false;
    return Object.keys(input as Record<string, unknown>).length > 0;
  };

  const backfillInputFromToolCall = (container: unknown): unknown => {
    if (!container || typeof container !== 'object') return container;
    if (Array.isArray(container)) return container;

    const record = container as Record<string, unknown>;
    const input = record.input;
    if (hasMeaningfulInput(input)) return container;

    const toolCall = record.toolCall;
    if (!toolCall || typeof toolCall !== 'object' || Array.isArray(toolCall)) return container;

    const toolCallRecord = toolCall as Record<string, unknown>;
    const toolCallRawInput = toolCallRecord.rawInput;
    const backfilledInput = hasMeaningfulInput(toolCallRawInput) ? toolCallRawInput : toolCall;

    return { ...record, input: backfilledInput };
  };

  const normalizedPayload = (() => {
    const topLevel = backfillInputFromToolCall(payload);
    if (!topLevel || typeof topLevel !== 'object' || Array.isArray(topLevel)) return topLevel;
    const record = topLevel as Record<string, unknown>;
    const maybeOptions = record.options;
    const nextOptions = backfillInputFromToolCall(maybeOptions);
    if (nextOptions === maybeOptions) return topLevel;
    return { ...record, options: nextOptions };
  })();

  const message: AgentPayload = {
    type: 'permission-request',
    permissionId: (params.msg as any).id,
    toolName: payload.toolName || (params.msg as any).reason || 'unknown',
    description: (params.msg as any).reason || payload.toolName || '',
    options: normalizedPayload,
  };

  params.session.sendAgentMessage(params.agent, message);
}

export function forwardAcpTerminalOutput(params: {
  msg: AgentMessage;
  messageBuffer: MessageBuffer;
  session: SessionWithSendOnly;
  agent: AgentKey;
  getCallId: (msg: AgentMessage) => string;
}): void {
  if (params.msg.type !== 'terminal-output') return;
  const data = (params.msg as any).data as string;
  params.messageBuffer.addMessage(data, 'result');
  const message: AgentPayload = {
    type: 'terminal-output',
    data,
    callId: params.getCallId(params.msg),
  };
  params.session.sendAgentMessage(params.agent, message);
}
