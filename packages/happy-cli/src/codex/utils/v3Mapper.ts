/**
 * v3 Codex Mapper — converts Codex MCP events into the v3 Message + Parts
 * canonical format.
 *
 * Codex events arrive as typed messages from the app-server:
 * - task_started → begin a new assistant turn
 * - agent_message → text part
 * - agent_reasoning / agent_reasoning_delta → reasoning part
 * - exec_command_begin → tool part (running)
 * - exec_command_end → tool part (completed/error)
 * - patch_apply_begin → tool part (running)
 * - patch_apply_end → tool part (completed/error)
 * - exec_approval_request / apply_patch_approval → tool part (blocked)
 * - task_complete / turn_aborted → finalize turn
 */

import { createId } from '@paralleldrive/cuid2';
import { v3 } from '@slopus/happy-sync';

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

function msgId(): MessageID { return `msg_${createId()}` as MessageID; }
function partId(): PartID { return `prt_${createId()}` as PartID; }

// ─── State ────────────────────────────────────────────────────────────────────

export type V3CodexMapperState = {
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
};

export function createV3CodexMapperState(opts: {
  sessionID: string;
  agent?: string;
  modelID?: string;
  providerID?: string;
  cwd?: string;
  root?: string;
}): V3CodexMapperState {
  return {
    sessionID: opts.sessionID as SessionID,
    agent: opts.agent ?? 'build',
    modelID: opts.modelID ?? 'unknown',
    providerID: opts.providerID ?? 'openai',
    cwd: opts.cwd ?? process.cwd(),
    root: opts.root ?? process.cwd(),
    currentAssistant: null,
    currentUserMessageID: null,
    toolParts: new Map(),
  };
}

// ─── Result ───────────────────────────────────────────────────────────────────

export type V3CodexMapperResult = {
  messages: MessageWithParts[];
  currentAssistant: MessageWithParts | null;
};

// ─── Mapper ───────────────────────────────────────────────────────────────────

