import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { resolveExecutable } from '@/environment/processRunner';
import { join } from 'node:path';
import { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentMessage } from '@/agent/core';
import { AcpBackend, normalizeAcpPermissionResult, type AcpPermissionHandler } from './AcpBackend';
import { DefaultTransport } from '@/agent/transport';
import { AcpSessionManager } from './AcpSessionManager';
import type { SessionEnvelope } from '@slopus/happy-wire';
import { logger } from '@/ui/logger';
import { MessageQueue2, createSerializedTaskRunner, isMediaAttachment, type ImageAttachment } from '@/utils/MessageQueue2';
import { AcpImagePromptError } from './imagePromptError';
import { detectCodexImage } from '@/codex/codexImageInput';
import { hashObject } from '@/utils/deterministicJson';
import { Credentials, readSettings } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/machineMetadata';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { encodeBase64 } from '@/api/encryption';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { delegationLaunchContext } from '@/daemon/delegationLaunchContext';
import { createDelegationPromptLifecycle } from '@/delegation/delegationPrompt';
import { createPausableDeadline, type PausableDeadline } from './pausableDeadline';
import { projectPath } from '@/projectPath';
import { BasePermissionHandler, type PendingRequest, type PermissionResponse, type PermissionResult } from '@/utils/BasePermissionHandler';
import { connectionState } from '@/utils/serverConnectionErrors';
import type { AgentState, FileEventMessage, Metadata } from '@/api/types';
import type { WorkerSessionStartupLifecycle } from '@/api/sessionStartupTrace';
import {
  extractConfigOptionsFromPayload,
  extractCurrentModeIdFromPayload,
  extractModeStateFromPayload,
  extractModelStateFromPayload,
  mergeAcpSessionConfigIntoMetadata,
  mergeAntigravityLegacyEfforts,
} from './sessionConfigMetadata';
import type { SessionConfigOption, SessionModeState, SessionModelState } from '@agentclientprotocol/sdk';
import { registerSessionTitleWorker } from '@/title/sessionTitleWorker';

const TURN_TIMEOUT_MS = 5 * 60 * 1000;
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
  attachmentError?: string;
  imageBatchId?: string;
  effort?: string | null;
  permissionMode?: string;
  model?: string | null;
};

type AcpSelectableOption = {
  code: string;
  value: string;
};

type AcpConfigSelector = {
  configId: string;
  currentCode: string;
  options: AcpSelectableOption[];
};

