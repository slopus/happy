import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentMessage, TurnInactivityWatchdog } from '@/agent/core';
import { startTurnInactivityWatchdog } from '@/agent/core';
import { AcpBackend, type AcpPermissionHandler } from './AcpBackend';
import { DefaultTransport } from '@/agent/transport';
import { AcpSessionManager } from './AcpSessionManager';
import type { SessionEnvelope } from '@slopus/happy-wire';
import { logger } from '@/ui/logger';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { Credentials, readSettings } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/run';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { encodeBase64 } from '@/api/encryption';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { fetchAplusMcpServers } from '@/aplus/fetchAplusMcpServers';
import { bridgeAplusMcpServers, mergeMcpServers } from '@/aplus/mergeAplusMcpServers';
import { appendTitleInstruction } from '@/utils/titlePrompt';
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
import { createDeferredContinuationContextConsumer } from '@/utils/deferredContinuationContext';
import type { StandaloneLaunchBootstrap } from '@/daemon/standaloneLaunchProtocol';
import { SessionLaunchControl } from '@/sessionDrain/sessionLaunchControl';
import { RuntimeProducerGate } from '@/sessionDrain/runtimeProducerGate';
import { createAcpDrainProvider } from './acpDrainProvider';

/** Max time without any backend activity before the turn is cancelled. */
const TURN_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
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

type AcpSelectableOption = {
  code: string;
  value: string;
};