export function handleCodexEvent(
  event: Record<string, unknown>,
  state: V3CodexMapperState,
): V3CodexMapperResult {
  const result: V3CodexMapperResult = { messages: [], currentAssistant: null };
  const type = event.type;

  if (type === 'task_started') {
    // Close any previous turn
    if (state.currentAssistant) {
      finalizeAssistant(state, result, 'completed');
    }
    // Start new assistant message
    startAssistant(state);
    result.currentAssistant = state.currentAssistant ? { info: state.currentAssistant.info, parts: state.currentAssistant.parts } : null;
    return result;
  }

  if (type === 'task_complete' || type === 'turn_aborted') {
    if (state.currentAssistant) {
      const status = type === 'task_complete' ? 'completed' : 'cancelled';
      finalizeAssistant(state, result, status);
    }
    return result;
  }

  if (type === 'token_count') {
    return result;
  }

  // Ensure we have an assistant message
  if (!state.currentAssistant) {
    startAssistant(state);
  }
  const asst = state.currentAssistant!;

  if (type === 'agent_message') {
    const text = typeof event.message === 'string' ? event.message : '';
    if (text.length > 0) {
      asst.parts.push({
        id: partId(),
        sessionID: state.sessionID,
        messageID: asst.info.id,
        type: 'text',
        text,
        time: { start: Date.now() },
      } satisfies TextPart);
    }
    result.currentAssistant = { info: asst.info, parts: asst.parts };
    return result;
  }

  if (type === 'agent_reasoning' || type === 'agent_reasoning_delta') {
    const text = typeof event.text === 'string'
      ? event.text
      : (typeof event.delta === 'string' ? event.delta : '');
    if (text.length > 0) {
      asst.parts.push({
        id: partId(),
        sessionID: state.sessionID,
        messageID: asst.info.id,
        type: 'reasoning',
        text,
        time: { start: Date.now() },
      } satisfies ReasoningPart);
    }
    result.currentAssistant = { info: asst.info, parts: asst.parts };
    return result;
  }

  if (type === 'reasoning') {
    const text = typeof event.message === 'string' ? event.message : '';
    if (text.length > 0) {
      asst.parts.push({
        id: partId(),
        sessionID: state.sessionID,
        messageID: asst.info.id,
        type: 'reasoning',
        text,
        time: { start: Date.now() },
      } satisfies ReasoningPart);
    }
    result.currentAssistant = { info: asst.info, parts: asst.parts };
    return result;
  }

  if (type === 'tool-call') {
    const callID = pickCallId(event);
    const toolName = typeof event.name === 'string' && event.name.length > 0
      ? event.name
      : 'tool';
    const input = event.input && typeof event.input === 'object'
      ? event.input as Record<string, unknown>
      : {};

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
        title: toolName,
        time: { start: Date.now() },
      },
    };
    asst.parts.push(toolPart);
    state.toolParts.set(callID, toolPart);
    result.currentAssistant = { info: asst.info, parts: asst.parts };
    return result;
  }

  if (type === 'tool-call-result') {
    const callID = pickCallId(event);
    const toolPart = state.toolParts.get(callID);
    if (toolPart && toolPart.state.status === 'running') {
      const output = event.output && typeof event.output === 'object'
        ? event.output as { content?: unknown; status?: unknown }
        : {};
      const content = typeof output.content === 'string' ? output.content : '';
      const status = output.status === 'canceled' ? 'canceled' : 'completed';

      toolPart.state = status === 'completed'
        ? {
            status: 'completed',
            input: toolPart.state.input,
            output: content,
            title: toolPart.state.title ?? toolPart.tool,
            metadata: {},
            time: { start: toolPart.state.time.start, end: Date.now() },
          }
        : {
            status: 'error',
            input: toolPart.state.input,
            error: content || 'Canceled',
            metadata: { canceled: true },
            time: { start: toolPart.state.time.start, end: Date.now() },
          };
      state.toolParts.delete(callID);
    }
    result.currentAssistant = { info: asst.info, parts: asst.parts };
    return result;
  }

  if (type === 'exec_command_begin') {
    const callID = pickCallId(event);
    const command = summarizeCommand(event.command);
    const input = { ...event };
    delete input.type;
    delete input.call_id;
    delete input.callId;

    const existingTool = state.toolParts.get(callID);
    if (existingTool && (existingTool.state.status === 'blocked' || existingTool.state.status === 'running')) {
      existingTool.tool = 'bash';
      existingTool.state = {
        status: 'running',
        input: input as Record<string, unknown>,
        title: command ? `Run \`${command.length > 60 ? command.slice(0, 57) + '...' : command}\`` : 'Run command',
        time: { start: (existingTool.state as any).time?.start ?? Date.now() },
      };
      result.currentAssistant = { info: asst.info, parts: asst.parts };
      return result;
    }

    const toolPart: ToolPart = {
      id: partId(),
      sessionID: state.sessionID,
      messageID: asst.info.id,
      type: 'tool',
      callID,
      tool: 'bash',
      state: {
        status: 'running',
        input: input as Record<string, unknown>,
        title: command ? `Run \`${command.length > 60 ? command.slice(0, 57) + '...' : command}\`` : 'Run command',
        time: { start: Date.now() },
      },
    };
    asst.parts.push(toolPart);
    state.toolParts.set(callID, toolPart);
    result.currentAssistant = { info: asst.info, parts: asst.parts };
    return result;
  }

  if (type === 'exec_command_end') {
    const callID = pickCallId(event);
    const toolPart = state.toolParts.get(callID);
    if (toolPart && toolPart.state.status === 'running') {
      const exitCode = typeof event.exit_code === 'number' ? event.exit_code : (typeof event.exitCode === 'number' ? event.exitCode : 0);
      const output = typeof event.stdout === 'string' ? event.stdout : '';
      toolPart.state = exitCode === 0
        ? {
            status: 'completed',
            input: toolPart.state.input,
            output,
            title: toolPart.state.title ?? 'bash',
            metadata: { exitCode },
            time: { start: toolPart.state.time.start, end: Date.now() },
          }
        : {
            status: 'error',
            input: toolPart.state.input,
            error: typeof event.stderr === 'string' ? event.stderr : `Exit code ${exitCode}`,
            metadata: { exitCode },
            time: { start: toolPart.state.time.start, end: Date.now() },
          };
      state.toolParts.delete(callID);
    }
    result.currentAssistant = { info: asst.info, parts: asst.parts };
    return result;
  }

  if (type === 'patch_apply_begin') {
    const callID = pickCallId(event);
    const changes = event.changes as Record<string, unknown> | undefined;
    const fileCount = changes ? Object.keys(changes).length : 0;

    const existingTool = state.toolParts.get(callID);
    if (existingTool && (existingTool.state.status === 'blocked' || existingTool.state.status === 'running')) {
      existingTool.tool = 'apply_patch';
      existingTool.state = {
        status: 'running',
        input: { changes, auto_approved: event.auto_approved },
        title: fileCount === 1 ? 'Apply patch to 1 file' : `Apply patch to ${fileCount} files`,
        time: { start: (existingTool.state as any).time?.start ?? Date.now() },
      };
      result.currentAssistant = { info: asst.info, parts: asst.parts };
      return result;
    }

    const toolPart: ToolPart = {
      id: partId(),
      sessionID: state.sessionID,
      messageID: asst.info.id,
      type: 'tool',
      callID,
      tool: 'apply_patch',
      state: {
        status: 'running',
        input: { changes, auto_approved: event.auto_approved },
        title: fileCount === 1 ? 'Apply patch to 1 file' : `Apply patch to ${fileCount} files`,
        time: { start: Date.now() },
      },
    };
    asst.parts.push(toolPart);
    state.toolParts.set(callID, toolPart);
    result.currentAssistant = { info: asst.info, parts: asst.parts };
    return result;
  }

  if (type === 'patch_apply_end') {
    const callID = pickCallId(event);
    const toolPart = state.toolParts.get(callID);
    if (toolPart && (toolPart.state.status === 'running' || toolPart.state.status === 'blocked')) {
      const status = typeof event.status === 'string' ? event.status : null;
      const success = event.success === false
        ? false
        : status === null || status === 'completed';
      const output = typeof event.stdout === 'string' && event.stdout.length > 0
        ? event.stdout
        : 'Patch applied';

      toolPart.state = success
        ? {
            status: 'completed',
            input: toolPart.state.input,
            output,
            title: toolPart.state.title ?? 'apply_patch',
            metadata: status ? { status } : {},
            time: { start: toolPart.state.time.start, end: Date.now() },
          }
        : {
            status: 'error',
            input: toolPart.state.input,
            error: typeof event.stderr === 'string' && event.stderr.length > 0
              ? event.stderr
              : output || (status ? `Patch ${status}` : 'Patch failed'),
            metadata: status ? { status } : {},
            time: { start: toolPart.state.time.start, end: Date.now() },
          };
      state.toolParts.delete(callID);
    }
    result.currentAssistant = { info: asst.info, parts: asst.parts };
    return result;
  }

  // exec_approval_request → tool blocked (permission)
  if (type === 'exec_approval_request') {
    const callID = typeof event.callId === 'string' ? event.callId : (typeof event.call_id === 'string' ? event.call_id : '');
    const command = summarizeCommand(event.command);
    const toolPart = state.toolParts.get(callID);
    if (toolPart && (toolPart.state.status === 'running' || toolPart.state.status === 'pending')) {
      toolPart.state = {
        status: 'blocked',
        input: toolPart.state.input,
        title: toolPart.state.status === 'running' ? toolPart.state.title : undefined,
        time: { start: (toolPart.state as any).time?.start ?? Date.now() },
        block: {
          type: 'permission',
          id: callID,
          permission: 'bash',
          patterns: command ? [command] : ['*'],
          always: ['*'],
          metadata: { command: event.command, reason: event.reason },
        },
      };
    } else {
      const blockedTool: ToolPart = {
        id: partId(),
        sessionID: state.sessionID,
        messageID: asst.info.id,
        type: 'tool',
        callID,
        tool: 'bash',
        state: {
          status: 'blocked',
          input: {
            command: event.command,
            cwd: event.cwd,
          },
          title: command ? `Run \`${command.length > 60 ? command.slice(0, 57) + '...' : command}\`` : 'Run command',
          time: { start: Date.now() },
          block: {
            type: 'permission',
            id: callID,
            permission: 'bash',
            patterns: command ? [command] : ['*'],
            always: ['*'],
            metadata: { command: event.command, reason: event.reason },
          },
        },
      };
      asst.parts.push(blockedTool);
      state.toolParts.set(callID, blockedTool);
    }
    result.currentAssistant = { info: asst.info, parts: asst.parts };
    return result;
  }

  // apply_patch_approval → tool blocked (permission)
  if (type === 'apply_patch_approval') {
    const callID = typeof event.callId === 'string' ? event.callId : (typeof event.call_id === 'string' ? event.call_id : '');
    const changes = event.fileChanges ?? event.file_changes;
    const files = changes && typeof changes === 'object' ? Object.keys(changes as Record<string, unknown>) : [];
    const toolPart = state.toolParts.get(callID);
    if (toolPart && (toolPart.state.status === 'running' || toolPart.state.status === 'pending')) {
      toolPart.state = {
        status: 'blocked',
        input: toolPart.state.input,
        title: toolPart.state.status === 'running' ? toolPart.state.title : undefined,
        time: { start: (toolPart.state as any).time?.start ?? Date.now() },
        block: {
          type: 'permission',
          id: callID,
          permission: 'edit',
          patterns: files,
          always: ['*'],
          metadata: { fileChanges: changes, reason: event.reason },
        },
      };
    } else {
      const blockedTool: ToolPart = {
        id: partId(),
        sessionID: state.sessionID,
        messageID: asst.info.id,
        type: 'tool',
        callID,
        tool: 'apply_patch',
        state: {
          status: 'blocked',
          input: { changes },
          title: files.length === 1 ? 'Apply patch to 1 file' : `Apply patch to ${files.length} files`,
          time: { start: Date.now() },
          block: {
            type: 'permission',
            id: callID,
            permission: 'edit',
            patterns: files,
            always: ['*'],
            metadata: { fileChanges: changes, reason: event.reason },
          },
        },
      };
      asst.parts.push(blockedTool);
      state.toolParts.set(callID, blockedTool);
    }
    result.currentAssistant = { info: asst.info, parts: asst.parts };
    return result;
  }

  return result;
}

