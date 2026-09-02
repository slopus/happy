import { render } from "ink";
import React from "react";
import { ApiClient } from '@/api/api';
import { CodexAppServerClient, resolveCodexAppServerConnection } from './codexAppServerClient';
import type {
    GetAccountTokenUsageResponse,
    ListMcpServerStatusResponse,
    Model,
    ReasoningEffort,
    ThreadGoal,
} from './codexAppServerTypes';
import { CodexPermissionHandler } from './utils/permissionHandler';
import { ReasoningProcessor } from './utils/reasoningProcessor';
import { DiffProcessor } from './utils/diffProcessor';
import { randomUUID } from 'node:crypto';
import { execFileSync, execSync } from 'node:child_process';
import { logger } from '@/ui/logger';
import { Credentials, readSettings } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/run';
import { configuration } from '@/configuration';
import packageJson from '../../package.json';
import { createSerializedTaskRunner, MessageQueue2 } from '@/utils/MessageQueue2';
import { isMediaAttachment, type PendingAttachment } from '@/utils/MessageQueue2';
import { isPlaintextMediaEvent, resolveMediaKind, stagedMediaPath, isMediaFileEvent, buildMediaAttachmentFromBytes, cleanupAllStagedMediaAttachments, cleanupMediaAttachments, secureAndRegisterStagedMediaPath } from '@/api/mediaAttachment';
import { buildCodexTurnPayload } from './codexImageInput';
import { projectPath } from '@/projectPath';
import { join } from 'node:path';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { MessageBuffer } from "@/ui/ink/messageBuffer";
import { CodexDisplay } from "@/ui/ink/CodexDisplay";
import { trimIdent } from "@/utils/trimIdent";
import { notifyDaemonSessionStarted } from "@/daemon/controlClient";
import { encodeBase64, decodeBase64 } from '@/api/encryption';
import type { Session as ApiSession } from '@/api/types';
import { registerKillSessionHandler } from "@/claude/registerKillSessionHandler";
import { connectionState } from '@/utils/serverConnectionErrors';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import type { PermissionMode } from '@/api/types';
import type { ApiSessionClient } from '@/api/apiSession';
import { isRemoteCodexPermissionMode, resolveCodexExecutionPolicy } from './executionPolicy';
import {
    isTerminalCodexTurn,
    mapCodexMcpMessageToSessionEnvelopes,
    mapCodexProcessorMessageToSessionEnvelopes,
    mapCodexThreadToSessionEnvelopes,
} from './utils/sessionProtocolMapper';
import { resumeExistingThread } from './resumeExistingThread';
import { emitReadyIfIdle } from './emitReadyIfIdle';
import { enqueueCodexUserText } from './codexClearCommand';
import {
    buildCodexTurnPrompt,
    hashCodexEnhancedMode,
    markPawsTurnOrigin,
    type CodexEnhancedMode,
} from './codexPrompt';
import { mergeCodexSessionConfigIntoMetadata } from './sessionConfigMetadata';
import { parseSpecialCommand } from '@/parsers/specialCommands';
import type { GoalCommand, UsageCommand } from '@/parsers/specialCommands';
import { listCodexSkillNames } from './codexSkills';
import { registerSessionTitleWorker } from '@/title/sessionTitleWorker';
import { updateQueuedMessageCount } from '@/api/sessionTurnStatus';
import { mergeReconnectMetadata } from './reconnectMetadata';

/**
 * Extracts a human-readable error from a codex task_complete/turn_aborted event.
 * Returns null if the event represents a successful/clean completion.
 */
function describeCodexFailure(msg: any): string | null {
    const hasFailure = msg?.status === 'failed' || (msg?.error !== undefined && msg?.error !== null);
    if (!hasFailure) return null;
    const err = msg.error;
    if (typeof err === 'string' && err.length > 0) return err;
    if (err && typeof err === 'object' && typeof err.message === 'string' && err.message.length > 0) {
        return err.message;
    }
    return 'Unknown error';
}

const DEFAULT_CODEX_PERMISSION_MODE: PermissionMode = 'yolo';

function formatCodexGoal(goal: ThreadGoal): string {
    const budget = goal.tokenBudget === null
        ? `${goal.tokensUsed} tokens used`
        : `${goal.tokensUsed} / ${goal.tokenBudget} tokens used`;

    return [
        '**Goal**',
        '',
        `Status: ${goal.status}`,
        `Progress: ${budget}`,
        '',
        goal.objective,
    ].join('\n');
}

function goalErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message.length > 0) {
        return error.message;
    }
    return 'Unknown goal error';
}

function formatNumber(value: number | null | undefined): string {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return 'unknown';
    }
    return new Intl.NumberFormat('en-US').format(value);
}

function formatDuration(seconds: number | null | undefined): string {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
        return 'unknown';
    }

    const rounded = Math.max(0, Math.round(seconds));
    const hours = Math.floor(rounded / 3600);
    const minutes = Math.floor((rounded % 3600) / 60);
    const secs = rounded % 60;
    const parts: string[] = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
    return parts.join(' ');
}

function formatDailyUsageBuckets(usage: GetAccountTokenUsageResponse, limit: number = 14): string[] {
    const buckets = [...(usage.dailyUsageBuckets ?? [])]
        .filter((bucket) => typeof bucket.startDate === 'string' && typeof bucket.tokens === 'number')
        .sort((a, b) => a.startDate.localeCompare(b.startDate))
        .slice(-limit);

    if (buckets.length === 0) {
        return ['No daily usage buckets were returned.'];
    }

    return buckets.map((bucket) => `- ${bucket.startDate}: ${formatNumber(bucket.tokens)} tokens`);
}