type AcpConfigSelector = {
  configId: string;
  currentCode: string;
  options: AcpSelectableOption[];
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

  constructor(session: ApiSessionClient, agentName: string) {
    super(session);
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

/**
 * ACP backends (gemini/opencode/grok) never carried the `change_title` nudge that
 * the Claude and Codex backends append, so their chats stayed untitled — the
 * `happy` MCP server is wired in for them (verified: grok runs `tools/list` and
 * `tools/call` against it), the model was simply never told to call the tool
 * (specs/acp-grok-tool-name-and-title).
 *
 * Only the model's copy of the turn changes; the app renders its own user bubble.
 */
function appendTitleInstructionWhileUntitled(session: ApiSessionClient, text: string): string {
  return session.hasTitle() ? text : appendTitleInstruction(text);
}

type PendingTurn = {
  resolve: () => void;
  reject: (err: Error) => void;
  watchdog: TurnInactivityWatchdog;
};

function resolveSessionFlavor(agentName: string): 'gemini' | 'opencode' | 'grok' | 'acp' {
  if (agentName === 'gemini') {
    return 'gemini';
  }
  if (agentName === 'opencode') {
    return 'opencode';
  }
  if (agentName === 'grok') {
    return 'grok';
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
  /** Max time without any backend activity before the turn is cancelled. */
  turnInactivityTimeoutMs?: number;
  /** A Windows standalone daemon launch this runtime drains through (Desktop W0-5f). */
  standaloneLaunch?: StandaloneLaunchBootstrap;
}): Promise<void> {
  if (opts.standaloneLaunch && opts.startedBy !== 'daemon') throw new Error('Standalone launch requires a daemon-started session');
  const launchControl = opts.standaloneLaunch ? await SessionLaunchControl.connect(opts.standaloneLaunch) : undefined;
  const verbose = opts.verbose === true;
  const turnInactivityTimeoutMs = opts.turnInactivityTimeoutMs ?? TURN_INACTIVITY_TIMEOUT_MS;
  const sessionTag = randomUUID();
  const deferredContinuation = createDeferredContinuationContextConsumer(process.env);
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

  // Requester identity from the daemon's spawn RPC (specs/session-created-by).
  const createdByAccountId = process.env.HAPPY_CREATED_BY_ACCOUNT_ID;
  const createdByDisplayName = process.env.HAPPY_CREATED_BY_DISPLAY_NAME;

  const { state, metadata } = createSessionMetadata({
    flavor: resolveSessionFlavor(opts.agentName),
    machineId: settings.machineId,
    startedBy: opts.startedBy,
    sandbox: settings.sandboxConfig,
    ...(createdByAccountId ? { createdBy: { accountId: createdByAccountId, displayName: createdByDisplayName } } : {}),
  });
  const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
  if (response) {
    logAcp('muted', `Happy Session ID: ${response.id}`);
  }
  if (launchControl && !response) throw new Error('Standalone launch requires an online session');

  let session: ApiSessionClient;
  let permissionHandler: GenericAcpPermissionHandler;
  // Assigned after handleKillSession is defined; re-attached on session swap
  // so an offline-started session still exits when archived server-side.
  let onSessionArchived: (() => void) | undefined;
  const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
    api,
    sessionTag,
    metadata,
    state,
    response,
    ...(launchControl ? { sessionOptions: { trackShutdownStorage: true } } : {}),
    onSessionSwap: (newSession) => {
      session = newSession;
      if (permissionHandler) {
        permissionHandler.updateSession(newSession);
      }
      if (onSessionArchived) {
        newSession.on('archived', onSessionArchived);
      }
    },
  });
  session = initialSession;

  if (response) {
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
  }

  permissionHandler = new GenericAcpPermissionHandler(session, opts.agentName);
  // Drop any permission requests left in agent state from a previous CLI
  // process that died while a tool prompt was open — see the matching
  // call in claudeRemoteLauncher for the full rationale.
  permissionHandler.reset('Previous CLI process exited before responding');
  const sessionManager = new AcpSessionManager();
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

  // chat-tool-output-streaming Phase 3 — bash_stream MCP tool runs in this
  // process and looks up the active session call id via the shared
  // bashStreamCallRegistry (which AcpSessionManager populates on
  // tool-call-start). No per-runner wiring needed; the registry is the
  // single source of truth across runClaude/runAcp/runCodex/runGemini.
  // Only the launch-bound local channel can drain this runtime (Desktop W0-5f).
  let runtimeGate: RuntimeProducerGate | undefined;
  let draining = false;
  let loopDone = false;
  let markLoopDone!: () => void;
  const loopFinished = new Promise<void>((resolve) => { markLoopDone = () => { loopDone = true; resolve(); }; });
  const happyServer = await startHappyServer(session, launchControl ? {
    admitTool: <T,>(work: () => Promise<T>) => (runtimeGate ? runtimeGate.admit(work, 'writer') : Promise.reject(new Error('Runtime input is not open'))),
  } : undefined);
  // Launched via `node <path>` like Codex: agents that spawn without a shell (Grok on
  // Windows) cannot execute a .mjs shebang script (os error 193).
  const bridgeCommand = join(projectPath(), 'bin', 'happy-mcp.mjs');
  const aplusMcpServers = bridgeAplusMcpServers(
    await fetchAplusMcpServers(opts.credentials.token, settings.machineId),
    { bridgeCommand, nodeExecPath: process.execPath },
  );
  const mcpServers = mergeMcpServers({
    happy: {
      command: process.execPath,
      args: ['--no-warnings', '--no-deprecation', bridgeCommand, '--url', happyServer.url],
    },
  }, aplusMcpServers);

  // ACP resolves approvals synchronously inside the requestPermission RPC and
  // never emits a permission-response message, so the handler call itself is the
  // only place that knows both when the user is asked and when they answer.
  // Suspending the watchdog around it keeps think-time from counting as a hang.
  const watchdogAwarePermissionHandler: AcpPermissionHandler = {
    handleToolCall: async (toolCallId, toolName, input) => {
      const turn = pendingTurn;
      turn?.watchdog.holdForApproval();
      try {
        return await permissionHandler.handleToolCall(toolCallId, toolName, input);
      } finally {
        turn?.watchdog.releaseApproval();
      }
    },
  };

  const backend = new AcpBackend({
    agentName: opts.agentName,
    cwd: process.cwd(),
    command: opts.command,
    args: opts.args,
    mcpServers,
    permissionHandler: watchdogAwarePermissionHandler,
    transportHandler: new DefaultTransport(opts.agentName),
    verbose,
  });

  let thinking = false;
  let acpSessionId: string | null = null;
  let shouldExit = false;
  let abortController = new AbortController();
  let pendingTurn: PendingTurn | null = null;

  const clearPendingTurn = (error?: Error) => {
    if (!pendingTurn) {
      return;
    }
    pendingTurn.watchdog.stop();
    const current = pendingTurn;
    pendingTurn = null;
    if (error) {
      current.reject(error);
      return;
    }
    current.resolve();
  };

  // Bounds inactivity, not total turn duration: backend progress restarts the
  // window and approval waits disarm it, so only a silent backend trips this.
  // Cancel the backend before giving up — rejecting alone would leave the agent
  // running while the runner reports the turn as failed.
  const waitForTurnEnd = () => {
    const turnEnded = new Promise<void>((resolve, reject) => {
      const watchdog = startTurnInactivityWatchdog({
        timeoutMs: turnInactivityTimeoutMs,
        onInactive: () => {
          logger.debug(`[${opts.agentName}] No backend activity for ${turnInactivityTimeoutMs}ms; cancelling turn`);
          const sessionToCancel = acpSessionId;
          if (sessionToCancel) {
            void backend.cancel(sessionToCancel).catch((error) => {
              logger.debug(`[${opts.agentName}] Failed to cancel inactive turn:`, error);
            });
          }
          clearPendingTurn(new Error(`${opts.agentName} produced no activity for ${turnInactivityTimeoutMs}ms`));
        },
      });
      pendingTurn = { resolve, reject, watchdog };
    });
    // The prompt RPC spans the whole turn in ACP, so a rejection (watchdog,
    // backend stop, kill) can land while the loop is still suspended inside
    // sendPrompt with no handler attached yet. Mark the rejection handled so it
    // fails the turn instead of crashing the process; `await turnEnded` still
    // observes it.
    turnEnded.catch(() => { });
    return turnEnded;
  };

  const stopRunnerFromBackendStatus = (status: 'error' | 'stopped', detail?: string) => {
    const reason = detail
      ? `${opts.agentName} backend ${status}: ${detail}`
      : `${opts.agentName} backend ${status}`;
    logger.debug(`[${opts.agentName}] ${reason}; stopping ACP runner`);
    shouldExit = true;
    messageQueue.close();
    // The drain cancelled this turn on purpose; that is its end, not a failure.
    clearPendingTurn(draining ? undefined : new Error(reason));
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

  const onBackendMessage = (msg: AgentMessage) => {
    if (verbose) {
      logAcp('muted', `Outgoing raw backend message from ${opts.agentName}: ${formatUnknownForConsole(msg, ACP_RAW_PREVIEW_CHARS)}`);
    }

    // Any backend message is proof the turn is still alive.
    pendingTurn?.watchdog.recordActivity();

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
        session.updateMetadata((currentMetadata) =>
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
        session.updateMetadata((currentMetadata) =>
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
        session.updateMetadata((currentMetadata) =>
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

  if (launchControl) {
    const gate = new RuntimeProducerGate({
      hasUndeliveredInput: () => messageQueue.size() > 0,
      canFreezeInbound: () => session.canFreezeInboundMessagesForShutdown(),
      freezeInbound: () => session.freezeInboundMessagesForShutdown(),
      stopLoop: () => { draining = true; shouldExit = true; messageQueue.close(); },
    });
    runtimeGate = gate;
    launchControl.bind(createAcpDrainProvider({
      ready: () => acpSessionId !== null && !loopDone,
      freezeInput: () => { permissionHandler.reset('Session is shutting down'); },
      activeTurn: () => {
        const sessionToCancel = acpSessionId;
        return pendingTurn && sessionToCancel ? { interrupt: () => backend.cancel(sessionToCancel) } : null;
      },
      requestEndInput: () => backend.endInput(),
      processStarted: () => backend.processId() !== undefined || backend.processExit() !== null,
      processExit: () => backend.processExit(),
      loopFinished,
      isLoopFinished: () => loopDone,
    }), session, gate);
  }

  session.onUserMessage((message) => {
    if (!message.content.text) {
      return;
    }
    if (runtimeGate) {
      void runtimeGate.admit(async () => enqueueUserMessage(message)).catch((error) => {
        logger.debug(`[${opts.agentName}] Refused a user message while the runtime is closing:`, error);
      });
      return;
    }
    enqueueUserMessage(message);
  });
  function enqueueUserMessage(message: Parameters<Parameters<typeof session.onUserMessage>[0]>[0]): void {

    if (typeof message.meta?.permissionMode === 'string') {
      currentPermissionMode = message.meta.permissionMode;
      logger.debug(`[${opts.agentName}] Requested ACP permission mode: ${currentPermissionMode}`);
    }

    if (message.meta && Object.prototype.hasOwnProperty.call(message.meta, 'model')) {
      currentModel = message.meta.model ?? null;
      logger.debug(`[${opts.agentName}] Requested ACP model: ${currentModel ?? 'null'}`);
    }

    const deferredTurn = deferredContinuation.prepare(message.content.text);
    try {
      messageQueue.push(deferredTurn?.text ?? message.content.text, {
        permissionMode: currentPermissionMode,
        model: currentModel,
      });
      deferredTurn?.commit();
    } catch (error) {
      deferredTurn?.rollback();
      throw error;
    }
  }
  session.keepAlive(thinking, 'remote');

  const keepAliveInterval = setInterval(() => {
    session.keepAlive(thinking, 'remote');
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

  /*
   * No channel ingress handlers here, deliberately (Saycode specs/desktop-messenger-channels).
   *
   * Registering them would make an ACP session *dispatchable*: the machine-level advertisement
   * only gates `/new`, while an existing session is judged by this live capability answer. ACP
   * can accept a prompt, but it cannot produce an answer the channel may relay — `AgentMessage`
   * model output carries only `textDelta`/`fullText` with no phase or final marker, and
   * `AcpBackend.sendPrompt` discards the `PromptResponse` whose `stopReason` is the one
   * authoritative terminal it receives. R14 forbids guessing which text is the answer, so the
   * absence of these handlers is the refusal: the probe gets "unknown method" and Desktop stops.
   *
   * What would change it: preserve `PromptResponse.stopReason` as the terminal, and obtain a
   * per-segment final marker from the provider's own response or annotations.
   */

  session.rpcHandlerManager.registerHandler('abort', handleAbort);
  const handleKillSession = async () => {
    if (runtimeGate?.isFrozen()) {
      // The drain owns the agent's EOF and the storage proof; the loop's own exit
      // path finishes after the decision.
      await runtimeGate.waitForShutdownDecision();
      return;
    }
    // Seal before the first await so a drain cannot freeze behind this kill.
    runtimeGate?.beginTermination();
    shouldExit = true;
    messageQueue.close();
    clearPendingTurn(new Error('Session terminated'));
    await handleAbort();
  };
  registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);
  // Without a handler a signal ends the process at once, in the middle of a drain decision.
  const onStandaloneSignal = () => { void handleKillSession(); };
  if (launchControl) {
    process.on('SIGTERM', onStandaloneSignal);
    process.on('SIGINT', onStandaloneSignal);
  }

  // Exit when the session is archived/deleted server-side: the web archive
  // button (ephemeral with reason='archived') or a fatal 404 from the
  // message sync. Without this the syncs stop but the process lingers.
  // Also attached to swapped sessions via onSessionSwap (offline start).
  onSessionArchived = () => {
    logger.debug('[ACP] Session archived server-side, terminating...');
    void handleKillSession();
  };
  session.on('archived', onSessionArchived);

  try {
    const started = await backend.startSession();
    acpSessionId = started.sessionId;
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
      if (runtimeGate && !runtimeGate.tryBeginPreparing()) {
        break;
      }

      logAcp('incoming', `Incoming prompt: ${formatUnknownForConsole(batch.message, ACP_EVENT_PREVIEW_CHARS)}`);
      sendEnvelopes(sessionManager.startTurn());
      const turnEnded = waitForTurnEnd();
      try {
        if (typeof batch.mode.permissionMode === 'string' && batch.mode.permissionMode.length > 0) {
          await switchPermissionModeIfRequested(batch.mode.permissionMode);
        }
        if (typeof batch.mode.model === 'string' && batch.mode.model.length > 0) {
          await switchModelIfRequested(batch.mode.model);
        }
        runtimeGate?.markDispatched();
        await backend.sendPrompt(acpSessionId, appendTitleInstructionWhileUntitled(session, batch.message));
        await turnEnded;
        sendEnvelopes(sessionManager.endTurn(draining ? 'cancelled' : 'completed'));
        session.sendSessionEvent({ type: 'ready' });
        if (verbose) {
          logAcp('muted', `Outgoing prompt completion from ${opts.agentName}`);
        }
      } catch (error) {
        sendEnvelopes(sessionManager.endTurn('failed'));
        session.sendSessionEvent({ type: 'ready' });
        logAcp('error', `Prompt error from ${opts.agentName}: ${error instanceof Error ? error.message : String(error)}`);
        clearPendingTurn(error instanceof Error ? error : new Error(String(error)));
        throw error;
      } finally {
        runtimeGate?.endTurn();
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

    if (runtimeGate) {
      // Seal synchronously; producers already admitted keep their promises.
      const producers = runtimeGate.closeAdmissionAndWait();
      if (runtimeGate.isFrozen()) {
        // The loop has finished its writes; the drain still owns the agent's EOF
        // and the storage proof. Nothing below may run before it confirms.
        runtimeGate.loopExited();
        markLoopDone();
        const decision = await runtimeGate.waitForShutdownDecision();
        if (decision === 'blocked') {
          process.exitCode = 1;
          logger.warn('[standalone] Shutdown blocked; retaining API and agent ownership');
          await new Promise<never>(() => {});
        }
      } else {
        await producers;
        runtimeGate.loopExited();
      }
    }
    markLoopDone();

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
        archiveReason: 'Session ended',
      }));
      session.sendSessionDeath();
      await session.flush();
      await session.close();
    } catch (error) {
      logger.debug(`[${opts.agentName}] Session close failed:`, error);
    }
    process.off('SIGTERM', onStandaloneSignal);
    process.off('SIGINT', onStandaloneSignal);
    launchControl?.close();
  }
}