type AcpRootTurn = {
  localIds: string[];
  turnId?: string;
  cancelled: boolean;
  promptStarted: boolean;
  cancellation?: Promise<void>;
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
  category: 'mode' | 'model' | 'thought_level',
): AcpConfigSelector | null {
  const optionMatchesCategory = (option: SessionConfigOption): boolean => {
    if (option.category === category) {
      return true;
    }
    if (category === 'thought_level') return false;
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

/** Delegation must identify one advertised native value, never silently fall back. */
function resolveDelegationCode(options: AcpSelectableOption[], requested: string, label: string): string {
  const exact = options.filter(option => option.code === requested);
  if (exact.length === 1) return exact[0].code;
  const normalized = normalizeComparable(requested);
  const labels = options.filter(option => normalizeComparable(option.code) === normalized || normalizeComparable(option.value) === normalized);
  const matches = labels.length ? labels : options.filter(option => {
    const tokens = normalizeComparable(option.value).split(/[^\p{L}\p{N}]+/u);
    return normalized.length > 0 && tokens.includes(normalized);
  });
  const codes = [...new Set(matches.map(option => option.code))];
  if (codes.length === 1) return codes[0];
  throw new Error(codes.length ? `Ambiguous ${label}: ${requested}` : `Unknown ${label}: ${requested}`);
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
  private permissionMode: 'default' | 'bypassPermissions' = 'default';
  private static readonly ALWAYS_AUTO_APPROVE_NAMES: ReadonlySet<string> = new Set([
    'change_title',
    'happy__change_title',
    'mcp__happy__change_title',
    'archive_session',
    'happy__archive_session',
    'mcp__happy__archive_session',
    'agent_roles',
    'delegate_task',
    'read_delegated_task',
    'cancel_delegated_task',
  ]);
  private static readonly ALWAYS_AUTO_APPROVE_ID_PREFIXES: readonly string[] = [
    'change_title',
    'archive_session',
  ];

  constructor(session: ApiSessionClient, agentName: string, private readonly sessionCallId: (id: string) => string) {
    super(session);
    this.logPrefix = `[${agentName}]`;
  }

  protected getLogPrefix(): string {
    return this.logPrefix;
  }

  setPermissionMode(mode: 'default' | 'bypassPermissions'): void {
    this.permissionMode = mode;
    if (mode === 'bypassPermissions') this.approveAllPending('approved');
  }

  protected resolvePermissionResponse(response: PermissionResponse, pending: PendingRequest): PermissionResult {
    const result = super.resolvePermissionResponse(response, pending);
    return pending.permissionOptions ? normalizeAcpPermissionResult(pending.permissionOptions.map(option => ({
      optionId: option.id, name: option.name, kind: option.kind,
    })), result) : result;
  }

  private shouldAutoApprove(toolName: string, toolCallId: string): boolean {
    if (GenericAcpPermissionHandler.ALWAYS_AUTO_APPROVE_NAMES.has(toolName)) {
      return true;
    }

    for (const prefix of GenericAcpPermissionHandler.ALWAYS_AUTO_APPROVE_ID_PREFIXES) {
      if (toolCallId === prefix || toolCallId.startsWith(`${prefix}-`)) {
        return true;
      }
    }

    return false;
  }

  async handleToolCall(providerCallId: string, toolName: string, input: unknown, options?: Parameters<AcpPermissionHandler['handleToolCall']>[3]): Promise<PermissionResult> {
    const toolCallId = this.sessionCallId(providerCallId);
    const permissionOptions = options?.map(option => ({ id: option.optionId, name: option.name, kind: option.kind }));
    if (this.permissionMode === 'bypassPermissions' || this.shouldAutoApprove(toolName, providerCallId)) {
      const result = options ? normalizeAcpPermissionResult(options, { decision: 'approved' }) : { decision: 'approved' as const };
      this.session.updateAgentState((currentState) => ({
        ...currentState,
        completedRequests: {
          ...currentState.completedRequests,
          [toolCallId]: {
            tool: toolName,
            arguments: input,
            createdAt: Date.now(),
            completedAt: Date.now(),
            status: result.decision === 'abort' ? 'denied' : 'approved',
            ...result,
            ...(permissionOptions ? { permissionOptions } : {}),
          },
        },
      } satisfies AgentState));

      logger.debug(`${this.logPrefix} Applied ACP approval policy: ${toolName} (${toolCallId})`);
      return result;
    }

    return new Promise<PermissionResult>((resolve, reject) => {
      this.pendingRequests.set(toolCallId, {
        resolve,
        reject,
        toolName,
        input,
        permissionOptions,
      });
      this.addPendingRequestToState(toolCallId, toolName, input, permissionOptions);
      logger.debug(`${this.logPrefix} Permission request sent for tool: ${toolName} (${toolCallId})`);
    });
  }
}

type PendingTurn = {
  resolve: () => void;
  reject: (err: Error) => void;
  deadline: PausableDeadline;
  root: AcpRootTurn;
};

function resolveSessionFlavor(agentName: string): 'gemini' | 'opencode' | 'antigravity' | 'acp' {
  if (agentName === 'gemini') {
    return 'gemini';
  }
  if (agentName === 'antigravity') return 'antigravity';
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
  startupLifecycle?: WorkerSessionStartupLifecycle;
}): Promise<void> {
  const verbose = opts.verbose === true;
  const sessionTag = randomUUID();
  connectionState.setBackend(opts.agentName);

  const api = await ApiClient.create(opts.credentials, opts.startupLifecycle);
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
  const delegatedLaunch = delegationLaunchContext();
  if (delegatedLaunch) {
    metadata.parentSessionId = delegatedLaunch.parentSessionId;
    metadata.delegatedTask = { taskId: delegatedLaunch.taskId, parentSessionId: delegatedLaunch.parentSessionId };
  }
  if (opts.agentName === 'antigravity') metadata.capabilities = { ...metadata.capabilities, acpPermissionPolicy: true };
  const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
  if (response) {
    logAcp('muted', `Happy Session ID: ${response.id}`);
  }

  let session: ApiSessionClient;
  let permissionHandler: GenericAcpPermissionHandler;
  let bindInputHandlers: (() => void) | undefined;
  let bindPermissionModeHandler: (() => void) | undefined;
  let bindDelegationHandlers: (() => void) | undefined;
  let unbindPermissionMetadata: (() => void) | undefined;
  const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
    api,
    sessionTag,
    metadata,
    state,
    response,
    onSessionSwap: (newSession) => {
      session = newSession;
      bindInputHandlers?.();
      if (permissionHandler) {
        permissionHandler.updateSession(newSession);
      }
      bindPermissionModeHandler?.();
      bindDelegationHandlers?.();
    },
  });
  session = initialSession;

  const reportSessionStarted = async () => {
    if (!response) return;
    try {
      await notifyDaemonSessionStarted(response.id, metadata, {
        encryptionKey: encodeBase64(response.encryptionKey),
        encryptionVariant: response.encryptionVariant,
        seq: response.seq,
        metadataVersion: response.metadataVersion,
        agentStateVersion: response.agentStateVersion,
      });
    } catch (error) {
      logger.debug('[acp] Failed to report session to daemon:', error);
    }
  };
  if (!delegatedLaunch) await reportSessionStarted();

  const sessionManager = new AcpSessionManager();
  const delegationPrompt = createDelegationPromptLifecycle({ delegatedChild: Boolean(delegatedLaunch) || opts.agentName !== 'antigravity' });
  permissionHandler = new GenericAcpPermissionHandler(session, opts.agentName, id => sessionManager.getSessionCallId(id));
  // Drop any permission requests left in agent state from a previous CLI
  // process that died while a tool prompt was open — see the matching
  // call in claudeRemoteLauncher for the full rationale.
  permissionHandler.reset('Previous CLI process exited before responding');
  const messageQueue = new MessageQueue2<AcpSwitchMode>((mode) => hashObject(mode));
  let currentPermissionMode: string | undefined;
  let permissionModeOverride: 'default' | 'bypassPermissions' | null = null;
  let currentAppendSystemPrompt: string | undefined;
  const effectiveDelegationContext = () => ({
    permissionMode: permissionModeOverride ?? (currentPermissionMode === 'bypassPermissions' ? 'bypassPermissions' as const : 'default' as const),
    ...(currentAppendSystemPrompt !== undefined ? { appendSystemPrompt: currentAppendSystemPrompt } : {}),
  });
  let currentModel: string | null | undefined;
  let modeSelector: AcpConfigSelector | null = null;
  let modelSelector: AcpConfigSelector | null = null;
  let effortSelector: AcpConfigSelector | null = null;
  let configSnapshot: SessionConfigOption[] = [];
  let configTail: Promise<unknown> = Promise.resolve();
  const serializeConfig = <T>(action: () => Promise<T>): Promise<T> => {
    const next = configTail.then(action);
    configTail = next.catch(() => {});
    return next;
  };
  let hasCategorizedModeConfig = false;
  let hasCategorizedModelConfig = false;
  let legacyModes: SessionModeState | null = null;
  let legacyModels: SessionModelState | null = null;
  let sawSlashCommands = false;
  let sawModes = false;
  let sawModels = false;
  let archiveReason = 'Session ended';
  let archiveCurrentSession: ((reason?: string) => void) | null = null;
  let pauseDelegationWait: () => (() => void) = () => () => {};

  const happyServer = await startHappyServer(session, {
    delegationContext: effectiveDelegationContext,
    currentDelegationSessionId: () => session.sessionId,
    onDelegationWait: () => pauseDelegationWait(),
    archiveSession: async (reason?: string) => {
      if (!archiveCurrentSession) {
        return { success: false, error: 'Archive handler is not ready' };
      }
      archiveCurrentSession(reason);
      return { success: true };
    },
  });
  const mcpServers = {
    happy: {
      command: join(projectPath(), 'bin', 'happy-mcp.mjs'),
      args: ['--url', happyServer.url],
    },
  };

  session.processorStarting?.();
  const backend = new AcpBackend({
    agentName: opts.agentName,
    cwd: process.cwd(),
    command: opts.agentName === 'antigravity' && opts.command === 'agy'
      ? await resolveExecutable('agy', process.env.PATH, [join(homedir(), '.local/bin/agy')]) ?? 'agy'
      : opts.command,
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
  let activeRoot: AcpRootTurn | null = null;
  let pendingInputCount = 0;
  let resolveBackendReady!: () => void;
  let rejectBackendReady!: (error: Error) => void;
  const backendReady = new Promise<void>((resolve, reject) => {
    resolveBackendReady = resolve;
    rejectBackendReady = reject;
  });
  void backendReady.catch(() => {});
  let backendReadinessReported = false;
  const updateBackendReady = () => {
    if (acpSessionId && (modelSelector?.options.length || legacyModels?.availableModels.length) && !backendReadinessReported) {
      backendReadinessReported = true;
      resolveBackendReady();
      session.reportDelegationReady?.();
    }
  };

  const clearPendingTurn = (error?: Error) => {
    if (!pendingTurn) {
      return;
    }
    pendingTurn.deadline.cancel();
    const current = pendingTurn;
    pendingTurn = null;
    if (error) {
      current.reject(error);
      return;
    }
    current.resolve();
  };

  const waitForTurnEnd = (root: AcpRootTurn) => new Promise<void>((resolve, reject) => {
    const current: PendingTurn = { resolve, reject, root, deadline: createPausableDeadline(TURN_TIMEOUT_MS, () => {
      if (pendingTurn !== current) return;
      pendingTurn = null;
      reject(new Error(`Timed out waiting for ${opts.agentName} to finish the turn`));
    }) };
    pendingTurn = current;
  });
  pauseDelegationWait = () => {
    const current = pendingTurn;
    const root = activeRoot;
    const parentSessionId = session.sessionId;
    if (opts.agentName !== 'antigravity' || delegatedLaunch || session.getMetadata?.()?.delegatedTask
      || shouldExit || !current || !root || current.root !== root || root.cancelled
      || !root.turnId || session.getCurrentRootTurnId?.() !== root.turnId) return () => {};
    const release = current.deadline.pause();
    return () => {
      if (shouldExit || session.sessionId !== parentSessionId || pendingTurn !== current || activeRoot !== root || root.cancelled) {
        current.deadline.cancel();
        return;
      }
      release();
    };
  };

  const stopRunnerFromBackendStatus = (status: 'error' | 'stopped', detail?: string) => {
    const reason = detail
      ? `${opts.agentName} backend ${status}: ${detail}`
      : `${opts.agentName} backend ${status}`;
    logger.debug(`[${opts.agentName}] ${reason}; stopping ACP runner`);
    shouldExit = true;
    rejectBackendReady(new Error(reason));
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

  const ownsPermissionMetadata = (current: Metadata): boolean => current.flavor === 'antigravity'
    && (typeof current.hostPid !== 'number' || current.hostPid === metadata.hostPid);
  const hasPermissionPolicy = (metadata: Metadata): boolean => metadata.capabilities?.acpPermissionPolicy === true
    && (permissionModeOverride === null ? metadata.acpPermissionMode !== 'bypassPermissions' : metadata.acpPermissionMode === permissionModeOverride);
  const publishPermissionPolicy = (force = false): void => {
    const owner = session;
    owner.updateMetadata(metadata => shouldExit || owner !== session || !metadata || !ownsPermissionMetadata(metadata)
      || metadata.lifecycleState === 'archived' || metadata.lifecycleState === 'archiveRequested'
      || (!force && hasPermissionPolicy(metadata)) ? metadata : {
      ...metadata,
      capabilities: { ...metadata.capabilities, acpPermissionPolicy: true },
      acpPermissionMode: permissionModeOverride ?? (metadata.acpPermissionMode === 'bypassPermissions' ? undefined : metadata.acpPermissionMode),
    });
  };

  const switchPermissionModeIfRequested = async (requestedMode: string): Promise<void> => {
    if (opts.agentName === 'antigravity') {
      const mode = permissionModeOverride ?? requestedMode;
      if (mode !== 'default' && mode !== 'bypassPermissions') throw new Error('Unsupported Antigravity permission mode');
      permissionModeOverride = mode;
      permissionHandler.setPermissionMode(mode);
      publishPermissionPolicy();
      return;
    }
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
        if (opts.agentName === 'antigravity' && modelSelector.currentCode !== resolved) throw new Error('Model change was not confirmed');
        modelSelector.currentCode = resolved;
        return;
      }
      if (opts.agentName === 'antigravity') throw new Error('Model change failed');
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

  const switchEffortIfRequested = async (effort: string | null | undefined) => {
    if (!effort) return;
    const selector = effortSelector;
    if (!selector || !selector.options.some(option => option.code === effort)) {
      throw new Error(`Unsupported reasoning effort for the selected model: ${effort}`);
    }
    if (selector.currentCode === effort) return;
    if (!await backend.setSessionConfigOption(selector.configId, effort)
      || effortSelector?.currentCode !== effort) {
      throw new Error(`Failed to confirm reasoning effort: ${effort}`);
    }
  };

  const onBackendMessage = (msg: AgentMessage) => {
    if (verbose) {
      logAcp('muted', `Outgoing raw backend message from ${opts.agentName}: ${formatUnknownForConsole(msg, ACP_RAW_PREVIEW_CHARS)}`);
    }

    if (msg.type === 'event' && msg.name === 'prompt_cancelled' && activeRoot) {
      activeRoot.cancelled = true;
      clearPendingTurn();
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
      session.updateMetadata((currentMetadata) => ({
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

        // Match metadata reconciliation: only explicitly categorized selects
        // take precedence over legacy catalogs (selectors also use heuristics).
        hasCategorizedModeConfig = configOptions.some(option => option.type === 'select' && option.category === 'mode');
        hasCategorizedModelConfig = configOptions.some(option => option.type === 'select' && option.category === 'model');
        modeSelector = extractConfigSelector(configOptions, 'mode');
        modelSelector = extractConfigSelector(configOptions, 'model');
        effortSelector = extractConfigSelector(configOptions, 'thought_level');
        configSnapshot = configOptions;
        updateBackendReady();
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
        session.updateMetadata((currentMetadata) => {
          const next = mergeAcpSessionConfigIntoMetadata(currentMetadata, { configOptions });
          return legacyModels ? mergeAntigravityLegacyEfforts(next, legacyModels) : next;
        });
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
        if (!hasCategorizedModeConfig) session.updateMetadata((currentMetadata) =>
          mergeAcpSessionConfigIntoMetadata(currentMetadata, { modes }),
        );
      }
    }

    if (msg.type === 'event' && msg.name === 'models_update') {
      const models = extractModelStateFromPayload(msg.payload);
      if (models) {
        legacyModels = models;
        updateBackendReady();
        sawModels = true;
        if (verbose) {
          logAcp('muted', `Outgoing models from ${opts.agentName} (${models.availableModels.length}), current=${models.currentModelId}:`);
          for (const model of models.availableModels) {
            logAcp('muted', `  model=${model.modelId} name=${model.name}`);
          }
        }
        // Offer identifiers accepted by the preferred config selector, not
        // legacy aliases such as Antigravity's model IDs with effort suffixes.
        if (!hasCategorizedModelConfig) session.updateMetadata((currentMetadata) =>
          mergeAcpSessionConfigIntoMetadata(currentMetadata, { models }),
        );
        if (hasCategorizedModelConfig && opts.agentName === 'antigravity') session.updateMetadata(currentMetadata => mergeAntigravityLegacyEfforts(currentMetadata, models));
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
        session.updateMetadata((currentMetadata) =>
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
        session.keepAlive(thinking, 'remote');
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

    sendEnvelopes(sessionManager.mapMessage(msg));
  };

  backend.onMessage(onBackendMessage);

  type ImageDownload = { image: ImageAttachment } | { error: string };
  let pendingImages: Array<Promise<ImageDownload>> = [];
  const processUserMessage = createSerializedTaskRunner(error => {
    logger.debug(`[${opts.agentName}] Could not queue user message:`, error);
  });

  const handleFileEvent = (fileEvent: FileEventMessage) => {
    if (shouldExit) return;
    const ev = fileEvent.content.data.ev;
    // Start downloading immediately, but retain both success and failure until
    // the next text claims this exact bucket. No rejected background promises.
    pendingImages.push((async (): Promise<ImageDownload> => {
      try {
        if (ev.kind && ev.kind !== 'image') {
          return { error: 'OpenCode currently accepts image attachments only. Your message was not sent.' };
        }
        const data = await session.downloadAndDecryptAttachment(ev.ref);
        if (!data?.length) throw new Error('empty image');
        const detected = detectCodexImage(data);
        if (!detected) return { error: 'This image format is not supported. Please use PNG, JPEG, GIF, or WebP and retry.' };
        return { image: { data, mimeType: detected.mime, name: ev.name } };
      } catch {
        return { error: 'The image could not be downloaded or decrypted. Your message was not sent. Please attach it again and retry.' };
      }
    })());
  };
  const handleUserMessage: Parameters<ApiSessionClient['onUserMessage']>[0] = (message) => {
    const claimedImages = pendingImages;
    pendingImages = [];
    if (!message.content.text && !claimedImages.length) return;

    if (typeof message.meta?.permissionMode === 'string'
      && (opts.agentName !== 'antigravity' || message.meta.permissionMode !== 'bypassPermissions' || message.meta.permissionModeExplicit === true)) {
      currentPermissionMode = message.meta.permissionMode;
      logger.debug(`[${opts.agentName}] Requested ACP permission mode: ${currentPermissionMode}`);
    }
    if (message.meta && Object.prototype.hasOwnProperty.call(message.meta, 'model')) {
      currentModel = message.meta.model ?? null;
      logger.debug(`[${opts.agentName}] Requested ACP model: ${currentModel ?? 'null'}`);
    }
    if (message.meta && Object.prototype.hasOwnProperty.call(message.meta, 'appendSystemPrompt')) {
      currentAppendSystemPrompt = typeof message.meta.appendSystemPrompt === 'string' ? message.meta.appendSystemPrompt : undefined;
    }
    const mode: AcpSwitchMode = { permissionMode: currentPermissionMode, model: currentModel,
      ...(opts.agentName === 'antigravity' ? { effort: message.meta?.effort ?? null } : {}),
      ...(claimedImages.length ? { imageBatchId: randomUUID() } : {}) };
    pendingInputCount += 1;
    void processUserMessage(async () => {
      try {
        const results = await Promise.all(claimedImages);
        if (shouldExit) return;
        const failed = results.find((result): result is { error: string } => 'error' in result);
        messageQueue.push(message.content.text || 'Please describe the attached image.',
          failed ? { ...mode, attachmentError: failed.error } : mode,
          failed ? [] : results.flatMap(result => 'image' in result ? [result.image] : []), message.localId, Boolean(message.meta?.delegation));
      } finally {
        pendingInputCount -= 1;
      }
    });
  };
  bindInputHandlers = () => {
    pendingImages = [];
    session.onUserMessage(handleUserMessage, opts.agentName === 'opencode' ? handleFileEvent : undefined);
  };
  bindInputHandlers();
  session.keepAlive(thinking, 'remote');

  const keepAliveInterval = setInterval(() => {
    session.keepAlive(thinking, 'remote');
  }, 2000);

  async function handleAbort() {
    const root = activeRoot;
    if (root?.cancellation) return root.cancellation;
    const cancellation = (async () => {
      if (acpSessionId) {
        await backend.cancel(acpSessionId);
      }
      // Once native work started, only its cancelled stop reason confirms a
      // cancellation. A concurrent natural end_turn must stay completed.
      if (root && activeRoot === root && !root.promptStarted) {
        root.cancelled = true;
        clearPendingTurn();
      }
      permissionHandler.reset();
      abortController.abort();
      abortController = new AbortController();
    })();
    if (root) root.cancellation = cancellation;
    try {
      await cancellation;
    } finally {
      if (root?.cancellation === cancellation) root.cancellation = undefined;
    }
  }

  async function requestSessionArchive(reason = 'User terminated') {
    archiveReason = reason;
    shouldExit = true;
    rejectBackendReady(new Error('Session terminated'));
    messageQueue.close();
    clearPendingTurn(new Error('Session terminated'));
    await handleAbort();
  }

  session.rpcHandlerManager.registerHandler('abort', handleAbort);
  bindPermissionModeHandler = () => {
    unbindPermissionMetadata?.();
    if (opts.agentName !== 'antigravity') return;
    const boundSession = session;
    const restorePolicy = (metadata: Metadata | null) => {
      if (shouldExit || boundSession !== session || !metadata || !ownsPermissionMetadata(metadata)
        || metadata.lifecycleState === 'archived' || metadata.lifecycleState === 'archiveRequested'
        || hasPermissionPolicy(metadata)) return;
      // Older clients can strip unknown fields when writing activity/title metadata.
      // Only the live worker's RPC changes its policy; restore its published state
      // from this event without reinterpreting the foreign snapshot as consent.
      publishPermissionPolicy();
    };
    boundSession.on?.('metadata-updated', restorePolicy);
    const reconcileAfterConnect = () => {
      if (!shouldExit && boundSession === session) publishPermissionPolicy(true);
    };
    boundSession.on?.('connected', reconcileAfterConnect);
    unbindPermissionMetadata = () => {
      boundSession.off?.('metadata-updated', restorePolicy);
      boundSession.off?.('connected', reconcileAfterConnect);
    };
    // Also cover a first connection that completed before these listeners bound.
    publishPermissionPolicy(true);
    session.rpcHandlerManager.registerHandler('setPermissionMode', async (request: { mode?: unknown }) => {
      const current = boundSession.getMetadata?.();
      if (shouldExit || boundSession !== session || (typeof boundSession.getMetadata === 'function' && !current) || (current && (!ownsPermissionMetadata(current)
        || current.lifecycleState === 'archived' || current.lifecycleState === 'archiveRequested'))) throw new Error('Session worker changed or ended');
      if (request.mode !== 'default' && request.mode !== 'bypassPermissions') throw new Error('Unsupported Antigravity permission mode');
      permissionModeOverride = request.mode;
      currentPermissionMode = request.mode;
      permissionHandler.setPermissionMode(request.mode);
      publishPermissionPolicy();
      return true;
    });
  };
  bindPermissionModeHandler();
  if (opts.agentName === 'antigravity') session.rpcHandlerManager.registerHandler('setAcpConfig', async (request: { model?: string; effort?: string | null }) => serializeConfig(async () => {
    if (shouldExit || !acpSessionId || thinking || pendingTurn) throw new Error('Session must be idle to change configuration');
    if (request.model !== undefined) {
      if (typeof request.model !== 'string' || !modelSelector?.options.some(option => option.code === request.model)) throw new Error('Unknown model');
      await switchModelIfRequested(request.model);
      if (modelSelector?.currentCode !== request.model) throw new Error('Model change was not confirmed');
    }
    if (request.effort !== undefined && request.effort !== null && typeof request.effort !== 'string') throw new Error('Invalid effort');
    await switchEffortIfRequested(request.effort);
    return { configOptions: configSnapshot };
  }));

  bindDelegationHandlers = () => {
    if (opts.agentName !== 'antigravity') return;
    const boundSession = session;
    const requireWorker = () => {
      const current = boundSession.getMetadata?.();
      if (shouldExit || boundSession !== session || !current || !ownsPermissionMetadata(current)
        || current.lifecycleState === 'archived' || current.lifecycleState === 'archiveRequested') throw new Error('Session worker changed or ended');
      return current;
    };
    const requireDelegatedOwner = () => {
      const current = requireWorker();
      if (current.hostPid !== process.pid) throw new Error('Session worker changed or ended');
      if (!delegatedLaunch || !current.delegatedTask || current.delegatedTask.taskId !== delegatedLaunch.taskId
        || current.delegatedTask.parentSessionId !== delegatedLaunch.parentSessionId || current.parentSessionId !== delegatedLaunch.parentSessionId) throw new Error('Only the bound delegated task worker can prepare or cancel delegation');
      if (current.application) throw new Error('Application-bound sessions cannot prepare delegation');
      return current;
    };
    boundSession.rpcHandlerManager.registerHandler('delegation-context', async () => {
      const current = requireWorker();
      return { agent: 'antigravity', ...effectiveDelegationContext(), hostPid: process.pid,
        lifecycleState: current.lifecycleState ?? 'running' };
    });
    boundSession.rpcHandlerManager.registerHandler('delegation-prepare', async (request: { model: string; effort?: string; permissionMode: 'default' | 'bypassPermissions' }) => {
      if (!request || typeof request.model !== 'string' || !request.model.trim()
        || (request.effort !== undefined && (typeof request.effort !== 'string' || !request.effort.trim()))
        || (request.permissionMode !== 'default' && request.permissionMode !== 'bypassPermissions')) throw new Error('Invalid delegation configuration');
      requireDelegatedOwner();
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([backendReady, new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Timed out waiting for ACP model catalog')), TURN_TIMEOUT_MS);
        })]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      return serializeConfig(async () => {
        const requireIdle = () => {
          requireDelegatedOwner();
          if (shouldExit || !acpSessionId || thinking || pendingTurn || activeRoot || pendingInputCount || messageQueue.size() || session.hasPendingUserInputs?.() || session.getCurrentRootTurnId?.()
          ) throw new Error('Session must be idle to prepare delegation');
        };
        requireIdle();
        if (!modelSelector) throw new Error('Native model configuration is unavailable');
        const model = resolveDelegationCode(modelSelector.options, request.model, 'model');
        await switchModelIfRequested(model);
        if (modelSelector?.currentCode !== model) throw new Error('Model change was not confirmed');
        const effort = request.effort === undefined ? undefined : resolveDelegationCode(effortSelector?.options ?? [], request.effort, 'reasoning effort');
        await switchEffortIfRequested(effort);
        if (effort && effortSelector?.currentCode !== effort) throw new Error('Reasoning effort change was not confirmed');
        requireIdle();
        const actualEffort = effortSelector?.currentCode;
        const previousPolicy = permissionModeOverride;
        permissionModeOverride = request.permissionMode;
        let invalidated = false;
        try {
          await boundSession.updateMetadataAndAwait(current => {
            try { requireIdle(); } catch { invalidated = true; }
            if (invalidated || current.hostPid !== process.pid || current.flavor !== 'antigravity'
              || current.parentSessionId !== delegatedLaunch?.parentSessionId || current.delegatedTask?.taskId !== delegatedLaunch?.taskId
              || current.delegatedTask?.parentSessionId !== delegatedLaunch?.parentSessionId || current.application
              || current.lifecycleState === 'archived' || current.lifecycleState === 'archiveRequested') {
              invalidated = true;
              return current;
            }
            return { ...mergeAcpSessionConfigIntoMetadata(current, { configOptions: configSnapshot }),
              capabilities: { ...current.capabilities, acpPermissionPolicy: true }, acpPermissionMode: request.permissionMode };
          });
          if (invalidated) throw new Error('Delegated worker changed or became busy while preparing configuration');
          requireIdle();
          const acknowledged = boundSession.getMetadata();
          if (acknowledged?.currentModelCode !== model || acknowledged.currentThoughtLevelCode !== actualEffort
            || acknowledged.acpPermissionMode !== request.permissionMode || modelSelector?.currentCode !== model || effortSelector?.currentCode !== actualEffort) throw new Error('Delegation configuration metadata was not acknowledged');
        } catch (error) {
          permissionModeOverride = previousPolicy;
          publishPermissionPolicy();
          throw error;
        }
        currentPermissionMode = request.permissionMode;
        permissionHandler.setPermissionMode(request.permissionMode);
        currentModel = model;
        return { model, ...(actualEffort ? { effort: actualEffort } : {}) };
      });
    });
    boundSession.rpcHandlerManager.registerHandler('delegation-abort', async (request: { expectedTurnId?: string; localId: string }) => {
      if (!request || typeof request.localId !== 'string' || !request.localId
        || (request.expectedTurnId !== undefined && (typeof request.expectedTurnId !== 'string' || !request.expectedTurnId))) throw new Error('Invalid delegation cancellation');
      requireDelegatedOwner();
      if (!request.localId.startsWith(`delegation:${delegatedLaunch!.taskId}:`)) throw new Error('Delegated task does not own this session input');
      if (messageQueue.removeByLocalId(request.localId)) {
        session.acknowledgeCancelledUserInput(request.localId);
        return { queuedCancelled: true };
      }
      const root = activeRoot;
      const actualTurnId = session.getCurrentRootTurnId?.();
      if (!root || root.localIds.length !== 1 || root.localIds[0] !== request.localId || !root.turnId || actualTurnId !== root.turnId
        || request.expectedTurnId !== root.turnId) throw new Error('Delegated turn does not match the current root turn');
      await handleAbort();
      return { cancelled: root.cancelled };
    });
    boundSession.declareDelegationSupport('antigravity');
  };
  bindDelegationHandlers();

  // A delegated child may receive its configuration as soon as this webhook
  // resolves. Publish only after its ownership/configuration RPCs exist.
  if (delegatedLaunch) await reportSessionStarted();

  registerSessionTitleWorker(session, 'acp');

  archiveCurrentSession = (reason?: string) => {
    setTimeout(() => {
      void requestSessionArchive(reason || 'Requested by user');
    }, 100);
  };

  registerKillSessionHandler(session.rpcHandlerManager, () => requestSessionArchive());

  try {
    const started = await backend.startSession();
    acpSessionId = started.sessionId;
    updateBackendReady();
    session.processorReady?.();
    session.sendSessionEvent({ type: 'ready' });
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

      logAcp('incoming', `Incoming prompt: ${formatUnknownForConsole(batch.message, ACP_EVENT_PREVIEW_CHARS)}`);
      const root: AcpRootTurn = { localIds: batch.localIds ?? [], cancelled: false, promptStarted: false };
      activeRoot = root;
      const startedEnvelopes = sessionManager.startTurn(batch.localIds);
      root.turnId = startedEnvelopes.find(envelope => envelope.ev.t === 'turn-start')?.turn;
      sendEnvelopes(startedEnvelopes);
      if (batch.mode.attachmentError) {
        sendEnvelopes(sessionManager.mapMessage({ type: 'model-output', textDelta: batch.mode.attachmentError }));
        sendEnvelopes(sessionManager.endTurn('failed'));
        session.sendSessionEvent({ type: 'ready' });
        activeRoot = null;
        continue;
      }
      const turnEnded = waitForTurnEnd(root);
      // Backend errors can settle the turn before sendPrompt rejects.
      void turnEnded.catch(() => {});
      let promptStarted = false;
      try {
        await serializeConfig(async () => {
          if (opts.agentName === 'antigravity' || (typeof batch.mode.permissionMode === 'string' && batch.mode.permissionMode.length > 0)) {
            await switchPermissionModeIfRequested(batch.mode.permissionMode ?? 'default');
          }
          if (typeof batch.mode.model === 'string' && batch.mode.model.length > 0) {
            await switchModelIfRequested(batch.mode.model);
            if (opts.agentName === 'antigravity' && modelSelector?.currentCode !== batch.mode.model) throw new Error('Model change was not confirmed');
          }
          if (opts.agentName === 'antigravity') await switchEffortIfRequested(batch.mode.effort);
        });
        await root.cancellation?.catch(() => {});
        if (!root.cancelled) {
          promptStarted = true;
          root.promptStarted = true;
          const images = (batch.attachments ?? []).filter((a): a is ImageAttachment => !isMediaAttachment(a));
          const discovery = delegationPrompt.getPrompt();
          const prompt = discovery ? `${batch.message}\n\n<happy-delegation-discovery>\n${discovery}\n</happy-delegation-discovery>` : batch.message;
          if (images.length) await backend.sendPrompt(acpSessionId, prompt, images);
          else await backend.sendPrompt(acpSessionId, prompt);
          delegationPrompt.markPromptSent();
        }
        await turnEnded;
        await root.cancellation?.catch(() => {});
        sendEnvelopes(sessionManager.endTurn(root.cancelled ? 'cancelled' : 'completed'));
        session.sendSessionEvent({ type: 'ready' });
        if (verbose) {
          logAcp('muted', `Outgoing prompt completion from ${opts.agentName}`);
        }
      } catch (error) {
        if (error instanceof AcpImagePromptError || !promptStarted) {
          sendEnvelopes(sessionManager.mapMessage({ type: 'model-output', textDelta: error instanceof Error ? error.message : String(error) }));
          sendEnvelopes(sessionManager.endTurn('failed'));
          clearPendingTurn();
          thinking = false;
          session.keepAlive(false, 'remote');
          session.sendSessionEvent({ type: 'ready' });
          continue;
        }
        if (batch.attachments?.length) {
          sendEnvelopes(sessionManager.mapMessage({ type: 'model-output', textDelta: 'OpenCode could not process this image message. Please retry.' }));
        }
        sendEnvelopes(sessionManager.endTurn('failed'));
        session.sendSessionEvent({ type: 'ready' });
        logAcp('error', `Prompt error from ${opts.agentName}: ${error instanceof Error ? error.message : String(error)}`);
        clearPendingTurn(error instanceof Error ? error : new Error(String(error)));
        throw error;
      } finally {
        if (activeRoot === root) activeRoot = null;
      }
    }
  } finally {
    shouldExit = true;
    rejectBackendReady(new Error('ACP runner shutting down'));
    unbindPermissionMetadata?.();
    pendingImages = [];
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
      session.updateMetadata((currentMetadata) => ({
        ...currentMetadata,
        lifecycleState: 'archived',
        lifecycleStateSince: Date.now(),
        archivedBy: 'cli',
        archiveReason,
      }));
      session.sendSessionDeath();
      await session.flush();
      await session.close();
    } catch (error) {
      logger.debug(`[${opts.agentName}] Session close failed:`, error);
    }
  }
}