function weekStartUtc(dateString: string): string {
    const date = new Date(`${dateString}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) {
        return dateString;
    }
    const daysSinceMonday = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - daysSinceMonday);
    return date.toISOString().slice(0, 10);
}

function formatWeeklyUsageBuckets(usage: GetAccountTokenUsageResponse): string[] {
    const weekly = new Map<string, number>();
    for (const bucket of usage.dailyUsageBuckets ?? []) {
        if (typeof bucket.startDate !== 'string' || typeof bucket.tokens !== 'number') {
            continue;
        }
        const key = weekStartUtc(bucket.startDate);
        weekly.set(key, (weekly.get(key) ?? 0) + bucket.tokens);
    }

    const entries = [...weekly.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-12);
    if (entries.length === 0) {
        return ['No weekly usage buckets were returned.'];
    }

    return entries.map(([week, tokens]) => `- Week of ${week}: ${formatNumber(tokens)} tokens`);
}

function formatCodexUsage(usage: GetAccountTokenUsageResponse, range: UsageCommand['range']): string {
    const summary = usage.summary ?? {};
    const header = range === 'summary'
        ? '**Codex Usage**'
        : `**Codex Usage: ${range[0].toUpperCase()}${range.slice(1)}**`;
    const lines = [
        header,
        '',
        `Lifetime tokens: ${formatNumber(summary.lifetimeTokens)}`,
        `Peak daily tokens: ${formatNumber(summary.peakDailyTokens)}`,
        `Current streak: ${formatNumber(summary.currentStreakDays)} days`,
        `Longest streak: ${formatNumber(summary.longestStreakDays)} days`,
        `Longest turn: ${formatDuration(summary.longestRunningTurnSec)}`,
    ];

    if (range === 'daily') {
        return [...lines, '', 'Daily buckets:', ...formatDailyUsageBuckets(usage, 30)].join('\n');
    }

    if (range === 'weekly') {
        return [...lines, '', 'Weekly buckets:', ...formatWeeklyUsageBuckets(usage)].join('\n');
    }

    if (range === 'cumulative') {
        const returnedBucketTokens = (usage.dailyUsageBuckets ?? []).reduce((total, bucket) => (
            total + (typeof bucket.tokens === 'number' ? bucket.tokens : 0)
        ), 0);
        return [
            ...lines,
            '',
            `Returned bucket total: ${formatNumber(returnedBucketTokens)} tokens`,
        ].join('\n');
    }

    return [...lines, '', 'Recent daily buckets:', ...formatDailyUsageBuckets(usage, 7)].join('\n');
}

function formatMcpStatus(status: ListMcpServerStatusResponse, verbose: boolean): string {
    const servers = status.data ?? [];
    if (servers.length === 0) {
        return '**MCP Servers**\n\nNo MCP servers are connected.';
    }

    const lines = ['**MCP Servers**', ''];
    for (const server of servers) {
        const tools = Object.values(server.tools ?? {});
        lines.push(
            `- ${server.name}: ${tools.length} tools, ${server.resources?.length ?? 0} resources, ${server.resourceTemplates?.length ?? 0} templates, auth=${server.authStatus}`,
        );

        if (verbose && server.serverInfo) {
            const details = [
                server.serverInfo.title,
                server.serverInfo.version ? `v${server.serverInfo.version}` : null,
                server.serverInfo.websiteUrl,
            ].filter((value): value is string => typeof value === 'string' && value.length > 0);
            if (details.length > 0) {
                lines.push(`  ${details.join(' | ')}`);
            }
        }

        if (verbose && tools.length > 0) {
            for (const tool of tools) {
                const title = tool.title && tool.title !== tool.name ? ` - ${tool.title}` : '';
                lines.push(`  - ${tool.name}${title}`);
            }
        }
    }

    if (status.nextCursor) {
        lines.push('', 'More MCP servers are available; rerun from a terminal for pagination.');
    }

    return lines.join('\n');
}

function runGit(args: string[]): string | null {
    try {
        return execFileSync('git', args, {
            cwd: process.cwd(),
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            maxBuffer: 1024 * 1024,
        }).trim();
    } catch {
        return null;
    }
}

function formatGitDiffSummary(): string {
    if (runGit(['rev-parse', '--is-inside-work-tree']) !== 'true') {
        return 'Not inside a Git worktree.';
    }

    const status = runGit(['status', '--short']) ?? '';
    const staged = runGit(['diff', '--cached', '--stat']) ?? '';
    const unstaged = runGit(['diff', '--stat']) ?? '';
    const lines = ['**Git Diff**', ''];

    if (!status && !staged && !unstaged) {
        return [...lines, 'Working tree is clean.'].join('\n');
    }

    if (status) {
        lines.push('Status:', '```text', status, '```');
    }
    if (staged) {
        lines.push('Staged:', '```text', staged, '```');
    }
    if (unstaged) {
        lines.push('Unstaged:', '```text', unstaged, '```');
    }

    return lines.join('\n');
}

/**
 * Main entry point for the codex command with ink UI
 */
export async function runCodex(opts: {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
    noSandbox?: boolean;
    resumeThreadId?: string;
    permissionMode?: PermissionMode;
    model?: string;
    effort?: ReasoningEffort;
}): Promise<void> {
    // Early check: ensure Codex CLI is installed before proceeding
    try {
        execSync('codex --version', { encoding: 'utf8', stdio: 'pipe', windowsHide: true });
    } catch {
        console.error('\n\x1b[1m\x1b[33mCodex CLI is not installed\x1b[0m\n');
        console.error('Please install Codex CLI using one of these methods:\n');
        console.error('\x1b[1mOption 1 - npm (recommended):\x1b[0m');
        console.error('  \x1b[36mnpm install -g @openai/codex\x1b[0m\n');
        console.error('\x1b[1mOption 2 - Homebrew (macOS):\x1b[0m');
        console.error('  \x1b[36mbrew install --cask codex\x1b[0m\n');
        console.error('Alternatively, use Claude Code:');
        console.error('  \x1b[36mhappy claude\x1b[0m\n');
        process.exit(1);
    }

    type EnhancedMode = CodexEnhancedMode;

    //
    // Define session
    //

    const sessionTag = randomUUID();

    // Set backend for offline warnings (before any API calls)
    connectionState.setBackend('Codex');

    const api = await ApiClient.create(opts.credentials);

    // Log startup options
    logger.debug(`[codex] Starting with options: startedBy=${opts.startedBy || 'terminal'}`);

    //
    // Machine
    //

    const settings = await readSettings();
    let machineId = settings?.machineId;
    const sandboxConfig = opts.noSandbox ? undefined : settings?.sandboxConfig;
    if (!machineId) {
        console.error(`[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on https://github.com/slopus/happy-cli/issues`);
        process.exit(1);
    }
    logger.debug(`Using machineId: ${machineId}`);
    await api.getOrCreateMachine({
        machineId,
        metadata: initialMachineMetadata
    });

    //
    // Create session
    //

    const initialPermissionMode = opts.permissionMode ?? DEFAULT_CODEX_PERMISSION_MODE;
    let discoveredSkills: string[] = [];
    try {
        discoveredSkills = listCodexSkillNames({ cwd: process.cwd() });
    } catch (error) {
        logger.debug('[codex] Failed to discover local skills', error);
    }
    // Lineage from the daemon's spawn RPC (set by app-side fork / duplicate).
    const forkedFromSessionId = process.env.HAPPY_FORKED_FROM_SESSION_ID;
    const forkedFromMessageId = process.env.HAPPY_FORKED_FROM_MESSAGE_ID;

    const { state, metadata: localMetadata } = createSessionMetadata({
        flavor: 'codex',
        machineId,
        startedBy: opts.startedBy,
        sandbox: sandboxConfig,
        dangerouslySkipPermissions: initialPermissionMode === 'yolo' || initialPermissionMode === 'bypassPermissions',
        skills: discoveredSkills,
        ...(forkedFromSessionId ? { parentSessionId: forkedFromSessionId } : {}),
        ...(forkedFromMessageId ? { forkedFromMessageId } : {}),
    });

    // Check for session reconnection env vars (set by daemon for resume-in-place)
    const reconnectSessionId = process.env.HAPPY_RECONNECT_SESSION_ID;
    const reconnectKeyBase64 = process.env.HAPPY_RECONNECT_ENCRYPTION_KEY;
    const reconnectVariant = process.env.HAPPY_RECONNECT_ENCRYPTION_VARIANT as 'legacy' | 'dataKey' | undefined;
    const reconnectSeq = process.env.HAPPY_RECONNECT_SEQ;
    const reconnectMetadataVersion = process.env.HAPPY_RECONNECT_METADATA_VERSION;
    const reconnectAgentStateVersion = process.env.HAPPY_RECONNECT_AGENT_STATE_VERSION;
    const reconnectServerMetadata = process.env.HAPPY_RECONNECT_METADATA_JSON;
    // Reconnect credentials and decrypted metadata belong only to this wrapper.
    // Do not leak them to app-server or commands spawned later in the session.
    for (const key of Object.keys(process.env)) {
        if (key.startsWith('HAPPY_RECONNECT_')) {
            delete process.env[key];
        }
    }
    const importedSessionTitle = process.env.HAPPY_IMPORTED_SESSION_TITLE?.trim();
    delete process.env.HAPPY_IMPORTED_SESSION_TITLE;
    const hydratedMetadata = mergeReconnectMetadata(localMetadata, reconnectServerMetadata);
    let codexPawsOriginToken = hydratedMetadata.codexPawsOriginToken ?? randomUUID();
    const metadata = {
        ...hydratedMetadata,
        codexPawsOriginToken,
        ...(!hydratedMetadata.summary?.text?.trim() && importedSessionTitle
            ? { summary: { text: importedSessionTitle, updatedAt: Date.now() } }
            : {}),
    };

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

    // Handle server unreachable case - create offline stub with hot reconnection
    let session: ApiSessionClient;
    // Permission handler declared here so it can be updated in onSessionSwap callback
    // (assigned later at line ~385 after client setup)
    let permissionHandler: CodexPermissionHandler;
    let client!: CodexAppServerClient;
    let reasoningProcessor!: ReasoningProcessor;
    let abortInProgress: Promise<void> | null = null;
    const messageQueue = new MessageQueue2<EnhancedMode>(hashCodexEnhancedMode);
    const syncQueuedMessageCount = (targetSession: ApiSessionClient): Promise<void> => (
        updateQueuedMessageCount(targetSession, messageQueue.size())
    );
    const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
        api,
        sessionTag,
        metadata,
        state,
        response,
        onSessionSwap: (newSession) => {
            session = newSession;
            void syncQueuedMessageCount(newSession);
            // Update permission handler with new session to avoid stale reference
            if (permissionHandler) {
                permissionHandler.updateSession(newSession);
            }
        }
    });
    session = initialSession;
    let codexCursorSync: Promise<void> = Promise.resolve();
    void syncQueuedMessageCount(session);

    // On reconnect, un-archive the session and skip replaying old messages.
    // Keep the metadata write awaitable: a version mismatch hydrates the
    // server's current metadata (including codexSyncCursor) before replay.
    let reconnectMetadataReady: Promise<void> = Promise.resolve();
    if (reconnectSessionId) {
        session.suppressNextArchiveSignal();
        session.skipExistingMessages();
        reconnectMetadataReady = session.updateMetadataAndAwait((meta) => ({
            ...meta,
            codexPawsOriginToken: meta.codexPawsOriginToken ?? codexPawsOriginToken,
            lifecycleState: 'running',
            archivedBy: undefined,
        })).then(() => {
            codexPawsOriginToken = session.getMetadata()?.codexPawsOriginToken ?? codexPawsOriginToken;
        });
    }

    // Always report to daemon if it exists (skip if offline)
    if (response) {
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
    }

    // Track current overrides to apply per message
    // Use shared PermissionMode type from api/types for cross-agent compatibility
    let baselineModel: string | undefined = opts.model;
    let baselineEffort: ReasoningEffort | undefined = opts.effort;
    let currentPermissionMode: PermissionMode | undefined = initialPermissionMode;
    let currentModel: string | undefined = baselineModel;
    let currentEffort: ReasoningEffort | undefined = baselineEffort;
    let currentFastMode = false;
    let currentAppendSystemPrompt: string | undefined = undefined;
    let codexModelCatalog: Model[] | null = null;

    const syncCodexSessionConfigMetadata = (model: string | undefined, effort: ReasoningEffort | undefined) => {
        if (!model) {
            return;
        }
        session.updateMetadata((currentMetadata) => mergeCodexSessionConfigIntoMetadata(currentMetadata, {
            models: codexModelCatalog,
            currentModel: model,
            currentEffort: effort ?? null,
        }));
    };

    // Valid Codex permission modes from remote messages. Matches the modes
    // the mobile UI exposes for Codex sessions (see modelModeOptions.ts:
    // getCodexPermissionModes) and mirrors the Gemini validation pattern at
    // runGemini.ts:222. Anything outside this set is silently ignored — the
    // previous code blindly cast `message.meta.permissionMode as PermissionMode`
    // at runtime, meaning a crafted value like `'totally_unsafe'` would be
    // accepted and then fall through to the `default` branch in
    // resolveCodexExecutionPolicy() — or worse, an attacker-chosen valid value
    // could escalate sandbox scope (issue #1092).
    const applyPermissionMode = (mode: PermissionMode, source: string) => {
        currentPermissionMode = mode;
        permissionHandler?.setPermissionMode(mode);
        session.updateMetadata((currentMetadata) => {
            if (currentMetadata.currentOperatingModeCode === mode) {
                return currentMetadata;
            }
            return {
                ...currentMetadata,
                currentOperatingModeCode: mode,
            };
        });
        logger.debug(`[Codex] Permission mode updated from ${source} to: ${mode}`);
    };

    const resetCurrentModeDefaults = () => {
        applyPermissionMode(initialPermissionMode, 'abort reset');
        currentModel = baselineModel;
        currentEffort = baselineEffort;
        currentAppendSystemPrompt = undefined;
        logger.debug('[Codex] Reset current mode defaults after abort');
    };

    const VALID_REMOTE_EFFORTS: readonly ReasoningEffort[] = [
        'none', 'minimal', 'low', 'medium', 'high', 'xhigh',
    ];

    // Handle file events — each download promise resolves to its own decoded
    // attachment (or null). drainAttachmentsForUserMessage on the next text
    // claims the in-flight set atomically; mirrors the Claude path so images
    // sent from the app travel with the next user message.
    session.onFileEvent((fileEvent) => {
        const ev = fileEvent.content.data.ev;
        logger.debug(`[Codex] File event received: ${ev.name} (${ev.size} bytes, ref: ${ev.ref})`);
        const downloadPromise = (async (): Promise<PendingAttachment | null> => {
            try {
                // Plaintext audio/video lane: stream to disk, hand off the path.
                if (isPlaintextMediaEvent(ev)) {
                    const kind = resolveMediaKind(ev);
                    const destPath = stagedMediaPath(ev, new Date().toISOString(), 0);
                    await session.streamAttachmentToDisk(ev.ref, destPath);
                    await secureAndRegisterStagedMediaPath(destPath);
                    logger.debug(`[Codex] Streamed ${kind} attachment to ${destPath} (${ev.size} bytes)`);
                    return { kind, localPath: destPath, size: ev.size, mimeType: ev.mimeType ?? 'application/octet-stream', name: ev.name };
                }
                const decrypted = await session.downloadAndDecryptAttachment(ev.ref);
                if (!decrypted) {
                    logger.debug(`[Codex] Failed to decrypt attachment: ${ev.name}`);
                    return null;
                }
                logger.debug(`[Codex] Attachment decrypted: ${ev.name} (${decrypted.length} bytes)`);
                // Encrypted media lane: write decrypted audio/video to disk and
                // hand the model the local path (see runClaude for rationale).
                if (isMediaFileEvent(ev)) {
                    const media = await buildMediaAttachmentFromBytes(ev, decrypted, new Date().toISOString(), 0);
                    logger.debug(`[Codex] Staged ${media.kind} attachment to ${media.localPath} (${media.size} bytes)`);
                    return media;
                }
                return { data: decrypted, mimeType: ev.mimeType ?? 'image/jpeg', name: ev.name };
            } catch (error) {
                logger.debug(`[Codex] Failed to download attachment: ${ev.name}`, { error });
                return null;
            }
        })();
        session.trackAttachmentDownload(downloadPromise);
    });

    const runUserMessageTask = createSerializedTaskRunner((error) => {
        logger.debug('[Codex] Failed to process remote user message:', error);
    });
    session.onUserMessage((message) => {
        // Claim every file attachment that arrived strictly before this text.
        // New file events from this point on belong to the next user message.
        const attachmentsForThisMessagePromise = session.drainAttachmentsForUserMessage();

        return runUserMessageTask(async () => {
            const attachmentsForThisMessage = await attachmentsForThisMessagePromise;

            // Resolve permission mode (validate against Codex-native modes)
            let messagePermissionMode = currentPermissionMode;
            if (message.meta?.permissionMode) {
                const incoming = message.meta.permissionMode as PermissionMode;
                if (isRemoteCodexPermissionMode(incoming)) {
                    messagePermissionMode = incoming;
                    applyPermissionMode(messagePermissionMode, 'user message');
                } else {
                    logger.debug(`[Codex] Ignoring invalid permission mode from user message: ${String(message.meta.permissionMode)}`);
                }
            } else {
                logger.debug(`[Codex] User message received with no permission mode override, using current: ${currentPermissionMode ?? 'default (effective)'}`);
            }

            // Resolve model; explicit null resets to default (undefined)
            let messageModel = currentModel;
            if (message.meta?.hasOwnProperty('model')) {
                messageModel = message.meta.model || undefined;
                currentModel = messageModel;
                logger.debug(`[Codex] Model updated from user message: ${messageModel || 'reset to default'}`);
            } else {
                logger.debug(`[Codex] User message received with no model override, using current: ${currentModel || 'default'}`);
            }

            // Resolve effort — passed straight to sendTurnAndWait. Validate the
            // incoming value against ReasoningEffort so a stale/garbage entry on
            // the wire doesn't poison the per-turn options.
            let messageEffort = currentEffort;
            if (message.meta?.hasOwnProperty('effort')) {
                const incoming = (message.meta as Record<string, unknown>).effort;
                if (incoming === null || incoming === undefined) {
                    messageEffort = undefined;
                    currentEffort = undefined;
                    logger.debug(`[Codex] Effort reset to default`);
                } else if (typeof incoming === 'string' && (VALID_REMOTE_EFFORTS as readonly string[]).includes(incoming)) {
                    messageEffort = incoming as ReasoningEffort;
                    currentEffort = messageEffort;
                    logger.debug(`[Codex] Effort updated from user message: ${messageEffort}`);
                } else {
                    logger.debug(`[Codex] Ignoring invalid effort from user message: ${String(incoming)}`);
                }
            } else {
                logger.debug(`[Codex] User message received with no effort override, using current: ${currentEffort ?? 'default'}`);
            }

            let messageAppendSystemPrompt = currentAppendSystemPrompt;
            if (message.meta?.hasOwnProperty('appendSystemPrompt')) {
                messageAppendSystemPrompt = message.meta.appendSystemPrompt || undefined;
                currentAppendSystemPrompt = messageAppendSystemPrompt;
                logger.debug(`[Codex] Append system prompt updated from user message: ${messageAppendSystemPrompt ? 'set' : 'reset to none'}`);
            } else {
                logger.debug(`[Codex] User message received with no append system prompt override, using current: ${currentAppendSystemPrompt ? 'set' : 'none'}`);
            }

            let messageFastMode = currentFastMode;
            if (message.meta?.hasOwnProperty('fast')) {
                messageFastMode = message.meta.fast === true;
                currentFastMode = messageFastMode;
                logger.debug(`[Codex] Fast mode updated from user message: ${messageFastMode ? 'on' : 'off'}`);
            }

            const enhancedMode: EnhancedMode = {
                permissionMode: messagePermissionMode || 'default',
                model: messageModel,
                appendSystemPrompt: messageAppendSystemPrompt,
                effort: messageEffort,
                fast: messageFastMode,
            };
            const enqueueResult = enqueueCodexUserText({
                text: message.content.text,
                mode: enhancedMode,
                attachments: attachmentsForThisMessage,
                queue: messageQueue,
            });
            void syncQueuedMessageCount(session);
            await cleanupMediaAttachments(enqueueResult.displacedAttachments.filter(isMediaAttachment));
            if (enqueueResult.status !== 'queued') {
                logger.debug(`[Codex] /${enqueueResult.status} command pushed to isolated queue`);
            }
        });
    });
    let thinking = false;
    let currentTurnId: string | null = null;
    let codexStartedSubagents = new Set<string>();
    let codexActiveSubagents = new Set<string>();
    let codexProviderSubagentToSessionSubagent = new Map<string, string>();
    let codexTextEnvelopeOccurrences = new Map<string, number>();
    session.keepAlive(thinking, 'remote');
    // Periodic keep-alive; store handle so we can clear on exit
    const keepAliveInterval = setInterval(() => {
        session.keepAlive(thinking, 'remote');
    }, 2000);

    const sendReady = () => {
        session.sendSessionEvent({ type: 'ready' });
        try {
            api.push().sendSessionNotification({
                kind: 'done',
                metadata: session.getMetadata(),
                data: {
                    sessionId: session.sessionId,
                    type: 'ready',
                    provider: 'codex',
                }
            });
        } catch (pushError) {
            logger.debug('[Codex] Failed to send ready push', pushError);
        }
    };

    // Debug helper: log active handles/requests if DEBUG is enabled
    function logActiveHandles(tag: string) {
        if (!process.env.DEBUG) return;
        const anyProc: any = process as any;
        const handles = typeof anyProc._getActiveHandles === 'function' ? anyProc._getActiveHandles() : [];
        const requests = typeof anyProc._getActiveRequests === 'function' ? anyProc._getActiveRequests() : [];
        logger.debug(`[codex][handles] ${tag}: handles=${handles.length} requests=${requests.length}`);
        try {
            const kinds = handles.map((h: any) => (h && h.constructor ? h.constructor.name : typeof h));
            logger.debug(`[codex][handles] kinds=${JSON.stringify(kinds)}`);
        } catch { }
    }

    //
    // Abort handling
    // IMPORTANT: There are two different operations:
    // 1. Abort (handleAbort): Stops the current inference/task but keeps the session alive
    //    - Used by the 'abort' RPC from mobile app
    //    - Similar to Claude Code's abort behavior
    //    - Allows continuing with new prompts after aborting
    // 2. Kill (handleKillSession): Terminates the entire process
    //    - Used by the 'killSession' RPC
    //    - Completely exits the CLI process
    //

    // AbortController is used ONLY to wake messageQueue.waitForMessages when idle.
    // Turn cancellation uses client.interruptTurn() — no AbortController hack needed.
    let abortController = new AbortController();
    let shouldExit = false;

    /**
     * Handles aborting the current task/inference without exiting the process.
     * This is the equivalent of Claude Code's abort - it stops what's currently
     * happening but keeps the session alive for new prompts.
     */
    async function handleAbort() {
        if (abortInProgress) {
            await abortInProgress;
            return;
        }

        logger.debug('[Codex] Abort requested - stopping current task');
        abortInProgress = (async () => {
            try {
                // Resolve any pending permission requests as 'abort' first.
                if (permissionHandler) {
                    permissionHandler.abortAll();
                }

                // Request interruption, then force-restart Codex app-server if
                // it doesn't settle quickly (long-running shell commands).
                if (client) {
                    const abortResult = await client.abortTurnWithFallback({
                        gracePeriodMs: 3000,
                        forceRestartOnTimeout: true,
                    });
                    if (abortResult.forcedRestart) {
                        logger.warn('[Codex] Forced app-server restart after interrupt timeout');
                        session.sendSessionEvent({
                            type: 'message',
                            message: abortResult.resumedThread
                                ? 'Force-stopped active task after interrupt timeout. Codex backend was restarted and the previous thread was resumed.'
                                : 'Force-stopped active task after interrupt timeout. Codex backend was restarted, but the previous thread could not be resumed.',
                        });
                    }
                }

                if (reasoningProcessor) {
                    reasoningProcessor.abort();
                }
                logger.debug('[Codex] Abort completed - session remains active');
            } catch (error) {
                logger.debug('[Codex] Error during abort:', error);
            } finally {
                resetCurrentModeDefaults();
                // Wake up message queue wait if idle
                abortController.abort();
                abortController = new AbortController();
            }
        })();

        await abortInProgress;
        abortInProgress = null;
    }

    /**
     * Handles session termination and process exit.
     * This is called when the session needs to be completely killed (not just aborted).
     * Abort stops the current inference but keeps the session alive.
     * Kill terminates the entire process.
     */
    const handleKillSession = async (archiveReason = 'User terminated') => {
        logger.debug('[Codex] Kill session requested - terminating process');
        await handleAbort();
        logger.debug('[Codex] Abort completed, proceeding with termination');

        try {
            // Update lifecycle state to archived before closing
            if (session) {
                await codexCursorSync;
                session.updateMetadata((currentMetadata) => ({
                    ...currentMetadata,
                    lifecycleState: 'archived',
                    lifecycleStateSince: Date.now(),
                    archivedBy: 'cli',
                    archiveReason
                }));
                
                // Send session death message
                session.sendSessionDeath();
                await session.flush();
                await session.close();
            }

            // Force close Codex transport (best-effort) so we don't leave stray processes
            try {
                await client.disconnect();
            } catch (e) {
                logger.debug('[Codex] Error disconnecting Codex during termination', e);
            }

            // Stop Happy MCP server
            happyServer.stop();
            await cleanupAllStagedMediaAttachments();

            logger.debug('[Codex] Session termination complete, exiting');
            process.exit(0);
        } catch (error) {
            logger.debug('[Codex] Error during session termination:', error);
            await cleanupAllStagedMediaAttachments();
            process.exit(1);
        }
    };

    // Register abort handler
    session.rpcHandlerManager.registerHandler('abort', handleAbort);

    registerSessionTitleWorker(session, 'codex');
    registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

    //
    // Initialize Ink UI
    //

    const messageBuffer = new MessageBuffer();
    const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
    let inkInstance: any = null;

    if (hasTTY) {
        console.clear();
        inkInstance = render(React.createElement(CodexDisplay, {
            messageBuffer,
            logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
            onExit: async () => {
                // Exit the agent
                logger.debug('[codex]: Exiting agent via Ctrl-C');
                shouldExit = true;
                await handleAbort();
            }
        }), {
            exitOnCtrlC: false,
            patchConsole: false
        });
    }

    if (hasTTY) {
        process.stdin.resume();
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        process.stdin.setEncoding("utf8");
    }

    //
    // Start Context 
    //

    client = new CodexAppServerClient(sandboxConfig, resolveCodexAppServerConnection());

    permissionHandler = new CodexPermissionHandler(session, (notification) => {
        api.push().sendSessionNotification(notification);
    });
    applyPermissionMode(currentPermissionMode ?? 'default', 'session init');
    // Drop any permission requests left in agent state from a previous CLI
    // process that died while a tool prompt was open — see the matching
    // call in claudeRemoteLauncher for the full rationale.
    permissionHandler.reset('Previous CLI process exited before responding');
    session.rpcHandlerManager.registerHandler<{ mode: string }, boolean>('setPermissionMode', async (request) => {
        const incoming = request?.mode;
        if (!isRemoteCodexPermissionMode(incoming)) {
            logger.debug(`[Codex] Ignoring invalid RPC permission mode: ${String(incoming)}`);
            return false;
        }
        applyPermissionMode(incoming as PermissionMode, 'session rpc');
        return true;
    });
    reasoningProcessor = new ReasoningProcessor((message) => {
        const envelopes = mapCodexProcessorMessageToSessionEnvelopes(message, {
            currentTurnId,
            textEnvelopeOccurrences: codexTextEnvelopeOccurrences,
        });
        for (const envelope of envelopes) {
            session.sendSessionProtocolMessage(envelope);
        }
    });
    const diffProcessor = new DiffProcessor((message) => {
        const envelopes = mapCodexProcessorMessageToSessionEnvelopes(message, {
            currentTurnId,
            textEnvelopeOccurrences: codexTextEnvelopeOccurrences,
        });
        for (const envelope of envelopes) {
            session.sendSessionProtocolMessage(envelope);
        }
    });

    // Approval handler: routes server → client approval requests to our permission handler
    client.setApprovalHandler(async (params) => {
        const toolName = params.type === 'exec'
            ? 'CodexBash'
            : params.type === 'patch'
                ? 'CodexPatch'
                : (params.toolName ?? 'McpTool');
        const input = params.type === 'exec'
            ? { command: params.command, cwd: params.cwd }
            : params.type === 'patch'
                ? { changes: params.fileChanges }
                : (params.input ?? {});

        try {
            const result = await permissionHandler.handleToolCall(params.callId, toolName, input);
            logger.debug('[Codex] Permission result:', result.decision);
            return result.decision;
        } catch (error) {
            logger.debug('[Codex] Error handling permission:', error);
            return 'denied';
        }
    });

    // A resumed app-server can emit continuation/completion notifications while
    // thread/read is still hydrating currentTurnId. Buffer that narrow window;
    // otherwise those events would be mapped without a Turn and lose stable IDs.
    let bufferCodexEvents = Boolean(opts.resumeThreadId);
    const bufferedCodexEvents: any[] = [];
    const handleCodexEvent = (msg: any) => {
        logger.debug(`[Codex] Event: ${JSON.stringify(msg)}`);

        // Add messages to the ink UI buffer based on message type
        if (msg.type === 'agent_message') {
            messageBuffer.addMessage((msg as any).message, 'assistant');
        } else if (msg.type === 'agent_reasoning_delta') {
            // Skip reasoning deltas in the UI to reduce noise
        } else if (msg.type === 'agent_reasoning') {
            messageBuffer.addMessage(`[Thinking] ${(msg as any).text.substring(0, 100)}...`, 'system');
        } else if (msg.type === 'exec_command_begin') {
            messageBuffer.addMessage(`Executing: ${(msg as any).command}`, 'tool');
        } else if (msg.type === 'exec_command_end') {
            const output = (msg as any).output || (msg as any).error || 'Command completed';
            const truncatedOutput = output.substring(0, 200);
            messageBuffer.addMessage(
                `Result: ${truncatedOutput}${output.length > 200 ? '...' : ''}`,
                'result'
            );
        } else if (msg.type === 'task_started') {
            messageBuffer.addMessage('Starting task...', 'status');
        } else if (msg.type === 'thread_settings_updated') {
            const threadSettings = (msg as any).thread_settings;
            if (threadSettings && typeof threadSettings.model === 'string') {
                baselineModel = threadSettings.model;
                currentModel = threadSettings.model;
                baselineEffort = threadSettings.effort ?? undefined;
                currentEffort = threadSettings.effort ?? undefined;
                syncCodexSessionConfigMetadata(currentModel, currentEffort);
            }
        } else if (msg.type === 'task_complete') {
            // Ready is emitted from the main loop's idle check so pushes only fire once
            // after the queue is actually drained.
            const failure = describeCodexFailure(msg);
            if (failure) {
                messageBuffer.addMessage(`Task failed: ${failure}`, 'status');
                session.sendSessionEvent({ type: 'message', message: `Codex error: ${failure}` });
            } else {
                messageBuffer.addMessage('Task completed', 'status');
            }
        } else if (msg.type === 'turn_aborted') {
            const failure = describeCodexFailure(msg);
            if (failure) {
                messageBuffer.addMessage(`Turn aborted: ${failure}`, 'status');
                session.sendSessionEvent({ type: 'message', message: `Codex error: ${failure}` });
            } else {
                messageBuffer.addMessage('Turn aborted', 'status');
            }
        }

        if (msg.type === 'task_started') {
            if (!thinking) {
                logger.debug('thinking started');
                thinking = true;
                session.keepAlive(thinking, 'remote');
            }
        }
        if (msg.type === 'task_complete' || msg.type === 'turn_aborted') {
            if (thinking) {
                logger.debug('thinking completed');
                thinking = false;
                session.keepAlive(thinking, 'remote');
            }
            // Reset diff processor on task end or abort
            diffProcessor.reset();
        }
        if (msg.type === 'agent_reasoning_section_break') {
            reasoningProcessor.handleSectionBreak();
        }
        if (msg.type === 'agent_reasoning_delta') {
            reasoningProcessor.processDelta((msg as any).delta);
        }
        if (msg.type === 'agent_reasoning') {
            reasoningProcessor.complete((msg as any).text);
        }
        if (msg.type === 'patch_apply_begin') {
            const { changes } = msg as any;
            const changeCount = Object.keys(changes).length;
            const filesMsg = changeCount === 1 ? '1 file' : `${changeCount} files`;
            messageBuffer.addMessage(`Modifying ${filesMsg}...`, 'tool');
        }
        if (msg.type === 'patch_apply_end') {
            const { stdout, stderr, success } = msg as any;
            if (success) {
                const message = stdout || 'Files modified successfully';
                messageBuffer.addMessage(message.substring(0, 200), 'result');
            } else {
                const errorMsg = stderr || 'Failed to modify files';
                messageBuffer.addMessage(`Error: ${errorMsg.substring(0, 200)}`, 'result');
            }
        }
        if (msg.type === 'turn_diff') {
            if ((msg as any).unified_diff) {
                diffProcessor.processDiff((msg as any).unified_diff);
            }
        }

        // Convert events into the unified session-protocol envelope stream.
        // Reasoning deltas are handled by ReasoningProcessor to avoid duplicate text output.
        if (msg.type !== 'agent_reasoning_delta' && msg.type !== 'agent_reasoning' && msg.type !== 'agent_reasoning_section_break' && msg.type !== 'turn_diff') {
            const mapped = mapCodexMcpMessageToSessionEnvelopes(msg, {
                currentTurnId,
                startedSubagents: codexStartedSubagents,
                activeSubagents: codexActiveSubagents,
                providerSubagentToSessionSubagent: codexProviderSubagentToSessionSubagent,
                textEnvelopeOccurrences: codexTextEnvelopeOccurrences,
            });
            currentTurnId = mapped.currentTurnId;
            codexStartedSubagents = mapped.startedSubagents;
            codexActiveSubagents = mapped.activeSubagents;
            codexProviderSubagentToSessionSubagent = mapped.providerSubagentToSessionSubagent;
            for (const envelope of mapped.envelopes) {
                session.sendSessionProtocolMessage(envelope);
            }
        }
        if (msg.type === 'task_complete') {
            const completedTurnId = (msg as any).turn_id;
            if (typeof completedTurnId === 'string' && client?.threadId) {
                const completedThreadId = client.threadId;
                const completedSession = session;
                codexCursorSync = codexCursorSync
                    .then(async () => {
                        // Advance only after the server acknowledges the Turn's
                        // stable envelope IDs. If the process dies first, the old
                        // cursor causes an idempotent replay on reconnect.
                        await completedSession.flushOutboxAndAwait();
                        await completedSession.updateMetadataAndAwait((currentMetadata) => ({
                            ...currentMetadata,
                            codexSyncCursor: {
                                threadId: completedThreadId,
                                turnId: completedTurnId,
                            },
                        }));
                    })
                    .catch((error) => {
                        logger.debug(`[Codex] Failed to persist sync cursor for turn ${completedTurnId}`, error);
                    });
            }
        }
    };
    client.setEventHandler((msg) => {
        if (bufferCodexEvents) {
            bufferedCodexEvents.push(msg);
            return;
        }
        handleCodexEvent(msg);
    });

    // Start Happy MCP server (HTTP) and prepare STDIO bridge config for Codex
    const happyServer = await startHappyServer(session, {
        archiveSession: async (reason?: string) => {
            setTimeout(() => {
                void handleKillSession(reason || 'Requested by user');
            }, 100);
            return { success: true };
        },
    });
    // Launch the bridge via `node <path>` (rather than relying on the .mjs shebang)
    // so it works on Windows, where Windows can't execute shebang scripts directly.
    // codex would otherwise fail to start the MCP server, the change_title tool would
    // not be visible to the model, and the model would improvise with shell echoes.
    const bridgeEntrypoint = join(projectPath(), 'bin', 'happy-mcp.mjs');
    const mcpServers = {
        happy: {
            command: process.execPath,
            args: ['--no-warnings', '--no-deprecation', bridgeEntrypoint, '--url', happyServer.url]
        }
    } as const;
    let first = true;
    let appendSystemPromptInjected = false;
    let browserStepPromptInjected = false;

    try {
        await reconnectMetadataReady;
        logger.debug('[codex]: client.connect begin');
        await client.connect();
        logger.debug('[codex]: client.connect done');

        try {
            const models: Model[] = [];
            let cursor: string | null = null;
            do {
                const page = await client.listModels({
                    cursor,
                    includeHidden: true,
                    limit: 100,
                });
                models.push(...page.data);
                cursor = page.nextCursor ?? null;
            } while (cursor);
            codexModelCatalog = models;
            logger.debug(`[Codex] Loaded ${models.length} models from app-server catalog`);
        } catch (error) {
            logger.debug('[Codex] Failed to load model catalog from app-server; using fallback metadata', error);
        }

        if (opts.resumeThreadId) {
            const resumedThread = await resumeExistingThread({
                client,
                session,
                messageBuffer,
                threadId: opts.resumeThreadId,
                cwd: process.cwd(),
                mcpServers,
                historyMode: reconnectSessionId ? 'after-cursor' : 'full',
            });
            if (resumedThread.activeTurnId) {
                currentTurnId = resumedThread.activeTurnId;
            }
            bufferCodexEvents = false;
            const pendingBufferedEvents = bufferedCodexEvents.splice(0);
            for (const pendingEvent of pendingBufferedEvents) {
                handleCodexEvent(pendingEvent);
            }
            if (!opts.model) {
                baselineModel = resumedThread.model;
                currentModel = resumedThread.model;
            }
            if (opts.effort === undefined) {
                baselineEffort = resumedThread.reasoningEffort ?? undefined;
                currentEffort = resumedThread.reasoningEffort ?? undefined;
            }
            syncCodexSessionConfigMetadata(
                opts.model ?? resumedThread.model,
                opts.effort ?? resumedThread.reasoningEffort ?? undefined,
            );
            first = false;
            appendSystemPromptInjected = true;
        }

        const forkCodexThreadId = process.env.HAPPY_FORK_CODEX_THREAD_ID;
        if (!reconnectSessionId && forkCodexThreadId && !opts.resumeThreadId) {
            try {
                const { thread } = await client.readThread({
                    threadId: forkCodexThreadId,
                    includeTurns: true,
                });
                const envelopes = mapCodexThreadToSessionEnvelopes(thread, {
                    omitPawsUserMessagesFromOriginToken: codexPawsOriginToken,
                    // Match the normal resume path so a durable retry rebuilds
                    // the exact same envelope set for an in-progress Turn.
                    activeTurnsUserOnly: true,
                });
                await session.updateMetadataAndAwait((currentMetadata) => ({
                    ...currentMetadata,
                    codexThreadId: forkCodexThreadId,
                    codexHistoryReplay: currentMetadata?.codexHistoryReplay?.threadId === forkCodexThreadId
                        ? currentMetadata.codexHistoryReplay
                        : { threadId: forkCodexThreadId, startedAt: Date.now() },
                }));
                await session.sendSessionProtocolHistoryAndAwait(envelopes);
                const lastReplayedTurn = (thread.turns ?? []).filter(isTerminalCodexTurn).at(-1);
                await session.updateMetadataAndAwait((currentMetadata) => {
                    const nextMetadata = {
                        ...currentMetadata,
                        codexThreadId: forkCodexThreadId,
                        ...(lastReplayedTurn ? {
                            codexSyncCursor: {
                                threadId: forkCodexThreadId,
                                turnId: lastReplayedTurn.id,
                            },
                        } : {}),
                    };
                    if (nextMetadata.codexHistoryReplay?.threadId === forkCodexThreadId) {
                        delete nextMetadata.codexHistoryReplay;
                    }
                    return nextMetadata;
                });
                logger.debug(`[CODEX FORK BACKFILL] Replayed ${envelopes.length} historical envelopes from thread ${forkCodexThreadId}`);
            } catch (error) {
                logger.debug(`[CODEX FORK BACKFILL] Failed to read thread ${forkCodexThreadId}:`, error);
                throw error;
            }
        }

        const resolveExecutionPolicyForMode = (mode: EnhancedMode) => {
            const sandboxManagedByHappy = client.sandboxEnabled;
            return resolveCodexExecutionPolicy(
                mode.permissionMode,
                sandboxManagedByHappy,
            );
        };

        const ensureCodexThread = async (mode: EnhancedMode) => {
            await client.setServiceTier(mode.fast ? 'fast' : 'standard');
            const executionPolicy = resolveExecutionPolicyForMode(mode);
            if (!client.hasActiveThread()) {
                const startedThread = await client.startThread({
                    model: mode.model,
                    cwd: process.cwd(),
                    approvalPolicy: executionPolicy.approvalPolicy,
                    sandbox: executionPolicy.sandbox,
                    mcpServers,
                });
                if (!mode.model) {
                    baselineModel = startedThread.model;
                    currentModel = startedThread.model;
                }
                if (mode.effort === undefined) {
                    baselineEffort = startedThread.reasoningEffort ?? baselineEffort;
                    currentEffort = startedThread.reasoningEffort ?? currentEffort;
                }
                session.updateMetadata((currentMetadata) => ({
                    ...currentMetadata,
                    codexThreadId: startedThread.threadId,
                }));
                syncCodexSessionConfigMetadata(
                    mode.model ?? startedThread.model,
                    mode.effort ?? startedThread.reasoningEffort ?? undefined,
                );
            }

            const threadId = client.threadId ?? session.getMetadata()?.codexThreadId;
            if (!threadId) {
                throw new Error('No Codex thread is available.');
            }

            return { threadId, executionPolicy };
        };

        const ensureExistingCodexThread = async (mode: EnhancedMode) => {
            await client.setServiceTier(mode.fast ? 'fast' : 'standard');
            const existingThreadId = client.threadId ?? session.getMetadata()?.codexThreadId;
            if (!existingThreadId) {
                return null;
            }

            const executionPolicy = resolveExecutionPolicyForMode(mode);
            if (!client.hasActiveThread()) {
                const resumedThread = await client.resumeThread({
                    threadId: existingThreadId,
                    model: mode.model,
                    cwd: process.cwd(),
                    approvalPolicy: executionPolicy.approvalPolicy,
                    sandbox: executionPolicy.sandbox,
                    mcpServers,
                });
                session.updateMetadata((currentMetadata) => ({
                    ...currentMetadata,
                    codexThreadId: resumedThread.threadId,
                }));
                syncCodexSessionConfigMetadata(
                    mode.model ?? resumedThread.model,
                    mode.effort ?? resumedThread.reasoningEffort ?? undefined,
                );
            }

            const threadId = client.threadId ?? existingThreadId;
            return { threadId, executionPolicy };
        };

        const respondToGoalCommand = async (goal: GoalCommand, mode: EnhancedMode): Promise<string> => {
            if (goal.action === 'edit') {
                return 'Goal editing through an external editor is not available from Happy. Send `/goal <new objective>` to replace the current goal.';
            }

            let threadId = client.threadId ?? session.getMetadata()?.codexThreadId;
            if (!threadId && goal.action === 'set') {
                threadId = (await ensureCodexThread(mode)).threadId;
            }

            if (!threadId) {
                return 'No goal is currently set. Send `/goal <objective>` to create one.';
            }

            if (goal.action === 'show') {
                const { goal: currentGoal } = await client.getThreadGoal({ threadId });
                return currentGoal
                    ? formatCodexGoal(currentGoal)
                    : 'No goal is currently set. Send `/goal <objective>` to create one.';
            }

            if (goal.action === 'clear') {
                const { cleared } = await client.clearThreadGoal({ threadId });
                return cleared ? 'Goal cleared.' : 'No goal was set.';
            }

            if (goal.action === 'pause') {
                const { goal: pausedGoal } = await client.setThreadGoal({ threadId, status: 'paused' });
                return ['Goal paused.', '', formatCodexGoal(pausedGoal)].join('\n');
            }

            if (goal.action === 'resume') {
                const { goal: activeGoal } = await client.setThreadGoal({ threadId, status: 'active' });
                return ['Goal resumed.', '', formatCodexGoal(activeGoal)].join('\n');
            }

            const { goal: updatedGoal } = await client.setThreadGoal({
                threadId,
                objective: goal.objective,
            });
            return ['Goal set.', '', formatCodexGoal(updatedGoal)].join('\n');
        };

        const formatCodexStatus = (mode: EnhancedMode): string => {
            const executionPolicy = resolveExecutionPolicyForMode(mode);
            const threadId = client.threadId ?? session.getMetadata()?.codexThreadId ?? 'none';
            return [
                '**Codex Status**',
                '',
                `Thread: ${threadId}`,
                `Model: ${currentModel ?? baselineModel ?? 'default'}`,
                `Effort: ${currentEffort ?? baselineEffort ?? 'default'}`,
                `Permission mode: ${mode.permissionMode}`,
                `Approval policy: ${executionPolicy.approvalPolicy ?? 'default'}`,
                `Sandbox: ${executionPolicy.sandbox ?? 'default'}`,
                `Cwd: ${process.cwd()}`,
                'App server: connected',
            ].join('\n');
        };

        const respondToUsageCommand = async (range: UsageCommand['range']): Promise<string> => {
            const usage = await client.readAccountUsage();
            return formatCodexUsage(usage, range);
        };

        const respondToMcpCommand = async (verbose: boolean, mode: EnhancedMode): Promise<string> => {
            const existing = await ensureExistingCodexThread(mode);
            const status = await client.listMcpServerStatus({
                threadId: existing?.threadId ?? null,
                detail: verbose ? 'full' : 'toolsAndAuthOnly',
                limit: 50,
            });
            return formatMcpStatus(status, verbose);
        };

        const resetCodexThreadState = (opts?: { resetFirst?: boolean }) => {
            client.clearThreadState();
            currentTurnId = null;
            codexStartedSubagents = new Set<string>();
            codexActiveSubagents = new Set<string>();
            codexProviderSubagentToSessionSubagent = new Map<string, string>();
            codexTextEnvelopeOccurrences = new Map<string, number>();
            permissionHandler.reset();
            reasoningProcessor.abort();
            diffProcessor.reset();
            appendSystemPromptInjected = false;
            browserStepPromptInjected = false;
            if (opts?.resetFirst) {
                first = true;
            }
            thinking = false;
            session.keepAlive(thinking, 'remote');
            session.updateMetadata((currentMetadata) => {
                const nextMetadata = { ...currentMetadata };
                delete nextMetadata.codexThreadId;
                return nextMetadata;
            });
        };

        const respondToForkCommand = async (mode: EnhancedMode): Promise<string> => {
            const existing = await ensureExistingCodexThread(mode);
            if (!existing) {
                return 'No active Codex thread is available to fork. Send a normal message first.';
            }

            const sourceThreadId = existing.threadId;
            const forkedThread = await client.forkThread({
                threadId: sourceThreadId,
                model: mode.model,
                cwd: process.cwd(),
                approvalPolicy: existing.executionPolicy.approvalPolicy,
                sandbox: existing.executionPolicy.sandbox,
                mcpServers,
            });
            session.updateMetadata((currentMetadata) => ({
                ...currentMetadata,
                codexThreadId: forkedThread.threadId,
            }));
            if (!mode.model) {
                baselineModel = forkedThread.model;
                currentModel = forkedThread.model;
            }
            syncCodexSessionConfigMetadata(mode.model ?? forkedThread.model, mode.effort ?? currentEffort);
            return [
                'Forked Codex thread.',
                '',
                `From: ${sourceThreadId}`,
                `To: ${forkedThread.threadId}`,
            ].join('\n');
        };

        let pending: { message: string; mode: EnhancedMode; isolate: boolean; hash: string; attachments?: PendingAttachment[] } | null = null;

        const sendImmediateCommandResponse = (responseText: string) => {
            messageBuffer.addMessage(responseText, 'assistant');
            session.sendAgentMessage('codex', {
                type: 'message',
                message: responseText,
            });
            emitReadyIfIdle({
                pending,
                queueSize: () => messageQueue.size(),
                shouldExit,
                sendReady,
            });
        };

        const sendStatusMessage = (statusMessage: string) => {
            messageBuffer.addMessage(statusMessage, 'status');
            session.sendSessionEvent({ type: 'message', message: statusMessage });
        };

        const finalizeCodexTurn = () => {
            permissionHandler.reset();
            reasoningProcessor.abort();
            diffProcessor.reset();
            thinking = false;
            session.keepAlive(thinking, 'remote');
            emitReadyIfIdle({
                pending,
                queueSize: () => messageQueue.size(),
                shouldExit,
                sendReady,
            });
            logActiveHandles('after-turn');
        };

        const runCodexPromptTurn = async (opts: {
            prompt: string;
            mode: EnhancedMode;
            attachments?: PendingAttachment[];
        }) => {
            try {
                const { executionPolicy } = await ensureCodexThread(opts.mode);

                const includeAppendSystemPrompt = Boolean(
                    opts.mode.appendSystemPrompt && !appendSystemPromptInjected,
                );
                const turnPrompt = buildCodexTurnPrompt({
                    message: opts.prompt,
                    mode: opts.mode,
                    includeAppendSystemPrompt,
                    includeBrowserStepInstruction: !browserStepPromptInjected,
                    includeTitleInstruction: first,
                });

                const turnPayload = buildCodexTurnPayload(
                    markPawsTurnOrigin(turnPrompt, codexPawsOriginToken),
                    opts.attachments,
                );
                if (turnPayload.images.length > 0) {
                    logger.debug(`[Codex] Attaching ${turnPayload.images.length} image(s) to turn`);
                }

                const result = await client.sendTurnAndWait(turnPayload.prompt, {
                    model: opts.mode.model,
                    approvalPolicy: executionPolicy.approvalPolicy,
                    sandbox: executionPolicy.sandbox,
                    effort: opts.mode.effort,
                    images: turnPayload.images,
                });
                first = false;
                browserStepPromptInjected = true;
                if (includeAppendSystemPrompt) {
                    appendSystemPromptInjected = true;
                }

                if (result.aborted) {
                    logger.debug('[Codex] Turn aborted');
                }
            } finally {
                await cleanupMediaAttachments((opts.attachments ?? []).filter(isMediaAttachment));
            }
        };

        const runServerStartedTurn = async (
            statusMessage: string,
            start: () => Promise<{ aborted: boolean }>,
        ) => {
            sendStatusMessage(statusMessage);
            try {
                const result = await start();
                if (result.aborted) {
                    logger.debug('[Codex] Server-started turn aborted');
                }
            } catch (error) {
                logger.warn('Error in codex session:', error);
                sendStatusMessage('Process exited unexpectedly');
            } finally {
                finalizeCodexTurn();
            }
        };

        while (!shouldExit) {
            logActiveHandles('loop-top');
            let message: { message: string; mode: EnhancedMode; isolate: boolean; hash: string; attachments?: PendingAttachment[] } | null = pending;
            pending = null;
            if (!message) {
                // Capture the current signal to distinguish idle-abort from queue close
                const waitSignal = abortController.signal;
                const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
                if (!batch) {
                    // If wait was aborted (e.g., remote abort with no active inference), ignore and continue
                    if (waitSignal.aborted && !shouldExit) {
                        logger.debug('[codex]: Wait aborted while idle; ignoring and continuing');
                        continue;
                    }
                    logger.debug(`[codex]: batch=${!!batch}, shouldExit=${shouldExit}`);
                    break;
                }
                message = batch;
                void syncQueuedMessageCount(session);
            }

            // Defensive check for TS narrowing
            if (!message) {
                break;
            }

            const specialCommand = parseSpecialCommand(message.message);
            if (specialCommand.type && specialCommand.type !== 'plan') {
                await cleanupMediaAttachments((message.attachments ?? []).filter(isMediaAttachment));
            }

            if (specialCommand.type === 'skills') {
                const skills = session.getMetadata()?.skills ?? [];
                const responseText = skills.length > 0
                    ? '**Available Skills**\n\n' + skills.map((skill) => `- /${skill}`).join('\n')
                    : 'No skills available. Try again after the session finishes initializing.';

                sendImmediateCommandResponse(responseText);
                continue;
            }

            if (specialCommand.type === 'usage' && specialCommand.usage) {
                let responseText: string;
                try {
                    responseText = await respondToUsageCommand(specialCommand.usage.range);
                } catch (error) {
                    logger.debug('[Codex] Failed to handle /usage command', error);
                    responseText = `Failed to read usage: ${goalErrorMessage(error)}`;
                }

                sendImmediateCommandResponse(responseText);
                continue;
            }

            if (specialCommand.type === 'mcp' && specialCommand.mcp) {
                let responseText: string;
                try {
                    responseText = await respondToMcpCommand(specialCommand.mcp.verbose, message.mode);
                } catch (error) {
                    logger.debug('[Codex] Failed to handle /mcp command', error);
                    responseText = `Failed to read MCP server status: ${goalErrorMessage(error)}`;
                }

                sendImmediateCommandResponse(responseText);
                continue;
            }

            if (specialCommand.type === 'status') {
                sendImmediateCommandResponse(formatCodexStatus(message.mode));
                continue;
            }

            if (specialCommand.type === 'diff') {
                sendImmediateCommandResponse(formatGitDiffSummary());
                continue;
            }

            if (specialCommand.type === 'fork') {
                let responseText: string;
                try {
                    responseText = await respondToForkCommand(message.mode);
                } catch (error) {
                    logger.debug('[Codex] Failed to handle /fork command', error);
                    responseText = `Failed to fork Codex thread: ${goalErrorMessage(error)}`;
                }

                sendImmediateCommandResponse(responseText);
                continue;
            }

            if (specialCommand.type === 'goal' && specialCommand.goal) {
                let responseText: string;
                try {
                    responseText = await respondToGoalCommand(specialCommand.goal, message.mode);
                } catch (error) {
                    logger.debug('[Codex] Failed to handle /goal command', error);
                    responseText = `Failed to update goal: ${goalErrorMessage(error)}`;
                }

                sendImmediateCommandResponse(responseText);
                continue;
            }

            if (specialCommand.type === 'new') {
                logger.debug('[Codex] Handling /new command - starting a fresh Codex thread on next prompt');
                resetCodexThreadState({ resetFirst: true });
                sendImmediateCommandResponse('Started a fresh Codex thread. Send your next message to begin.');
                continue;
            }

            if (specialCommand.type === 'clear') {
                logger.debug('[Codex] Handling /clear command - resetting Codex thread state');
                resetCodexThreadState();
                sendStatusMessage('Context was reset');
                emitReadyIfIdle({
                    pending,
                    queueSize: () => messageQueue.size(),
                    shouldExit,
                    sendReady,
                });
                continue;
            }

            if (specialCommand.type === 'compact') {
                try {
                    const existing = await ensureExistingCodexThread(message.mode);
                    if (!existing) {
                        sendImmediateCommandResponse('No active Codex thread is available to compact.');
                        continue;
                    }

                    await runServerStartedTurn('Compacting Codex context...', () => client.startCompactAndWait({
                        threadId: existing.threadId,
                    }));
                } catch (error) {
                    logger.debug('[Codex] Failed to handle /compact command', error);
                    sendImmediateCommandResponse(`Failed to compact Codex context: ${goalErrorMessage(error)}`);
                }
                continue;
            }

            if (specialCommand.type === 'review' && specialCommand.review) {
                try {
                    const { threadId } = await ensureCodexThread(message.mode);
                    const target = specialCommand.review.instructions
                        ? { type: 'custom' as const, instructions: specialCommand.review.instructions }
                        : { type: 'uncommittedChanges' as const };

                    await runServerStartedTurn('Reviewing current changes...', () => client.startReviewAndWait({
                        threadId,
                        target,
                        delivery: 'inline',
                    }));
                } catch (error) {
                    logger.debug('[Codex] Failed to handle /review command', error);
                    sendImmediateCommandResponse(`Failed to start Codex review: ${goalErrorMessage(error)}`);
                }
                continue;
            }

            if (specialCommand.type === 'plan' && specialCommand.plan) {
                messageBuffer.addMessage(message.message, 'user');
                const prompt = specialCommand.plan.prompt
                    ?? 'Propose a concise implementation plan for the current task. Do not modify files, run write operations, publish, deploy, or make commits.';
                const planMode: EnhancedMode = {
                    ...message.mode,
                    permissionMode: 'plan',
                };

                try {
                    await runCodexPromptTurn({
                        prompt,
                        mode: planMode,
                        attachments: message.attachments,
                    });
                } catch (error) {
                    logger.warn('Error in codex session:', error);
                    sendStatusMessage('Process exited unexpectedly');
                } finally {
                    finalizeCodexTurn();
                }
                continue;
            }

            // Display user messages in the UI
            messageBuffer.addMessage(message.message, 'user');

            try {
                await runCodexPromptTurn({
                    prompt: message.message,
                    mode: message.mode,
                    attachments: message.attachments,
                });
            } catch (error) {
                // Only actual errors reach here (process crash, connection failure, etc.)
                logger.warn('Error in codex session:', error);
                sendStatusMessage('Process exited unexpectedly');
            } finally {
                // Reset permission handler, reasoning processor, and diff processor
                finalizeCodexTurn();
            }
        }

    } finally {
        // Clean up resources when main loop exits
        logger.debug('[codex]: Final cleanup start');
        messageQueue.close();
        let queueClearTimeout: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                updateQueuedMessageCount(session, 0),
                new Promise<void>((resolve) => {
                    queueClearTimeout = setTimeout(() => {
                        logger.debug('[Codex] Timed out waiting for queued message state to clear during shutdown');
                        resolve();
                    }, 2_000);
                }),
            ]);
        } finally {
            if (queueClearTimeout) clearTimeout(queueClearTimeout);
        }
        await cleanupAllStagedMediaAttachments();
        logActiveHandles('cleanup-start');

        // Cancel offline reconnection if still running
        if (reconnectionHandle) {
            logger.debug('[codex]: Cancelling offline reconnection');
            reconnectionHandle.cancel();
        }

        try {
            logger.debug('[codex]: sendSessionDeath');
            await codexCursorSync;
            session.sendSessionDeath();
            logger.debug('[codex]: flush begin');
            await session.flush();
            logger.debug('[codex]: flush done');
            logger.debug('[codex]: session.close begin');
            await session.close();
            logger.debug('[codex]: session.close done');
        } catch (e) {
            logger.debug('[codex]: Error while closing session', e);
        }
        logger.debug('[codex]: client.disconnect begin');
        await client.disconnect();
        logger.debug('[codex]: client.disconnect done');
        // Stop Happy MCP server
        logger.debug('[codex]: happyServer.stop');
        happyServer.stop();

        // Clean up ink UI
        if (process.stdin.isTTY) {
            logger.debug('[codex]: setRawMode(false)');
            try { process.stdin.setRawMode(false); } catch { }
        }
        // Stop reading from stdin so the process can exit
        if (hasTTY) {
            logger.debug('[codex]: stdin.pause()');
            try { process.stdin.pause(); } catch { }
        }
        // Clear periodic keep-alive to avoid keeping event loop alive
        logger.debug('[codex]: clearInterval(keepAlive)');
        clearInterval(keepAliveInterval);
        if (inkInstance) {
            logger.debug('[codex]: inkInstance.unmount()');
            inkInstance.unmount();
        }
        messageBuffer.clear();

        logActiveHandles('cleanup-end');
        logger.debug('[codex]: Final cleanup completed');
    }
}
