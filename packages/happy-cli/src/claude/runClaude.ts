import os from 'node:os';
import { randomUUID } from 'node:crypto';

import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { loop } from '@/claude/loop';
import { AgentGoalStatus, AgentState, Metadata } from '@/api/types';
import packageJson from '../../package.json';
import { Credentials, readSettings } from '@/persistence';
import { EnhancedMode, PermissionMode } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { parseSpecialCommand } from '@/parsers/specialCommands';
import { getEnvironmentInfo } from '@/ui/doctor';
import { configuration } from '@/configuration';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { initialMachineMetadata } from '@/daemon/run';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { startHookServer } from '@/claude/utils/startHookServer';
import { generateHookSettingsFile, cleanupHookSettingsFile } from '@/claude/utils/generateHookSettings';
import { registerKillSessionHandler } from './registerKillSessionHandler';
import { projectPath } from '../projectPath';
import { resolve } from 'node:path';
import { startOfflineReconnection, connectionState } from '@/utils/serverConnectionErrors';
import { fetchAvailableModels, getHardcodedModels } from './fetchAvailableModels';
import { claudeLocal } from '@/claude/claudeLocal';
import { createSessionScanner } from '@/claude/utils/sessionScanner';
import {
    CLAUDE_GOAL_ACTION_CONFIRMATIONS,
    claudeGoalActionCapabilities,
    mapClaudeGoalStatusEventToAgentGoalStatus,
    parseClaudeGoalActionParams,
    type ClaudeGoalStatusTranscriptEvent,
} from '@/claude/claudeGoalStatus';
import { Session } from './session';
import { applySandboxPermissionPolicy, resolveInitialClaudePermissionMode, resolveRemoteClaudePermissionMode } from './utils/permissionMode';
import { decodeBase64, encodeBase64 } from '@/api/encryption';
import type { Session as ApiSession } from '@/api/types';
import { getProjectPath } from './utils/path';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RawJSONLinesSchema, type RawJSONLines } from './types';

/** JavaScript runtime to use for spawning Claude Code */
export type JsRuntime = 'node' | 'bun'

export interface StartOptions {
    model?: string
    permissionMode?: PermissionMode
    startingMode?: 'local' | 'remote'
    shouldStartDaemon?: boolean
    claudeEnvVars?: Record<string, string>
    claudeArgs?: string[]
    startedBy?: 'daemon' | 'terminal'
    noSandbox?: boolean
    /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
    jsRuntime?: JsRuntime
}

const DEFAULT_CLAUDE_PERMISSION_MODE: PermissionMode = 'yolo';
const DEFAULT_CLAUDE_MODEL = 'opus';
const DEFAULT_CLAUDE_EFFORT: 'low' | 'medium' | 'high' | 'xhigh' | 'max' = 'medium';
type ClaudeGoalCommand = NonNullable<ReturnType<typeof parseClaudeGoalActionParams>>;
type PendingClaudeGoalAction = {
    command: ClaudeGoalCommand;
    resolve: (value: { ok: true }) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
};

