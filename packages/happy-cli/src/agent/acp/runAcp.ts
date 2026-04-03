import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import { SyncBridge } from '@/api/syncBridge';
import { resolveSessionScopedSyncNodeToken } from '@/api/syncNodeToken';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerCommonHandlers } from '@/modules/common/registerCommonHandlers';
import type { AgentMessage } from '@/agent/core';
import { AcpBackend, type AcpPermissionHandler } from './AcpBackend';
import { DefaultTransport } from '@/agent/transport';
import { AcpSessionManager } from './AcpSessionManager';
import type { SessionEnvelope } from '@/legacy/sessionProtocol';
import type {
  SessionMessage,
  SessionAgentMessage,
  SessionUserMessage,
} from '@slopus/happy-sync';
import type { SessionID } from '@slopus/happy-sync';
import { logger } from '@/ui/logger';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { Credentials, readSettings } from '@/persistence';
import type { AgentState } from '@/api/types';
import { initialMachineMetadata } from '@/daemon/run';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { configuration } from '@/configuration';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { projectPath } from '@/projectPath';
import { BasePermissionHandler, type PermissionResult } from '@/utils/BasePermissionHandler';
import { connectionState } from '@/utils/serverConnectionErrors';
import {
  extractConfigOptionsFromPayload,
  extractCurrentModeIdFromPayload,
  extractModeStateFromPayload,
  extractModelStateFromPayload,
  mergeAcpSessionConfigIntoMetadata,
} from './sessionConfigMetadata';
import type { SessionConfigOption, SessionModeState, SessionModelState } from '@agentclientprotocol/sdk';

const TURN_TIMEOUT_MS = 5 * 60 * 1000;
const IDLE_BEFORE_PROMPT_SETTLE_MS = 15_000;
const PROMPT_RPC_DRAIN_WAIT_MS = 5_000;
const ACP_EVENT_PREVIEW_CHARS = 240;
const ACP_RAW_PREVIEW_CHARS = 2000;
const ACP_COLOR_RESET = '\u001b[0m';
const ACP_LOG_COLORS = {
  muted: '\u001b[90m',
  error: '\u001b[31m',
  incoming: '\u001b[32m',
  outgoing: '\u001b[34m',
  tool: '\u001b[38;5;208m',
} as const;

type AcpLogKind = keyof typeof ACP_LOG_COLORS;
type AcpFormattedLog = {
  kind: AcpLogKind;
  text: string;
};

function shouldUseColoredAcpLogs(): boolean {
  if (process.env.FORCE_COLOR === '0') {
    return false;
  }
  if (process.env.FORCE_COLOR !== undefined) {
    return true;
  }
  return process.stdout.isTTY === true || process.stderr.isTTY === true;
}

function formatAcpTime(date: Date = new Date()): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function colorizeAcpLine(kind: AcpLogKind, line: string): string {
  if (!shouldUseColoredAcpLogs()) {
    return line;
  }
  return `${ACP_LOG_COLORS[kind]}${line}${ACP_COLOR_RESET}`;
}

function logAcp(kind: AcpLogKind, message: string): void {
  const line = `[${formatAcpTime()}] ${message}`;
  console.log(colorizeAcpLine(kind, line));
}

function toSingleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncateForConsole(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}...`;
}

function formatUnknownForConsole(value: unknown, limit: number): string {
  let serialized = '';
  if (typeof value === 'string') {
    serialized = value;
  } else {
    try {
      serialized = JSON.stringify(value);
    } catch {
      serialized = String(value);
    }
  }
  return truncateForConsole(toSingleLine(serialized), limit);
}

function formatTextForConsole(text: string): string {
  return JSON.stringify(truncateForConsole(toSingleLine(text), ACP_EVENT_PREVIEW_CHARS));
}

function formatOptionalDetail(text: string | null | undefined, limit = ACP_EVENT_PREVIEW_CHARS): string {
  if (!text) {
    return '';
  }
  return ` - ${truncateForConsole(toSingleLine(text), limit)}`;
}

function extractThinkingText(payload: unknown): string {
  if (typeof payload === 'string') {
    return payload;
  }
  if (payload && typeof payload === 'object' && typeof (payload as { text?: unknown }).text === 'string') {
    return (payload as { text: string }).text;
  }
  return '';
}

function formatAcpMessageForFrontend(agentName: string, msg: AgentMessage, detailed: boolean): AcpFormattedLog | null {
  switch (msg.type) {
    case 'status':
      return null;
    case 'model-output': {
      const text = msg.textDelta ?? msg.fullText ?? '';
      return {
        kind: 'outgoing',
        text: `Outgoing message: ${formatTextForConsole(text)}`,
      };
    }
    case 'tool-call':
      return {
        kind: 'tool',
        text: `Tool: ${msg.toolName} started (callId=${msg.callId})`,
      };
    case 'tool-result':
      return {
        kind: 'tool',
        text: `Tool: ${msg.toolName} completed (callId=${msg.callId})`,
      };
    case 'permission-request':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing permission request from ${agentName}: id=${msg.id} reason=${msg.reason}`,
      };
    case 'permission-response':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing permission response from ${agentName}: id=${msg.id} approved=${msg.approved}`,
      };
    case 'fs-edit':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing fs edit from ${agentName}: description=${formatTextForConsole(msg.description)}`,
      };
    case 'terminal-output':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing terminal output from ${agentName}: text=${formatTextForConsole(msg.data)}`,
      };
    case 'event': {
      if (msg.name === 'thinking') {
        const thinkingText = extractThinkingText(msg.payload);
        return {
          kind: 'muted',
          text: `Thinking: ${formatTextForConsole(thinkingText)}`,
        };
      }
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing event from ${agentName}: name=${msg.name} payload=${formatUnknownForConsole(msg.payload, ACP_EVENT_PREVIEW_CHARS)}`,
      };
    }
    case 'token-count':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing token count from ${agentName}: data=${formatUnknownForConsole(msg, ACP_EVENT_PREVIEW_CHARS)}`,
      };
    case 'exec-approval-request':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing exec approval request from ${agentName}: callId=${msg.call_id}`,
      };
    case 'patch-apply-begin':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing patch apply begin from ${agentName}: callId=${msg.call_id} autoApproved=${msg.auto_approved === true}`,
      };
    case 'patch-apply-end':
      if (!detailed) {
        return null;
      }
      return {
        kind: 'muted',
        text: `Outgoing patch apply end from ${agentName}: callId=${msg.call_id} success=${msg.success}`,
      };
    default:
      return null;
  }
}

function formatEnvelopeForServerLog(agentName: string, envelope: SessionEnvelope): AcpFormattedLog {
  if (envelope.ev.t === 'text') {
    const thinkingPrefix = envelope.ev.thinking ? 'thinking' : 'text';
    return {
      kind: 'incoming',
      text: `Incoming ${thinkingPrefix} prompt for ${agentName}: ${formatUnknownForConsole(envelope.ev.text, ACP_EVENT_PREVIEW_CHARS)}`,
    };
  }
  if (envelope.ev.t === 'tool-call-start') {
    return {
      kind: 'tool',
      text: `Tool start sent to server from ${agentName}: tool=${envelope.ev.name} callId=${envelope.ev.call} args=${formatUnknownForConsole(envelope.ev.args, ACP_EVENT_PREVIEW_CHARS)}`,
    };
  }
  if (envelope.ev.t === 'tool-call-end') {
    return {
      kind: 'tool',
      text: `Tool end sent to server from ${agentName}: callId=${envelope.ev.call}`,
    };
  }
  if (envelope.ev.t === 'turn-start') {
    return {
      kind: 'incoming',
      text: `Incoming turn start for ${agentName}`,
    };
  }
  if (envelope.ev.t === 'turn-end') {
    return {
      kind: 'incoming',
      text: `Incoming turn end for ${agentName}: status=${envelope.ev.status}`,
    };
  }
  return {
    kind: 'incoming',
    text: `Incoming ${envelope.ev.t} for ${agentName}: ${formatUnknownForConsole(envelope.ev, ACP_EVENT_PREVIEW_CHARS)}`,
  };
}

type AcpSwitchMode = {
  permissionMode?: string;
  model?: string | null;
};

// ─── acpx SessionAgentMessage accumulator ─────────────────────────────────────

type AcpxAccumulator = {
  message: SessionAgentMessage;
  /** Stable wrapper for SyncNode's localId tracking (same reference across send/update). */
  wrapper: SessionMessage;
  localId: string;
  sent: boolean;
};

function createAcpxAccumulator(): AcpxAccumulator {
  const message: SessionAgentMessage = { content: [], tool_results: {} };
  return {
    message,
    wrapper: { Agent: message },
    localId: randomUUID(),
    sent: false,
  };
}

function applyAgentMessageToAccumulator(acc: AcpxAccumulator, msg: AgentMessage): void {
  const m = acc.message;
  switch (msg.type) {
    case 'model-output': {
      const text = msg.textDelta ?? msg.fullText ?? '';
      if (!text) break;
      const last = m.content.length > 0 ? m.content[m.content.length - 1] : null;
      if (last && 'Text' in last) {
        (last as { Text: string }).Text += text;
      } else {
        m.content.push({ Text: text });
      }
      break;
    }
    case 'event': {
      if (msg.name === 'thinking') {
        const payload = msg.payload;
        const text = typeof payload === 'string'
          ? payload
          : (payload && typeof payload === 'object' && typeof (payload as { text?: unknown }).text === 'string')
            ? (payload as { text: string }).text
            : '';
        if (!text) break;
        const last = m.content.length > 0 ? m.content[m.content.length - 1] : null;
        if (last && 'Thinking' in last) {
          (last as { Thinking: { text: string } }).Thinking.text += text;
        } else {
          m.content.push({ Thinking: { text } });
        }
      }
      break;
    }
    case 'tool-call': {
      m.content.push({
        ToolUse: {
          id: msg.callId,
          name: msg.toolName,
          raw_input: typeof msg.args === 'string' ? msg.args : JSON.stringify(msg.args),
          input: msg.args,
          is_input_complete: true,
        },
      });
      break;
    }
    case 'tool-result': {
      const resultText = typeof msg.result === 'string'
        ? msg.result
        : JSON.stringify(msg.result ?? '');
      m.tool_results[msg.callId] = {
        tool_use_id: msg.callId,
        tool_name: msg.toolName,
        is_error: false,
        content: { Text: resultText },
      };
      break;
    }
    default:
      break;
  }
}

function isTranscriptMessage(msg: AgentMessage): boolean {
  return msg.type === 'model-output'
    || msg.type === 'tool-call'
    || msg.type === 'tool-result'
    || (msg.type === 'event' && msg.name === 'thinking');
}

// ─────────────────────────────────────────────────────────────────────────────

type AcpSelectableOption = {
  code: string;
  value: string;
};

type AcpConfigSelector = {
  configId: string;
  currentCode: string;
  options: AcpSelectableOption[];
};

type MessageModelLike =
  | string
  | null
  | undefined
  | {
      providerID?: string | null;
      modelID?: string | null;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function isSelectValue(value: unknown): value is { value: string; name: string } {
  return isRecord(value) && typeof value.value === 'string' && typeof value.name === 'string';
}

function isSelectGroup(value: unknown): value is { options: unknown[] } {
  return isRecord(value) && Array.isArray(value.options);
}

function flattenSelectOptions(options: unknown): AcpSelectableOption[] {
  if (!Array.isArray(options)) {
    return [];
  }

  const flattened: AcpSelectableOption[] = [];

  for (const entry of options) {
    if (isSelectValue(entry)) {
      flattened.push({ code: entry.value, value: entry.name });
      continue;
    }
    if (isSelectGroup(entry)) {
      for (const grouped of entry.options) {
        if (!isSelectValue(grouped)) {
          continue;
        }
        flattened.push({ code: grouped.value, value: grouped.name });
      }
    }
  }

  return flattened;
}

function extractConfigSelector(
  configOptions: SessionConfigOption[],
  category: 'mode' | 'model',
): AcpConfigSelector | null {
  const optionMatchesCategory = (option: SessionConfigOption): boolean => {
    if (option.category === category) {
      return true;
    }
    // Some ACP providers omit category; fallback to id/name heuristics.
    const id = normalizeComparable(option.id);
    const name = normalizeComparable(option.name);
    if (category === 'model') {
      return id.includes('model') || name.includes('model');
    }
    return id.includes('mode') || id.includes('permission') || name.includes('mode') || name.includes('permission');
  };

  for (const option of configOptions) {
    if (option.type !== 'select' || !optionMatchesCategory(option)) {
      continue;
    }
    return {
      configId: option.id,
      currentCode: option.currentValue,
      options: flattenSelectOptions(option.options),
    };
  }
  return null;
}

function normalizeComparable(value: string): string {
  return value.trim().toLowerCase();
}

function resolveRequestedAcpModel(model: MessageModelLike): string | null {
  if (typeof model === 'string') {
    return model;
  }

  if (!model || typeof model !== 'object') {
    return null;
  }

  const providerID = typeof model.providerID === 'string' ? model.providerID.trim() : '';
  const modelID = typeof model.modelID === 'string' ? model.modelID.trim() : '';

  if (!modelID) {
    return null;
  }

  if (modelID.includes('/')) {
    return modelID;
  }

  return providerID ? `${providerID}/${modelID}` : modelID;
}

function resolveRequestedCode(options: AcpSelectableOption[], requested: string): string | null {
  for (const option of options) {
    if (option.code === requested || option.value === requested) {
      return option.code;
    }
  }

  const normalizedRequested = normalizeComparable(requested);
  for (const option of options) {
    if (normalizeComparable(option.code) === normalizedRequested || normalizeComparable(option.value) === normalizedRequested) {
      return option.code;
    }
  }

  return null;
}

function resolveRequestedLegacyModeCode(modes: SessionModeState, requested: string): string | null {
  for (const mode of modes.availableModes) {
    if (mode.id === requested || mode.name === requested) {
      return mode.id;
    }
  }

  const normalizedRequested = normalizeComparable(requested);
  for (const mode of modes.availableModes) {
    if (normalizeComparable(mode.id) === normalizedRequested || normalizeComparable(mode.name) === normalizedRequested) {
      return mode.id;
    }
  }

  return null;
}

function resolveRequestedLegacyModelCode(models: SessionModelState, requested: string): string | null {
  for (const model of models.availableModels) {
    if (model.modelId === requested || model.name === requested) {
      return model.modelId;
    }
  }

  const normalizedRequested = normalizeComparable(requested);
  for (const model of models.availableModels) {
    if (normalizeComparable(model.modelId) === normalizedRequested || normalizeComparable(model.name) === normalizedRequested) {
      return model.modelId;
    }
  }

  return null;
}

class GenericAcpPermissionHandler extends BasePermissionHandler implements AcpPermissionHandler {
  private readonly logPrefix: string;

  constructor(
    rpcManager: RpcHandlerManager,
    updateAgentState: (handler: (state: AgentState) => AgentState) => void,
    sendPermissionRequest: ((request: { callID: string; tool: string; patterns: string[]; input: Record<string, unknown> }) => Promise<void>) | undefined,
    agentName: string,
  ) {
    super({ rpcHandlerManager: rpcManager, updateAgentState, sendPermissionRequest });
    this.logPrefix = `[${agentName}]`;
  }

  protected getLogPrefix(): string {
    return this.logPrefix;
  }

  async handleToolCall(toolCallId: string, toolName: string, input: unknown): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve, reject) => {
      this.pendingRequests.set(toolCallId, {
        resolve,
        reject,
        toolName,
        input,
      });
      this.addPendingRequestToState(toolCallId, toolName, input);
      logger.debug(`${this.logPrefix} Permission request sent for tool: ${toolName} (${toolCallId})`);
    });
  }
}

type PendingTurn = {
  resolve: () => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
};

function resolveSessionFlavor(agentName: string): 'gemini' | 'opencode' | 'acp' {
  if (agentName === 'gemini') {
    return 'gemini';
  }
  if (agentName === 'opencode') {
    return 'opencode';
  }
  return 'acp';
}

export async function runAcp(opts: {
  credentials: Credentials;
  agentName: string;
  command: string;
  args: string[];
  startedBy?: 'daemon' | 'terminal';
  verbose?: boolean;
}): Promise<void> {
  const verbose = opts.verbose === true;
  const sessionTag = randomUUID();
  connectionState.setBackend(opts.agentName);

  const api = await ApiClient.create(opts.credentials);
  const settings = await readSettings();
  if (!settings?.machineId) {
    throw new Error('No machine ID found in settings');
  }

  await api.getOrCreateMachine({
    machineId: settings.machineId,
    metadata: initialMachineMetadata,
  });

  const { state, metadata } = createSessionMetadata({
    flavor: resolveSessionFlavor(opts.agentName),
    machineId: settings.machineId,
    startedBy: opts.startedBy,
    sandbox: settings.sandboxConfig,
  });
  const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
  if (response) {
    logAcp('muted', `Happy Session ID: ${response.id}`);
  }

  let session: ApiSessionClient;
  let permissionHandler: GenericAcpPermissionHandler;
  const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
    api,
    sessionTag,
    metadata,
    state,
    response,
    onSessionSwap: (newSession) => {
      session = newSession;
      if (permissionHandler) {
        permissionHandler.updateDeps({
          rpcHandlerManager: rpcHandlerManager ?? newSession.rpcHandlerManager,
          updateAgentState: syncBridge
            ? (handler) => syncBridge!.updateAgentState(handler as any)
            : (handler) => newSession.updateAgentState(handler),
        });
      }
    },
  });
  session = initialSession;

  // ─── Create SyncBridge directly ──────────────────────────────────────────

  let syncBridge: SyncBridge | null = null;
  let rpcHandlerManager: RpcHandlerManager | null = null;

  if (response) {
    const sessionScopedToken = await resolveSessionScopedSyncNodeToken({
      serverUrl: configuration.serverUrl,
      sessionId: response.id,
      token: {
        raw: opts.credentials.token,
        claims: {
          scope: { type: 'account', userId: 'cli' },
          permissions: ['read', 'write', 'admin'],
        },
      },
    });

    syncBridge = new SyncBridge({
      serverUrl: configuration.serverUrl,
      token: sessionScopedToken,
      keyMaterial: {
        key: response.encryptionKey,
        variant: response.encryptionVariant,
      },
      sessionId: response.id as SessionID,
    });
    await syncBridge.connect();
    logAcp('muted', `SyncBridge connected`);

    // ─── Create RpcHandlerManager and wire to SyncBridge ─────────────────

    rpcHandlerManager = new RpcHandlerManager({
      scopePrefix: response.id,
      encryptionKey: response.encryptionKey,
      encryptionVariant: response.encryptionVariant,
    });

    syncBridge.setRpcHandler(async (method: string, params: string) => {
      return rpcHandlerManager!.handleRequest({ method, params });
    });

    rpcHandlerManager.setRegistrationCallback((prefixedMethod) => {
      syncBridge!.registerRpcMethods([prefixedMethod]);
    });

    registerCommonHandlers(rpcHandlerManager, process.cwd());
    syncBridge.registerRpcMethods(rpcHandlerManager.getRegisteredMethods());
  }

  permissionHandler = new GenericAcpPermissionHandler(
    rpcHandlerManager ?? session.rpcHandlerManager,
    syncBridge
      ? (handler) => syncBridge!.updateAgentState(handler as any)
      : (handler) => session.updateAgentState(handler),
    syncBridge
      ? (request) => syncBridge!.sendPermissionRequest(request)
      : undefined,
    opts.agentName,
  );
  if (syncBridge) {
    syncBridge.onPermissionDecision((decision) => {
      permissionHandler.handleSyncDecision({
        id: decision.callId,
        approved: decision.decision !== 'reject',
        decision: decision.decision === 'always'
          ? 'approved_for_session'
          : decision.decision === 'reject'
            ? 'denied'
            : 'approved',
      });
    });
  }
  const sessionManager = new AcpSessionManager();
  let acpxAcc: AcpxAccumulator | null = null;
  const messageQueue = new MessageQueue2<AcpSwitchMode>((mode) => hashObject(mode));
  let currentPermissionMode: string | undefined;
  let currentModel: string | null | undefined;
  let modeSelector: AcpConfigSelector | null = null;
  let modelSelector: AcpConfigSelector | null = null;
  let legacyModes: SessionModeState | null = null;
  let legacyModels: SessionModelState | null = null;
  let sawSlashCommands = false;
  let sawModes = false;
  let sawModels = false;

  if (syncBridge) {
    syncBridge.onRuntimeConfigChange((change) => {
      if (typeof change.permissionMode === 'string') {
        currentPermissionMode = change.permissionMode;
      }
      if (Object.prototype.hasOwnProperty.call(change, 'model')) {
        currentModel = resolveRequestedAcpModel(change.model);
      }
    });
  }

  const happyServer = await startHappyServer({ sessionId: session.sessionId, sendClaudeMessage: (body) => session.sendClaudeSessionMessage(body) });
  const mcpServers = {
    happy: {
      command: join(projectPath(), 'bin', 'happy-mcp.mjs'),
      args: ['--url', happyServer.url],
    },
  };

  const backend = new AcpBackend({
    agentName: opts.agentName,
    cwd: process.cwd(),
    command: opts.command,
    args: opts.args,
    mcpServers,
    permissionHandler,
    transportHandler: new DefaultTransport(opts.agentName),
    verbose,
  });

  let thinking = false;
  let acpSessionId: string | null = null;
  let shouldExit = false;
  let abortController = new AbortController();
  let pendingTurn: PendingTurn | null = null;
  let activePromptRpc: Promise<void> | null = null;
  let turnActivityVersion = 0;
  let turnActivityWaiters: Array<() => void> = [];

  const clearPendingTurn = (error?: Error) => {
    if (!pendingTurn) {
      logger.debug(`[${opts.agentName}] Turn-end signal received with no pending turn`);
      return;
    }
    clearTimeout(pendingTurn.timeout);
    const current = pendingTurn;
    pendingTurn = null;
    if (error) {
      logger.debug(`[${opts.agentName}] Rejecting pending turn: ${error.message}`);
      current.reject(error);
      return;
    }
    logger.debug(`[${opts.agentName}] Resolving pending turn`);
    current.resolve();
  };

  const waitForTurnEnd = () => new Promise<void>((resolve, reject) => {
    logger.debug(`[${opts.agentName}] Registered pending turn waiter`);
    const timeout = setTimeout(() => {
      pendingTurn = null;
      logger.debug(`[${opts.agentName}] Pending turn waiter timed out`);
      reject(new Error(`Timed out waiting for ${opts.agentName} to finish the turn`));
    }, TURN_TIMEOUT_MS);
    pendingTurn = { resolve, reject, timeout };
  });

  const markTurnActivity = () => {
    turnActivityVersion += 1;
    const waiters = turnActivityWaiters;
    turnActivityWaiters = [];
    for (const wake of waiters) {
      wake();
    }
  };

  const waitForTurnActivityAfter = (version: number, timeoutMs: number): Promise<boolean> => new Promise((resolve) => {
    if (turnActivityVersion > version) {
      resolve(true);
      return;
    }

    const onActivity = () => {
      clearTimeout(timeout);
      resolve(true);
    };

    const timeout = setTimeout(() => {
      const index = turnActivityWaiters.indexOf(onActivity);
      if (index !== -1) {
        turnActivityWaiters.splice(index, 1);
      }
      resolve(false);
    }, timeoutMs);

    turnActivityWaiters.push(onActivity);
  });

  const waitForPromptRpcToSettle = async (
    pending: Promise<void>,
    timeoutMs: number,
  ): Promise<boolean> => {
    return await Promise.race([
      pending.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  };

  const drainOutstandingPromptRpc = async (): Promise<void> => {
    const pending = activePromptRpc;
    if (!pending || !acpSessionId) {
      return;
    }

    logger.debug(
      `[${opts.agentName}] Waiting up to ${PROMPT_RPC_DRAIN_WAIT_MS}ms for previous ACP prompt RPC to settle before sending next prompt`,
    );

    if (await waitForPromptRpcToSettle(pending, PROMPT_RPC_DRAIN_WAIT_MS)) {
      return;
    }

    logger.debug(
      `[${opts.agentName}] Previous ACP prompt RPC still pending; sending session/cancel before next prompt`,
    );
    try {
      await backend.cancelPromptTurn(acpSessionId);
    } catch (error) {
      logger.debug(
        `[${opts.agentName}] Failed to cancel stale ACP prompt RPC; detaching anyway:`,
        error,
      );
      activePromptRpc = null;
      return;
    }

    if (await waitForPromptRpcToSettle(pending, PROMPT_RPC_DRAIN_WAIT_MS)) {
      return;
    }

    logger.debug(
      `[${opts.agentName}] Previous ACP prompt RPC still pending after session/cancel; detaching from stale prompt RPC and continuing`,
    );
    activePromptRpc = null;
  };

  const stopRunnerFromBackendStatus = (status: 'error' | 'stopped', detail?: string) => {
    const reason = detail
      ? `${opts.agentName} backend ${status}: ${detail}`
      : `${opts.agentName} backend ${status}`;
    logger.debug(`[${opts.agentName}] ${reason}; stopping ACP runner`);
    shouldExit = true;
    messageQueue.close();
    clearPendingTurn(new Error(reason));
  };

  const sendEnvelopes = (envelopes: SessionEnvelope[]) => {
    for (const envelope of envelopes) {
      if (verbose) {
        const formatted = formatEnvelopeForServerLog(opts.agentName, envelope);
        logAcp('muted', formatted.text);
      }
      session.sendSessionProtocolMessage(envelope);
      if (verbose) {
        logAcp('muted', `Incoming raw envelope for ${opts.agentName}: ${formatUnknownForConsole(envelope, ACP_RAW_PREVIEW_CHARS)}`);
      }
    }
  };

  const sendAcpxMessage = (message: SessionMessage) => {
    if (!syncBridge) return;
    syncBridge.sendMessage(message).catch((error) => {
      logger.debug(`[${opts.agentName}] Failed to send acpx message:`, error);
    });
  };

  const updateAcpxMessage = (message: SessionMessage) => {
    if (!syncBridge) return;
    syncBridge.updateMessage(message).catch((error) => {
      logger.debug(`[${opts.agentName}] Failed to update acpx message:`, error);
    });
  };

  const switchPermissionModeIfRequested = async (requestedMode: string): Promise<void> => {
    if (!requestedMode) {
      return;
    }

    if (modeSelector) {
      const resolved = resolveRequestedCode(modeSelector.options, requestedMode);
      if (!resolved) {
        logger.debug(`[${opts.agentName}] Ignoring unknown ACP permission mode request: ${requestedMode}`);
        return;
      }
      if (resolved === modeSelector.currentCode) {
        return;
      }
      const switched = await backend.setSessionConfigOption(modeSelector.configId, resolved);
      if (switched) {
        modeSelector.currentCode = resolved;
        return;
      }
    }

    if (!legacyModes) {
      return;
    }

    const resolvedLegacyMode = resolveRequestedLegacyModeCode(legacyModes, requestedMode);
    if (!resolvedLegacyMode) {
      logger.debug(`[${opts.agentName}] Ignoring unknown ACP legacy mode request: ${requestedMode}`);
      return;
    }
    if (resolvedLegacyMode === legacyModes.currentModeId) {
      return;
    }

    const switched = await backend.setSessionMode(resolvedLegacyMode);
    if (switched) {
      legacyModes = {
        ...legacyModes,
        currentModeId: resolvedLegacyMode,
      };
    }
  };

  const switchModelIfRequested = async (requestedModel: string): Promise<void> => {
    if (!requestedModel) {
      return;
    }

    if (modelSelector) {
      const resolved = resolveRequestedCode(modelSelector.options, requestedModel);
      if (!resolved) {
        logger.debug(`[${opts.agentName}] Ignoring unknown ACP model request: ${requestedModel}`);
        return;
      }
      if (resolved === modelSelector.currentCode) {
        return;
      }
      const switched = await backend.setSessionConfigOption(modelSelector.configId, resolved);
      if (switched) {
        modelSelector.currentCode = resolved;
        return;
      }
    }

    if (!legacyModels) {
      return;
    }

    const resolvedLegacyModel = resolveRequestedLegacyModelCode(legacyModels, requestedModel);
    if (!resolvedLegacyModel) {
      logger.debug(`[${opts.agentName}] Ignoring unknown ACP legacy model request: ${requestedModel}`);
      return;
    }
    if (resolvedLegacyModel === legacyModels.currentModelId) {
      return;
    }

    const switched = await backend.setSessionModel(resolvedLegacyModel);
    if (switched) {
      legacyModels = {
        ...legacyModels,
        currentModelId: resolvedLegacyModel,
      };
    }
  };

  const updateMetadata = (handler: (current: any) => any) => {
    if (syncBridge) {
      syncBridge.updateMetadata(handler);
    } else {
      session.updateMetadata(handler);
    }
  };

  const onBackendMessage = (msg: AgentMessage) => {
    if (msg.type !== 'status') {
      markTurnActivity();
    }

    if (verbose) {
      logAcp('muted', `Outgoing raw backend message from ${opts.agentName}: ${formatUnknownForConsole(msg, ACP_RAW_PREVIEW_CHARS)}`);
    }

    if (msg.type === 'event' && msg.name === 'available_commands') {
      const commands = msg.payload as { name: string; description?: string }[];
      const commandNames = commands.map((c) => c.name);
      sawSlashCommands = commands.length > 0;
      if (verbose) {
        logAcp('muted', `Outgoing slash commands from ${opts.agentName} (${commands.length}):`);
        for (const command of commands) {
          logAcp('muted', `  /${command.name}${formatOptionalDetail(command.description, 160)}`);
        }
      }
      updateMetadata((currentMetadata: any) => ({
        ...currentMetadata,
        slashCommands: commandNames,
      }));
    }

    if (msg.type === 'event' && msg.name === 'config_options_update') {
      const configOptions = extractConfigOptionsFromPayload(msg.payload);
      if (configOptions) {
        if (verbose) {
          logAcp('muted', `Outgoing config options from ${opts.agentName} (${configOptions.length}):`);
          for (const option of configOptions) {
            if (option.type === 'select') {
              const optionValues = flattenSelectOptions(option.options);
              logAcp('muted', `  config=${option.id} category=${option.category ?? 'unknown'} current=${option.currentValue} options=${optionValues.length}`);
            } else {
              logAcp('muted', `  config=${option.id} type=${option.type} category=${option.category ?? 'unknown'}`);
            }
          }
        }

        modeSelector = extractConfigSelector(configOptions, 'mode');
        modelSelector = extractConfigSelector(configOptions, 'model');
        if (verbose) {
          if (modeSelector) {
            sawModes = true;
            logAcp('muted', `Outgoing mode options from ${opts.agentName} (${modeSelector.options.length}), current=${modeSelector.currentCode}:`);
            for (const option of modeSelector.options) {
              logAcp('muted', `  mode=${option.code} label=${option.value}`);
            }
          } else {
            logAcp('muted', `Outgoing mode options from ${opts.agentName}: not reported in config options`);
          }
          if (modelSelector) {
            sawModels = true;
            logAcp('muted', `Outgoing model options from ${opts.agentName} (${modelSelector.options.length}), current=${modelSelector.currentCode}:`);
            for (const option of modelSelector.options) {
              logAcp('muted', `  model=${option.code} label=${option.value}`);
            }
          } else {
            logAcp('muted', `Outgoing model options from ${opts.agentName}: not reported in config options`);
          }
        }
        updateMetadata((currentMetadata: any) =>
          mergeAcpSessionConfigIntoMetadata(currentMetadata, { configOptions }),
        );
      }
    }

    if (msg.type === 'event' && msg.name === 'modes_update') {
      const modes = extractModeStateFromPayload(msg.payload);
      if (modes) {
        legacyModes = modes;
        sawModes = true;
        if (verbose) {
          logAcp('muted', `Outgoing modes from ${opts.agentName} (${modes.availableModes.length}), current=${modes.currentModeId}:`);
          for (const mode of modes.availableModes) {
            logAcp('muted', `  mode=${mode.id} name=${mode.name}${formatOptionalDetail(mode.description, 160)}`);
          }
        }
        updateMetadata((currentMetadata: any) =>
          mergeAcpSessionConfigIntoMetadata(currentMetadata, { modes }),
        );
      }
    }

    if (msg.type === 'event' && msg.name === 'models_update') {
      const models = extractModelStateFromPayload(msg.payload);
      if (models) {
        legacyModels = models;
        sawModels = true;
        if (verbose) {
          logAcp('muted', `Outgoing models from ${opts.agentName} (${models.availableModels.length}), current=${models.currentModelId}:`);
          for (const model of models.availableModels) {
            logAcp('muted', `  model=${model.modelId} name=${model.name}`);
          }
        }
        updateMetadata((currentMetadata: any) =>
          mergeAcpSessionConfigIntoMetadata(currentMetadata, { models }),
        );
      }
    }

    if (msg.type === 'event' && msg.name === 'current_mode_update') {
      const currentModeId = extractCurrentModeIdFromPayload(msg.payload);
      if (currentModeId) {
        if (modeSelector) {
          modeSelector = {
            ...modeSelector,
            currentCode: currentModeId,
          };
        }
        if (legacyModes) {
          legacyModes = {
            ...legacyModes,
            currentModeId,
          };
        }
        updateMetadata((currentMetadata: any) =>
          mergeAcpSessionConfigIntoMetadata(currentMetadata, { currentModeId }),
        );
      }
    }

    if (msg.type === 'status') {
      const suffix = msg.detail ? `: ${msg.detail}` : '';
      const statusLine = `Status: ${msg.status}${suffix}`;
      logAcp('muted', statusLine);
      const nextThinking = msg.status === 'running';
      if (thinking !== nextThinking) {
        thinking = nextThinking;
        if (syncBridge) {
          syncBridge.keepAlive(thinking, 'remote');
        } else {
          session.keepAlive(thinking, 'remote');
        }
      }
      if (msg.status === 'idle') {
        clearPendingTurn();
      }
      if (msg.status === 'error' || msg.status === 'stopped') {
        stopRunnerFromBackendStatus(msg.status, msg.detail);
      }
    }

    const frontendMessage = formatAcpMessageForFrontend(opts.agentName, msg, verbose);
    if (frontendMessage) {
      logAcp(frontendMessage.kind, frontendMessage.text);
    }

    if (syncBridge && acpxAcc) {
      if (msg.type === 'status') {
        return;
      }
      if (isTranscriptMessage(msg)) {
        applyAgentMessageToAccumulator(acpxAcc, msg);
        updateAcpxMessage(acpxAcc.wrapper);
      }
      return;
    }

    sendEnvelopes(sessionManager.mapMessage(msg));
  };

  backend.onMessage(onBackendMessage);

  if (syncBridge) {
    syncBridge.onUserMessage((message) => {
      const userMsg = message.User;
      const textContent = userMsg.content.find((c): c is Extract<typeof c, { Text: string }> => 'Text' in c);
      if (!textContent) return;

      messageQueue.push(textContent.Text, {
        permissionMode: currentPermissionMode,
        model: currentModel,
      });
    });
  } else {
    session.onUserMessage((message) => {
      if (!message.content.text) {
        return;
      }

      if (typeof message.meta?.permissionMode === 'string') {
        currentPermissionMode = message.meta.permissionMode;
        logger.debug(`[${opts.agentName}] Requested ACP permission mode: ${currentPermissionMode}`);
      }

      if (message.meta && Object.prototype.hasOwnProperty.call(message.meta, 'model')) {
        currentModel = resolveRequestedAcpModel(message.meta.model);
        logger.debug(`[${opts.agentName}] Requested ACP model: ${currentModel ?? 'null'}`);
      }

      messageQueue.push(message.content.text, {
        permissionMode: currentPermissionMode,
        model: currentModel,
      });
    });
  }

  if (syncBridge) {
    syncBridge.keepAlive(thinking, 'remote');
  } else {
    session.keepAlive(thinking, 'remote');
  }

  const keepAliveInterval = setInterval(() => {
    if (syncBridge) {
      syncBridge.keepAlive(thinking, 'remote');
    } else {
      session.keepAlive(thinking, 'remote');
    }
  }, 2000);

  async function handleAbort() {
    try {
      if (acpSessionId) {
        await backend.cancel(acpSessionId);
      }
      permissionHandler.reset();
      abortController.abort();
    } catch (error) {
      logger.debug(`[${opts.agentName}] Abort failed:`, error);
    } finally {
      abortController = new AbortController();
    }
  }

  const activeRpcManager = rpcHandlerManager ?? session.rpcHandlerManager;
  activeRpcManager.registerHandler('abort', handleAbort);
  syncBridge?.onAbortRequest(() => {
    void handleAbort();
  });
  registerKillSessionHandler(activeRpcManager, async () => {
    shouldExit = true;
    messageQueue.close();
    clearPendingTurn(new Error('Session terminated'));
    await handleAbort();
  });

  try {
    const started = await backend.startSession();
    acpSessionId = started.sessionId;
    if (response) {
      try {
        await notifyDaemonSessionStarted(response.id, metadata);
      } catch (error) {
        logger.debug('[acp] Failed to report session to daemon:', error);
      }
    }
    if (verbose) {
      if (!sawSlashCommands) {
        logAcp('muted', `Outgoing slash commands from ${opts.agentName}: not reported yet`);
      }
      if (!sawModes) {
        logAcp('muted', `Outgoing modes from ${opts.agentName}: not reported yet`);
      }
      if (!sawModels) {
        logAcp('muted', `Outgoing models from ${opts.agentName}: not reported yet`);
      }
    }

    while (!shouldExit) {
      const waitSignal = abortController.signal;
      const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
      if (!batch) {
        if (shouldExit) {
          break;
        }
        if (waitSignal.aborted) {
          continue;
        }
        break;
      }

      if (!acpSessionId) {
        throw new Error('ACP session is not started');
      }

      await drainOutstandingPromptRpc();

      logAcp('incoming', `Incoming prompt: ${formatUnknownForConsole(batch.message, ACP_EVENT_PREVIEW_CHARS)}`);
      if (syncBridge) {
        acpxAcc = createAcpxAccumulator();
        sendAcpxMessage(acpxAcc.wrapper);
        acpxAcc.sent = true;
      } else {
        sendEnvelopes(sessionManager.startTurn());
      }
      let turnEnded = waitForTurnEnd();
      try {
        if (typeof batch.mode.permissionMode === 'string' && batch.mode.permissionMode.length > 0) {
          await switchPermissionModeIfRequested(batch.mode.permissionMode);
        }
        if (typeof batch.mode.model === 'string' && batch.mode.model.length > 0) {
          await switchModelIfRequested(batch.mode.model);
        }
        // Some ACP agents keep the prompt RPC open until all background/subagent
        // work finishes. Some also emit transient `status: idle` updates between
        // phases of the same prompt, so only treat an idle-before-prompt-return
        // as terminal if the session stays quiet for a short grace period.
        let turnEndedBeforePromptReturned = false;
        let promptReturned = false;
        const promptPromise = backend.sendPrompt(acpSessionId, batch.message).catch((error) => {
          if (turnEndedBeforePromptReturned) {
            logger.debug(`[${opts.agentName}] Ignoring late ACP prompt rejection after turn end:`, error);
            return;
          }
          throw error;
        });
        const promptSettled = promptPromise
          .catch(() => undefined)
          .finally(() => {
            if (activePromptRpc === promptSettled) {
              activePromptRpc = null;
            }
          });
        activePromptRpc = promptSettled;
        const trackedPromptPromise = promptPromise.then(() => {
          promptReturned = true;
        });

        while (true) {
          let raceResult: 'prompt' | 'idle' | null = null;
          await Promise.race([
            trackedPromptPromise.then(() => {
              raceResult = 'prompt';
            }),
            turnEnded.then(() => {
              raceResult = 'idle';
            }),
          ]);

          if (raceResult === 'prompt') {
            logger.debug(`[${opts.agentName}] Prompt RPC returned before turn end; waiting for idle`);
            // Wait for idle with a grace period — if the agent returned without
            // tool calls the backend may never emit idle on its own.
            const idleOrTimeout = await Promise.race([
              turnEnded.then(() => 'idle' as const),
              new Promise<'timeout'>(resolve =>
                setTimeout(() => resolve('timeout'), IDLE_BEFORE_PROMPT_SETTLE_MS),
              ),
            ]);
            if (idleOrTimeout === 'timeout') {
              logger.debug(
                `[${opts.agentName}] No idle ${IDLE_BEFORE_PROMPT_SETTLE_MS}ms after prompt returned; finalizing`,
              );
            }
            turnEndedBeforePromptReturned = true;
            break;
          }

          if (promptReturned) {
            turnEndedBeforePromptReturned = true;
            break;
          }

          logger.debug(`[${opts.agentName}] Turn ended before prompt RPC returned`);
          const activityVersionAtIdle = turnActivityVersion;
          const sawMoreActivity = await waitForTurnActivityAfter(
            activityVersionAtIdle,
            IDLE_BEFORE_PROMPT_SETTLE_MS,
          );
          if (!sawMoreActivity) {
            logger.debug(
              `[${opts.agentName}] No new activity ${IDLE_BEFORE_PROMPT_SETTLE_MS}ms after idle; finalizing before prompt RPC returned`,
            );
            turnEndedBeforePromptReturned = true;
            break;
          }

          logger.debug(`[${opts.agentName}] More activity arrived after idle; waiting for the next idle`);
          turnEnded = waitForTurnEnd();
        }
        logger.debug(`[${opts.agentName}] Finalizing ACP turn after wait`);
        if (syncBridge && acpxAcc) {
          updateAcpxMessage(acpxAcc.wrapper);
          acpxAcc = null;
        } else {
          sendEnvelopes(sessionManager.endTurn('completed'));
        }
        if (syncBridge) {
          syncBridge.updateAgentState((currentState: any) => ({
            ...currentState,
            lastEvent: { type: 'ready', time: Date.now() },
          }));
        } else {
          session.sendSessionEvent({ type: 'ready' });
        }
        if (verbose) {
          logAcp('muted', `Outgoing prompt completion from ${opts.agentName}`);
        }
      } catch (error) {
        if (syncBridge && acpxAcc) {
          updateAcpxMessage(acpxAcc.wrapper);
          acpxAcc = null;
        } else {
          sendEnvelopes(sessionManager.endTurn('failed'));
        }
        if (syncBridge) {
          syncBridge.updateAgentState((currentState: any) => ({
            ...currentState,
            lastEvent: { type: 'ready', time: Date.now() },
          }));
        } else {
          session.sendSessionEvent({ type: 'ready' });
        }
        logAcp('error', `Prompt error from ${opts.agentName}: ${error instanceof Error ? error.message : String(error)}`);
        clearPendingTurn(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    }
  } finally {
    clearInterval(keepAliveInterval);
    reconnectionHandle?.cancel();
    clearPendingTurn(new Error('ACP runner shutting down'));

    try {
      permissionHandler.reset();
    } catch (error) {
      logger.debug(`[${opts.agentName}] Failed to reset permission handler:`, error);
    }

    backend.offMessage?.(onBackendMessage);
    await backend.dispose();

    try {
      happyServer.stop();
    } catch (error) {
      logger.debug(`[${opts.agentName}] Failed to stop Happy MCP server:`, error);
    }

    try {
      updateMetadata((currentMetadata: any) => ({
        ...currentMetadata,
        lifecycleState: 'archived',
        lifecycleStateSince: Date.now(),
        archivedBy: 'cli',
        archiveReason: 'Session ended',
      }));
      if (syncBridge) {
        syncBridge.sendSessionDeath();
        await syncBridge.flush();
        syncBridge.disconnect();
      } else {
        session.sendSessionDeath();
        await session.flush();
        await session.close();
      }
    } catch (error) {
      logger.debug(`[${opts.agentName}] Session close failed:`, error);
    }
  }
}