export function flushV3CodexTurn(state: V3CodexMapperState, status: string = 'completed'): MessageWithParts[] {
  const result: V3CodexMapperResult = { messages: [], currentAssistant: null };
  if (state.currentAssistant) {
    finalizeAssistant(state, result, status);
  }
  return result.messages;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function startAssistant(state: V3CodexMapperState): void {
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
  state.toolParts.clear();
}

function finalizeAssistant(
  state: V3CodexMapperState,
  result: V3CodexMapperResult,
  status: string,
): void {
  if (!state.currentAssistant) return;
  const asst = state.currentAssistant;

  const hasTools = asst.parts.some(p => p.type === 'tool');
  const finish = hasTools ? 'tool-calls' : (status === 'cancelled' ? 'cancelled' : 'stop');

  asst.parts.push({
    id: partId(),
    sessionID: state.sessionID,
    messageID: asst.info.id,
    type: 'step-finish',
    reason: finish,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } satisfies StepFinishPart);

  asst.info.time.completed = Date.now();
  asst.info.finish = finish;

  result.messages.push(validateMessageWithParts({ info: asst.info, parts: asst.parts }));
  state.currentAssistant = null;
}

/** Validate a finalized message against the v3 schema. Throws on invalid data. */
function validateMessageWithParts(msg: MessageWithParts): MessageWithParts {
  return v3.MessageWithPartsSchema.parse(msg);
}

function pickCallId(event: Record<string, unknown>): string {
  const callId = event.call_id ?? event.callId;
  if (typeof callId === 'string' && callId.length > 0) return callId;
  return createId();
}

function summarizeCommand(command: unknown): string | null {
  if (typeof command === 'string' && command.trim().length > 0) return command;
  if (Array.isArray(command)) {
    const cmd = command.map(v => String(v)).join(' ').trim();
    return cmd.length > 0 ? cmd : null;
  }
  return null;
}