export async function runClaude(credentials: Credentials, options: StartOptions = {}): Promise<void> {
    logger.debug(`[CLAUDE] ===== CLAUDE MODE STARTING =====`);
    logger.debug(`[CLAUDE] This is the Claude agent, NOT Gemini`);
    
    const workingDirectory = process.cwd();
    const sessionTag = randomUUID();

    // Log environment info at startup
    logger.debugLargeJson('[START] Happy process started', getEnvironmentInfo());
    logger.debug(`[START] Options: startedBy=${options.startedBy}, startingMode=${options.startingMode}`);

    // Validate daemon spawn requirements - fail fast on invalid config
    if (options.startedBy === 'daemon' && options.startingMode === 'local') {
        throw new Error('Daemon-spawned sessions cannot use local/interactive mode. Use --happy-starting-mode remote or spawn sessions directly from terminal.');
    }

    // Set backend for offline warnings (before any API calls)
    connectionState.setBackend('Claude');

    // Create session service
    const api = await ApiClient.create(credentials);

    // Create a new session
    let state: AgentState = {};

    // Get machine ID from settings (should already be set up)
    const settings = await readSettings();
    let machineId = settings?.machineId
    const sandboxConfig = options.noSandbox ? undefined : settings?.sandboxConfig;
    const sandboxEnabled = Boolean(sandboxConfig?.enabled);
    const initialPermissionMode = applySandboxPermissionPolicy(
        resolveInitialClaudePermissionMode(options.permissionMode ?? DEFAULT_CLAUDE_PERMISSION_MODE, options.claudeArgs),
        sandboxEnabled,
    );
    const dangerouslySkipPermissions =
        initialPermissionMode === 'bypassPermissions' ||
        initialPermissionMode === 'yolo' ||
        sandboxEnabled ||
        Boolean(options.claudeArgs?.includes('--dangerously-skip-permissions'));
    if (!machineId) {
        console.error(`[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/slopus/happy-cli/issues`);
        process.exit(1);
    }
    logger.debug(`Using machineId: ${machineId}`);

    // Create machine if it doesn't exist
    await api.getOrCreateMachine({
        machineId,
        metadata: initialMachineMetadata
    });

    // Lineage from the daemon's spawn RPC (set by app-side fork / duplicate).
    const forkedFromSessionId = process.env.HAPPY_FORKED_FROM_SESSION_ID;
    const forkedFromMessageId = process.env.HAPPY_FORKED_FROM_MESSAGE_ID;

    // Apply Claude env vars early so fetchAvailableModels can reach the
    // gateway API (needs ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN).
    if (options.claudeEnvVars) {
        Object.entries(options.claudeEnvVars).forEach(([key, value]) => {
            process.env[key] = value;
        });
    }

    // Fetch available models from the gateway so the app can display
    // the full model list — including provider models, 1M-context
    // variants, and all discoverable models (same source as /model).
    const availableModels =
      (await fetchAvailableModels()) ?? getHardcodedModels();
    const currentModelCode = options.model ?? DEFAULT_CLAUDE_MODEL;

    let metadata: Metadata = {
        path: workingDirectory,
        host: os.hostname(),
        version: packageJson.version,
        os: os.platform(),
        machineId: machineId,
        homeDir: os.homedir(),
        happyHomeDir: configuration.happyHomeDir,
        happyLibDir: projectPath(),
        happyToolsDir: resolve(projectPath(), 'tools', 'unpacked'),
        startedFromDaemon: options.startedBy === 'daemon',
        hostPid: process.pid,
        startedBy: options.startedBy || 'terminal',
        // Initialize lifecycle state
        lifecycleState: 'running',
        lifecycleStateSince: Date.now(),
        flavor: 'claude',
        sandbox: sandboxConfig?.enabled ? sandboxConfig : null,
        dangerouslySkipPermissions,
        models: availableModels,
        currentModelCode,
        ...(forkedFromSessionId ? { parentSessionId: forkedFromSessionId } : {}),
        ...(forkedFromMessageId ? { forkedFromMessageId } : {}),
    };

    // Check for session reconnection env vars (set by daemon for resume-in-place)
    const reconnectSessionId = process.env.HAPPY_RECONNECT_SESSION_ID;
    const reconnectKeyBase64 = process.env.HAPPY_RECONNECT_ENCRYPTION_KEY;
    const reconnectVariant = process.env.HAPPY_RECONNECT_ENCRYPTION_VARIANT as 'legacy' | 'dataKey' | undefined;
    const reconnectSeq = process.env.HAPPY_RECONNECT_SEQ;
    const reconnectMetadataVersion = process.env.HAPPY_RECONNECT_METADATA_VERSION;
    const reconnectAgentStateVersion = process.env.HAPPY_RECONNECT_AGENT_STATE_VERSION;

    let response: ApiSession | null;
    if (reconnectSessionId && reconnectKeyBase64 && reconnectVariant) {
        logger.debug(`[START] Reconnecting to existing session ${reconnectSessionId}`);
        response = {
            id: reconnectSessionId,
            seq: parseInt(reconnectSeq || '0', 10),
            encryptionKey: decodeBase64(reconnectKeyBase64),
            encryptionVariant: reconnectVariant,
            metadata,
            metadataVersion: parseInt(reconnectMetadataVersion || '0', 10),
            agentState: state,
            agentStateVersion: parseInt(reconnectAgentStateVersion || '0', 10),
        };
    } else {
        response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
    }

    // Handle server unreachable case - run Claude locally with hot reconnection
    // Note: connectionState.notifyOffline() was already called by api.ts with error details
    if (!response) {
        let offlineSessionId: string | null = null;

        const reconnection = startOfflineReconnection({
            serverUrl: configuration.serverUrl,
            onReconnected: async () => {
                const resp = await api.getOrCreateSession({ tag: randomUUID(), metadata, state });
                if (!resp) throw new Error('Server unavailable');
                const session = api.sessionSyncClient(resp);
                let latestClaudeGoalStatus: AgentGoalStatus | null = null;
                const observedClaudeGoalRevisions = new Set<string>();
                const goalCommandSupported = () => {
                    const slashCommands = session.getMetadata()?.slashCommands ?? [];
                    return slashCommands.includes('goal') || slashCommands.includes('/goal');
                };
                const currentClaudeSessionId = () => session.getMetadata()?.claudeSessionId ?? null;
                const updateClaudeGoalState = (event: ClaudeGoalStatusTranscriptEvent) => {
                    if (observedClaudeGoalRevisions.has(event.sourceRevision)) {
                        return;
                    }
                    const capabilities = claudeGoalActionCapabilities({
                        goalCommandSupported: goalCommandSupported(),
                        observedGoalStatus: true,
                        confirmedActions: CLAUDE_GOAL_ACTION_CONFIRMATIONS,
                    });
                    const goalStatus = mapClaudeGoalStatusEventToAgentGoalStatus(
                        event,
                        currentClaudeSessionId(),
                        capabilities ? { capabilities } : undefined,
                    );
                    if (!goalStatus) {
                        return;
                    }
                    observedClaudeGoalRevisions.add(event.sourceRevision);
                    latestClaudeGoalStatus = goalStatus;
                    session.updateAgentState((current) => ({
                        ...current,
                        agentGoalStatus: latestClaudeGoalStatus ?? goalStatus,
                    }));
                };
                const scanner = await createSessionScanner({
                    sessionId: null,
                    workingDirectory,
                    onMessage: (msg) => {
                        void session.sendClaudeSessionMessageFromLocalTranscript(msg);
                    },
                    onTranscriptEvent: updateClaudeGoalState,
                });
                if (offlineSessionId) scanner.onNewSession(offlineSessionId);
                return { session, scanner };
            },
            onNotify: console.log,
            onCleanup: () => {
                // Scanner cleanup handled automatically when process exits
            }
        });

        try {
            await claudeLocal({
                path: workingDirectory,
                sessionId: null,
                onSessionFound: (id) => { offlineSessionId = id; },
                onThinkingChange: () => {},
                abort: new AbortController().signal,
                claudeEnvVars: options.claudeEnvVars,
                claudeArgs: options.claudeArgs,
                mcpServers: {},
                allowedTools: [],
                sandboxConfig,
            });
        } finally {
            reconnection.cancel();
        }
        process.exit(0);
    }

    logger.debug(`Session created: ${response.id}`);

    // Always report to daemon if it exists
    try {
        logger.debug(`[START] Reporting session ${response.id} to daemon`);
        const result = await notifyDaemonSessionStarted(response.id, metadata, {
            encryptionKey: encodeBase64(response.encryptionKey),
            encryptionVariant: response.encryptionVariant,
            seq: response.seq,
            metadataVersion: response.metadataVersion,
            agentStateVersion: response.agentStateVersion,
        });
        if (result.error) {
            logger.debug(`[START] Failed to report to daemon (may not be running):`, result.error);
        } else {
            logger.debug(`[START] Reported session ${response.id} to daemon`);
        }
    } catch (error) {
        logger.debug('[START] Failed to report to daemon (may not be running):', error);
    }

    // SDK metadata (tools, slash commands) is now extracted from the
    // system.init message in claudeRemote.ts via onSDKMetadata callback

    // Create realtime session
    const session = api.sessionSyncClient(response);

    // On reconnect, un-archive the session and skip replaying old messages.
    if (reconnectSessionId) {
        session.suppressNextArchiveSignal();
        session.skipExistingMessages();
        session.updateMetadata((meta) => ({
            ...meta,
            lifecycleState: 'running',
            archivedBy: undefined,
        }));
    }

    // Fork backfill: when this Happy session was just spawned as a fork
    // of another (HAPPY_FORK_CLAUDE_SESSION_ID is set by the daemon at
    // spawn time), the fresh server-side message log is empty but the
    // copied Claude JSONL on disk has the full prior conversation. The
    // SDK with `resume:` reads that JSONL silently — it never re-emits
    // historical messages back to the Happy client — so without an
    // explicit backfill the user lands in an empty chat.
    //
    // Read the JSONL once before any SDK invocation and push every line
    // through sendClaudeSessionMessage so the protocol mapper produces
    // proper user/agent envelopes. SDK messages from later turns then
    // continue from the same mapper state.
    //
    // Skipped on reconnect (HAPPY_RECONNECT_*) — that path reattaches
    // to the existing Happy session, where the server already has every
    // message it needs.
    const forkClaudeSessionId = process.env.HAPPY_FORK_CLAUDE_SESSION_ID;
    if (!reconnectSessionId && forkClaudeSessionId) {
        const jsonlPath = join(getProjectPath(workingDirectory), `${forkClaudeSessionId}.jsonl`);
        try {
            const file = await readFile(jsonlPath, 'utf-8');
            const lines = file.split('\n');
            let backfilled = 0;
            for (const line of lines) {
                if (line.trim().length === 0) continue;
                let parsed: unknown;
                try { parsed = JSON.parse(line); } catch { continue; }
                const result = RawJSONLinesSchema.safeParse(parsed);
                if (!result.success) continue;
                await session.sendClaudeSessionMessageFromLocalTranscript(result.data as RawJSONLines);
                backfilled += 1;
            }
            logger.debug(`[FORK BACKFILL] Replayed ${backfilled} historical messages from ${jsonlPath}`);
            // Bind the new Happy session to the forked Claude UUID up
            // front so the metadata is consistent the moment the app
            // opens this session — even before the SDK's hook callback
            // fires.
            session.updateMetadata((meta) => ({ ...meta, claudeSessionId: forkClaudeSessionId }));
        } catch (error) {
            logger.debug(`[FORK BACKFILL] Failed to read ${jsonlPath}:`, error);
        }
    }

    // Ring buffer of user prompts that just arrived from the app via the
    // legacy `sentFrom: 'web'` channel. The remote-mode session scanner
    // (started below) walks the on-disk Claude JSONL looking for prompts
    // that landed in the file but never reached the server — i.e. the
    // ones the user typed in a `claude --resume <id>` terminal sitting
    // alongside this Happy session. App-sent prompts also land in the
    // JSONL once the SDK writes them, so we'd double-forward them
    // without this dedupe. Match by content within a short time window;
    // entries older than 5 minutes roll off so unrelated future prompts
    // with identical text still get through from the terminal side.
    const recentAppPromptsMaxAgeMs = 5 * 60 * 1000;
    const recentAppPrompts: Array<{ text: string; addedAt: number }> = [];
    const recordAppPrompt = (text: string) => {
        const now = Date.now();
        recentAppPrompts.push({ text, addedAt: now });
        const cutoff = now - recentAppPromptsMaxAgeMs;
        while (recentAppPrompts.length > 0 && recentAppPrompts[0].addedAt < cutoff) {
            recentAppPrompts.shift();
        }
    };
    const consumeAppPrompt = (text: string): boolean => {
        const cutoff = Date.now() - recentAppPromptsMaxAgeMs;
        for (let i = 0; i < recentAppPrompts.length; i++) {
            const entry = recentAppPrompts[i];
            if (entry.addedAt < cutoff) continue;
            if (entry.text === text) {
                recentAppPrompts.splice(i, 1);
                return true;
            }
        }
        return false;
    };

    let currentRunMode: 'local' | 'remote' = options.startingMode ?? 'local';
    let latestClaudeGoalStatus: AgentGoalStatus | null = null;
    const observedClaudeGoalRevisions = new Set<string>();
    let pendingClaudeGoalAction: PendingClaudeGoalAction | null = null;
    const goalCommandSupported = () => {
        const slashCommands = session.getMetadata()?.slashCommands ?? [];
        return slashCommands.includes('goal') || slashCommands.includes('/goal');
    };
    const currentClaudeSessionId = () => session.getMetadata()?.claudeSessionId ?? null;
    const settlePendingClaudeGoalAction = (goalStatus: AgentGoalStatus) => {
        if (!pendingClaudeGoalAction) {
            return;
        }

        const pending = pendingClaudeGoalAction;
        if (pending.command.type === 'clear' && goalStatus.status === 'inactive') {
            clearTimeout(pending.timeout);
            pendingClaudeGoalAction = null;
            pending.resolve({ ok: true });
            return;
        }

        if (
            pending.command.type === 'set'
            && goalStatus.status === 'active'
            && goalStatus.text.trim() === pending.command.objective.trim()
        ) {
            clearTimeout(pending.timeout);
            pendingClaudeGoalAction = null;
            pending.resolve({ ok: true });
        }
    };
    const updateClaudeGoalState = (event: ClaudeGoalStatusTranscriptEvent) => {
        if (observedClaudeGoalRevisions.has(event.sourceRevision)) {
            return;
        }
        const capabilities = claudeGoalActionCapabilities({
            goalCommandSupported: goalCommandSupported(),
            observedGoalStatus: true,
            confirmedActions: CLAUDE_GOAL_ACTION_CONFIRMATIONS,
        });
        const goalStatus = mapClaudeGoalStatusEventToAgentGoalStatus(
            event,
            currentClaudeSessionId(),
            capabilities ? { capabilities } : undefined,
        );
        if (!goalStatus) {
            return;
        }
        observedClaudeGoalRevisions.add(event.sourceRevision);
        latestClaudeGoalStatus = goalStatus;
        settlePendingClaudeGoalAction(goalStatus);
        session.updateAgentState((current) => ({
            ...current,
            agentGoalStatus: latestClaudeGoalStatus ?? goalStatus,
        }));
    };

    // Remote-mode session scanner: catches user-typed prompts that
    // appeared in the Claude JSONL while we weren't looking — typically
    // because the user opened `claude --resume <id>` in a terminal next
    // to the running Happy session. SDK-emitted assistant + tool_result
    // user messages keep flowing through the existing sdkToLogConverter
    // pipeline; the scanner here only forwards things that pipeline
    // can't see.
    const initialScannerSessionId = forkClaudeSessionId
        ?? (metadata.claudeSessionId ?? null);
    const remoteScanner = await createSessionScanner({
        sessionId: initialScannerSessionId,
        workingDirectory,
        onMessage: (raw) => {
            if (currentRunMode !== 'remote') return;
            // Only user-typed prompts. SDK pipeline owns assistant and
            // tool_result-bearing user messages.
            if (raw.type !== 'user') return;
            if ((raw as any).isSidechain) return;
            const content = (raw as any).message?.content;
            if (typeof content !== 'string') return;
            // Drop empty / whitespace-only lines.
            if (content.trim().length === 0) return;
            // App-sent prompts will show up here because the SDK
            // writes them to the JSONL — dedupe by content.
            if (consumeAppPrompt(content)) return;
            session.sendClaudeSessionMessage(raw);
        },
        onTranscriptEvent: updateClaudeGoalState,
    });

    // Start Happy MCP server
    const happyServer = await startHappyServer(session);
    logger.debug(`[START] Happy MCP server started at ${happyServer.url}`);

    // Variable to track current session instance (updated via onSessionReady callback)
    // Used by hook server to notify Session when Claude changes session ID
    let currentSession: Session | null = null;

    // Start Hook server for receiving Claude session notifications
    const hookServer = await startHookServer({
        onSessionHook: (sessionId, data) => {
            logger.debug(`[START] Session hook received: ${sessionId}`, data);

            // Tell the remote scanner about this sessionId so it knows
            // which JSONL to watch (and so it can fire onNewSession for
            // claude --resume hand-offs that mint a fresh session id).
            //
            // In remote mode every user prompt arrives via the SDK or the
            // app channel — both of which already deliver their messages
            // to the server before they hit disk. Anything the scanner
            // finds in the JSONL at the moment it learns the session id
            // is therefore already on the server; treating it as fresh
            // (the previous behavior) replayed the whole history back to
            // the chat on reconnect. The scanner's real job is forwarding
            // *future* JSONL writes from a parallel `claude --resume`
            // terminal, which the file watcher will pick up.
            remoteScanner.onNewSession(sessionId, { treatExistingAsProcessed: true });

            // Update session ID in the Session instance
            if (currentSession) {
                const previousSessionId = currentSession.sessionId;
                if (previousSessionId !== sessionId) {
                    logger.debug(`[START] Claude session ID changed: ${previousSessionId} -> ${sessionId}`);
                    currentSession.onSessionFound(sessionId);
                }
            }
        }
    });
    logger.debug(`[START] Hook server started on port ${hookServer.port}`);

    // Generate hook settings file for Claude
    const hookSettingsPath = generateHookSettingsFile(hookServer.port);
    logger.debug(`[START] Generated hook settings file: ${hookSettingsPath}`);

    // Print log file path
    const logPath = logger.logFilePath;
    logger.infoDeveloper(`Session: ${response.id}`);
    logger.infoDeveloper(`Logs: ${logPath}`);

    // Set initial agent state
    session.updateAgentState((currentState) => ({
        ...currentState,
        controlledByUser: options.startingMode !== 'remote'
    }));

    // Import MessageQueue2 and create message queue
    const messageQueue = new MessageQueue2<EnhancedMode>(mode => hashObject({
        isPlan: mode.permissionMode === 'plan',
        model: mode.model,
        fallbackModel: mode.fallbackModel,
        customSystemPrompt: mode.customSystemPrompt,
        appendSystemPrompt: mode.appendSystemPrompt,
        allowedTools: mode.allowedTools,
        disallowedTools: mode.disallowedTools,
        effort: mode.effort,
    }));

    // Forward messages to the queue
    // Permission modes: Use the unified 7-mode type, mapping happens at SDK boundary in claudeRemote.ts
    let currentPermissionMode: PermissionMode | undefined = initialPermissionMode;
    let currentModel: string | undefined = options.model ?? DEFAULT_CLAUDE_MODEL; // Track current model state
    let currentFallbackModel: string | undefined = undefined; // Track current fallback model
    let currentCustomSystemPrompt: string | undefined = undefined; // Track current custom system prompt
    let currentAppendSystemPrompt: string | undefined = undefined; // Track current append system prompt
    let currentAllowedTools: string[] | undefined = undefined; // Track current allowed tools
    let currentDisallowedTools: string[] | undefined = undefined; // Track current disallowed tools
    let currentEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined = DEFAULT_CLAUDE_EFFORT; // Track current Claude effort (thinking depth)

    const resetCurrentModeDefaults = () => {
        currentPermissionMode = initialPermissionMode;
        currentModel = options.model ?? DEFAULT_CLAUDE_MODEL;
        currentFallbackModel = undefined;
        currentCustomSystemPrompt = undefined;
        currentAppendSystemPrompt = undefined;
        currentAllowedTools = undefined;
        currentDisallowedTools = undefined;
        currentEffort = DEFAULT_CLAUDE_EFFORT;
        logger.debug('[loop] Reset current mode defaults after abort');
    };
    const currentEnhancedMode = (): EnhancedMode => ({
        permissionMode: currentPermissionMode || 'default',
        model: currentModel,
        fallbackModel: currentFallbackModel,
        customSystemPrompt: currentCustomSystemPrompt,
        appendSystemPrompt: currentAppendSystemPrompt,
        allowedTools: currentAllowedTools,
        disallowedTools: currentDisallowedTools,
        effort: currentEffort,
    });

    session.rpcHandlerManager.registerHandler('goal-action', async (params: unknown) => {
        const actionParams = params && typeof params === 'object' && !Array.isArray(params)
            ? params as Record<string, unknown>
            : null;
        const command = actionParams ? parseClaudeGoalActionParams(actionParams) : null;
        if (!command) {
            throw new Error('Unsupported Claude goal action');
        }
        if (pendingClaudeGoalAction) {
            throw new Error('Claude goal action already in progress');
        }
        if (!latestClaudeGoalStatus || latestClaudeGoalStatus.status !== 'active') {
            throw new Error('No active Claude goal');
        }

        const capabilities = latestClaudeGoalStatus.capabilities ?? {};
        if (command.type === 'clear' && !capabilities.clear) {
            throw new Error('Claude clear goal action is not supported');
        }
        if (command.type === 'set' && !capabilities.edit) {
            throw new Error('Claude edit goal action is not supported');
        }
        if (currentRunMode !== 'remote') {
            throw new Error('Claude goal action is not ready: remote mode is not active');
        }
        if (!currentSession || currentSession.thinking) {
            throw new Error('Claude goal action is not ready while Claude is thinking');
        }
        if (messageQueue.size() > 0) {
            throw new Error('Claude message queue is busy');
        }

        const slashCommand = command.type === 'clear'
            ? '/goal clear'
            : `/goal ${command.objective}`;
        const mode = currentEnhancedMode();

        return await new Promise<{ ok: true }>((resolve, reject) => {
            const timeout = setTimeout(() => {
                pendingClaudeGoalAction = null;
                reject(new Error('Timed out waiting for Claude goal confirmation'));
            }, 30000);

            pendingClaudeGoalAction = { command, resolve, reject, timeout };
            try {
                messageQueue.pushIsolated(slashCommand, mode);
            } catch (error) {
                clearTimeout(timeout);
                pendingClaudeGoalAction = null;
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    });

    // Exit when session is archived from web/mobile
    session.on('archived', () => {
        logger.debug('[loop] Session archived from web/mobile, cleaning up...');
        cleanup();
    });

    // Handle file events — each download promise resolves to its own decoded
    // attachment (or null). drainAttachmentsForUserMessage on the next text
    // claims the in-flight set atomically; later file events go into a fresh
    // bucket bound to the next message — no shared push-array between batches.
    session.onFileEvent((fileEvent) => {
        const ev = fileEvent.content.data.ev;
        logger.debug(`[loop] File event received: ${ev.name} (${ev.size} bytes, ref: ${ev.ref})`);
        const downloadPromise = (async (): Promise<{ data: Uint8Array; mimeType: string; name: string } | null> => {
            try {
                const decrypted = await session.downloadAndDecryptAttachment(ev.ref);
                if (!decrypted) {
                    logger.debug(`[loop] Failed to decrypt attachment: ${ev.name}`);
                    return null;
                }
                logger.debug(`[loop] Attachment decrypted: ${ev.name} (${decrypted.length} bytes)`);
                return { data: decrypted, mimeType: ev.mimeType ?? 'image/jpeg', name: ev.name };
            } catch (error) {
                logger.debug(`[loop] Failed to download attachment: ${ev.name}`, { error });
                return null;
            }
        })();
        session.trackAttachmentDownload(downloadPromise);
    });

    session.onUserMessage(async (message) => {

        // Stamp the prompt so the remote-mode JSONL scanner can dedupe
        // it later — the SDK is about to write this same text to disk
        // with a real Claude uuid, and we don't want to re-forward it.
        if (message?.content?.text) {
            recordAppPrompt(message.content.text);
        }

        // Claim every file attachment that arrived strictly before this text.
        // New file events from this point on belong to the next user message.
        const attachmentsForThisMessage = await session.drainAttachmentsForUserMessage();

        // Resolve permission mode from meta - pass through as-is, mapping happens at SDK boundary
        let messagePermissionMode: PermissionMode | undefined = currentPermissionMode;
        if (message.meta?.permissionMode) {
            const previousPermissionMode = currentPermissionMode;
            messagePermissionMode = resolveRemoteClaudePermissionMode(
                currentPermissionMode,
                message.meta.permissionMode,
                sandboxEnabled,
            );
            currentPermissionMode = messagePermissionMode;
            const ignoredDefaultDowngrade =
                (previousPermissionMode === 'bypassPermissions' || previousPermissionMode === 'yolo')
                && message.meta.permissionMode === 'default'
                && currentPermissionMode === previousPermissionMode;
            if (ignoredDefaultDowngrade) {
                logger.debug(`[loop] Ignoring permission mode downgrade from ${previousPermissionMode} to default`);
            } else {
                logger.debug(`[loop] Permission mode updated from user message to: ${currentPermissionMode}`);
            }
        } else {
            logger.debug(`[loop] User message received with no permission mode override, using current: ${currentPermissionMode}`);
        }

        // Resolve model - use message.meta.model if provided, otherwise use current model
        let messageModel = currentModel;
        if (message.meta?.hasOwnProperty('model')) {
            messageModel = message.meta.model || undefined; // null becomes undefined
            currentModel = messageModel;
            session.updateMetadata((meta) => ({ ...meta, currentModelCode: messageModel ?? undefined }));
            logger.debug(`[loop] Model updated from user message: ${messageModel || 'reset to default'}`);
        } else {
            logger.debug(`[loop] User message received with no model override, using current: ${currentModel || 'default'}`);
        }

        // Resolve custom system prompt - use message.meta.customSystemPrompt if provided, otherwise use current
        let messageCustomSystemPrompt = currentCustomSystemPrompt;
        if (message.meta?.hasOwnProperty('customSystemPrompt')) {
            messageCustomSystemPrompt = message.meta.customSystemPrompt || undefined; // null becomes undefined
            currentCustomSystemPrompt = messageCustomSystemPrompt;
            logger.debug(`[loop] Custom system prompt updated from user message: ${messageCustomSystemPrompt ? 'set' : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no custom system prompt override, using current: ${currentCustomSystemPrompt ? 'set' : 'none'}`);
        }

        // Resolve fallback model - use message.meta.fallbackModel if provided, otherwise use current fallback model
        let messageFallbackModel = currentFallbackModel;
        if (message.meta?.hasOwnProperty('fallbackModel')) {
            messageFallbackModel = message.meta.fallbackModel || undefined; // null becomes undefined
            currentFallbackModel = messageFallbackModel;
            logger.debug(`[loop] Fallback model updated from user message: ${messageFallbackModel || 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no fallback model override, using current: ${currentFallbackModel || 'none'}`);
        }

        // Resolve append system prompt - use message.meta.appendSystemPrompt if provided, otherwise use current
        let messageAppendSystemPrompt = currentAppendSystemPrompt;
        if (message.meta?.hasOwnProperty('appendSystemPrompt')) {
            messageAppendSystemPrompt = message.meta.appendSystemPrompt || undefined; // null becomes undefined
            currentAppendSystemPrompt = messageAppendSystemPrompt;
            logger.debug(`[loop] Append system prompt updated from user message: ${messageAppendSystemPrompt ? 'set' : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no append system prompt override, using current: ${currentAppendSystemPrompt ? 'set' : 'none'}`);
        }

        // Resolve allowed tools - use message.meta.allowedTools if provided, otherwise use current
        let messageAllowedTools = currentAllowedTools;
        if (message.meta?.hasOwnProperty('allowedTools')) {
            messageAllowedTools = message.meta.allowedTools || undefined; // null becomes undefined
            currentAllowedTools = messageAllowedTools;
            logger.debug(`[loop] Allowed tools updated from user message: ${messageAllowedTools ? messageAllowedTools.join(', ') : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no allowed tools override, using current: ${currentAllowedTools ? currentAllowedTools.join(', ') : 'none'}`);
        }

        // Resolve disallowed tools - use message.meta.disallowedTools if provided, otherwise use current
        let messageDisallowedTools = currentDisallowedTools;
        if (message.meta?.hasOwnProperty('disallowedTools')) {
            messageDisallowedTools = message.meta.disallowedTools || undefined; // null becomes undefined
            currentDisallowedTools = messageDisallowedTools;
            logger.debug(`[loop] Disallowed tools updated from user message: ${messageDisallowedTools ? messageDisallowedTools.join(', ') : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no disallowed tools override, using current: ${currentDisallowedTools ? currentDisallowedTools.join(', ') : 'none'}`);
        }

        // Resolve effort — pass through to Claude SDK as the `effort` option.
        // Validate against the SDK's accepted set so a stale/garbage value
        // from the wire doesn't poison the session.
        let messageEffort = currentEffort;
        const VALID_EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
        if (message.meta?.hasOwnProperty('effort')) {
            const incoming = (message.meta as Record<string, unknown>).effort;
            if (incoming === null || incoming === undefined) {
                messageEffort = undefined;
                currentEffort = undefined;
                logger.debug(`[loop] Effort reset to default`);
            } else if (typeof incoming === 'string' && VALID_EFFORTS.has(incoming)) {
                messageEffort = incoming as 'low' | 'medium' | 'high' | 'xhigh' | 'max';
                currentEffort = messageEffort;
                logger.debug(`[loop] Effort updated from user message: ${messageEffort}`);
            } else {
                logger.debug(`[loop] Ignoring invalid effort from user message: ${String(incoming)}`);
            }
        } else {
            logger.debug(`[loop] User message received with no effort override, using current: ${currentEffort ?? 'default'}`);
        }

        // Check for special commands before processing
        const specialCommand = parseSpecialCommand(message.content.text);

        if (specialCommand.type === 'compact') {
            logger.debug('[start] Detected /compact command');
            messageQueue.pushIsolateAndClear(specialCommand.originalMessage || message.content.text, currentEnhancedMode(), attachmentsForThisMessage);
            logger.debugLargeJson('[start] /compact command pushed to queue:', message);
            return;
        }

        if (specialCommand.type === 'clear') {
            logger.debug('[start] Detected /clear command');
            messageQueue.pushIsolateAndClear(specialCommand.originalMessage || message.content.text, currentEnhancedMode(), attachmentsForThisMessage);
            logger.debugLargeJson('[start] /clear command pushed to queue:', message);
            return;
        }

        if (specialCommand.type === 'mcp' || specialCommand.type === 'skills') {
            // In local mode, let Claude Code handle these commands natively
            if (currentRunMode === 'local') {
                logger.debug(`[start] /${specialCommand.type} in local mode — passing through to Claude Code`);
            } else {
                logger.debug(`[start] Detected /${specialCommand.type} command in remote mode`);
                const metadata = session.getMetadata();
                let responseText: string;

                if (specialCommand.type === 'mcp') {
                    const servers = metadata?.mcpServers;
                    if (servers && servers.length > 0) {
                        responseText = '**MCP Servers**\n\n' + servers.map(s => `- **${s.name}** — ${s.status}`).join('\n');
                    } else {
                        responseText = 'No MCP servers configured. Session may still be initializing — try again after sending a message.';
                    }
                } else {
                    const skills = metadata?.skills ?? metadata?.slashCommands;
                    if (skills && skills.length > 0) {
                        responseText = '**Available Skills**\n\n' + skills.map(s => `- /${s}`).join('\n');
                    } else {
                        responseText = 'No skills available. Session may still be initializing — try again after sending a message.';
                    }
                }

                session.sendClaudeSessionMessage({
                    type: 'assistant',
                    uuid: randomUUID(),
                    parentUuid: null,
                    isSidechain: false,
                    sessionId: session.sessionId || 'unknown',
                    timestamp: new Date().toISOString(),
                    message: {
                        role: 'assistant',
                        model: 'system',
                        content: [{ type: 'text', text: responseText }],
                    },
                } as any);
                return;
            }
        }

        // Push with resolved permission mode, model, system prompts, and tools
        messageQueue.push(message.content.text, currentEnhancedMode(), attachmentsForThisMessage);
        logger.debugLargeJson('User message pushed to queue:', message)
    });

    // Setup signal handlers for graceful shutdown
    //
    // `archive`: whether to stamp lifecycleState='archived' on the way
    // out. Two reasons we'd want to skip it:
    //   - The user pressed Ctrl-C in their terminal. They almost
    //     certainly want to come back to this session later — pinning
    //     it as `archived` would hide it from the active sessions list
    //     and force them to dig it up by URL just to hit Resume.
    //   - Same for SIGTERM (e.g. the system shutting us down).
    //
    // Browser-side "Archive" is intentionally explicit and DOES want
    // the metadata stamped — it routes through the killSession RPC
    // handler which calls cleanup({ archive: true }).
    //
    // Crashes (uncaughtException / unhandledRejection) keep archiving
    // because the session is genuinely toast at that point.
    const cleanup = async (opts: { archive?: boolean } = { archive: true }) => {
        logger.debug(`[START] Received termination signal, cleaning up (archive=${opts.archive ?? true})...`);

        try {
            // Update lifecycle state to archived before closing — only
            // when explicitly archiving. On Ctrl-C / SIGTERM we leave
            // lifecycleState alone so the server treats this exactly
            // like a network blip: active=false via missed keepalives,
            // but the session stays visible and resumable in the app.
            if (session) {
                if (opts.archive ?? true) {
                    session.updateMetadata((currentMetadata) => ({
                        ...currentMetadata,
                        lifecycleState: 'archived',
                        lifecycleStateSince: Date.now(),
                        archivedBy: 'cli',
                        archiveReason: 'User terminated'
                    }));
                }

                // Cleanup session resources (intervals, callbacks)
                currentSession?.cleanup();

                // Send session death message
                session.sendSessionDeath();

                // Belt-and-braces: also POST /v1/sessions/<id>/archive so
                // the server flips active=false even if the socket emit
                // didn't drain before close. The HTTP endpoint touches
                // only `active` and `lastActiveAt` — it doesn't write
                // archive metadata — so this is safe in the archive=false
                // case too, and matches the "session goes inactive but
                // stays resumable" semantics we want for Ctrl-C.
                try {
                    await api.deactivateSession(session.sessionId);
                } catch (err) {
                    logger.debug('[START] deactivateSession during cleanup failed:', err);
                }

                await session.flush();
                await session.close();
            }

            // Stop Happy MCP server
            happyServer.stop();

            // Stop Hook server and cleanup settings file
            hookServer.stop();
            cleanupHookSettingsFile(hookSettingsPath);

            // Stop the remote JSONL scanner (file watchers + intervals).
            await remoteScanner.cleanup();

            logger.debug('[START] Cleanup complete, exiting');
            process.exit(0);
        } catch (error) {
            logger.debug('[START] Error during cleanup:', error);
            process.exit(1);
        }
    };

    // Handle termination signals — Ctrl-C / SIGTERM are user-initiated
    // exits, treat as "I'll come back to this session later" rather than
    // "archive forever".
    process.on('SIGTERM', () => { void cleanup({ archive: false }); });
    process.on('SIGINT', () => { void cleanup({ archive: false }); });

    // Crashes archive on the way out so the session shows up correctly
    // in the app rather than masquerading as live.
    process.on('uncaughtException', (error) => {
        logger.debug('[START] Uncaught exception:', error);
        void cleanup({ archive: true });
    });

    process.on('unhandledRejection', (reason) => {
        logger.debug('[START] Unhandled rejection:', reason);
        void cleanup({ archive: true });
    });

    // Browser-side "Archive" button routes through this RPC and DOES
    // want the metadata stamped — it's the user explicitly choosing to
    // retire the session, not just disconnecting.
    registerKillSessionHandler(session.rpcHandlerManager, () => cleanup({ archive: true }));

    // Create claude loop
    const exitCode = await loop({
        path: workingDirectory,
        model: options.model,
        permissionMode: initialPermissionMode,
        startingMode: options.startingMode,
        messageQueue,
        api,
        allowedTools: happyServer.toolNames.map(toolName => `mcp__happy__${toolName}`),
        onModeChange: (newMode) => {
            currentRunMode = newMode;
            session.sendSessionEvent({ type: 'switch', mode: newMode });
            session.updateAgentState((currentState) => ({
                ...currentState,
                controlledByUser: newMode === 'local'
            }));
        },
        onSessionReady: (sessionInstance) => {
            // Store reference for hook server callback
            currentSession = sessionInstance;
        },
        onAbort: resetCurrentModeDefaults,
        mcpServers: {
            'happy': {
                type: 'http' as const,
                url: happyServer.url,
            }
        },
        session,
        claudeEnvVars: options.claudeEnvVars,
        claudeArgs: options.claudeArgs,
        sandboxConfig,
        hookSettingsPath,
        jsRuntime: options.jsRuntime
    });

    // Cleanup session resources (intervals, callbacks) - prevents memory leak
    // Note: currentSession is set by onSessionReady callback during loop()
    (currentSession as Session | null)?.cleanup();

    // Send session death message
    session.sendSessionDeath();

    // Wait for socket to flush
    logger.debug('Waiting for socket to flush...');
    await session.flush();

    // Close session
    logger.debug('Closing session...');
    await session.close();

    // Stop Happy MCP server
    happyServer.stop();
    logger.debug('Stopped Happy MCP server');

    // Stop Hook server and cleanup settings file
    hookServer.stop();
    cleanupHookSettingsFile(hookSettingsPath);
    logger.debug('Stopped Hook server and cleaned up settings file');

    // Exit with the code from Claude
    process.exit(exitCode);
}
