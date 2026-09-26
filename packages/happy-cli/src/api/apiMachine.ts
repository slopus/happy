import type { RpcRequest, RpcResponseCallback } from './rpc/types';
import { createWorktreeReclaimHandler } from '@/daemon/worktreeDependencyReclaimRpc';
/**
 * WebSocket client for machine/daemon communication with Happy server
 * Similar to ApiSessionClient but for machine-scoped connections
 */

import { io, Socket } from 'socket.io-client';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { MachineMetadata, DaemonState, Machine, Update, UpdateMachineBody } from './types';
import type { DaemonSessionStateResponse } from '@/daemon/daemonSessionState';
import {
    registerCommonHandlers,
    type RecoverSessionOptions,
    type RecoverSessionResult,
    type ResumeSessionResult,
    type SpawnSessionOptions,
    type SpawnSessionResult,
} from '../modules/common/registerCommonHandlers';
import { resolveDaemonAllowedRoot } from '../modules/common/resolveAllowedRoot';
import { REMOTE_TERMINAL_DISABLED_ERROR, resolveMachineLockdownPolicy } from '../daemon/machineLockdownPolicy';
import { homedir } from 'node:os';
import { encodeBase64, decodeBase64, encrypt, decrypt } from './encryption';
import { createTerminalOutputCoalescer } from '@/daemon/terminalOutputCoalescer';
import {
    MACHINE_RESOURCE_METRICS_RPC,
    createMachineResourceService,
} from '@/daemon/machineResourceService';
import { AI_AUTH_SELECTION_CAPABILITY, parseAiAuthSelection } from '@/daemon/sessionEnv';
import { backoff } from '@/utils/time';
import { applyManagedRpcRestrictions, registerManagedRpcHandlers, type ManagedRpcHandlers } from '@/daemon/managedRpcHandlers';
import type { ByosOfflineRpcHandlers } from '@/daemon/byosOfflineReceive';
import type { DifficultyRoutingClassifierHost } from '@/daemon/difficultyRoutingClassifierHost';
import { RpcHandlerManager } from './rpc/RpcHandlerManager';
import { createRpcRequestListener } from './rpc/rpcRequestListener';
import { detectCLIAvailability, CLIAvailability } from '@/utils/detectCLI';
import { detectResumeSupport, type ResumeSupport } from '@/resume/localHappyAgentAuth';
import type { PortRegistry } from '@/daemon/portRegistry';
import type { AutomationStore } from '@/daemon/automations/automationStore';
import { createAutomationRpcHandlers } from '@/daemon/automations/automationRpcHandlers';
import {
    resolveStopSessionMode,
    type StopSessionContext,
    type StopSessionResult,
} from '@/daemon/sessionIdleReaper';
import {
    SESSION_EXIT_VERIFICATION_SCOPE,
    type SessionExitVerification,
} from '@/daemon/sessionExitVerification';
import { proxyHttp, PreviewProxyError } from '@/daemon/previewProxy';
/**
 * Bound preview requests travel on their own Socket.IO event. Kept as a
 * constant so the daemon and happy-server cannot drift apart silently — a
 * mismatch here reads, on the server side, as "this daemon predates runtime
 * binding", which is exactly what it would be.
 */
export const PREVIEW_BOUND_PROXY_EVENT = 'preview-proxy-http-bound';
/** Upgrade counterpart of PREVIEW_BOUND_PROXY_EVENT — see openPreviewWsTunnelBound. */
export const PREVIEW_BOUND_WS_OPEN_EVENT = 'preview-proxy-ws-open-bound';
/**
 * specs/runtime-isolation-hardening (H3, P3) — browser-viewer relays travel on
 * their own events again, for the reason the project ones do and one more.
 *
 * The shared reason: a daemon that predates viewer binding has no listener
 * here, so a viewer request reaches no upstream at all. Checking the answer
 * instead would be too late — the bytes would already be on the port.
 *
 * The added reason: the viewer variant is *disjoint* from the project one.
 * Sharing an event and switching on `purpose` would put one handler in charge
 * of deciding which rules apply to a payload it was handed, which is exactly
 * the shape that lets a mixed claim be read as whichever variant is weaker.
 */
export const PREVIEW_VIEWER_BOUND_PROXY_EVENT = 'preview-proxy-http-viewer-bound';
/** Upgrade counterpart of PREVIEW_VIEWER_BOUND_PROXY_EVENT. */
export const PREVIEW_VIEWER_BOUND_WS_OPEN_EVENT = 'preview-proxy-ws-viewer-bound';
/** Mint-time viewer lease, counterpart of `preview-runtime-lease`. */
export const PREVIEW_VIEWER_RUNTIME_LEASE_EVENT = 'preview-viewer-runtime-lease';
import {
    acquireRuntimeLease,
    enforceRelayBinding,
    createRuntimeLeaseCanonicalizer,
    MINT_LEASE_ANSWER_DEADLINE_MS,
    type RuntimeLeaseDeps,
} from '@/daemon/previewRuntimeLease';
import {
    createBoundedProbe,
    createEvidenceIo,
    probeListenerEvidence,
    DEFAULT_PROBE_LIMITS,
    type ProbeFn,
} from '@/daemon/previewRuntimeEvidence';
import {
    acquireViewerLease,
    enforceViewerRelayBinding,
    type ViewerLeaseDeps,
} from '@/daemon/previewViewerLease';
import {
    resolveBrokerViewerEvidence,
    resolveNativeViewerEvidence,
    type ViewerEvidenceRequest,
    type ViewerEvidenceResult,
} from '@/daemon/previewViewerEvidence';
import { probeNativeViewerListenerEvidence } from '@/daemon/previewNativeViewerListener';
import {
    createBoundedViewerProof,
    type ViewerProofFn,
} from '@/daemon/previewViewerEvidenceGate';
import { PreviewWsProxy } from '@/daemon/previewWsProxy';
import { startServerProcess, StartServerError } from '@/daemon/startServer';
import packageJson from '../../package.json';
import { AUTOMATION_PROTOCOL_VERSION } from '@slopus/happy-wire';
import { stopServerProcess, StopServerError } from '@/daemon/stopServer';
import { createPtySession } from '@/daemon/remoteTerminal';
import { decideTerminalCwd, formatCwdFallbackBanner } from '@/daemon/decideTerminalCwd';
import { validatePath } from '@/modules/common/pathSecurity';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { exec } from 'node:child_process';
import { readDaemonState } from '@/persistence';
import { fetchBrowserStatus } from '@/daemon/browserClient';
import { runPairing, formatPairOutcome } from '@/commands/browserPair';
import {
    canSudoWithoutPassword,
    detectChrome,
    isCdpReachable,
    launchChrome,
    planChromeInstall,
    resolveChromeDisplay,
    resolveProfileUserDataDir,
} from '@/daemon/browserSetup';
import {
    buildOpenboxArgs,
    buildOpenboxConfig,
    buildVncConfigArgs,
    buildWebsockifyArgs,
    buildX11vncArgs,
    buildXvfbArgs,
    buildXvncArgs,
    VIEWER_SCREEN,
    VIEWER_SLOTS,
    VIEWER_VNC_PORTS,
    VIEWER_WEB_PORTS,
    decideViewerBrowserAction,
    decideViewerStackAction,
    readDisplayFromEnviron,
    readFlagFromCmdline,
    summariseViewerBrowser,
    type ViewerBrowserSummary,
    detectViewerCapabilities,
    desiredViewerTools,
    missingViewerTools,
    selectViewerBackend,
    type ViewerBackend,
    VIEWER_PROCESS_KINDS,
    viewerEnvironClaimsSlot,
    viewerOwnerEnv,
    describeDetachedExit,
    readProcessGroupId,
    isPortFree,
    isViewerServing,
    waitForViewerServing,
    type DetachedProcess,
    planViewerInstall,
    resolveViewerProfileDir,
    selectViewerSlot,
    type ViewerSlot,
    spawnDetached,
    validateViewerKey,
    viewerProcessMatchesLease,
} from '@/daemon/remoteViewer';
import {
    BrowserViewerLeaseRegistry,
    type BrowserViewerLeaseRecord,
} from '@/daemon/browserViewerLeaseRegistry';
import { ensureViewerWebRoot } from '@/daemon/viewerWebRoot';
import { BrowserSessionBrokerClient } from '@/daemon/browserSessionBrokerContract';
import { readOrCreateBrowserBridgeToken } from '@/daemon/browserBridgeToken';
import { deriveBrowserViewerBridgeToken } from '@/daemon/browserBridge';
import { readFile, readdir } from 'node:fs/promises';
import { DEFERRED_CONTINUATION_CONTEXT_MAX_BYTES } from '@/utils/deferredContinuationContext';
import { ensureElectronGuiDisplay } from '@/daemon/electronGuiDisplay';
import { projectPath } from '@/projectPath';
import {
    addDaemonTerminalSession,
    getDaemonTerminalSession,
    killAllDaemonTerminalSessions,
    recordBytesIn,
    recordBytesOut,
    recordTerminalActivity,
    removeDaemonTerminalSession,
} from '@/daemon/daemonTerminalSessions';
import type { ChildProcess } from 'node:child_process';
import type { BrowserCdpPipe } from '@/daemon/browserCdpPipe';
import { shouldReconnect } from '@/utils/lidState';
import { RECONNECT_DIAL_TIMEOUT_MS, RECONNECT_NOT_READY_POLL_MS, reconnectDelayMs } from '@/api/reconnectCadence';
import { getProjectPath } from '@/claude/utils/path';
import {
    forkSession as claudeForkSession,
    forkAndTruncateSession as claudeForkAndTruncateSession,
    listClaudeRewindPoints,
    ForkTruncateUuidNotFoundError,
    ForkSourceMissingError,
} from '@/claude/utils/claudeSessionFork';
import { createClaudeSessionTransferHandler } from '@/claude/utils/claudeSessionTransfer';
import { readClaudeCodeUsage } from '@/claudeCodeUsage/readUsage';
import { CodexAppServerClient } from '@/codex/codexAppServerClient';
import { createCodexThreadTransferHandler } from '@/codex/codexThreadTransfer';
import { ADDITIONAL_DIRECTORIES_CAPABILITY, parseAdditionalDirectories } from '@/daemon/additionalDirectories';
import { CHANNEL_SUPPORT_CAPABILITY } from '@/channel/channelSupportCapability';
import {
    CodexForkRewindPointNotFoundError,
    forkCodexThread,
    listCodexRewindPoints,
} from '@/codex/codexThreadFork';
import type { MachineAutomationKey } from '@/daemon/automations/machineAutomationKey';
import { LESSON_HOST_RPC_METHOD } from '@/memory/lessonHostRuntime';
import type { LessonHostSupervisor } from '@/memory/lessonHostSupervisor';
import type { ServerAutomationCache } from '@/daemon/automations/serverAutomationCache';
import { syncServerAutomationDeltas } from '@/daemon/automations/serverAutomationSync';
import type { ServerAutomationTransport } from '@/daemon/automations/serverAutomationExecutor';
import type { PendingAutomationReport } from '@/daemon/automations/serverAutomationRuntimeStore';
import type { SessionFollowupTransport } from '@/daemon/automations/sessionFollowupRunner';
import type { AiCredentialRuntime } from '@/daemon/aiCredentialRuntime';
import type { AutonomousQualityGateRpcHandlers } from '@/daemon/autonomousQualityGateRpc';
import type { CheckpointRpcHandlers } from '@/checkpoint/checkpointRpc';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BROKER_ACTIVITY_TOUCH_INTERVAL_MS = 60_000;
/*
 * How often the connection supervisor re-reads the socket's actual state.
 *
 * Long enough that a normal reconnect (a 1s kick, then every 3s) settles
 * between two ticks and the supervisor never sees a transient gap worth
 * reporting; short enough that a socket nobody is retrying is picked up in
 * well under a minute rather than in hours.
 */
const CONNECTION_SUPERVISOR_INTERVAL_MS = 30_000;

/** What the daemon can answer about its own link to the server. */
export interface MachineConnectionHealth {
    /** A live socket exists right now. */
    connected: boolean;
    /** A retry cadence is in flight. Meaningless while `connected`. */
    reconnecting: boolean;
    /** Milliseconds since the socket was last up, or null while connected. */
    disconnectedForMs: number | null;
}

interface ServerToDaemonEvents {
    update: (data: Update) => void;
    // `callback` is optional because socket.io does not guarantee an ack on
    // every delivered packet — see createRpcRequestListener.
    'rpc-request': (data: RpcRequest, callback?: RpcResponseCallback) => void;
    'proxy-http-request': (
        params: {
            port: number;
            method: string;
            path: string;
            headers: Record<string, string>;
            bodyB64: string | null;
            // specs/runtime-isolation-hardening (H3) — the runtime the relayed
            // token was minted for. Absent from an older happy-server.
            binding?: { projectId: string; leaseId: string; workspacePaths?: string[] } | null;
        },
        ack: (response: unknown) => void,
    ) => void;
    // Mint-time counterpart: the server asks which runtime currently owns the
    // port before it signs a bound token. An older daemon has no handler for
    // this event, which is exactly how the server detects it.
    'preview-runtime-lease': (
        params: { projectId: string; port: number; workspacePaths?: string[] },
        ack: (response: unknown) => void,
    ) => void;
    // Preview WebSocket relay (raw byte tunnel). Counterpart to
    // proxy-http-request for upgrades (noVNC/websockify, ws, HMR). See
    // daemon/previewWsProxy.ts.
    [PREVIEW_BOUND_PROXY_EVENT]: (
        params: {
            port: number;
            method: string;
            path: string;
            headers: Record<string, string>;
            bodyB64: string | null;
            binding: { projectId: string; leaseId: string; workspacePaths?: string[] };
        },
        ack: (response: unknown) => void,
    ) => void;
    'proxy-ws-open': (
        params: { tunnelId: string; port: number; dataB64: string },
        ack: (response: unknown) => void,
    ) => void;
    // Bound upgrades only. An older daemon has no listener for this event, so
    // it never writes the upgrade request to the port — the approval buffer
    // on the server alone would already be too late.
    [PREVIEW_BOUND_WS_OPEN_EVENT]: (
        params: {
            tunnelId: string;
            port: number;
            dataB64: string;
            binding: { projectId: string; leaseId: string; workspacePaths?: string[] };
        },
        ack: (response: unknown) => void,
    ) => void;
    // specs/runtime-isolation-hardening (H3, P3) — viewer-bound relays. The
    // binding shape is disjoint from the project one: no projectId, no
    // workspacePaths, and `purpose` is mandatory.
    [PREVIEW_VIEWER_BOUND_PROXY_EVENT]: (
        params: {
            port: number;
            method: string;
            path: string;
            headers: Record<string, string>;
            bodyB64: string | null;
            binding: { purpose: 'viewer'; viewerKey: string; leaseId: string };
        },
        ack: (response: unknown) => void,
    ) => void;
    [PREVIEW_VIEWER_BOUND_WS_OPEN_EVENT]: (
        params: {
            tunnelId: string;
            port: number;
            dataB64: string;
            binding: { purpose: 'viewer'; viewerKey: string; leaseId: string };
        },
        ack: (response: unknown) => void,
    ) => void;
    // Mint-time counterpart: which runtime currently serves this viewer key's
    // port. An older daemon never acks, which is how the server tells.
    [PREVIEW_VIEWER_RUNTIME_LEASE_EVENT]: (
        params: { viewerKey: string; port: number },
        ack: (response: unknown) => void,
    ) => void;
    'proxy-ws-data': (payload: { tunnelId: string; dataB64: string }) => void;
    'proxy-ws-close': (payload: { tunnelId: string }) => void;
    // specs/remote-terminal/ Phase 2 — server forwards terminal control
    // events here. `params` / `data` payloads are E2EE between the
    // daemon and the originating client; happy-server only routes them.
    'terminal-open-fwd': (
        msg: { sessionId: string; params: string | null },
        ack: (response: unknown) => void,
    ) => void;
    'terminal-frame-fwd': (msg: { sessionId: string; data: string }) => void;
    'terminal-resize-fwd': (msg: { sessionId: string; cols: number; rows: number }) => void;
    'terminal-close-fwd': (msg: { sessionId: string }) => void;
    // specs/desktop-terminal-reliability/ Phase 3 — the client asks for
    // everything after the last seq it saw, following a reconnect or a gap.
    'terminal-resume-fwd': (msg: { sessionId: string; afterSeq: number }) => void;
    'rpc-registered': (data: { method: string }) => void;
    'rpc-unregistered': (data: { method: string }) => void;
    'rpc-error': (data: { type: string, error: string }) => void;
    auth: (data: { success: boolean, user: string }) => void;
    error: (data: { message: string }) => void;
}

interface DaemonToServerEvents {
    'automation-key-register': (data: {
        expectedKeyVersion: number;
        publicKey: string;
        protocolVersion: number;
    }, cb: (answer: {
        ok: boolean;
        value?: { keyVersion: number };
        error?: string;
    }) => void) => void;
    'automation-sync': (data: { afterSeq: string; limit: number }, cb: (answer: {
        ok: boolean;
        value?: unknown;
        error?: string;
    }) => void) => void;
    'automation-sync-ack': (data: {
        items: Array<{ automationId: string; revision: number }>;
    }, cb: (answer: {
        ok: boolean;
        value?: unknown;
        error?: string;
    }) => void) => void;
    'automation-claim': (data: {
        automationId: string;
        generation: number;
        scheduledFor: number;
    }, cb: (answer: { ok: boolean; value?: unknown; error?: string }) => void) => void;
    'automation-run-start': (data: {
        runId: string;
        claimToken: string;
    }, cb: (answer: { ok: boolean; value?: unknown; error?: string }) => void) => void;
    'automation-run-heartbeat': (data: {
        runId: string;
        claimToken: string;
    }, cb: (answer: { ok: boolean; value?: unknown; error?: string }) => void) => void;
    'automation-run-report': (data: PendingAutomationReport, cb: (answer: {
        ok: boolean;
        value?: unknown;
        error?: string;
    }) => void) => void;
    'session-followup-sync': (data: {
        wireVersion: 1;
        afterSeq: string;
        limit: number;
    }, cb: (answer: { ok: boolean; value?: unknown; error?: string }) => void) => void;
    'session-followup-claim': (data: {
        wireVersion: 1;
        followupId: string;
        generation: number;
        step: number;
    }, cb: (answer: { ok: boolean; value?: unknown; error?: string }) => void) => void;
    'session-followup-evaluate': (data: {
        wireVersion: 1;
        followupId: string;
        generation: number;
        step: number;
        claimToken: string;
        decision: 'WAIT' | 'CONTINUE' | 'TERMINATE';
        observedSeq: number;
        terminalCode?: string;
    }, cb: (answer: { ok: boolean; value?: unknown; error?: string }) => void) => void;
    'session-followup-deliver': (data: {
        wireVersion: 1;
        followupId: string;
        generation: number;
        step: number;
        claimToken: string;
        expectedSeq: number;
        localId: string;
        contentCiphertext: string;
    }, cb: (answer: { ok: boolean; value?: unknown; error?: string }) => void) => void;
    'machine-alive': (data: {
        machineId: string;
        time: number;
    }) => void;

    'machine-update-metadata': (data: {
        machineId: string;
        metadata: string; // Encrypted MachineMetadata
        expectedVersion: number
    }, cb: (answer: {
        result: 'error'
    } | {
        result: 'version-mismatch'
        version: number,
        metadata: string
    } | {
        result: 'success',
        version: number,
        metadata: string
    }) => void) => void;

    'machine-update-state': (data: {
        machineId: string;
        daemonState: string; // Encrypted DaemonState
        expectedVersion: number
    }, cb: (answer: {
        result: 'error'
    } | {
        result: 'version-mismatch'
        version: number,
        daemonState: string
    } | {
        result: 'success',
        version: number,
        daemonState: string
    }) => void) => void;

    'rpc-register': (data: { method: string }) => void;
    'rpc-unregister': (data: { method: string }) => void;
    'rpc-call': (data: { method: string, params: any }, callback: (response: {
        ok: boolean
        result?: any
        error?: string
    }) => void) => void;
    // specs/remote-terminal/ Phase 2 — daemon-originated stream frames.
    // `data` is the E2EE-encrypted PTY chunk; happy-server forwards it
    // to the client without inspection.
    // `seq` is monotonic per session and starts at 1, so 0 means "seen
    // nothing". Frames sent before this shipped carry none, which the client
    // reads as "the next one after whatever I last had".
    'terminal-frame': (msg: { sessionId: string; seq?: number; data: string }) => void;
    // The whole replay buffer as one frame, when the client fell further behind
    // than the buffer reaches. The client resets its screen to this.
    'terminal-snapshot': (msg: { sessionId: string; seq: number; data: string }) => void;
    // There is no honest answer to the resume: say where the hole starts rather
    // than let the client believe it is current.
    'terminal-frame-gap': (msg: { sessionId: string; fromSeq: number }) => void;
    'terminal-closed': (msg: { sessionId: string; code: number; signal: number | null }) => void;
    // Preview WebSocket relay — upstream→browser bytes and tunnel teardown.
    'proxy-ws-data': (payload: { tunnelId: string; dataB64: string }) => void;
    'proxy-ws-close': (payload: { tunnelId: string }) => void;
}

type BrowserPairResult = {
    ok: boolean;
    message: string;
    connections: Array<{ profile: string; pairingId?: string }>;
    freshProfiles: string[];
    debuggerTier: boolean | null;
};

type ViewerBridgeSummary =
    | { bridgeReady: true; bridgeMessage?: undefined }
    | { bridgeReady: false; bridgeMessage: string };

type ViewerBrowserState = ViewerBrowserSummary & Partial<ViewerBridgeSummary>;
type ViewerStackStartResult = {
    display: string;
    vncPort: number | null;
    webPort: number;
    ready: boolean;
    reused: boolean;
} & ViewerBrowserState;

type IsolatedViewerStartResult = {
    viewerKey: string;
    slot: number;
    display: string;
    vncPort: number;
    webPort: number;
    profileDir: string;
    ready: boolean;
    reused: boolean;
} & ViewerBrowserState;

type MachineRpcHandlers = {
    daemonSessionState?: (request: unknown) => Promise<DaemonSessionStateResponse>;
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    resumeSession?: (sessionId: string, options?: {
        model?: string;
        permissionMode?: string;
        environmentVariables?: Record<string, string>;
        mcpCallerGrantEnvelope?: string;
        mcpConfigProjectId?: string;
        expectedConnectors?: string[];
        /** Present = authoritative (empty withdraws every root); absent = keep the session's roots. */
        additionalDirectories?: string[];
    }) => Promise<ResumeSessionResult>;
    recoverSession?: (sessionId: string, options: RecoverSessionOptions) => Promise<RecoverSessionResult>;
    stopSession: (sessionId: string, context?: StopSessionContext) => StopSessionResult;
    /**
     * Stop plus proof that the session's processes are gone. Used only for a
     * `verifyExit: true` request; absent on a daemon build without it, which
     * answers such a request with the legacy stop and `unavailable` evidence.
     */
    stopSessionWithExitVerification?: (
        sessionId: string,
        context?: StopSessionContext,
    ) => Promise<{ result: StopSessionResult; exitVerification: SessionExitVerification }>;
    requestShutdown: () => void;
    portRegistry: PortRegistry;
    /** When present, registers the scheduled-automation RPCs and advertises automationSupport. */
    automationStore?: AutomationStore;
    /**
     * Reports a freshly spawned session to A+ so it lands in the project's conversation list
     * (specs/daemon-spawn-project-link). Absent on a plain Happy daemon.
     *
     * The spawn path awaits this bounded bookkeeping attempt before returning so Desktop cannot
     * observe lineage before the project can load the child. Failure still leaves spawn successful.
     */
    linkSpawnedSession?: (input: { sessionId: string; directory: string }) => void | Promise<void>;
    aiCredentialRuntime: AiCredentialRuntime;
    autonomousQualityGate?: AutonomousQualityGateRpcHandlers;
    checkpoint?: CheckpointRpcHandlers;
    /**
     * BYOS offline delivery, when the daemon wired it.
     *
     * Absent on a daemon that has no parent origin configured: without one the
     * receiver cannot ask whether a delivery is authorized, and registering a
     * handler that can only ever hold would make the parent wait for a person
     * on every request.
     */
    byosOfflineReceive?: ByosOfflineRpcHandlers;
    difficultyRouting?: DifficultyRoutingClassifierHost;
}

/**
 * The stop-session response every caller has always received. Kept in one place
 * now that the verified variant wraps the same three outcomes.
 */
function describeStopResult(sessionId: string, result: StopSessionResult) {
    if (result.stopped) {
        logger.debug(`[API MACHINE] Stopped session ${sessionId}`);
        return { message: 'Session stopped', stopped: true as const };
    }

    // Duplicate or untracked stop: a no-op acknowledgement so callers can retry
    // idempotently. It says this daemon tracks no such session — not that any
    // process exited; only `exitVerification` answers that.
    if (result.reason === 'not-found') {
        logger.debug(`[API MACHINE] Session ${sessionId} not tracked; treating stop as no-op success`);
        return { message: 'Session not tracked', stopped: false as const, reason: 'not-found' as const };
    }

    if (result.reason === 'managed-generation') {
        // The stop went to the supervisor, which is the only side that
        // can kill a managed generation and observe it empty. Saying
        // `stopped` here would report a stop nobody proved.
        logger.debug(`[API MACHINE] Managed generation stop routed to the supervisor for ${sessionId}`);
        return {
            message: 'Managed generation; stop requested from the supervisor',
            stopped: false as const,
            reason: 'managed-generation' as const,
            detail: result.detail,
        };
    }

    // Guard refused an if-idle stop because the session is active. Return a
    // structured refusal (not an error) so a policy caller can back off and
    // re-evaluate later instead of retrying immediately or escalating.
    logger.debug(
        `[API MACHINE] Refused idle stop for active session ${sessionId} (guard=${result.guard})`,
    );
    return {
        message: 'Session active; stop skipped',
        stopped: false as const,
        reason: 'active' as const,
        guard: result.guard,
        activity: result.activity,
    };
}

function requireNonEmptyString(value: unknown, name: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`${name} is required`);
    }
    return value;
}

function readExpectedConnectors(value: unknown): string[] | undefined {
    if (value === undefined) return undefined;
    if (
        !Array.isArray(value)
        || value.length > 32
        || value.some((provider) => typeof provider !== 'string' || !/^[a-z0-9-]{1,64}$/.test(provider))
    ) {
        throw new Error('Expected connectors must contain provider names only');
    }
    const providers = [...new Set(value)].sort();
    return providers.length > 0 ? providers : undefined;
}

async function withCodexAppServerClient<T>(handler: (client: CodexAppServerClient) => Promise<T>): Promise<T> {
    const client = new CodexAppServerClient();
    await client.connect();
    try {
        return await handler(client);
    } finally {
        await client.disconnect();
    }
}

export class ApiMachineClient {
    private socket!: Socket<ServerToDaemonEvents, DaemonToServerEvents>;
    /** Set when the managed credential ended; suppresses every reconnect. */
    private credentialStopped = false;
    private keepAliveInterval: NodeJS.Timeout | null = null;
    private runtimeActivityProvider: (() => {
        activeSessionCount: number;
        activeAutomationCount: number;
    }) | null = null;
    private lastKnownCLIAvailability: CLIAvailability | null = null;
    private lastKnownResumeSupport: ResumeSupport | null = null;
    // specs/20260521-happy-cli-version-republish — daemon 재시작 후 새 cli
    // 버전을 server metadata 에 re-publish 못 하던 회귀 fix. null 초기
    // 이므로 첫 keep-alive 가 무조건 publish 하여 stale 한 server-side
    // happyCliVersion 을 갱신한다.
    private lastKnownCliVersion: string | null = null;
    // Whether the automation RPCs were registered (setRPCHandlers with an
    // automationStore). Advertised as metadata.automationSupport.rpcAvailable.
    private automationRpcAvailable = false;
    private lastKnownAutomationRpcAvailable: boolean | null = null;
    private autonomousQualityGateRpcAvailable = false;
    private lastKnownAutonomousQualityGateRpcAvailable: boolean | null = null;
    private automationKey: MachineAutomationKey | null = null;
    /** Set once the daemon can resolve projects to workspaces. */
    private lessonHosts: LessonHostSupervisor | null = null;
    private automationProtocolVersion: number = AUTOMATION_PROTOCOL_VERSION;
    private persistAutomationKeyVersion: ((version: number) => void) | null = null;
    private automationServerKeyVersion: number | null = null;
    // Fail closed while server-backed ownership is unresolved. Legacy file ticks
    // are enabled only after the server explicitly reports rollout disabled.
    private automationLegacyFallbackEnabled = false;
    private lastKnownAutomationServerKeyVersion: number | null = null;
    private serverAutomationCache: ServerAutomationCache | null = null;
    private serverAutomationSyncInFlight: Promise<void> | null = null;
    private rpcHandlerManager: RpcHandlerManager;
    /**
     * The machine's only resource sampler. It measures nothing until something
     * subscribes and stops again when the last subscription goes away, so an
     * unwatched daemon costs exactly one idle object (specs/machine-resource-metrics).
     */
    private readonly machineResourceService = createMachineResourceService();
    // Live raw-TCP tunnels for preview WebSocket upgrades (previewWsProxy.ts).
    private previewWsProxy: PreviewWsProxy | null = null;
    /**
     * specs/runtime-isolation-hardening (H3, P2) — opens whose binding is
     * still being verified.
     *
     * Verification runs before the upstream is touched and can take a while
     * (a saturated probe queue, a slow docker call). happy-server's open
     * deadline can pass during that window, and the close it sends then finds
     * nothing: previewWsProxy has no record of a tunnel that has not started
     * connecting. Without this the upstream is opened afterwards anyway — a
     * ghost with no owner, no expiry timer and no recheck behind it.
     *
     * Only ids with an open actually in flight are held, and each is removed
     * when its open finishes: a map of every tunnel id ever seen would be
     * unbounded and fed by the network.
     */
    private previewWsPendingOpens = new Map<string, { cancelled: boolean }>();
    // specs/runtime-isolation-hardening (H3). Probed per request, with no
    // memoization: a cached answer is a window in which a port that changed
    // hands keeps verifying against the runtime it no longer serves. Only the
    // number of probes running at once is bounded — a module burst from one
    // preview page must not turn into hundreds of simultaneous docker spawns.
    private previewEvidenceIo = createEvidenceIo();
    private previewProbe: ProbeFn = createBoundedProbe(
        (port: number) => probeListenerEvidence(port, this.previewEvidenceIo),
        DEFAULT_PROBE_LIMITS,
    );
    private previewPortRegistry: PortRegistry | null = null;
    private previewPathCanonicalizer = createRuntimeLeaseCanonicalizer();
    // Running noVNC stack for the remote browser screen, if started.
    // vncPort is null for a stack we adopted from a previous daemon: only the
    // process that spawned it knows which VNC port it bound, and nothing after
    // adoption reads it. Guessing it by arithmetic would encode a coupling the
    // args builders do not actually promise.
    private viewer: { display: string; vncPort: number | null; webPort: number } | null = null;
    private viewerStartInFlight: {
        callerWillLaunchBrowser: boolean;
        promise: Promise<ViewerStackStartResult>;
    } | null = null;
    /** Set only on a verified managed runtime; null on every BYOS machine. */
    private managedHandlers: ManagedRpcHandlers | null = null;
    private daemonSessionStateRpcAvailable = false;
    private isolatedViewerStarts = new Map<string, Promise<IsolatedViewerStartResult>>();
    private isolatedViewerMutation: Promise<void> = Promise.resolve();
    private isolatedViewerRegistry = new BrowserViewerLeaseRegistry(
        join(configuration.happyHomeDir, 'browser-viewers', 'leases.json'),
    );
    private browserSessionBroker = process.env.HAPPY_BROWSER_BROKER_SOCKET
        ? new BrowserSessionBrokerClient(process.env.HAPPY_BROWSER_BROKER_SOCKET)
        : null;
    private brokerRelayTouchedAt = new Map<number, number>();
    /**
     * specs/runtime-isolation-hardening (H3, P3) — one gate for the whole
     * daemon, so the per-machine cap on viewer proof work is real. Reuses the
     * project probe's measured limits (8 concurrent, 256 queued); the budget
     * is per call and defaults to DEFAULT_VIEWER_PROOF_DEADLINE_MS.
     */
    private viewerProofGate: ViewerProofFn = createBoundedViewerProof(
        (request) => this.resolveViewerEvidence(request),
        DEFAULT_PROBE_LIMITS,
    );
    // Unsafe extension commands are accepted only from the fd 3/4 pipe that
    // launched Chrome. Keep that owner alive for as long as this daemon uses
    // the browser; a CDP port cannot recreate or replace the pipe later.
    private browserCdpPipes = new Map<number, BrowserCdpPipe>();
    private resumeSessionHandler: ((sessionId: string, options?: {
        model?: string;
        permissionMode?: string;
        environmentVariables?: Record<string, string>;
        mcpCallerGrantEnvelope?: string;
        mcpConfigProjectId?: string;
        expectedConnectors?: string[];
        /** Present = authoritative (empty withdraws every root); absent = keep the session's roots. */
        additionalDirectories?: string[];
    }) => Promise<ResumeSessionResult>) | null = null;
    private recoverSessionHandler: ((sessionId: string, options: RecoverSessionOptions) => Promise<RecoverSessionResult>) | null = null;
    private linkSpawnedSessionHandler: ((input: { sessionId: string; directory: string }) => void | Promise<void>) | null = null;
    // specs/remote-terminal-cwd-fallback/ — cached so the
    // terminal-open-fwd handler can run validatePath against the same
    // root the rest of the RPC surface uses (Files tab / writeFile).
    private allowedRoot: string;
    /**
     * The pending next dial. Non-null means "a retry cadence is running", which
     * is all `getConnectionHealth()` and the connection supervisor read it for.
     */
    private reconnectInterval: NodeJS.Timeout | null = null;
    /** Consecutive dials since the last successful connect. Drives the backoff. */
    private reconnectAttempts = 0;
    /**
     * When the outstanding `socket.connect()` was issued, or null when no dial
     * is out. specs/machine-socket-duplicate-registration/ — this is the
     * single-flight guard: the old cadence dialled every 3s regardless, so a
     * slow handshake collected several overlapping dials and several of them
     * completed, leaving the server holding more than one live machine socket.
     */
    private reconnectDialStartedAt: number | null = null;
    /**
     * `shutdown()` 이 시작됐는가.
     *
     * `socket.close()` 는 `disconnect` 를 발생시키고, 그 핸들러가 재연결 cadence 를
     * 다시 켠다. 정리하려고 끈 타이머가 끄는 그 동작 때문에 되살아나는 것이라,
     * 종료 절차가 이벤트 루프를 놓지 못하고 run.ts 의 1초 fallback 에 걸려
     * `forcing exit with code 1` 로 끝난다. 강제 종료는 정리를 건너뛰므로 서버는
     * 소켓이 죽은 줄 ping 예산이 다 될 때까지 모른다 — 재시작 한 번이 필요 이상으로
     * 긴 오프라인이 되는 경로다.
     *
     * apiSession 은 같은 결함을 `closed` 플래그로 이미 막아 뒀다(2026-09-05:
     * 닫은 세션이 1초 뒤 되살아나 프로세스가 2시간 11분 남았던 건). 여기에는
     * 그 대응물이 없었다.
     */
    private shuttingDown = false;
    /*
     * specs/daemon-socket-watchdog/ — the level-triggered backstop.
     *
     * Every other reconnect path here is edge-triggered: it runs because
     * `connect_error` or `disconnect` fired. An edge that is never wired, or
     * never fires, leaves this process alive and socket-less forever, and
     * nothing downstream can tell — the local heartbeat file keeps saying
     * `running` and the server keeps serving the last daemon state it was
     * told. This interval asks the question the edges cannot: is there a
     * socket right now, and if not, is anyone trying?
     */
    private connectionSupervisorInterval: NodeJS.Timeout | null = null;
    /** When the socket was last known to be down. Null only while connected. */
    private disconnectedSince: number | null = null;

    constructor(
        private token: string,
        private machine: Machine
    ) {
        // Initialize RPC handler manager
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.machine.id,
            encryptionKey: this.machine.encryptionKey,
            encryptionVariant: this.machine.encryptionVariant,
            logger: (msg, data) => logger.debug(msg, data)
        });

        // specs/daemon-rpc-workspace-rebase/ Phase 2 — rebase the
        // path-validation root for machine-scoped RPCs (getDirectoryTree
        // / readFile / writeFile / etc.) onto the user's home directory
        // (or HAPPY_WORKSPACE_ROOT if the operator explicitly puts the
        // workspace outside home, e.g. /opt/work). Previously this used
        // process.cwd(), which made the RPC surface depend on whichever
        // shell the user happened to start `happy daemon start` in,
        // breaking the cross-identity Files tab when the daemon was
        // launched from / or any directory that doesn't enclose the
        // project's workspaceDir.
        const allowedRoot = resolveDaemonAllowedRoot(process.env, homedir());
        this.allowedRoot = allowedRoot;
        registerCommonHandlers(this.rpcHandlerManager, allowedRoot);
        this.rpcHandlerManager.registerHandler(
            'worktree-dependencies:reclaim', createWorktreeReclaimHandler(allowedRoot),
        );
        // Registered, not exempted: on a managed runtime the manager's own
        // dispatch allowlist still refuses this method, which is the intended
        // answer there rather than something to work around.
        this.rpcHandlerManager.registerHandler(
            MACHINE_RESOURCE_METRICS_RPC,
            async (params) => this.machineResourceService.handleRequest(params),
        );
        this.rpcHandlerManager.registerHandler(
            'claude-session-transfer',
            createClaudeSessionTransferHandler({ allowedRoot }),
        );
        this.rpcHandlerManager.registerHandler(
            'codex-thread-transfer',
            createCodexThreadTransferHandler({
                allowedRoot,
                codexHome: process.env.CODEX_HOME ?? join(homedir(), '.codex'),
                readThreadPath: async (threadId) => withCodexAppServerClient(async (client) => {
                    const { thread } = await client.readThread({ threadId, includeTurns: false });
                    if (typeof thread.path !== 'string' || thread.path.length === 0) {
                        throw new Error('Codex thread rollout path is unavailable');
                    }
                    return thread.path;
                }),
                forkThreadFromPath: async ({ path, cwd }) => withCodexAppServerClient(async (client) => {
                    const forked = await client.forkThreadFromPath({ path, cwd });
                    return { threadId: forked.threadId };
                }),
            }),
        );
    }

    /**
     * Enables the managed dispatch surface. Must be called before
     * `setRPCHandlers`, which applies the restrictions as its last step.
     */
    setManagedRuntime(handlers: ManagedRpcHandlers): void {
        this.managedHandlers = handlers;
    }

    setRPCHandlers({
        daemonSessionState,
        spawnSession,
        resumeSession,
        recoverSession,
        stopSession,
        stopSessionWithExitVerification,
        requestShutdown,
        portRegistry,
        automationStore,
        aiCredentialRuntime,
        autonomousQualityGate,
        checkpoint,
        byosOfflineReceive,
        linkSpawnedSession,
        difficultyRouting,
    }: MachineRpcHandlers) {
        this.daemonSessionStateRpcAvailable = !!daemonSessionState;
        if (daemonSessionState) {
            this.rpcHandlerManager.registerHandler('daemon-session-state', daemonSessionState);
        }
        this.previewPortRegistry = portRegistry;
        this.resumeSessionHandler = resumeSession ?? null;
        this.recoverSessionHandler = recoverSession ?? null;
        this.linkSpawnedSessionHandler = linkSpawnedSession ?? null;

        if (autonomousQualityGate) {
            this.rpcHandlerManager.registerHandler('autonomous-quality-gate:start', autonomousQualityGate.start);
            this.rpcHandlerManager.registerHandler('autonomous-quality-gate:status', autonomousQualityGate.status);
            this.rpcHandlerManager.registerHandler('autonomous-quality-gate:control', autonomousQualityGate.control);
            this.autonomousQualityGateRpcAvailable = true;
        }

        if (byosOfflineReceive) {
            this.rpcHandlerManager.registerHandler(
                'byos-offline:confirm-session-host', byosOfflineReceive.confirmSessionHost,
            );
            this.rpcHandlerManager.registerHandler(
                'byos-offline:deliver', byosOfflineReceive.deliver,
            );
        }

        if (difficultyRouting) {
            this.rpcHandlerManager.registerHandler('difficulty-routing:classify', (params) => (
                difficultyRouting.classify(params as never)
            ));
        }

        if (checkpoint) {
            this.rpcHandlerManager.registerHandler('checkpoint:status', checkpoint.status);
            this.rpcHandlerManager.registerHandler('checkpoint:list', checkpoint.list);
            this.rpcHandlerManager.registerHandler('checkpoint:preview', checkpoint.preview);
            this.rpcHandlerManager.registerHandler('checkpoint:execute', checkpoint.execute);
            this.rpcHandlerManager.registerHandler('checkpoint:cancel', checkpoint.cancel);
            this.rpcHandlerManager.registerHandler('checkpoint:retry', checkpoint.retry);
            this.rpcHandlerManager.registerHandler('checkpoint:decision', checkpoint.decision);
            this.rpcHandlerManager.registerHandler('checkpoint:restart', checkpoint.restart);
        }

        // Scheduled automations CRUD (specs: daemon-scheduled-automations).
        // Handlers live in automationRpcHandlers.ts so they unit-test without
        // an RpcHandlerManager; directory validation reuses this.allowedRoot,
        // the same root the spawn/file RPC surface enforces.
        if (automationStore) {
            const automationHandlers = createAutomationRpcHandlers({
                store: automationStore,
                allowedRoot: this.allowedRoot,
            });
            this.rpcHandlerManager.registerHandler('automation-upsert', automationHandlers.upsert);
            this.rpcHandlerManager.registerHandler('automation-remove', automationHandlers.remove);
            this.rpcHandlerManager.registerHandler('automation-list', automationHandlers.list);
            this.automationRpcAvailable = true;
        }

        this.rpcHandlerManager.registerHandler('ai-credential:export', (params) => (
            aiCredentialRuntime.capture(params)
        ));
        this.rpcHandlerManager.registerHandler('ai-credential:apply', (params) => (
            aiCredentialRuntime.apply(params)
        ));
        this.rpcHandlerManager.registerHandler('ai-credential:purge', (params) => (
            aiCredentialRuntime.purge(params)
        ));
        this.rpcHandlerManager.registerHandler('ai-credential:status', (params) => (
            aiCredentialRuntime.status(params)
        ));
        this.rpcHandlerManager.registerHandler('ai-credential:rotation', (params) => (
            aiCredentialRuntime.rotation(params)
        ));

        // Register spawn session handler
        this.rpcHandlerManager.registerHandler('spawn-happy-session', async (params: any) => {
            if (params === null || typeof params !== 'object' || Array.isArray(params)) {
                throw new Error('Spawn parameters must be an object');
            }
            const {
                directory,
                sessionId,
                machineId,
                approvedNewDirectoryCreation,
                agent,
                model,
                effort,
                environmentVariables,
                additionalDirectories,
                token,
                happyToken,
                happySecret,
                mcpCallerGrantEnvelope,
                mcpConfigProjectId,
                expectedConnectors,
                resumeClaudeSessionId,
                resumeCodexThreadId,
                deferredContinuationContext,
                parentSessionId,
                forkedFromMessageId,
                createdByAccountId,
                createdByDisplayName,
                axStep,
                bootstrapFiles,
                initialPrompt,
                exitAfterFirstTurn,
                aiAuthSelection,
            } = params || {};
            logger.debug(`[API MACHINE] Spawning session: dir=${directory}, hasUserCreds=${!!(happyToken && happySecret)}`);

            if (!directory) {
                throw new Error('Directory is required');
            }
            if (mcpCallerGrantEnvelope !== undefined && typeof mcpCallerGrantEnvelope !== 'string') {
                throw new Error('MCP caller grant envelope must be a string');
            }
            if (
                mcpConfigProjectId !== undefined
                && (typeof mcpConfigProjectId !== 'string' || !mcpConfigProjectId.trim())
            ) {
                throw new Error('MCP config project id must be a non-empty string');
            }
            const validExpectedConnectors = readExpectedConnectors(expectedConnectors);
            // 닫힌 집합 밖의 선택은 거절한다. 조용히 무시하면 선택이 없는 것처럼
            // 돌아 사용자가 고르지 않은 자격으로 세션이 실행된다.
            const validAiAuthSelection = parseAiAuthSelection(aiAuthSelection);
            const validAdditionalDirectories = parseAdditionalDirectories(additionalDirectories);
            if (validAdditionalDirectories && agent !== 'claude' && agent !== 'codex') {
                throw new Error('Additional directories are only supported for Claude and Codex');
            }
            if (
                initialPrompt !== undefined
                && (typeof initialPrompt !== 'string' || !initialPrompt.trim())
            ) {
                throw new Error('Initial prompt must be a non-empty string');
            }
            if (
                deferredContinuationContext !== undefined
                && (typeof deferredContinuationContext !== 'string' || !deferredContinuationContext.trim())
            ) {
                throw new Error('Deferred continuation context must be a non-empty string');
            }
            if (
                typeof deferredContinuationContext === 'string'
                && Buffer.byteLength(deferredContinuationContext, 'utf8') > DEFERRED_CONTINUATION_CONTEXT_MAX_BYTES
            ) {
                throw new Error('Deferred continuation context is too large');
            }
            if (exitAfterFirstTurn !== undefined && typeof exitAfterFirstTurn !== 'boolean') {
                throw new Error('Exit-after-first-turn must be a boolean');
            }
            if (model !== undefined && (typeof model !== 'string' || !model.trim())) {
                throw new Error('Model must be a non-empty string');
            }
            if (effort !== undefined && (typeof effort !== 'string' || !effort.trim())) {
                throw new Error('Effort must be a non-empty string');
            }
            if (exitAfterFirstTurn && initialPrompt === undefined) {
                throw new Error('Run-once session requires a non-empty initial prompt');
            }
            const runOnceAgent = agent ?? 'claude';
            if (exitAfterFirstTurn && runOnceAgent !== 'claude' && runOnceAgent !== 'codex') {
                throw new Error('Run-once session is only supported for Claude and Codex');
            }

            const result = await spawnSession({
                directory,
                sessionId,
                machineId,
                approvedNewDirectoryCreation,
                agent,
                model,
                effort,
                environmentVariables,
                additionalDirectories: validAdditionalDirectories,
                token,
                happyToken,
                happySecret,
                mcpCallerGrantEnvelope,
                mcpConfigProjectId,
                expectedConnectors: validExpectedConnectors,
                resumeClaudeSessionId,
                resumeCodexThreadId,
                deferredContinuationContext,
                parentSessionId,
                forkedFromMessageId,
                createdByAccountId,
                createdByDisplayName,
                axStep,
                bootstrapFiles,
                initialPrompt,
                exitAfterFirstTurn,
                aiAuthSelection: validAiAuthSelection,
            });

            switch (result.type) {
                case 'success':
                    logger.debug(`[API MACHINE] Spawned session ${result.sessionId}`);
                    // Bookkeeping only, and strictly after the session exists. A failure here
                    // must never downgrade a live session into a failed spawn, so both the
                    // synchronous throw and a late rejection are swallowed.
                    try {
                        await this.linkSpawnedSessionHandler?.({ sessionId: result.sessionId, directory });
                    } catch (error) {
                        logger.debug(`[API MACHINE] Project link for ${result.sessionId} failed: ${error}`);
                    }
                    return {
                        type: 'success',
                        sessionId: result.sessionId,
                        ...(result.additionalDirectories
                            ? { additionalDirectories: result.additionalDirectories }
                            : {}),
                        ...(result.appliedAiAuthSource
                            ? { appliedAiAuthSource: result.appliedAiAuthSource }
                            : {}),
                    };

                case 'requestToApproveDirectoryCreation':
                    logger.debug(`[API MACHINE] Requesting directory creation approval for: ${result.directory}`);
                    return { type: 'requestToApproveDirectoryCreation', directory: result.directory };

                case 'error':
                    throw new Error(result.errorMessage);
            }
        });

        this.syncResumeSessionRpcRegistration();
        this.syncRecoverSessionRpcRegistration();

        // Register stop session handler
        this.rpcHandlerManager.registerHandler('stop-session', async (params: any) => {
            const { sessionId, source, reason, mode, verifyExit } = params || {};

            if (!sessionId) {
                throw new Error('Session ID is required');
            }

            const context: StopSessionContext = {
                ...(typeof source === 'string' ? { source } : {}),
                ...(typeof reason === 'string' ? { reason } : {}),
                ...(mode === 'force' || mode === 'if-idle' ? { mode } : {}),
            };
            const effectiveMode = resolveStopSessionMode(context);
            logger.debug(`[API MACHINE] Stop session request ${sessionId}`, {
                source: context.source,
                reason: context.reason,
                mode: effectiveMode,
                verifyExit: verifyExit === true,
            });

            // A caller that deletes data after the stop asks for proof of exit
            // with `verifyExit: true`. Everyone else gets the response they
            // always got, byte for byte, and pays none of the observation cost.
            if (verifyExit !== true) {
                return describeStopResult(sessionId, stopSession(sessionId, context));
            }

            if (!stopSessionWithExitVerification) {
                // A daemon build without the verifier. Say so rather than
                // implying the legacy stop proved anything.
                return {
                    ...describeStopResult(sessionId, stopSession(sessionId, context)),
                    exitVerification: {
                        status: 'unavailable' as const,
                        scope: SESSION_EXIT_VERIFICATION_SCOPE,
                        detail: 'verification-unsupported' as const,
                    },
                };
            }

            const verified = await stopSessionWithExitVerification(sessionId, context);
            logger.debug(
                `[API MACHINE] Stop session ${sessionId} exit verification: ${verified.exitVerification.status}`,
            );
            return {
                ...describeStopResult(sessionId, verified.result),
                exitVerification: verified.exitVerification,
            };
        });

        // Read opencode config models from ~/.config/opencode/opencode.json so
        // the desktop can populate the model picker before the first opencode
        // session runs. Returns { models: [] } when the file is missing or
        // unparseable — the desktop falls back to session-reported models.
        this.rpcHandlerManager.registerHandler('read-opencode-models', async () => {
            const configPath = `${homedir()}/.config/opencode/opencode.json`;
            try {
                const raw = await readFile(configPath, 'utf-8');
                const config = JSON.parse(raw) as unknown;
                if (!config || typeof config !== 'object') return { models: [] };
                const providers = (config as Record<string, unknown>).provider;
                if (!providers || typeof providers !== 'object') return { models: [] };
                const models: Array<{ code: string; value: string }> = [];
                for (const [provKey, provData] of Object.entries(providers as Record<string, unknown>)) {
                    if (!provData || typeof provData !== 'object') continue;
                    const provModels = (provData as Record<string, unknown>).models;
                    if (!provModels || typeof provModels !== 'object') continue;
                    for (const [modelKey, modelData] of Object.entries(provModels as Record<string, unknown>)) {
                        if (!modelData || typeof modelData !== 'object') continue;
                        const code = `${provKey}/${modelKey}`;
                        const name = (modelData as Record<string, unknown>).name;
                        models.push({ code, value: typeof name === 'string' && name ? name : code });
                    }
                }
                return { models };
            } catch {
                return { models: [] };
            }
        });

        // Register Claude session fork handlers (used by app-side fork /
        // duplicate flows). These take the source session's working
        // directory and underlying Claude UUID, copy the on-disk JSONL
        // — optionally truncated at a chosen message — and return the new
        // Claude UUID. The caller then spawns a fresh Happy session with
        // `resumeClaudeSessionId` set so `claude --resume <newUuid>`
        // continues the conversation.
        this.rpcHandlerManager.registerHandler('claude-fork-session', async (params: any) => {
            const { directory, claudeSessionId } = params || {};
            if (typeof directory !== 'string' || directory.length === 0) {
                throw new Error('directory is required');
            }
            if (typeof claudeSessionId !== 'string' || !UUID_RE.test(claudeSessionId)) {
                throw new Error('claudeSessionId must be a valid UUID');
            }
            try {
                const newClaudeSessionId = await claudeForkSession(getProjectPath(directory), claudeSessionId);
                return { type: 'success', newClaudeSessionId };
            } catch (error) {
                if (error instanceof ForkSourceMissingError) {
                    throw new Error('Claude session file not found on this machine');
                }
                throw error;
            }
        });

        // List user-text rewind points directly from the on-disk JSONL.
        // The server-side session log misses claudeUuid for messages typed
        // live in the app (legacy `sentFrom: 'web'` path); disk is the
        // source of truth and carries the right uuids for every message.
        this.rpcHandlerManager.registerHandler('claude-list-rewind-points', async (params: any) => {
            const { directory, claudeSessionId } = params || {};
            if (typeof directory !== 'string' || directory.length === 0) {
                throw new Error('directory is required');
            }
            if (typeof claudeSessionId !== 'string' || !UUID_RE.test(claudeSessionId)) {
                throw new Error('claudeSessionId must be a valid UUID');
            }
            try {
                const points = await listClaudeRewindPoints(getProjectPath(directory), claudeSessionId);
                return { type: 'success', points };
            } catch (error) {
                if (error instanceof ForkSourceMissingError) {
                    throw new Error('Claude session file not found on this machine');
                }
                throw error;
            }
        });

        this.rpcHandlerManager.registerHandler('claude-duplicate-session', async (params: any) => {
            const { directory, claudeSessionId, cutAfterUuid } = params || {};
            if (typeof directory !== 'string' || directory.length === 0) {
                throw new Error('directory is required');
            }
            if (typeof claudeSessionId !== 'string' || !UUID_RE.test(claudeSessionId)) {
                throw new Error('claudeSessionId must be a valid UUID');
            }
            if (typeof cutAfterUuid !== 'string' || !UUID_RE.test(cutAfterUuid)) {
                throw new Error('cutAfterUuid must be a valid UUID');
            }
            try {
                const newClaudeSessionId = await claudeForkAndTruncateSession(
                    getProjectPath(directory),
                    claudeSessionId,
                    cutAfterUuid,
                );
                return { type: 'success', newClaudeSessionId };
            } catch (error) {
                if (error instanceof ForkSourceMissingError) {
                    throw new Error('Claude session file not found on this machine');
                }
                if (error instanceof ForkTruncateUuidNotFoundError) {
                    throw new Error(
                        'The chosen rewind point is no longer present in the source session — try forking without truncation',
                    );
                }
                throw error;
            }
        });

        this.rpcHandlerManager.registerHandler('codex-fork-thread', async (params: any) => {
            const directory = requireNonEmptyString(params?.directory, 'directory');
            const codexThreadId = requireNonEmptyString(params?.codexThreadId, 'codexThreadId');

            const result = await withCodexAppServerClient((client) => forkCodexThread(client, {
                threadId: codexThreadId,
                cwd: directory,
            }));
            return result;
        });

        this.rpcHandlerManager.registerHandler('codex-list-rewind-points', async (params: any) => {
            const codexThreadId = requireNonEmptyString(params?.codexThreadId, 'codexThreadId');

            return withCodexAppServerClient(async (client) => {
                const { thread } = await client.readThread({
                    threadId: codexThreadId,
                    includeTurns: true,
                });
                return {
                    type: 'success',
                    points: listCodexRewindPoints(thread),
                };
            });
        });

        this.rpcHandlerManager.registerHandler('codex-duplicate-thread', async (params: any) => {
            const directory = requireNonEmptyString(params?.directory, 'directory');
            const codexThreadId = requireNonEmptyString(params?.codexThreadId, 'codexThreadId');
            const cutAfterItemId = requireNonEmptyString(params?.cutAfterItemId, 'cutAfterItemId');

            try {
                return await withCodexAppServerClient((client) => forkCodexThread(client, {
                    threadId: codexThreadId,
                    cwd: directory,
                    cutAfterItemId,
                }));
            } catch (error) {
                if (error instanceof CodexForkRewindPointNotFoundError) {
                    throw new Error(
                        'The chosen rewind point is no longer present in the source Codex thread — try forking without truncation',
                    );
                }
                throw error;
            }
        });

        // Browser bridge setup, driven by buttons on the machine screen so a
        // terminal-only Linux box needs no SSH session. See
        // specs/browser-setup-gui/.
        this.rpcHandlerManager.registerHandler('browser-setup:status', async () => {
            const chrome = await detectChrome();
            const state = await readDaemonState();
            const controlPort = state?.httpPort;
            const status = (controlPort && state?.controlSecret)
                ? await fetchBrowserStatus(controlPort, state.controlSecret)
                : null;
            return {
                chromeInstalled: Boolean(chrome),
                chromePath: chrome?.path ?? null,
                chromeVersion: chrome?.version ?? null,
                canSudo: chrome ? false : await canSudoWithoutPassword(),
                connections: status?.connections ?? [],
                daemonRunning: Boolean(controlPort),
            };
        });

        this.rpcHandlerManager.registerHandler('browser-setup:install-chrome', async () => {
            const chrome = await detectChrome();
            const plan = planChromeInstall({
                chromePath: chrome?.path ?? null,
                canSudo: chrome ? true : await canSudoWithoutPassword(),
            });
            if (plan.action !== 'run') {
                // 'manual' deliberately reaches the UI as a non-success: no
                // root means no install, and saying otherwise would leave the
                // user hunting for a Chrome that was never placed.
                return plan;
            }
            const result = await runShell(plan.command);
            const installed = await detectChrome();
            return {
                action: 'run',
                command: plan.command,
                ok: Boolean(installed),
                chromePath: installed?.path ?? null,
                stderr: result.ok ? undefined : result.output,
            };
        });

        this.rpcHandlerManager.registerHandler('browser-setup:launch', async (params: any) => {
            const profile = typeof params?.profile === 'string' && params.profile.trim()
                ? params.profile.trim()
                : 'default';
            const chrome = await detectChrome();
            if (!chrome) {
                throw new Error('Chrome이 설치되어 있지 않습니다. 먼저 설치를 실행하세요.');
            }
            const userDataDir = resolveProfileUserDataDir(
                join(configuration.happyHomeDir, 'chrome-profiles'),
                profile,
            );
            const cdpPort = await pickFreeCdpPort();
            if (cdpPort === null) {
                throw new Error('사용 가능한 CDP 포트를 찾지 못했습니다.');
            }

            const wantsViewer = params?.viewer === true;
            // Ensures the viewer stack before deciding headless/display —
            // "launch under the viewer" must be the Chrome the user actually
            // sees, not a second headless instance running blind.
            const viewerState = wantsViewer
                ? await this.startViewerStack({ callerWillLaunchBrowser: true })
                : null;
            const chosen = resolveChromeDisplay({
                wantsViewer,
                viewerDisplay: viewerState?.display ?? null,
                daemonDisplayEnv: process.env.DISPLAY,
            });
            if (chosen.headless === null) {
                throw new Error('원격 화면이 아직 준비되지 않았습니다.');
            }
            const headless = chosen.headless;
            const env = chosen.display ? { DISPLAY: chosen.display } : undefined;
            // Sized only when this Chrome is going onto the viewer's own
            // Xvfb screen. A daemon running under a real desktop display
            // gets Chrome's normal window, which is that user's to arrange.
            const windowSize = viewerState ? VIEWER_SCREEN : undefined;
            let launched = launchChrome(chrome.path, {
                userDataDir,
                cdpPort,
                headless,
                display: chosen.display ?? undefined,
                windowSize,
            }, env);
            let { pid } = launched;
            let ready = await waitForCdp(cdpPort, 15_000);
            let sandbox = true;
            if (!ready) {
                // Kernels that block unprivileged user namespaces kill Chrome's
                // zygote before it opens the CDP port, so "launched" is not
                // "running". Retry once without the sandbox and report the
                // downgrade rather than leaving a browser that never answers.
                sandbox = false;
                launched.cdpPipe.close();
                launched = launchChrome(chrome.path, {
                    userDataDir,
                    cdpPort,
                    headless,
                    display: chosen.display ?? undefined,
                    noSandbox: true,
                    windowSize,
                }, env);
                ({ pid } = launched);
                ready = await waitForCdp(cdpPort, 15_000);
            }
            if (ready) this.rememberBrowserCdpPipe(cdpPort, launched.cdpPipe);
            else launched.cdpPipe.close();
            const viewer = viewerState
                ? {
                    ...viewerState,
                    ...summariseViewerBrowser({ chromeInstalled: true, cdpPort: ready ? cdpPort : null }),
                }
                : null;
            return { profile, cdpPort, userDataDir, pid, headless, ready, sandbox, viewer };
        });

        this.rpcHandlerManager.registerHandler('browser-setup:pair', async (params: any) => {
            const cdpPort = Number(params?.cdpPort);
            if (!Number.isInteger(cdpPort) || cdpPort <= 0) {
                throw new Error('cdpPort is required');
            }
            return this.pairBrowser(cdpPort, params?.debuggerTier !== false);
        });

        // Remote browser screen (noVNC) — lets the user open any site and log
        // in by hand, 2FA and captcha included, with no SSH tunnel. The
        // bridge's own click/fill are ref-based and cannot drive a captcha,
        // which is why this exists. See specs/browser-remote-login/.
        this.rpcHandlerManager.registerHandler('browser-viewer:status', async () => {
            const capabilities = await detectViewerCapabilities();
            const missing = missingViewerTools(capabilities);
            // `upgradable` is not `missing`: the screen works without these,
            // it just cannot size itself to the viewer's window.
            const upgradable = missing.length === 0 ? desiredViewerTools(capabilities) : [];
            return {
                installed: missing.length === 0,
                missing,
                canSudo: missing.length === 0 && upgradable.length === 0
                    ? false
                    : await canSudoWithoutPassword(),
                running: this.viewer !== null,
                webPort: this.viewer?.webPort ?? null,
                display: this.viewer?.display ?? null,
                upgradable,
            };
        });

        this.rpcHandlerManager.registerHandler('browser-viewer:install', async () => {
            // Installs the whole modern stack, not only what blocks the
            // screen: the user has already accepted a package change here,
            // and this is what turns a scaled screen into an exact fit.
            const missing = desiredViewerTools(await detectViewerCapabilities());
            const plan = planViewerInstall({
                missing,
                canSudo: missing.length === 0 ? true : await canSudoWithoutPassword(),
            });
            if (plan.action !== 'run') {
                // 'manual' reaches the UI as a non-success on purpose: these
                // are system packages, so without root nothing was installed.
                return plan;
            }
            const result = await runShell(plan.command);
            const after = await detectViewerCapabilities();
            const stillMissing = missingViewerTools(after);
            return {
                action: 'run',
                command: plan.command,
                // `ok` still means "the screen can open" — that is what the
                // caller gates on. What the install asked for beyond that
                // travels separately instead of being folded into a success.
                ok: stillMissing.length === 0,
                missing: stillMissing,
                upgradable: desiredViewerTools(after),
                stderr: result.ok ? undefined : result.output,
            };
        });

        this.rpcHandlerManager.registerHandler('browser-viewer:start', async (params: any) => {
            const viewerKey = requireNonEmptyString(params?.viewerKey, 'viewerKey');
            if (!validateViewerKey(viewerKey)) throw new Error('viewerKey is invalid');
            if (this.browserSessionBroker) return this.startBrokerViewer(viewerKey);
            return this.startIsolatedViewerStack(viewerKey);
        });

        /**
         * specs/runtime-isolation-hardening (H3, P3) — the required path opens
         * the viewer through this method instead of `browser-viewer:start`.
         *
         * A new method name is what makes the old-daemon case safe *before*
         * any side effect: a daemon that predates viewer binding has no
         * handler, so the RPC comes back "Method not found" having started
         * nothing. Asking an old daemon for a capability and then calling
         * start would leave a window between the two answers — and a
         * singleton daemon that ignores params would already have launched a
         * stack by the time its reply was checked.
         *
         * Validation happens strictly *before* the existing start body runs;
         * the body itself is reused unchanged so the two paths cannot drift.
         */
        this.rpcHandlerManager.registerHandler('browser-viewer:start-bound', async (params: any) => {
            const viewerKey = requireNonEmptyString(params?.viewerKey, 'viewerKey');
            if (!validateViewerKey(viewerKey)) throw new Error('viewerKey is invalid');
            // The key is server-derived from the authenticated user; the
            // daemon accepts no other field that could widen what is opened.
            if (this.browserSessionBroker) return this.startBrokerViewer(viewerKey);
            return this.startIsolatedViewerStack(viewerKey);
        });

        this.rpcHandlerManager.registerHandler('browser-viewer:lookup', async (params: any) => {
            const viewerKey = requireNonEmptyString(params?.viewerKey, 'viewerKey');
            if (!validateViewerKey(viewerKey)) throw new Error('viewerKey is invalid');
            if (this.browserSessionBroker) {
                const response = await this.browserSessionBroker.request({ op: 'lookup', viewerKey });
                if (!response.ok) throw new Error(response.code);
                return response.lease;
            }
            // The registry decides whether this viewer still holds a slot.
            // Reading the cache first would answer for a lease another start
            // has released: the slot can belong to someone else by now, and
            // reporting it ready — then writing it back — hands its former
            // owner their screen. Every write puts the registry first, so the
            // cache is never ahead of it.
            const lease = await this.isolatedViewerRegistry.get(viewerKey);
            if (!lease) return null;
            // A read, and only a read. This handler runs outside the start/stop
            // mutation, so a write-back could land after the records loop had
            // released this very record — putting a lease back on a slot the
            // loop is about to hand out. All it ever wrote was a timestamp
            // nothing reads.
            //
            // `ready` is the only signal the relay-token route has, and it
            // refuses the screen on false. One 1.5s probe is all a loaded
            // machine needs to miss, so a miss gets a second, patient look
            // before a live viewer is reported gone to the person watching it.
            const ready = await isViewerServing(lease.webPort)
                || (await waitForViewerServing(lease.webPort, VIEWER_CONFIRM_DEAD_MS, { pollMs: 500 })).ready;
            // The probe ran outside the mutation. In that window stop/start
            // can release this slot and hand it to someone else — the probe
            // then answered for *their* screen, and the lease captured before
            // it would mint a token onto it. Ownership has to still hold now.
            const still = await this.isolatedViewerRegistry.get(viewerKey);
            if (!still || !sameViewerLease(still, lease)) return null;
            return { ...lease, ready };
        });

        this.rpcHandlerManager.registerHandler('browser-viewer:stop', async (params: any) => {
            const viewerKey = requireNonEmptyString(params?.viewerKey, 'viewerKey');
            if (!validateViewerKey(viewerKey)) throw new Error('viewerKey is invalid');
            if (this.browserSessionBroker) {
                const response = await this.browserSessionBroker.request({ op: 'stop', viewerKey });
                if (!response.ok) throw new Error(response.code);
                return { viewerKey, stopped: response.stopped === true };
            }
            return this.withIsolatedViewerMutation(async () => {
                const lease = await this.isolatedViewerRegistry.get(viewerKey);
                if (!lease) return { viewerKey, stopped: false };
                // Releasing the record drops the only note of these pids, so
                // a stack that shrugged off SIGTERM would hold its slot with
                // nothing left able to reach it. See it out first.
                await this.reapViewerStack(lease);
                if (lease.cdpPort !== null) {
                    this.browserCdpPipes.get(lease.cdpPort)?.close();
                    this.browserCdpPipes.delete(lease.cdpPort);
                }
                await this.isolatedViewerRegistry.delete(viewerKey);
                return { viewerKey, stopped: true };
            });
        });

        this.rpcHandlerManager.registerHandler('browser-viewer:migrate-legacy', async (params: any) => {
            const viewerKey = requireNonEmptyString(params?.viewerKey, 'viewerKey');
            if (!validateViewerKey(viewerKey)) throw new Error('viewerKey is invalid');
            if (!this.browserSessionBroker) throw new Error('browser-broker-required');
            const response = await this.browserSessionBroker.request({ op: 'migrate-legacy', viewerKey });
            if (!response.ok) throw new Error(response.code);
            return { viewerKey, migrated: response.migrated === true };
        });

        // Host-mode Electron preview (no docker): make sure a window can be
        // created here (Xvfb on Linux, a GUI session on macOS) and hand back
        // the env that preloads the cdp-screencast bridge into the app.
        // aplus-dev-studio specs/electron-gui-preview-cross-platform Phase 3.
        this.rpcHandlerManager.registerHandler('gui-display:ensure', async (params: any) => {
            return ensureElectronGuiDisplay({
                streamPort: params?.streamPort,
                packageRoot: projectPath(),
                canSudo: canSudoWithoutPassword,
            });
        });

        /*
         * Lesson host. The desktop sends `{ ...request, grantEnvelope }`; the
         * envelope is the only authority in it, and everything else is echoed
         * data this daemon re-derives or refuses.
         *
         * Registered unconditionally so the desktop always gets a typed answer.
         * Before the daemon has resolved a workspace and a studio key there is
         * no runtime, and `unsupported` is the truthful reply — a missing
         * handler would instead surface as "RPC method not available", which
         * reads as a broken daemon rather than a feature that is not set up.
         */
        this.rpcHandlerManager.registerHandler(LESSON_HOST_RPC_METHOD, async (params: any) => {
            const hosts = this.lessonHosts;
            if (!hosts) return { ok: false, reason: 'unsupported' };
            return hosts.handle(params);
        });

        // Register stop daemon handler
        this.rpcHandlerManager.registerHandler('stop-daemon', () => {
            logger.debug('[API MACHINE] Received stop-daemon RPC request');

            // Trigger shutdown callback after a delay
            setTimeout(() => {
                logger.debug('[API MACHINE] Initiating daemon shutdown from RPC');
                requestShutdown();
            }, 100);

            return { message: 'Daemon stop request acknowledged, starting shutdown sequence...' };
        });

        // Read the daemon-uid's Claude Code rate-window quota. Returns a
        // structured ClaudeCodeUsage envelope; failures (missing CLI, not
        // logged in, /usage parse drift) are encoded in the response rather
        // than thrown so the web-ui can render per-machine rows without
        // toast bombing. See specs/20260618-machine-cli-usage-quota/.
        this.rpcHandlerManager.registerHandler('claude-code-usage:read', async () => {
            return readClaudeCodeUsage();
        });

        // Register port allocation handler — sticky per (user, project)
        // composite key in 30000-40000 since specs/preview-cross-user-
        // isolation/ Phase 4. Both userId and projectId are required.
        this.rpcHandlerManager.registerHandler('allocate-port', async (params: any) => {
            const { userId, projectId } = params || {};
            if (!userId || typeof userId !== 'string') {
                throw new Error('userId is required');
            }
            if (!projectId || typeof projectId !== 'string') {
                throw new Error('projectId is required');
            }
            const result = await portRegistry.allocate(userId, projectId);
            logger.debug(`[API MACHINE] allocate-port ${userId}:${projectId} -> ${result.port} (reused=${result.reused})`);
            return result;
        });

        // Register read-only port lookup handler. Used by web-ui preflight
        // (specs/preview-server-lifecycle/ Phase 1) to check whether a (user,
        // project) already has a sticky port assigned before deciding to
        // start a new server. Falls back to the legacy bare-projectId entry
        // so daemons that have not yet seen the new composite key still
        // resolve the right port for the original owner.
        this.rpcHandlerManager.registerHandler('get-port', async (params: any) => {
            const { userId, projectId } = params || {};
            if (!userId || typeof userId !== 'string') {
                throw new Error('userId is required');
            }
            if (!projectId || typeof projectId !== 'string') {
                throw new Error('projectId is required');
            }
            const data = await portRegistry.readAll();
            const entry = data[`${userId}:${projectId}`] ?? data[projectId];
            const port = entry ? entry.port : null;
            logger.debug(`[API MACHINE] get-port ${userId}:${projectId} -> ${port}`);
            return { port };
        });

        // Register port release handler (e.g., on project deletion). userId
        // is required to scope the release to the correct (user, project).
        this.rpcHandlerManager.registerHandler('release-port', async (params: any) => {
            const { userId, projectId } = params || {};
            if (!userId || typeof userId !== 'string') {
                throw new Error('userId is required');
            }
            if (!projectId || typeof projectId !== 'string') {
                throw new Error('projectId is required');
            }
            const released = await portRegistry.release(userId, projectId);
            logger.debug(`[API MACHINE] release-port ${userId}:${projectId} -> released=${released}`);
            return { released };
        });

        // Register dev-server spawn handler — the web-ui hits this when
        // Phase 12 "direct server start" runs on a remote-machine session.
        // Returns an explicit {type:'success'|'error', ...} envelope so the
        // caller sees the StartServerError code (CWD_NOT_FOUND, ENOENT,
        // ...). See specs/remote-server-start/ Phase 3.
        const spawnedServers = new Map<number, ChildProcess>();
        this.rpcHandlerManager.registerHandler('start-server', async (params: any) => {
            const { command, cwd, env } = params || {};
            if (typeof command !== 'string' || typeof cwd !== 'string') {
                return { type: 'error', code: 'INVALID_REQUEST', message: 'command and cwd are required' };
            }
            try {
                const result = await startServerProcess(
                    { command, cwd, env },
                    {
                        fastFailDelayMs: 50,
                        onSpawn: (child) => {
                            if (child.pid) {
                                spawnedServers.set(child.pid, child);
                                child.on('exit', () => spawnedServers.delete(child.pid!));
                            }
                        },
                    },
                );
                logger.debug(`[API MACHINE] start-server spawned pid=${result.pid} cwd=${cwd}`);
                return { type: 'success', pid: result.pid };
            } catch (e) {
                if (e instanceof StartServerError) {
                    logger.debug(`[API MACHINE] start-server failed: ${e.code} ${e.message}`);
                    return { type: 'error', code: e.code, message: e.message };
                }
                const message = e instanceof Error ? e.message : String(e);
                logger.debug(`[API MACHINE] start-server internal error: ${message}`);
                return { type: 'error', code: 'INTERNAL', message };
            }
        });

        // Companion to `start-server` — signals the child with SIGTERM,
        // falling back to SIGKILL if it does not exit gracefully. Envelope
        // matches start-server: success or {code,message} error.
        // See specs/preview-server-lifecycle/ Phase 5a.
        this.rpcHandlerManager.registerHandler('stop-server', async (params: any) => {
            const { pid } = params || {};
            if (typeof pid !== 'number') {
                return { type: 'error', code: 'INVALID_REQUEST', message: 'pid is required' };
            }
            try {
                const result = await stopServerProcess({ pid });
                logger.debug(`[API MACHINE] stop-server pid=${pid} signal=${result.sentSignal}`);
                return { type: 'success', sentSignal: result.sentSignal };
            } catch (e) {
                if (e instanceof StopServerError) {
                    logger.debug(`[API MACHINE] stop-server failed: ${e.code} ${e.message}`);
                    return { type: 'error', code: e.code, message: e.message };
                }
                const message = e instanceof Error ? e.message : String(e);
                logger.debug(`[API MACHINE] stop-server internal error: ${message}`);
                return { type: 'error', code: 'INTERNAL', message };
            }
        });

        // NOTE: proxy-http is intentionally wired as a plain socket event
        // (see connect() — 'proxy-http-request') instead of an encrypted
        // RpcHandlerManager handler. happy-server's preview relay route
        // terminates iframe requests and needs to forward plaintext bodies
        // — it has no access to the machine encryption key, so the E2EE
        // RPC envelope can't be used. The preview payload is inherently
        // non-sensitive (it's the HTTP request flowing from the iframe,
        // and happy-server already sees it to rewrite HTML).

        // Applied last so it wins over every legacy registration above,
        // regardless of the order those modules ran in. On a BYOS machine
        // `managedHandlers` is null and nothing below executes, so the
        // existing surface is untouched.
        if (this.managedHandlers) {
            applyManagedRpcRestrictions(this.rpcHandlerManager);
            registerManagedRpcHandlers(this.rpcHandlerManager, this.managedHandlers);
        }
    }

    /**
     * specs/runtime-isolation-hardening (H3). Null until `setRPCHandlers` has
     * run: without the port registry the daemon cannot spot a port that is
     * registered to another project, and a partial check is not the check.
     */
    private previewLeaseDeps(options?: { probeDeadlineMs?: number }): RuntimeLeaseDeps | null {
        const registry = this.previewPortRegistry;
        if (!registry) return null;
        return {
            probeEvidence: (port: number) => (options?.probeDeadlineMs === undefined
                ? this.previewProbe(port)
                : this.previewProbe(port, { deadlineMs: options.probeDeadlineMs })),
            readPortRegistry: () => registry.readAll(),
            canonicalize: (target: string) => this.previewPathCanonicalizer(target),
        };
    }

    /**
     * specs/runtime-isolation-hardening (H3, P3) — the viewer counterpart of
     * `previewLeaseDeps`.
     *
     * The mode is decided once, here, by whether a root broker is configured,
     * and there is **no fallback between the two**. In broker mode the native
     * registry describes nothing that is running, so reading it after a failed
     * broker lookup would not be a second opinion — it would be a first
     * opinion about the wrong machine state.
     */
    private viewerLeaseDeps(options?: { deadlineMs?: number }): ViewerLeaseDeps {
        // Every viewer proof goes through the same gate instance, so the cap
        // is per machine rather than per request. The budget is applied here
        // too: an unbudgeted proof that overran the mint window used to be
        // read by happy-server as "this daemon predates runtime binding",
        // which records a wrong fact about the fleet instead of a refusal.
        return { resolveEvidence: (request) => this.viewerProofGate(request, options) };
    }

    /**
     * The unbounded proof itself. Mode is picked per call because the broker
     * may be configured after construction; there is no fallback between the
     * two — in broker mode the native registry describes nothing running.
     */
    private resolveViewerEvidence(request: ViewerEvidenceRequest): Promise<ViewerEvidenceResult> {
        const broker = this.browserSessionBroker;
        if (broker) {
            return resolveBrokerViewerEvidence(request, {
                lookupBrokerLease: async (viewerKey) => {
                    const response = await broker.request({ op: 'lookup', viewerKey });
                    if (!response.ok) throw new Error(response.code);
                    return response.lease;
                },
            });
        }
        return resolveNativeViewerEvidence(request, {
                    // The on-disk record is what survives a daemon restart,
                    // and verification must not be decided by whatever this
                    // process happens to remember.
                    getViewerLease: async (viewerKey) =>
                        (await this.isolatedViewerRegistry.get(viewerKey)) ?? null,
                    // Viewer-only prober. The generic project probe reports
                    // "2 processes listen on 127.0.0.1:<port>" for a healthy
                    // viewer under load — websockify forks a worker that
                    // inherits the listening socket — and that ambiguity is
                    // the right answer for a project port and the wrong one
                    // here, where the expected pid is known in advance. The
                    // generic probe is left strict and untouched.
                    probeListener: (port: number, expectedPid: number) =>
                        probeNativeViewerListenerEvidence(port, expectedPid, this.previewEvidenceIo),
                    readProcessCmdline: (pid: number) => this.previewEvidenceIo.readFile(`/proc/${pid}/cmdline`),
        });
    }

    /**
     * Same gate as the project relay, over the viewer variant. There is no
     * `unbound` outcome: these events exist only for bound requests, so an
     * absent binding is a caller error rather than an older server.
     */
    private enforceViewerBinding(
        binding: unknown,
        port: number,
    ): Promise<{ outcome: 'enforced' } | { outcome: 'rejected'; code: string; message: string }> {
        return enforceViewerRelayBinding(binding, port, this.viewerLeaseDeps());
    }

    /** Handler body of the `preview-viewer-runtime-lease` socket event. */
    private async answerPreviewViewerRuntimeLease(params: any, ack: (response: any) => void): Promise<void> {
        try {
            const result = await acquireViewerLease(
                { viewerKey: params?.viewerKey, port: params?.port },
                this.viewerLeaseDeps({ deadlineMs: MINT_LEASE_ANSWER_DEADLINE_MS }),
            );
            logger.debug(
                `[API MACHINE] preview-viewer-runtime-lease port=${params?.port} -> ${result.type === 'success' ? result.evidenceKind : result.code}`,
            );
            ack(result);
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            logger.debug(`[API MACHINE] preview-viewer-runtime-lease internal error: ${message}`);
            ack({ type: 'error', code: 'EVIDENCE_UNAVAILABLE', message });
        }
    }

    private async relayPreviewViewerBoundHttp(params: any): Promise<any> {
        const binding = await this.enforceViewerBinding(params?.binding, params?.port);
        if (binding.outcome === 'rejected') {
            logger.debug(`[API MACHINE] viewer-bound http refused: ${binding.code} ${binding.message}`);
            return { type: 'error', code: binding.code, message: binding.message };
        }
        try {
            const result = await proxyHttp({
                port: params?.port,
                method: params?.method,
                path: params?.path,
                headers: params?.headers ?? {},
                bodyB64: params?.bodyB64 ?? null,
            });
            return { type: 'success', ...result, bindingEnforced: true };
        } catch (e) {
            if (e instanceof PreviewProxyError) {
                return { type: 'error', code: e.code, message: e.message };
            }
            const message = e instanceof Error ? e.message : String(e);
            logger.debug(`[API MACHINE] viewer-bound http internal error: ${message}`);
            return { type: 'error', code: 'INTERNAL', message };
        }
    }

    /**
     * Viewer upgrades. Shares the whole cancellation / supersede / close
     * machinery with the project tunnel — a second copy would drift, and the
     * expiry and revocation behaviour is exactly what must not differ.
     */
    private async openPreviewViewerWsTunnelBound(params: any): Promise<any> {
        const tunnelId = typeof params?.tunnelId === 'string' ? params.tunnelId : null;
        if (!tunnelId) {
            return { ok: false, code: 'INVALID_TUNNEL', message: 'Missing tunnelId' };
        }
        const cancelled = { ok: false, code: 'CANCELLED', message: 'Tunnel was closed before it opened' };
        const pending = { cancelled: false };
        const superseded = this.previewWsPendingOpens.get(tunnelId);
        if (superseded) superseded.cancelled = true;
        this.previewWsPendingOpens.set(tunnelId, pending);
        try {
            const binding = await this.enforceViewerBinding(params?.binding, params?.port);
            if (pending.cancelled) return cancelled;
            if (binding.outcome === 'rejected') {
                logger.debug(`[API MACHINE] viewer-bound ws refused: ${binding.code} ${binding.message}`);
                return { ok: false, code: binding.code, message: binding.message };
            }
            const opened = await this.previewWsProxy!.open(params);
            if (pending.cancelled) {
                this.previewWsProxy?.close(tunnelId);
                return cancelled;
            }
            return opened?.ok === true ? { ...opened, bindingEnforced: true } : opened;
        } finally {
            if (this.previewWsPendingOpens.get(tunnelId) === pending) {
                this.previewWsPendingOpens.delete(tunnelId);
            }
        }
    }

    /**
     * specs/runtime-isolation-hardening (H3) — prove that the runtime still
     * answering on this port is the one the token was minted for, before any
     * bytes are relayed. `bindingEnforced` is echoed on success: it is the
     * only way happy-server can tell an enforcing daemon apart from one that
     * silently ignored the binding fields.
     */
    /**
     * Same binding gate as the HTTP relay: a tunnel is a relayed request too,
     * and leaving it unchecked would make the upgrade path the way around the
     * binding.
     */
    /**
     * Bound upgrades arrive here instead. Since this event exists only for
     * them, serving it unbound would give the whole separation away.
     */
    private async openPreviewWsTunnelBound(params: any): Promise<any> {
        if (params?.binding === undefined || params?.binding === null) {
            return {
                ok: false,
                code: 'INVALID_REQUEST',
                message: 'This event carries bound preview upgrades only',
            };
        }
        return this.openPreviewWsTunnel(params);
    }

    private async openPreviewWsTunnel(params: any): Promise<any> {
        const tunnelId = typeof params?.tunnelId === 'string' ? params.tunnelId : null;
        if (!tunnelId) {
            return { ok: false, code: 'INVALID_TUNNEL', message: 'Missing tunnelId' };
        }
        const cancelled = { ok: false, code: 'CANCELLED', message: 'Tunnel was closed before it opened' };
        // Registered *before* the first await, so a close arriving mid-check
        // has something to cancel.
        const pending = { cancelled: false };
        // A duplicate id supersedes the earlier attempt rather than racing it.
        const superseded = this.previewWsPendingOpens.get(tunnelId);
        if (superseded) superseded.cancelled = true;
        this.previewWsPendingOpens.set(tunnelId, pending);
        try {
            const binding = await this.enforcePreviewBinding(params?.binding, params?.port);
            if (pending.cancelled) return cancelled;
            if (binding.outcome === 'rejected') {
                logger.debug(`[API MACHINE] proxy-ws-open refused: ${binding.code} ${binding.message}`);
                // The WS open ack is `{ok, code, message}` — not the HTTP
                // relay's `{type}` envelope (openPreviewWsTunnel reads `ok`).
                return { ok: false, code: binding.code, message: binding.message };
            }
            const opened = await this.previewWsProxy!.open(params);
            if (pending.cancelled) {
                // Cancelled while the TCP connect was in flight; previewWsProxy
                // handles that itself, but say so rather than acking success.
                this.previewWsProxy?.close(tunnelId);
                return cancelled;
            }
            // The echo rides along only on a tunnel that actually opened —
            // happy-server reads `ok` first, and a refusal carrying an
            // enforcement flag would be a confusing thing to log.
            return binding.outcome === 'enforced' && opened?.ok === true
                ? { ...opened, bindingEnforced: true }
                : opened;
        } finally {
            // The record lives exactly as long as the open does.
            if (this.previewWsPendingOpens.get(tunnelId) === pending) {
                this.previewWsPendingOpens.delete(tunnelId);
            }
        }
    }

    private closePreviewWsTunnel(tunnelId: string | undefined): void {
        if (!tunnelId) return;
        const pending = this.previewWsPendingOpens.get(tunnelId);
        if (pending) pending.cancelled = true;
        this.previewWsProxy?.close(tunnelId);
    }

    /** Daemon socket dropped: nothing in flight can still be wanted. */
    private cancelPreviewWsTunnels(): void {
        for (const pending of this.previewWsPendingOpens.values()) pending.cancelled = true;
        this.previewWsPendingOpens.clear();
        this.previewWsProxy?.closeAll();
    }

    private async relayPreviewBoundHttp(params: any): Promise<any> {
        if (params?.binding === undefined || params?.binding === null) {
            return {
                type: 'error',
                code: 'INVALID_REQUEST',
                message: 'This event carries bound preview requests only',
            };
        }
        return this.relayPreviewHttp(PREVIEW_BOUND_PROXY_EVENT, params);
    }

    private async relayPreviewHttp(event: string, params: any): Promise<any> {
        try {
            const binding = await this.enforcePreviewBinding(params?.binding, params?.port);
            if (binding.outcome === 'rejected') {
                logger.debug(`[API MACHINE] ${event} refused: ${binding.code} ${binding.message}`);
                return { type: 'error', code: binding.code, message: binding.message };
            }
            const result = await proxyHttp({
                port: params?.port,
                method: params?.method,
                path: params?.path,
                headers: params?.headers ?? {},
                bodyB64: params?.bodyB64 ?? null,
            });
            logger.debug(
                `[API MACHINE] ${event} ${params?.method} ${params?.path} -> ${result.status}${result.truncated ? ' (truncated)' : ''} binding=${binding.outcome}`,
            );
            return {
                type: 'success',
                ...result,
                ...(binding.outcome === 'enforced' ? { bindingEnforced: true } : {}),
            };
        } catch (e) {
            if (e instanceof PreviewProxyError) {
                logger.debug(`[API MACHINE] ${event} failed: ${e.code} ${e.message}`);
                return { type: 'error', code: e.code, message: e.message };
            }
            const message = e instanceof Error ? e.message : String(e);
            logger.debug(`[API MACHINE] ${event} internal error: ${message}`);
            return { type: 'error', code: 'INTERNAL', message };
        }
    }

    private async enforcePreviewBinding(
        binding: unknown,
        port: number,
    ): Promise<{ outcome: 'enforced' | 'unbound' } | { outcome: 'rejected'; code: string; message: string }> {
        if (binding === undefined || binding === null) return { outcome: 'unbound' };
        const deps = this.previewLeaseDeps();
        if (!deps) {
            // A bound request we cannot verify is refused, never relayed —
            // "could not check" is not "checked and fine".
            return {
                outcome: 'rejected',
                code: 'EVIDENCE_UNAVAILABLE',
                message: 'Daemon is not ready to verify the preview runtime binding',
            };
        }
        return enforceRelayBinding(binding, port, deps);
    }

    /**
     * Handler body of the `preview-runtime-lease` socket event (mint time).
     * Answers inside happy-server's 3 s ack window: a probe that cannot finish
     * by then is reported as EVIDENCE_BUSY rather than left to ack late.
     */
    private async answerPreviewRuntimeLease(params: any, ack: (response: any) => void): Promise<void> {
        const deps = this.previewLeaseDeps({ probeDeadlineMs: MINT_LEASE_ANSWER_DEADLINE_MS });
        if (!deps) {
            ack({
                type: 'error',
                code: 'EVIDENCE_UNAVAILABLE',
                message: 'Daemon is not ready to resolve preview runtimes',
            });
            return;
        }
        try {
            const result = await acquireRuntimeLease(
                {
                    projectId: params?.projectId,
                    port: params?.port,
                    // Workspace paths come from happy-server's
                    // authenticated studio callback, never from a
                    // browser-facing request.
                    workspacePaths: Array.isArray(params?.workspacePaths) ? params.workspacePaths : [],
                },
                deps,
            );
            logger.debug(
                `[API MACHINE] preview-runtime-lease project=${params?.projectId} port=${params?.port} -> ${result.type === 'success' ? result.evidenceKind : result.code}`,
            );
            ack(result);
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            logger.debug(`[API MACHINE] preview-runtime-lease internal error: ${message}`);
            ack({ type: 'error', code: 'EVIDENCE_UNAVAILABLE', message });
        }
    }

    /**
     * Binds the lesson hosts for this daemon.
     *
     * Late-bound because resolving a project to a workspace needs the
     * authoritative bindings the daemon accumulates as sessions start, and the
     * studio key needs credentials this client does not own. Replacing an
     * existing supervisor closes it, so a re-bind cannot leave a second store
     * open on the same project.
     */
    async setLessonHosts(hosts: LessonHostSupervisor | null): Promise<void> {
        const previous = this.lessonHosts;
        this.lessonHosts = hosts;
        if (previous && previous !== hosts) await previous.close();
    }

    setAutomationKey(key: MachineAutomationKey, persistVersion: (version: number) => void, protocolVersion: number = AUTOMATION_PROTOCOL_VERSION): void {
        this.automationKey = key;
        this.automationProtocolVersion = protocolVersion;
        this.persistAutomationKeyVersion = persistVersion;
    }

    setServerAutomationCache(cache: ServerAutomationCache): void {
        this.serverAutomationCache = cache;
    }

    shouldRunLegacyAutomationScheduler(): boolean {
        return this.automationLegacyFallbackEnabled;
    }

    serverAutomationTransport(): ServerAutomationTransport {
        return {
            claim: (input) => this.socket.emitWithAck('automation-claim', input),
            start: (input) => this.socket.emitWithAck('automation-run-start', input),
            heartbeat: (input) => this.socket.emitWithAck('automation-run-heartbeat', input),
            report: (input) => this.socket.emitWithAck('automation-run-report', input),
        };
    }

    sessionFollowupTransport(): SessionFollowupTransport {
        const normalize = async (request: Promise<{ ok: boolean; value?: unknown; error?: string }>) => {
            const response = await request;
            return response.ok
                ? { ok: true as const, value: response.value }
                : { ok: false as const, error: response.error };
        };
        return {
            sync: (input) => normalize(this.socket.emitWithAck('session-followup-sync', input)),
            claim: (input) => normalize(this.socket.emitWithAck('session-followup-claim', input)),
            evaluate: (input) => normalize(this.socket.emitWithAck('session-followup-evaluate', input)),
            deliver: (input) => normalize(this.socket.emitWithAck('session-followup-deliver', input)),
        };
    }

    /**
     * Idempotent: returns the running stack if one is already up. Shared by
     * the `browser-viewer:start` RPC and `browser-setup:launch`'s `viewer`
     * option, so "launch Chrome under the viewer" never spins up a second,
     * disconnected Xvfb (specs/browser-remote-login/).
     *
     * Runs under the same mutation as the per-user starts. Its own in-flight
     * entry only collapses concurrent callers of *this* path; both paths draw
     * displays and ports from one pool, so without the shared lock they can
     * pick the same slot and each report the other's server as their own.
     */
    private startViewerStack(
        options: { callerWillLaunchBrowser?: boolean } = {},
    ): Promise<ViewerStackStartResult> {
        const callerWillLaunchBrowser = options.callerWillLaunchBrowser ?? false;
        const inFlight = this.viewerStartInFlight;
        if (inFlight) {
            if (inFlight.callerWillLaunchBrowser === callerWillLaunchBrowser) {
                return inFlight.promise;
            }
            // A profile-launch caller intentionally defers the default Chrome,
            // while a viewer-open caller requires it. Serialize unlike modes,
            // then re-evaluate the live stack with the second caller's policy.
            return inFlight.promise.then(() => this.startViewerStack(options));
        }
        const promise = this.withIsolatedViewerMutation(() => this.startViewerStackOnce(options));
        this.viewerStartInFlight = { callerWillLaunchBrowser, promise };
        const clear = () => {
            if (this.viewerStartInFlight?.promise === promise) this.viewerStartInFlight = null;
        };
        promise.then(clear, clear);
        return promise;
    }

    private async startViewerStackOnce(
        options: { callerWillLaunchBrowser?: boolean } = {},
    ): Promise<ViewerStackStartResult> {
        const missing = missingViewerTools(await detectViewerCapabilities());
        if (missing.length > 0) {
            throw new Error(`원격 화면에 필요한 프로그램이 없습니다: ${missing.join(', ')}`);
        }
        // The cache is not evidence: the stack is spawned detached, so it both
        // outlives the daemon and can die under it. Probe before trusting it.
        const cachedAlive = this.viewer ? await isViewerServing(this.viewer.webPort) : false;
        const decision = decideViewerStackAction({
            cached: this.viewer,
            cachedAlive,
            // Scanned whenever the cache is not alive, not just when it is
            // absent — a stale entry must not stop us adopting a stack that
            // is genuinely serving, or we spawn a duplicate beside it.
            adoptable: cachedAlive ? null : await findRunningViewer(),
        });
        if (decision.action === 'reuse' && this.viewer) {
            const browser = await this.ensureViewerBrowser(
                this.viewer.display,
                options.callerWillLaunchBrowser ?? false,
            );
            return { ...this.viewer, ready: true, reused: true, ...browser };
        }
        if (decision.action === 'adopt') {
            // Left behind by a previous daemon. Re-registering it beats
            // spawning a duplicate that leaks ports until none are left.
            const adopted = { display: ':99', vncPort: null, webPort: decision.webPort };
            this.viewer = adopted;
            const browser = await this.ensureViewerBrowser(
                adopted.display,
                options.callerWillLaunchBrowser ?? false,
            );
            return { ...adopted, ready: true, reused: true, ...browser };
        }
        this.viewer = null;

        const display = ':99';
        const vncPort = await pickFreePort([...VIEWER_VNC_PORTS]);
        const webPort = await pickFreePort([...VIEWER_WEB_PORTS]);
        if (vncPort === null || webPort === null) {
            throw new Error('원격 화면에 쓸 포트를 찾지 못했습니다.');
        }
        const shared = await this.startViewerDisplay(display, vncPort, webPort);
        const websockify = spawnDetached('websockify', buildWebsockifyArgs({
            webPort, vncPort, webRoot: shared.webRoot,
        }), viewerOwnerEnv(display));
        const ready = await this.awaitViewerServing(webPort, websockify, display);
        this.viewer = { display, vncPort, webPort };
        const browser = await this.ensureViewerBrowser(display, options.callerWillLaunchBrowser ?? false);
        return { display, vncPort, webPort, ready, reused: false, ...browser };
    }

    private startIsolatedViewerStack(viewerKey: string): Promise<IsolatedViewerStartResult> {
        const inFlight = this.isolatedViewerStarts.get(viewerKey);
        if (inFlight) return inFlight;

        const promise = this.withIsolatedViewerMutation(
            () => this.startIsolatedViewerStackOnce(viewerKey),
        );
        this.isolatedViewerStarts.set(viewerKey, promise);
        const clear = () => {
            if (this.isolatedViewerStarts.get(viewerKey) === promise) {
                this.isolatedViewerStarts.delete(viewerKey);
            }
        };
        promise.then(clear, clear);
        return promise;
    }

    private async startBrokerViewer(viewerKey: string): Promise<{
        viewerKey: string
        webPort: number
        profileDir: string
        ready: true
        browserReady: true
        bridgeReady: true
        isolation: 'container'
    }> {
        if (!this.browserSessionBroker) throw new Error('browser broker is not configured');
        const authToken = await readOrCreateBrowserBridgeToken(configuration.browserBridgeTokenFile, {
            migrateFrom: configuration.legacyBrowserBridgeTokenFile,
        });
        const response = await this.browserSessionBroker.request({
            op: 'ensure',
            viewerKey,
            bridgeToken: deriveBrowserViewerBridgeToken(authToken, viewerKey),
        });
        if (!response.ok) throw new Error(response.code);
        if (!response.lease || response.lease.viewerKey !== viewerKey || !response.lease.ready) {
            throw new Error('browser-broker-owner-mismatch');
        }
        return {
            viewerKey,
            webPort: response.lease.webPort,
            profileDir: response.lease.profileVolume,
            ready: true,
            browserReady: true,
            bridgeReady: true,
            isolation: 'container',
        };
    }

    private touchBrokerViewerPort(webPort: number): void {
        if (!this.browserSessionBroker || !Number.isInteger(webPort)) return;
        const now = Date.now();
        const touchedAt = this.brokerRelayTouchedAt.get(webPort);
        if (touchedAt !== undefined && now - touchedAt < BROKER_ACTIVITY_TOUCH_INTERVAL_MS) return;
        this.brokerRelayTouchedAt.set(webPort, now);
        void this.browserSessionBroker.request({ op: 'touch-port', webPort }).then((response) => {
            if (!response.ok) logger.debug(`[API MACHINE] Browser relay activity touch failed: ${response.code}`);
        }).catch((error) => {
            logger.debug(`[API MACHINE] Browser relay activity touch failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    }

    private withIsolatedViewerMutation<T>(operation: () => Promise<T>): Promise<T> {
        const run = this.isolatedViewerMutation.then(operation, operation);
        this.isolatedViewerMutation = run.then(() => undefined, () => undefined);
        return run;
    }

    private async startIsolatedViewerStackOnce(viewerKey: string): Promise<IsolatedViewerStartResult> {
        const missing = missingViewerTools(await detectViewerCapabilities());
        if (missing.length > 0) {
            throw new Error(`원격 화면에 필요한 프로그램이 없습니다: ${missing.join(', ')}`);
        }

        const persisted = await this.isolatedViewerRegistry.get(viewerKey);
        // A miss here leads straight to SIGTERM and SIGKILL of this viewer's
        // own stack. Reopening a screen is consent to replace a dead one — not
        // a live one that lost a 1.5s probe on a loaded machine — so the
        // reuse check owes the same second look every other decision gets.
        const persistedAlive = persisted !== null && (
            await isViewerServing(persisted.webPort)
            || (await waitForViewerServing(persisted.webPort, VIEWER_CONFIRM_DEAD_MS, { pollMs: 500 })).ready
        );
        if (persisted && persistedAlive) {
            const browser = await this.ensureViewerBrowser(
                persisted.display,
                false,
                persisted.profileDir,
                viewerKey,
            );
            const next = {
                ...persisted,
                cdpPort: browser.browserReady ? browser.cdpPort : null,
                lastUsedAt: Date.now(),
            };
            await this.isolatedViewerRegistry.set(next);
            return {
                viewerKey,
                slot: next.slot,
                display: next.display,
                vncPort: next.vncPort,
                webPort: next.webPort,
                profileDir: next.profileDir,
                ready: true,
                reused: true,
                ...browser,
            };
        }

        // Its screen is gone, and this is the last moment its pids are known:
        // a websockify that is bound but no longer serving would otherwise
        // hold the slot for good, now that an unbindable port counts as
        // occupied. Reopening a screen is consent to replace it, so this one
        // needs no second opinion — unlike the records below.
        if (persisted) await this.reapViewerStack(persisted);

        const records = await this.isolatedViewerRegistry.list();
        const occupiedSlots = new Set<number>();
        for (const record of records) {
            if (record.viewerKey === viewerKey) continue;
            if (await isViewerServing(record.webPort)) { occupiedSlots.add(record.slot); continue; }
            // A free web port means websockify is gone, not that the display
            // is: an Xvnc left on the VNC port still carries this user's
            // Chrome, and the released record is the last thing that knows
            // its pids. The cmdline check inside the reap is what keeps a
            // recycled pid from being signalled.
            if (await isPortFree(record.webPort)) {
                await this.isolatedViewerRegistry.delete(record.viewerKey);
                await this.reapViewerStack(record);
                continue;
            }
            // Bound but not answering. Both of the things that follow —
            // dropping someone else's lease and ending their stack — are
            // destructive, and `isViewerServing` gives up after 1.5s, which a
            // loaded machine can eat. Ask again, patiently, before treating
            // one lost probe as proof that a screen is gone.
            if ((await waitForViewerServing(record.webPort, VIEWER_CONFIRM_DEAD_MS, { pollMs: 500 })).ready) {
                occupiedSlots.add(record.slot);
                continue;
            }
            // The record is the only note of the pids holding this port, so
            // the stack has to end with it. Nobody could reap it afterwards —
            // its owner least of all — and the slot would be occupied for the
            // life of the machine.
            await this.isolatedViewerRegistry.delete(record.viewerKey);
            await this.reapViewerStack(record);
        }
        for (const slot of VIEWER_SLOTS) {
            if (occupiedSlots.has(slot.slot)) continue;
            // Not "is someone serving noVNC here" but "can this slot's ports
            // be bound at all". A web port held by a listener that answers
            // nothing passes the serving probe as free and then refuses the
            // bind, so the slot was handed out again on every retry (walter-gpu
            // slot 1, 2026-09-21). And a free web port says nothing about the
            // display: an Xvnc still up on the VNC port has the previous
            // user's Chrome on it, and a viewer landing here would be proxied
            // straight onto their screen.
            if (!(await isPortFree(slot.webPort)) || !(await isPortFree(slot.vncPort))) {
                occupiedSlots.add(slot.slot);
                continue;
            }
            // And an Xvfb has no port at all. One left on this slot's display
            // still carries the previous user's Chrome, and an x11vnc started
            // here would attach to it and stream their windows.
            if ((await this.viewerSlotPids(slot)).length > 0) occupiedSlots.add(slot.slot);
        }

        const persistedSlot = persisted
            ? VIEWER_SLOTS.find((slot) => slot.slot === persisted.slot) ?? null
            : null;
        const slot = persistedSlot && !occupiedSlots.has(persistedSlot.slot)
            ? persistedSlot
            : selectViewerSlot(occupiedSlots);
        if (!slot) throw new Error('viewer-capacity-exhausted');
        let chosen: ViewerSlot = slot;

        const profileDir = resolveViewerProfileDir(configuration.happyHomeDir, viewerKey);
        mkdirSync(profileDir, { recursive: true, mode: 0o700 });
        const isolated = await this.startViewerDisplayOnSlot(chosen, occupiedSlots, persistedSlot);
        chosen = isolated.slot;
        const websockify = spawnDetached('websockify', buildWebsockifyArgs({
            webPort: chosen.webPort,
            vncPort: chosen.vncPort,
            webRoot: isolated.started.webRoot,
        }), viewerOwnerEnv(chosen.display));
        const ready = await this.awaitViewerServing(chosen.webPort, websockify, `slot ${chosen.slot} (${chosen.display})`);
        const browser = await this.ensureViewerBrowser(chosen.display, false, profileDir, viewerKey);
        const lease: BrowserViewerLeaseRecord = {
            viewerKey,
            slot: chosen.slot,
            display: chosen.display,
            vncPort: chosen.vncPort,
            webPort: chosen.webPort,
            cdpPort: browser.browserReady ? browser.cdpPort : null,
            profileDir,
            lastUsedAt: Date.now(),
            processIds: {
                ...isolated.started.processIds,
                ...(websockify.pid ? { websockify: websockify.pid } : {}),
            },
        };
        await this.isolatedViewerRegistry.set(lease);
        return {
            viewerKey,
            slot: chosen.slot,
            display: chosen.display,
            vncPort: chosen.vncPort,
            webPort: chosen.webPort,
            profileDir,
            ready,
            reused: false,
            ...browser,
        };
    }

    /**
     * Brings up the display and VNC server for one viewer slot.
     *
     * Two backends, chosen by what the machine has. TigerVNC's Xvnc accepts
     * the client's `SetDesktopSize`, which is the only way the remote screen
     * can become exactly the size of the user's window — noVNC otherwise
     * draws a fixed 1920x1080 desktop clipped into whatever window it gets
     * (reported 2026-09-19). Machines with only the older Xvfb + x11vnc pair
     * keep working, scaled rather than clipped.
     *
     * The window manager is not decoration: a desktop that resizes under a
     * browser window nothing re-maximizes is worse than one that does not
     * resize at all, so `selectViewerBackend` only asks for remote resizing
     * when openbox is there to refit the window.
     */
    /**
     * The display for this slot, or the next slot that will have one.
     *
     * A display can be refused for reasons no port reveals — another X server
     * already on it, its pids recorded nowhere. Failing the whole start there
     * would turn one unusable slot into no remote screen at all, so the slot
     * is marked taken and the next is tried. `slot` is reassigned, so the
     * caller records the lease against the one that actually opened.
     */
    private async startViewerDisplayOnSlot(
        slot: ViewerSlot,
        occupiedSlots: Set<number>,
        persistedSlot: ViewerSlot | null,
    ): Promise<{ slot: ViewerSlot; started: Awaited<ReturnType<ApiMachineClient['startViewerDisplay']>> }> {
        for (let candidate: ViewerSlot | null = slot; candidate; ) {
            try {
                return { slot: candidate, started: await this.startViewerDisplay(candidate.display, candidate.vncPort, candidate.webPort) };
            } catch (error) {
                occupiedSlots.add(candidate.slot);
                const next = persistedSlot && !occupiedSlots.has(persistedSlot.slot)
                    ? persistedSlot
                    : selectViewerSlot(occupiedSlots);
                if (!next) throw error;
                logger.warn(`[viewer] slot ${candidate.slot} (${candidate.display}) would not start: ${error instanceof Error ? error.message : String(error)}; trying ${next.display}`);
                candidate = next;
            }
        }
        throw new Error('viewer-capacity-exhausted');
    }

    private async startViewerDisplay(display: string, vncPort: number, webPort: number): Promise<{
        backend: ViewerBackend;
        webRoot: string;
        processIds: { xvnc?: number; xvfb?: number; x11vnc?: number };
    }> {
        const capabilities = await detectViewerCapabilities();
        const preferred = selectViewerBackend(capabilities);
        if (!preferred) {
            throw new Error(`원격 화면에 필요한 프로그램이 없습니다: ${missingViewerTools(capabilities).join(', ')}`);
        }

        const processIds: { xvnc?: number; xvfb?: number; x11vnc?: number } = {};
        try {
            return await this.startViewerDisplayOnce(display, vncPort, preferred, capabilities, processIds);
        } catch (error) {
            // Anything spawned before the failure is up with its pids in
            // nobody's lease, so nothing would ever come back for it and the
            // slot would be held for the life of the machine. Every throw
            // below is inside this, including the port waits.
            await this.reapViewerStack({ display, vncPort, webPort, processIds });
            throw error;
        }
    }

    private async startViewerDisplayOnce(
        display: string,
        vncPort: number,
        preferred: ViewerBackend,
        capabilities: Awaited<ReturnType<typeof detectViewerCapabilities>>,
        processIds: { xvnc?: number; xvfb?: number; x11vnc?: number },
    ): Promise<{ backend: ViewerBackend; webRoot: string; processIds: typeof processIds }> {
        let backend = preferred;
        let serving = false;
        if (preferred.kind === 'xvnc') {
            // Whoever holds it, a busy port makes the wait below meaningless:
            // it would report someone else's server as ours — and route this
            // viewer onto whatever display that server is showing.
            if (!(await isPortFree(vncPort))) {
                throw new Error(`원격 화면의 VNC 포트 ${vncPort} 가 이미 사용 중입니다 (${display}).`);
            }
            const xvnc = spawnDetached('Xvnc', buildXvncArgs({ display, vncPort, ...VIEWER_SCREEN }), viewerOwnerEnv(display));
            serving = await waitForPort(vncPort, 8_000) && !xvnc.exit;
            if (serving) {
                if (xvnc.pid) processIds.xvnc = xvnc.pid;
                if (capabilities.hasVncConfig) {
                    // Without this helper a paste reaches Xvnc and stops
                    // there: nothing owns the X CLIPBOARD selection.
                    spawnDetached('vncconfig', buildVncConfigArgs(), { DISPLAY: display });
                } else {
                    logger.debug('[viewer] vncconfig is missing; pasting into the remote screen will not work');
                }
            } else {
                // Installed but unable to start — a display already in use, a
                // missing font path. Say so: falling back silently reads to
                // the user as "resizing just does not work on this machine".
                logger.debug(`[viewer] Xvnc did not open ${vncPort} on ${display}; falling back to Xvfb + x11vnc`);
                if (xvnc.pid) {
                    try { process.kill(-xvnc.pid, 'SIGTERM'); } catch { /* already gone */ }
                    // Xvfb cannot take a display whose lock file is still
                    // there, and the lock goes with the process.
                    await delay(500);
                }
            }
        }
        if (!serving) {
            if (!capabilities.hasXvfb || !capabilities.hasX11vnc) {
                throw new Error('원격 화면의 디스플레이 서버를 시작하지 못했습니다.');
            }
            const xvfb = spawnDetached('Xvfb', buildXvfbArgs({ display, ...VIEWER_SCREEN }), viewerOwnerEnv(display));
            await delay(1500);
            if (xvfb.pid) processIds.xvfb = xvfb.pid;
            // An X server refuses a display that is already taken and exits.
            // Going on regardless is how the next x11vnc ends up attached to
            // whoever is still on that display, streaming their windows to
            // this viewer — the ports say nothing, an Xvfb has none.
            if (xvfb.exit) {
                throw new Error(`원격 화면의 디스플레이 ${display} 를 시작하지 못했습니다 (${describeDetachedExit(xvfb.exit)}).`);
            }
            const x11vnc = spawnDetached('x11vnc', buildX11vncArgs({ display, vncPort }), viewerOwnerEnv(display));
            if (x11vnc.pid) processIds.x11vnc = x11vnc.pid;
            // The port being up is not proof it is ours: another stack can
            // already be on this display, and then this viewer would be
            // proxied onto their screen.
            if (!await waitForPort(vncPort, 8_000) || x11vnc.exit) {
                throw new Error(`원격 화면의 VNC 서버가 ${vncPort} 를 열지 못했습니다 (${display}).`);
            }
            backend = {
                kind: 'xvfb-x11vnc',
                resizeMode: 'scale',
                windowManager: capabilities.hasWindowManager,
            };
        }

        return { backend, webRoot: this.buildViewerWebRoot(display, backend), processIds };
    }

    private buildViewerWebRoot(display: string, backend: ViewerBackend): string {
        if (backend.windowManager) {
            // Not tracked as a viewer process: openbox is a client of this
            // display and exits with it, so there is nothing extra to reap.
            const configPath = join(configuration.happyHomeDir, 'browser-viewers', 'openbox.xml');
            mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
            // Written atomically: another slot's openbox may be reading this
            // very file, and a half-written rc.xml silently falls back to
            // decorated, unmaximized windows.
            const configTemp = `${configPath}.${randomUUID()}.tmp`;
            writeFileSync(configTemp, buildOpenboxConfig());
            renameSync(configTemp, configPath);
            spawnDetached('openbox', buildOpenboxArgs({ configPath }), { DISPLAY: display });
        }

        return ensureViewerWebRoot({
            sourceRoot: resolveNovncWebRoot(),
            baseDir: join(configuration.happyHomeDir, 'browser-viewers', 'novnc-web'),
            resizeMode: backend.resizeMode,
            onFallback: (reason) => logger.debug(`[viewer] serving stock noVNC: web root mirror failed: ${reason}`),
        });
    }

    /**
     * Whether the noVNC port actually answers, and a log line when it does
     * not.
     *
     * The caller turns a false here into `ready: false`, which the studio
     * surfaces as "원격 화면이 응답하지 않습니다" rather than opening a relay
     * URL onto a port that resets every connection. Logged at warn because
     * the whole of the 2026-09-21 outage left no daemon-side trace at all:
     * the failure was only visible three layers away, as ECONNRESET in the
     * server's relay log.
     */
    private async awaitViewerServing(
        webPort: number,
        websockify: DetachedProcess,
        /** Which screen this was, for the log — never the viewer key. */
        label: string,
    ): Promise<boolean> {
        const outcome = await waitForViewerServing(webPort, VIEWER_SERVING_TIMEOUT_MS, {
            process: websockify,
        });
        if (outcome.ready) return true;
        const cause = outcome.reason === 'process-exited'
            ? `websockify ${outcome.detail}`
            : `nothing answered within ${VIEWER_SERVING_TIMEOUT_MS}ms`;
        logger.warn(`[viewer] ${label}: noVNC never came up on 127.0.0.1:${webPort} — ${cause}`);
        return false;
    }

    /**
     * Ends a viewer stack and waits for its web port to come free.
     *
     * SIGTERM returns long before the port is released, and slot selection
     * reads "still bound" as "occupied" — so without the wait a reap frees a
     * slot and then declines to use it. The escalation is what keeps the slot
     * recoverable at all: once the lease naming these pids is gone, nothing
     * else knows what is holding the port, and with three slots on a machine
     * that is a third of its capacity until it reboots.
     */
    private async reapViewerStack(slot: ViewerSlotProcesses): Promise<void> {
        if ((await this.ownedViewerGroups(slot)).length === 0) return;
        await this.signalViewerGroups(slot, 'SIGTERM');
        if (await this.waitForViewerStackGone(slot)) return;
        // Re-derived, never a list saved at SIGTERM: a pgid is a number, and a
        // group that let go in between would have its number signalled again —
        // by then possibly somebody else's.
        await this.signalViewerGroups(slot, 'SIGKILL');
        if (!await this.waitForViewerStackGone(slot)) {
            logger.warn(`[viewer] slot ${slot.display}: a viewer process survived SIGKILL; abandoning the slot`);
        }
    }

    private async signalViewerGroups(slot: ViewerSlotProcesses, signal: NodeJS.Signals): Promise<void> {
        for (const pgid of await this.ownedViewerGroups(slot)) {
            // Viewer processes are detached process-group leaders. Targeting
            // that exact group avoids touching another user's slot.
            try { process.kill(-pgid, signal); } catch { /* group already empty */ }
        }
    }

    /**
     * Both halves of letting go. The processes, because an Xvfb has no port
     * and would otherwise look gone; and the ports, because a signal returns
     * long before the kernel takes the listener back and the slot loop right
     * after this reads "still bound" as "occupied".
     */
    private async waitForViewerStackGone(slot: ViewerSlotProcesses): Promise<boolean> {
        const deadline = Date.now() + VIEWER_STOP_RELEASE_TIMEOUT_MS;
        for (;;) {
            const done = (await this.viewerSlotPids(slot)).length === 0
                && await isPortFree(slot.webPort)
                && await isPortFree(slot.vncPort);
            if (done) return true;
            if (Date.now() >= deadline) return false;
            await delay(100);
        }
    }

    /**
     * Every pid that looks like it is running this slot's stack.
     *
     * Two sources, because neither alone is enough. The lease's own pids are
     * the cheap answer, but a leader can exit while the worker it forked keeps
     * the listener — websockify does exactly that — and then `/proc/<leader>`
     * is gone. So `/proc` is swept as well, which finds a group through any
     * surviving member and also finds a stack whose pids were never recorded.
     *
     * Deliberately generous: this answers "is this slot taken", where a false
     * positive costs a slot and a false negative costs a user their screen.
     * It is not enough to kill on — see {@link ownedViewerGroups}.
     */
    private async viewerSlotPids(slot: ViewerSlotProcesses): Promise<number[]> {
        const pids = new Set<number>();
        const matchesSlot = (cmdline: string) =>
            VIEWER_PROCESS_KINDS.some((kind) => viewerProcessMatchesLease(kind, cmdline, slot));
        for (const pid of Object.values(slot.processIds ?? {}) as Array<number | undefined>) {
            if (!pid) continue;
            try {
                if (matchesSlot(await readFile(`/proc/${pid}/cmdline`, 'utf8'))) pids.add(pid);
            } catch { /* already exited */ }
        }
        let entries: string[];
        try { entries = await readdir('/proc'); } catch { return [...pids]; }
        for (const entry of entries) {
            if (!/^\d+$/.test(entry)) continue;
            try {
                if (matchesSlot(await readFile(`/proc/${entry}/cmdline`, 'utf8'))) pids.add(Number(entry));
            } catch { /* vanished mid-sweep, or another user's */ }
        }
        return [...pids];
    }

    /**
     * The process groups this daemon may end for a slot.
     *
     * A command line says which slot a process is on, not who started it:
     * `Xvfb :99` is a command anyone here can run, and the match is loose
     * enough that `tail -f /tmp/Xvfb :99` satisfies it. Good enough to
     * reserve a slot, nowhere near good enough to signal a process group —
     * which reaches that process's siblings too. So every candidate has to
     * carry this daemon's marker in its environment before its group becomes
     * a target. A viewer from an older CLI has no marker and is left alone:
     * its slot reads occupied, which loses a screen rather than someone
     * else's work.
     */
    private async ownedViewerGroups(slot: ViewerSlotProcesses): Promise<number[]> {
        const groups = new Set<number>();
        for (const pid of await this.viewerSlotPids(slot)) {
            try {
                if (!viewerEnvironClaimsSlot(await readFile(`/proc/${pid}/environ`, 'utf8'), slot.display)) continue;
                const pgid = readProcessGroupId(await readFile(`/proc/${pid}/stat`, 'utf8'));
                if (pgid !== null) groups.add(pgid);
            } catch { /* vanished, or not ours to read */ }
        }
        return [...groups];
    }

    /**
     * Puts a browser on the viewer display, or reuses the one already there.
     *
     * Without this the viewer is a black screen: Xvfb renders nothing on its
     * own, and the "원격 브라우저 화면 열기" flow never called the launch
     * path. Reuse is probed rather than cached so a browser that outlived the
     * daemon is adopted instead of a second Chrome being stacked onto the
     * same display, one per click.
     */
    private async ensureViewerBrowser(
        display: string,
        callerWillLaunchBrowser: boolean,
        profileDir?: string,
        viewerKey?: string,
    ): Promise<ViewerBrowserState> {
        if (decideViewerBrowserAction({ liveCdpPort: null, callerWillLaunchBrowser }).action === 'defer') {
            return summariseViewerBrowser({ chromeInstalled: true, cdpPort: null });
        }
        const chrome = await detectChrome();
        // Reported, never swallowed: a viewer with no Chrome serves a healthy
        // connection to an empty display, which reads as an unexplained black
        // screen (dev, 2026-08-15).
        if (!chrome) return summariseViewerBrowser({ chromeInstalled: false, cdpPort: null });

        const userDataDir = profileDir ?? resolveProfileUserDataDir(
            join(configuration.happyHomeDir, 'chrome-profiles'),
            'default',
        );
        const running = await scanChromeProcesses();
        let liveCdpPort: number | null = null;
        for (const port of CDP_PORT_RANGE) {
            if (!running.some((process) => (
                process.cdpPort === port
                && process.display === display
                && process.userDataDir === userDataDir
            ))) continue;
            if (await isCdpReachable(port)) { liveCdpPort = port; break; }
        }
        const decision = decideViewerBrowserAction({ liveCdpPort, callerWillLaunchBrowser });
        if (decision.action === 'reuse') {
            return {
                ...summariseViewerBrowser({ chromeInstalled: true, cdpPort: decision.cdpPort }),
                ...await this.pairViewerBrowser(decision.cdpPort, viewerKey),
            };
        }

        // The default profile is a Chrome singleton. If a headless or other-
        // display Chrome holds it, launching another one cannot put that
        // logged-in profile on noVNC; fail honestly instead of pairing the
        // invisible process or waiting through two doomed launch attempts.
        if (running.some((process) => process.userDataDir === userDataDir)) {
            return summariseViewerBrowser({ chromeInstalled: true, cdpPort: null });
        }

        const cdpPort = await pickFreeCdpPort();
        if (cdpPort === null) return summariseViewerBrowser({ chromeInstalled: true, cdpPort: null });
        const env = { DISPLAY: display };
        let launched = launchChrome(chrome.path, { userDataDir, cdpPort, headless: false, display, windowSize: VIEWER_SCREEN }, env);
        let up = await waitForCdp(cdpPort, 15_000);
        if (!up) {
            // Same kernel/namespace fallback the launch RPC uses.
            launched.cdpPipe.close();
            launched = launchChrome(chrome.path, {
                userDataDir,
                cdpPort,
                headless: false,
                display,
                noSandbox: true,
                windowSize: VIEWER_SCREEN,
            }, env);
            up = await waitForCdp(cdpPort, 15_000);
        }
        if (up) this.rememberBrowserCdpPipe(cdpPort, launched.cdpPipe);
        else launched.cdpPipe.close();
        const browser = summariseViewerBrowser({ chromeInstalled: true, cdpPort: up ? cdpPort : null });
        if (!browser.browserReady) return browser;
        return { ...browser, ...await this.pairViewerBrowser(cdpPort, viewerKey) };
    }

    /**
     * The shared browser-pairing contract behind both the explicit setup RPC
     * and the noVNC viewer. Keeping the existing runPairing sequence here
     * preserves extension injection, token storage, and debugger-tier checks.
     */
    private async pairBrowser(
        cdpPort: number,
        debuggerTier: boolean,
        pairingId?: string,
        viewerKey?: string,
        forceExtensionReload?: boolean,
    ): Promise<BrowserPairResult> {
        const cdpPipe = this.browserCdpPipes.get(cdpPort);
        const facts = await runPairing({
            cdpPort,
            debuggerTier,
            pairingId,
            forceExtensionReload,
            ...(viewerKey ? { viewerKey } : {}),
            ...(cdpPipe ? { browserCdpRequest: cdpPipe.request.bind(cdpPipe) } : {}),
        });
        const outcome = formatPairOutcome(facts);
        return {
            ok: outcome.ok,
            message: stripAnsi(outcome.text),
            connections: facts.connections,
            freshProfiles: facts.freshProfiles,
            debuggerTier: facts.debuggerTierActual ?? null,
        };
    }

    /** Pairing failure must not hide the login screen used to repair it. */
    private async pairViewerBrowser(cdpPort: number, viewerKey?: string): Promise<ViewerBridgeSummary> {
        try {
            const pairingId = `viewer-${cdpPort}-${randomUUID()}`;
            let result = await this.pairBrowser(cdpPort, true, pairingId, viewerKey, false);
            if (!result.ok) {
                result = await this.pairBrowser(cdpPort, true, pairingId, viewerKey, true);
            }
            return result.ok
                ? { bridgeReady: true }
                : { bridgeReady: false, bridgeMessage: result.message };
        } catch (error) {
            return {
                bridgeReady: false,
                bridgeMessage: error instanceof Error ? error.message : '브라우저 브리지를 연결하지 못했습니다.',
            };
        }
    }

    private rememberBrowserCdpPipe(cdpPort: number, cdpPipe: BrowserCdpPipe): void {
        const previous = this.browserCdpPipes.get(cdpPort);
        if (previous && previous !== cdpPipe) previous.close();
        this.browserCdpPipes.set(cdpPort, cdpPipe);
    }

    private requestServerAutomationSync(): void {
        if (!this.serverAutomationCache || this.serverAutomationSyncInFlight) return;
        const sync = syncServerAutomationDeltas({
            cache: this.serverAutomationCache,
            sync: (request) => this.socket.emitWithAck('automation-sync', request),
            ack: (request) => this.socket.emitWithAck('automation-sync-ack', request),
        }).then((result) => {
            if (result.changed > 0) logger.debug(`[API MACHINE] Applied ${result.changed} automation delta(s)`);
        }).catch((error) => {
            logger.debug(`[API MACHINE] Automation sync failed: ${error}`);
        }).finally(() => {
            this.serverAutomationSyncInFlight = null;
        });
        this.serverAutomationSyncInFlight = sync;
    }

    private async registerAutomationKey(): Promise<void> {
        this.automationLegacyFallbackEnabled = false;
        const key = this.automationKey;
        if (!key) return;
        const answer = await this.socket.emitWithAck('automation-key-register', {
            expectedKeyVersion: key.registeredKeyVersion,
            publicKey: Buffer.from(key.publicKey).toString('base64'),
            protocolVersion: this.automationProtocolVersion,
        });
        if (!answer.ok || !answer.value || !Number.isSafeInteger(answer.value.keyVersion)) {
            if (answer.error === 'feature-disabled') {
                this.automationServerKeyVersion = null;
                this.automationLegacyFallbackEnabled = true;
            }
            logger.debug(`[API MACHINE] Automation key registration unavailable: ${answer.error ?? 'invalid-response'}`);
            return;
        }
        const keyVersion = answer.value.keyVersion;
        if (keyVersion !== key.registeredKeyVersion) {
            this.persistAutomationKeyVersion?.(keyVersion);
            this.automationKey = { ...key, registeredKeyVersion: keyVersion };
        }
        this.automationServerKeyVersion = keyVersion;
        this.requestServerAutomationSync();
        await this.updateMachineMetadata((metadata) => ({
            ...(metadata || {} as any),
            automationSupport: {
                rpcAvailable: this.automationRpcAvailable,
                serverBacked: true,
                keyVersion,
                sessionFollowup: true,
                protocolVersion: this.automationProtocolVersion,
            },
        }));
    }

    private syncResumeSessionRpcRegistration(): void {
        const method = 'resume-happy-session';

        if (this.resumeSessionHandler) {
            if (!this.rpcHandlerManager.hasHandler(method)) {
                this.rpcHandlerManager.registerHandler(method, async (params: any) => {
                    const {
                        sessionId,
                        model,
                        permissionMode,
                        environmentVariables,
                        mcpCallerGrantEnvelope,
                        mcpConfigProjectId,
                        expectedConnectors,
                        additionalDirectories,
                    } = params || {};

                    if (!sessionId || typeof sessionId !== 'string') {
                        throw new Error('Session ID is required');
                    }
                    // Unlike spawn, an empty list is meaningful here: it withdraws the roots.
                    const validAdditionalDirectories = Array.isArray(additionalDirectories) && additionalDirectories.length === 0
                        ? []
                        : parseAdditionalDirectories(additionalDirectories);
                    if (
                        environmentVariables !== undefined
                        && (
                            environmentVariables === null
                            || typeof environmentVariables !== 'object'
                            || Array.isArray(environmentVariables)
                            || Object.values(environmentVariables).some((value) => typeof value !== 'string')
                        )
                    ) {
                        throw new Error('Environment variables must contain string values only');
                    }
                    if (mcpCallerGrantEnvelope !== undefined && typeof mcpCallerGrantEnvelope !== 'string') {
                        throw new Error('MCP caller grant envelope must be a string');
                    }
                    if (mcpConfigProjectId !== undefined && typeof mcpConfigProjectId !== 'string') {
                        throw new Error('MCP config project ID must be a string');
                    }
                    const validExpectedConnectors = readExpectedConnectors(expectedConnectors);

                    const handler = this.resumeSessionHandler;
                    if (!handler) {
                        throw new Error('Resume session handler not available');
                    }

                    const result = await handler(sessionId, {
                        model,
                        permissionMode,
                        environmentVariables,
                        mcpCallerGrantEnvelope,
                        mcpConfigProjectId,
                        expectedConnectors: validExpectedConnectors,
                        ...(validAdditionalDirectories !== undefined ? { additionalDirectories: validAdditionalDirectories } : {}),
                    });
                    switch (result.type) {
                        case 'success':
                            return { type: 'success', sessionId: result.sessionId };
                        case 'requestToApproveDirectoryCreation':
                            return result;
                        case 'error':
                            return result;
                    }
                });
            }
            return;
        }

        if (this.rpcHandlerManager.hasHandler(method)) {
            this.rpcHandlerManager.unregisterHandler(method);
        }
    }

    private syncRecoverSessionRpcRegistration(): void {
        const method = 'recover-happy-session';

        if (this.recoverSessionHandler) {
            if (!this.rpcHandlerManager.hasHandler(method)) {
                this.rpcHandlerManager.registerHandler(method, async (params: any) => {
                    const {
                        sessionId,
                        initialPrompt,
                        initialPromptLocalId,
                        appendSystemPrompt,
                        saycodeSystemPromptEnabled,
                        saycodePromptBlocks,
                        environmentVariables,
                        model,
                        permissionMode,
                        mcpCallerGrantEnvelope,
                        mcpConfigProjectId,
                        expectedConnectors,
                    } = params || {};
                    // Sanitize rather than throw: a preference must never abort a
                    // recovery. Non-boolean entries are dropped and a non-object value
                    // degrades to undefined (legacy master inheritance), mirroring
                    // MessageMetaSchema's catch(undefined) on the wire.
                    const sanitizedSaycodePromptBlocks = (() => {
                        if (
                            typeof saycodePromptBlocks !== 'object'
                            || saycodePromptBlocks === null
                            || Array.isArray(saycodePromptBlocks)
                        ) return undefined;
                        const blocks = Object.fromEntries(
                            Object.entries(saycodePromptBlocks as Record<string, unknown>)
                                .filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'),
                        );
                        return Object.keys(blocks).length > 0 ? blocks : undefined;
                    })();

                    if (typeof sessionId !== 'string' || !sessionId.trim()) {
                        throw new Error('Session ID is required');
                    }
                    if (typeof initialPrompt !== 'string' || !initialPrompt.trim()) {
                        throw new Error('Initial prompt must be a non-empty string');
                    }
                    if (
                        initialPromptLocalId !== undefined
                        && (typeof initialPromptLocalId !== 'string' || !initialPromptLocalId.trim())
                    ) {
                        throw new Error('Initial prompt local ID must be a non-empty string');
                    }
                    if (
                        appendSystemPrompt !== undefined
                        && (typeof appendSystemPrompt !== 'string' || appendSystemPrompt.trim().length === 0)
                    ) {
                        throw new Error('Append system prompt must be a non-empty string');
                    }
                    if (
                        saycodeSystemPromptEnabled !== undefined
                        && typeof saycodeSystemPromptEnabled !== 'boolean'
                    ) {
                        throw new Error('Saycode system prompt policy must be a boolean');
                    }
                    if (
                        environmentVariables !== undefined
                        && (
                            environmentVariables === null
                            || typeof environmentVariables !== 'object'
                            || Array.isArray(environmentVariables)
                            || Object.values(environmentVariables).some((value) => typeof value !== 'string')
                        )
                    ) {
                        throw new Error('Environment variables must contain string values only');
                    }
                    if (mcpCallerGrantEnvelope !== undefined && typeof mcpCallerGrantEnvelope !== 'string') {
                        throw new Error('MCP caller grant envelope must be a string');
                    }
                    if (
                        mcpConfigProjectId !== undefined
                        && (typeof mcpConfigProjectId !== 'string' || !mcpConfigProjectId.trim())
                    ) {
                        throw new Error('MCP config project id must be a non-empty string');
                    }

                    const handler = this.recoverSessionHandler;
                    if (!handler) {
                        throw new Error('Recover session handler not available');
                    }
                    return handler(sessionId, {
                        initialPrompt,
                        initialPromptLocalId,
                        appendSystemPrompt,
                        saycodeSystemPromptEnabled,
                        saycodePromptBlocks: sanitizedSaycodePromptBlocks,
                        environmentVariables,
                        model,
                        permissionMode,
                        mcpCallerGrantEnvelope,
                        mcpConfigProjectId,
                        expectedConnectors: readExpectedConnectors(expectedConnectors),
                    });
                });
            }
            return;
        }

        if (this.rpcHandlerManager.hasHandler(method)) {
            this.rpcHandlerManager.unregisterHandler(method);
        }
    }

    /**
     * Update machine metadata
     * Currently unused, changes from the mobile client are more likely
     * for example to set a custom name.
     */
    async updateMachineMetadata(handler: (metadata: MachineMetadata | null) => MachineMetadata): Promise<void> {
        await backoff(async () => {
            const updated = handler(this.machine.metadata);

            const answer = await this.socket.emitWithAck('machine-update-metadata', {
                machineId: this.machine.id,
                metadata: encodeBase64(encrypt(this.machine.encryptionKey, this.machine.encryptionVariant, updated)),
                expectedVersion: this.machine.metadataVersion
            });

            if (answer.result === 'success') {
                this.machine.metadata = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.metadata));
                this.machine.metadataVersion = answer.version;
                logger.debug('[API MACHINE] Metadata updated successfully');
            } else if (answer.result === 'version-mismatch') {
                if (answer.version > this.machine.metadataVersion) {
                    this.machine.metadataVersion = answer.version;
                    this.machine.metadata = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.metadata));
                }
                throw new Error('Metadata version mismatch'); // Triggers retry
            }
        });
    }

    /**
     * Update daemon state (runtime info) - similar to session updateAgentState
     * Simplified without lock - relies on backoff for retry
     */
    async updateDaemonState(handler: (state: DaemonState | null) => DaemonState): Promise<void> {
        await backoff(async () => {
            const updated = handler(this.machine.daemonState);

            const answer = await this.socket.emitWithAck('machine-update-state', {
                machineId: this.machine.id,
                daemonState: encodeBase64(encrypt(this.machine.encryptionKey, this.machine.encryptionVariant, updated)),
                expectedVersion: this.machine.daemonStateVersion
            });

            if (answer.result === 'success') {
                this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.daemonState));
                this.machine.daemonStateVersion = answer.version;
                logger.debug('[API MACHINE] Daemon state updated successfully');
            } else if (answer.result === 'version-mismatch') {
                if (answer.version > this.machine.daemonStateVersion) {
                    this.machine.daemonStateVersion = answer.version;
                    this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(answer.daemonState));
                }
                throw new Error('Daemon state version mismatch'); // Triggers retry
            }
        });
    }

    /**
     * Takes up a renewed credential — by **re-authenticating**, not by
     * relabelling.
     *
     * Two things made the obvious version wrong.
     *
     * The handshake is what presents the credential, and it reads `socket.auth`
     * at connect time, so changing only the field the constructor was given
     * left every reconnect presenting the expired token: the connection alive
     * today keeps working, and the first network flap ends the runtime in a way
     * that reads as a network fault and never resolves.
     *
     * And the live connection is **not** fine as it is. The server re-reads the
     * grant on every event against the token the handshake carried, and a
     * renewal supersedes the previous grant — after a short grace in which the
     * renewal itself is delivered over this very socket (the server's
     * `MANAGED_DAEMON_RENEWAL_GRACE_MS`). A connection still presenting the
     * old bearer is refused once that grace ends, and dropped by the server's
     * own revalidation shortly after. An earlier version of this comment
     * claimed a live socket did not need the new token; that was wrong, and
     * this is the correction.
     *
     * So the connection is dropped and the reconnect path brings it back
     * authenticated with the new bearer, re-registering its RPC methods as any
     * reconnect does. A few seconds of connection is the cost; the alternative
     * is a runtime that looks connected while every request it makes is
     * refused.
     */
    replaceToken(token: string): void {
        if (token.trim() === '') throw new Error('a machine client cannot present an empty token');
        if (token === this.token) return;
        this.token = token;
        if (!this.socket) return;
        this.socket.auth = { ...(this.socket.auth as Record<string, unknown>), token };
        // Dropped, not closed for good: `disconnect` runs the reconnect path,
        // which dials again with the auth just replaced.
        if (this.socket.connected) this.socket.disconnect();
    }

    /**
     * Stops presenting a credential that is no longer valid, and stops working.
     *
     * Called when the credential expired and no renewal replaced it. The socket
     * is closed and reconnection is not attempted: a runtime that kept retrying
     * with a dead credential would look like a connectivity failure to
     * everybody, while the real answer — this runtime is no longer authorised —
     * is one the parent already knows.
     */
    stopForExpiredCredential(): void {
        logger.debug('[API MACHINE] Managed credential expired; closing the machine socket');
        /*
         * Set **before** closing, and it outlives the close.
         *
         * Closing fires `disconnect`, and the disconnect handler is what starts
         * the reconnect loop — so without a stop that survives that event the
         * runtime immediately begins retrying with the credential that just
         * expired. `startSmartReconnect` checks this flag, which is why it is a
         * field rather than a local decision here.
         */
        this.credentialStopped = true;
        this.stopSmartReconnect();
        // The supervisor exists to restart reconnects; with no credential
        // there is nothing for it to restart them with.
        this.stopConnectionSupervisor();
        // The field is non-nullable and every other path assumes a socket
        // exists; closing is what stops the traffic, and `disconnected` is what
        // the rest of this class already checks.
        this.socket?.close();
    }

    connect() {
        const serverUrl = configuration.serverUrl.replace(/^http/, 'ws');
        logger.debug(`[API MACHINE] Connecting to ${serverUrl}`);

        this.socket = io(serverUrl, {
            transports: ['websocket'],
            auth: {
                token: this.token,
                clientType: 'machine-scoped' as const,
                machineId: this.machine.id,
                happyClient: `cli-daemon/${configuration.currentCliVersion}`
            },
            path: '/v1/updates',
            reconnection: false,
        });

        // Down until proven up: a socket that never connects has been down
        // since the moment we started dialling, not since some later event.
        this.disconnectedSince = Date.now();
        this.startConnectionSupervisor();

        this.socket.on('connect', () => {
            logger.debug('[API MACHINE] Connected to server');
            this.disconnectedSince = null;

            // The dial landed: end the cadence and return the backoff to its
            // first step so the next blip still recovers in about a second.
            this.stopSmartReconnect();
            this.reconnectAttempts = 0;

            this.updateDaemonState((state) => ({
                ...state,
                status: 'running',
                pid: process.pid,
                httpPort: this.machine.daemonState?.httpPort,
                startedAt: Date.now()
            }));
            void this.registerAutomationKey().catch((error) => {
                logger.debug(`[API MACHINE] Failed to register automation key: ${error}`);
            });

            this.rpcHandlerManager.onSocketConnect(this.socket);
            this.syncResumeSessionRpcRegistration();
            this.startKeepAlive();
        });

        this.socket.on('disconnect', (reason) => {
            logger.debug(`[API MACHINE] Disconnected from server — reason: ${reason}`);
            this.disconnectedSince = Date.now();
            // A socket that was up has no dial outstanding; a socket that
            // dropped mid-handshake has one that just resolved. Either way the
            // next tick may dial without waiting out the in-flight budget.
            this.reconnectDialStartedAt = null;
            this.rpcHandlerManager.onSocketDisconnect();
            this.stopKeepAlive();
            // Tear down any live preview WebSocket tunnels — the relay path is
            // dead once the daemon socket drops, so leave no orphan TCP
            // sockets, including opens still waiting on their binding check.
            this.cancelPreviewWsTunnels();
            // specs/remote-terminal/ Phase 2 — relay path is broken once
            // the socket drops, and the server's session map entry now
            // points at a dead socket. Kill local PTYs so no orphans
            // outlive the daemon's connection. The 30s grace timer (Q4)
            // is deferred to a future remote-terminal-detach-attach spec
            // since it requires server+daemon coordinated state for any
            // real reattach value (Phase 5 review).
            const killed = killAllDaemonTerminalSessions();
            if (killed > 0) {
                logger.debug(`[API MACHINE] Killed ${killed} terminal session(s) on disconnect`);
            }
            this.startSmartReconnect();
        });

        // Single consolidated RPC handler
        this.socket.on('rpc-request', createRpcRequestListener({
            handleRequest: (data) => this.rpcHandlerManager.handleRequest(data),
            logger: (message) => logger.debug(`[API MACHINE] ${message}`),
            onRequest: (data) => logger.debugLargeJson(`[API MACHINE] Received RPC request:`, data),
        }));

        // Plain-text preview proxy channel — happy-server relays iframe HTTP
        // requests here without encryption because it needs to inspect/rewrite
        // response bodies (HTML path rewriting) and has no access to the
        // machine encryption key anyway. Independent of the rpc-request
        // pipeline above.
        this.socket.on(
            'proxy-http-request',
            async (params: any, ack: (response: any) => void) => {
                ack(await this.relayPreviewHttp('proxy-http-request', params));
            },
        );

        // specs/runtime-isolation-hardening (H3, P1) — bound requests arrive
        // here instead. The separate event is what keeps a daemon that
        // predates runtime binding from executing them: it has no listener,
        // so the request is never run rather than run and then refused by its
        // answer. Since this event exists only for bound requests, serving it
        // unbound would give the whole separation away.
        this.socket.on(
            PREVIEW_BOUND_PROXY_EVENT as any,
            async (params: any, ack: (response: any) => void) => {
                ack(await this.relayPreviewBoundHttp(params));
            },
        );

        // Mint-time lease: happy-server asks which runtime owns the port
        // before signing a bound token. A daemon without this handler never
        // acks, and the server reports RUNTIME_BINDING_UNSUPPORTED rather than
        // quietly falling back to an unbound token.
        this.socket.on(
            'preview-runtime-lease',
            (params: any, ack: (response: any) => void) => this.answerPreviewRuntimeLease(params, ack),
        );

        // Preview WebSocket relay — raw byte tunnel for upgrades (noVNC /
        // websockify, ws, HMR). Bytes flow verbatim so the upstream performs the
        // actual WS handshake with the browser end-to-end. See previewWsProxy.ts.
        this.previewWsProxy = new PreviewWsProxy(
            { emit: (event: any, payload: any) => this.socket.emit(event, payload) },
            {
                logger: { debug: (msg: string) => logger.debug(msg) },
                onActivity: (port) => this.touchBrokerViewerPort(port),
            },
        );
        // Not attached on a managed runtime: the preview WebSocket proxy reaches the host outside
        // the RPC dispatch gate, so the allowlist there would not see it.
        if (!this.managedHandlers) this.socket.on('proxy-ws-open', async (params, ack) => {
            ack(await this.openPreviewWsTunnel(params));
        });
        // The bound variants reach the host the same way, so the same gate applies.
        if (!this.managedHandlers) this.socket.on(PREVIEW_BOUND_WS_OPEN_EVENT as any, async (params: any, ack: (response: any) => void) => {
            ack(await this.openPreviewWsTunnelBound(params));
        });
        // specs/runtime-isolation-hardening (H3, P3) — viewer-bound relays and
        // their mint-time lease. A daemon without these listeners performs no
        // side effect at all for a viewer request: no upstream connect, no
        // upstream write, no ack. That silence is the server's signal, and it
        // is the only version of "old daemon refused" that happens *before*
        // anything reaches the port.
        this.socket.on(PREVIEW_VIEWER_BOUND_PROXY_EVENT as any, async (params: any, ack: (response: any) => void) => {
            ack(await this.relayPreviewViewerBoundHttp(params));
        });
        if (!this.managedHandlers) this.socket.on(PREVIEW_VIEWER_BOUND_WS_OPEN_EVENT as any, async (params: any, ack: (response: any) => void) => {
            ack(await this.openPreviewViewerWsTunnelBound(params));
        });
        this.socket.on(
            PREVIEW_VIEWER_RUNTIME_LEASE_EVENT as any,
            (params: any, ack: (response: any) => void) => this.answerPreviewViewerRuntimeLease(params, ack),
        );
        this.socket.on('proxy-ws-data', (payload) => {
            this.previewWsProxy?.data(payload);
        });
        this.socket.on('proxy-ws-close', (payload) => {
            this.closePreviewWsTunnel(payload?.tunnelId);
        });

        // specs/remote-terminal/ Phase 2 — interactive PTY relay.
        //
        // happy-server has already gated this on userId-owns-machineId
        // (terminalRelayHandler.ts ACL) so by the time `terminal-open-fwd`
        // arrives the daemon trusts the request. The `params` blob is
        // E2EE-encrypted by the originating client with the same key the
        // rpc-call pipeline uses; we decrypt to extract cols/rows/cwd/etc.
        // PTY stdout is encrypted on this side before being forwarded as
        // `terminal-frame`, so happy-server never sees plaintext.
        const machineKey = this.machine.encryptionKey;
        const machineVariant = this.machine.encryptionVariant;
        const machineId = this.machine.id;
        // Not attached on a managed runtime: the forwarded terminal opener reaches the host outside
        // the RPC dispatch gate, so the allowlist there would not see it.
        if (!this.managedHandlers) this.socket.on('terminal-open-fwd', async (msg, ack) => {
            try {
                const { sessionId, params } = msg || {};
                if (!sessionId || typeof sessionId !== 'string') {
                    ack({ ok: false, error: 'sessionId is required' });
                    return;
                }
                // aplus-dev-studio specs/trial-auto-onboarding-budget D6 — trial
                // machines refuse shells outright; the daemon is the only layer
                // that can, because the trial user owns this daemon.
                if (resolveMachineLockdownPolicy(process.env).remoteTerminalDisabled) {
                    logger.debug('[API MACHINE] terminal-open-fwd refused: remote terminal disabled by machine policy');
                    ack({ ok: false, error: REMOTE_TERMINAL_DISABLED_ERROR });
                    return;
                }
                let opts: any = null;
                if (params && typeof params === 'string') {
                    try {
                        opts = decrypt(machineKey, machineVariant, decodeBase64(params));
                    } catch (e) {
                        logger.debug(`[API MACHINE] terminal-open-fwd decrypt failed: ${(e as Error).message}`);
                        ack({ ok: false, error: 'Failed to decrypt open params' });
                        return;
                    }
                }
                const auditUserId = typeof opts?.userId === 'string' ? opts.userId : 'remote-client';
                // specs/remote-terminal-cwd-fallback/ — never let
                // pty.spawn() chdir into a path that may not exist on
                // this daemon. decideTerminalCwd validates, auto-mkdirs
                // when safe, and falls back to homedir otherwise so the
                // user always gets a working shell instead of node-pty's
                // raw `chdir(2) failed.: No such file or directory`.
                const cwdDecision = decideTerminalCwd({
                    requested: typeof opts?.cwd === 'string' ? opts.cwd : undefined,
                    allowedRoot: this.allowedRoot,
                    homedir: homedir(),
                    fsExists: existsSync,
                    fsMkdir: (path) => mkdirSync(path, { recursive: true }),
                    validate: validatePath,
                });
                let pty: ReturnType<typeof createPtySession>;
                try {
                    pty = createPtySession({
                        userId: auditUserId,
                        shell: typeof opts?.shell === 'string' ? opts.shell : undefined,
                        args: Array.isArray(opts?.args) ? opts.args : undefined,
                        cwd: cwdDecision.cwd,
                        env: opts?.env && typeof opts.env === 'object' ? opts.env : undefined,
                        cols: Number.isInteger(opts?.cols) ? opts.cols : undefined,
                        rows: Number.isInteger(opts?.rows) ? opts.rows : undefined,
                    });
                } catch (e) {
                    const message = e instanceof Error ? e.message : String(e);
                    logger.debug(`[API MACHINE] terminal-open-fwd spawn failed: ${message}`);
                    ack({ ok: false, error: message });
                    return;
                }
                const entry = addDaemonTerminalSession(sessionId, pty, {
                    userId: auditUserId,
                    machineId,
                });
                // Emit the fallback banner BEFORE registering pty.onData
                // so the dim ANSI notice always lands ahead of the
                // shell's first prompt chunk in the terminal-frame
                // stream. Encrypt with the same machine key the regular
                // frames use; happy-server forwards untouched.
                if (cwdDecision.fallback) {
                    const banner = formatCwdFallbackBanner(cwdDecision);
                    if (banner) {
                        // The banner is an output frame like any other, so it
                        // takes seq 1 and goes into the replay buffer. Emitting
                        // it unsequenced would both break the "every frame
                        // carries a seq" contract this same ack advertises via
                        // caps.resume, and consume seq 1 on the client — which
                        // reads a missing seq as "the next one" — so the shell's
                        // first real chunk would look like a duplicate.
                        const seq = entry.output.push(banner);
                        try {
                            const data = encodeBase64(encrypt(machineKey, machineVariant, banner));
                            this.socket.emit('terminal-frame', { sessionId, seq, data });
                            recordBytesOut(sessionId, banner.length);
                        } catch (e) {
                            logger.debug(`[API MACHINE] terminal-open-fwd banner encrypt failed: ${(e as Error).message}`);
                        }
                    }
                    logger.debug(
                        `[REMOTE-TERMINAL] cwd-fallback session=${sessionId} user=${entry.userId} machine=${entry.machineId ?? '-'} ` +
                        `requested=${cwdDecision.fallback.requested} fallback=${cwdDecision.cwd} reason=${cwdDecision.fallback.reason}` +
                        (cwdDecision.fallback.error ? ` error=${JSON.stringify(cwdDecision.fallback.error)}` : ''),
                    );
                }
                // Coalescing spec: specs/platform-performance-roadmap D1 —
                // every OS-read chunk would otherwise be its own
                // encrypt+emit+relay+decrypt round trip; an output firehose
                // (yes, find /) turns into a per-chunk message storm.
                const outputCoalescer = createTerminalOutputCoalescer({
                    sessionId,
                    emit: (chunk) => {
                        /*
                         * specs/desktop-terminal-reliability/ Phase 3 — the
                         * coalesced chunk is the unit of replay, so it is what
                         * gets a seq. Buffer first, then send: a frame the
                         * client asks to replay must already be in the buffer
                         * by the time the ask can arrive.
                         */
                        const seq = entry.output.push(chunk);
                        try {
                            const data = encodeBase64(encrypt(machineKey, machineVariant, chunk));
                            this.socket.emit('terminal-frame', { sessionId, seq, data });
                        } catch (e) {
                            logger.debug(`[API MACHINE] terminal-frame encrypt failed: ${(e as Error).message}`);
                        }
                    },
                });
                pty.onData((chunk) => {
                    recordBytesOut(sessionId, chunk.length);
                    outputCoalescer.push(chunk);
                });
                pty.onExit((code, signal) => {
                    // The process is gone: ship whatever output is still
                    // buffered before the close frame, so the client's last
                    // visible output isn't silently dropped.
                    outputCoalescer.flush();
                    outputCoalescer.dispose();
                    this.socket.emit('terminal-closed', { sessionId, code, signal });
                    const closedAt = Date.now();
                    // Audit log per specs/remote-terminal/ §3 #7. Body is
                    // intentionally NOT recorded — only metadata. logger.debug
                    // writes to the daemon log file without disrupting an
                    // interactive Claude session sharing the terminal.
                    logger.debug(
                        `[REMOTE-TERMINAL] close session=${sessionId} user=${entry.userId} machine=${entry.machineId ?? '-'} ` +
                        `exitCode=${code} signal=${signal ?? 'null'} bytesIn=${entry.bytesIn} bytesOut=${entry.bytesOut} ` +
                        `durationMs=${closedAt - entry.openedAt}`,
                    );
                    removeDaemonTerminalSession(sessionId);
                });
                logger.debug(
                    `[REMOTE-TERMINAL] open session=${sessionId} user=${entry.userId} machine=${entry.machineId ?? '-'} pid=${pty.pid}`,
                );
                /*
                 * The desktop client has spoken resume/snapshot since
                 * specs/desktop-terminal-reliability/ Phase 3 but has been
                 * running in legacy mode all along, because nothing ever
                 * advertised these. Both are honoured below.
                 */
                ack({ ok: true, pid: pty.pid, caps: { resume: true, snapshot: true } });
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                logger.debug(`[API MACHINE] terminal-open-fwd internal error: ${message}`);
                ack({ ok: false, error: 'Internal error' });
            }
        });

        // Not attached on a managed runtime: forwarded terminal frames reaches the host outside
        // the RPC dispatch gate, so the allowlist there would not see it.
        if (!this.managedHandlers) this.socket.on('terminal-frame-fwd', (msg) => {
            const { sessionId, data } = msg || {};
            const entry = getDaemonTerminalSession(sessionId);
            if (!entry || typeof data !== 'string') return;
            try {
                const chunk = decrypt(machineKey, machineVariant, decodeBase64(data));
                if (typeof chunk === 'string') {
                    entry.session.write(chunk);
                    recordBytesIn(sessionId, chunk.length);
                }
            } catch (e) {
                logger.debug(`[API MACHINE] terminal-frame-fwd decrypt failed: ${(e as Error).message}`);
            }
        });

        /*
         * specs/desktop-terminal-reliability/ Phase 3 — a client that missed
         * frames (a reconnect, or a gap it noticed in the seq) asks for
         * everything after the last seq it saw.
         *
         * Not attached on a managed runtime, for the same reason as
         * terminal-frame-fwd: forwarded terminal events reach the host outside
         * the RPC dispatch gate, so the allowlist there would not see this.
         */
        if (!this.managedHandlers) this.socket.on('terminal-resume-fwd', (msg) => {
            const { sessionId, afterSeq } = msg || {};
            const entry = getDaemonTerminalSession(sessionId);
            if (!entry) return;
            const seen = Number.isFinite(afterSeq) ? Math.max(0, Math.trunc(afterSeq as number)) : 0;
            const answer = entry.output.resume(seen);
            /*
             * A resume is proof the client is still watching. Without this the
             * idle watchdog keeps counting from the last byte that actually
             * moved, and a terminal recovered at minute 14 dies at minute 15.
             */
            recordTerminalActivity(sessionId);
            try {
                if (answer.kind === 'replay') {
                    for (const frame of answer.frames) {
                        const data = encodeBase64(encrypt(machineKey, machineVariant, frame.chunk));
                        this.socket.emit('terminal-frame', { sessionId, seq: frame.seq, data });
                    }
                } else if (answer.kind === 'snapshot') {
                    const data = encodeBase64(encrypt(machineKey, machineVariant, answer.data));
                    this.socket.emit('terminal-snapshot', { sessionId, seq: answer.seq, data });
                } else if (answer.kind === 'gap') {
                    // Nothing to send that would be true. Say where the hole
                    // starts rather than letting the client believe it is current.
                    this.socket.emit('terminal-frame-gap', { sessionId, fromSeq: answer.fromSeq });
                }
            } catch (e) {
                logger.debug(`[API MACHINE] terminal-resume-fwd reply failed: ${(e as Error).message}`);
                return;
            }
            logger.debug(
                `[REMOTE-TERMINAL] resume session=${sessionId} afterSeq=${seen} answer=${answer.kind}`
                + (answer.kind === 'replay' ? ` frames=${answer.frames.length}` : ''),
            );
        });

        this.socket.on('terminal-resize-fwd', (msg) => {
            const { sessionId, cols, rows } = msg || {};
            const entry = getDaemonTerminalSession(sessionId);
            if (!entry) return;
            if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return;
            entry.session.resize(cols, rows);
        });

        this.socket.on('terminal-close-fwd', (msg) => {
            const { sessionId } = msg || {};
            const entry = getDaemonTerminalSession(sessionId);
            if (!entry) return;
            // terminate(), not kill('SIGTERM'): an interactive shell ignores
            // SIGTERM, so the old close path left a live `/bin/bash -l` and its
            // pty descriptors behind on every single terminal close
            // (specs/remote-terminal-close-leak/). terminate() escalates to
            // SIGKILL and holds its own reference to the child, so removing the
            // entry below cannot cancel the teardown.
            //
            // A graceful exit is already audited by the pty.onExit handler
            // above; only log the abnormal outcomes, so a future recurrence of
            // "close did nothing" is visible in the daemon log instead of
            // silently accumulating shells again.
            void entry.session.terminate().then((outcome) => {
                if (outcome === 'exited' || outcome === 'already-gone') return;
                logger.debug(
                    `[REMOTE-TERMINAL] terminate session=${sessionId} pid=${entry.session.pid} outcome=${outcome}`,
                );
            });
            // onExit handler clears the entry; remove explicitly in case
            // the teardown races with reconnect.
            removeDaemonTerminalSession(sessionId);
        });

        // Handle update events from server
        this.socket.on('update', (data: Update) => {
            // Machine clients should only care about machine updates
            if (data.body.t === 'update-machine' && (data.body as UpdateMachineBody).machineId === this.machine.id) {
                // Handle machine metadata or daemon state updates from other clients (e.g., mobile app)
                const update = data.body as UpdateMachineBody;

                if (update.metadata) {
                    logger.debug('[API MACHINE] Received external metadata update');
                    this.machine.metadata = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(update.metadata.value));
                    this.machine.metadataVersion = update.metadata.version;
                }

                if (update.daemonState) {
                    logger.debug('[API MACHINE] Received external daemon state update');
                    this.machine.daemonState = decrypt(this.machine.encryptionKey, this.machine.encryptionVariant, decodeBase64(update.daemonState.value));
                    this.machine.daemonStateVersion = update.daemonState.version;
                }
            } else {
                logger.debug(`[API MACHINE] Received unknown update type: ${(data.body as any).t}`);
            }
        });

        this.socket.on('connect_error', (error) => {
            logger.debug(`[API MACHINE] Connection error: ${error.message}`);
            // This is how a dial resolves when it fails. Clearing the marker
            // before rescheduling lets the next tick dial immediately instead
            // of waiting out the in-flight budget.
            this.reconnectDialStartedAt = null;
            this.startSmartReconnect();
        });

        this.socket.io.on('error', (error: any) => {
            logger.debug('[API MACHINE] Socket error:', error);
        });
    }

    private startKeepAlive() {
        this.stopKeepAlive();
        const publishKeepAlive = () => {
            const payload = {
                machineId: this.machine.id,
                time: Date.now()
            };
            if (process.env.DEBUG) {
                logger.debugLargeJson(`[API MACHINE] Emitting machine-alive`, payload);
            }
            this.socket.emit('machine-alive', payload);
            const activity = this.runtimeActivityProvider?.();
            if (activity) {
                this.updateDaemonState((state) => ({
                    ...state,
                    status: state?.status ?? 'running',
                    activity: {
                        activeSessionCount: Math.max(0, Math.floor(activity.activeSessionCount)),
                        activeAutomationCount: Math.max(0, Math.floor(activity.activeAutomationCount)),
                        reportedAt: Date.now(),
                    },
                })).catch((err) => {
                    logger.debug('[API MACHINE] Failed to publish runtime activity:', err);
                });
            }
            if (this.automationServerKeyVersion !== null) this.requestServerAutomationSync();

            // Re-detect CLI availability and push metadata update if changed
            const newAvailability = detectCLIAvailability();
            const prev = this.lastKnownCLIAvailability;
            const newResumeSupport = detectResumeSupport();
            const prevResume = this.lastKnownResumeSupport;
            const newCliVersion = packageJson.version;
            const prevCliVersion = this.lastKnownCliVersion;
            const cliAvailabilityChanged = !prev || prev.claude !== newAvailability.claude || prev.codex !== newAvailability.codex || prev.gemini !== newAvailability.gemini || prev.openclaw !== newAvailability.openclaw;
            const resumeSupportChanged = !prevResume
                || prevResume.rpcAvailable !== newResumeSupport.rpcAvailable
                || prevResume.happyAgentAuthenticated !== newResumeSupport.happyAgentAuthenticated;
            const cliVersionChanged = prevCliVersion !== newCliVersion;
            const automationSupportChanged = this.lastKnownAutomationRpcAvailable !== this.automationRpcAvailable;
            const autonomousQualityGateSupportChanged = this.lastKnownAutonomousQualityGateRpcAvailable !== this.autonomousQualityGateRpcAvailable;
            const automationServerKeyChanged = this.lastKnownAutomationServerKeyVersion !== this.automationServerKeyVersion;
            const daemonSessionStateAvailable = this.daemonSessionStateRpcAvailable && !this.managedHandlers;
            const daemonSessionStateChanged = this.machine.metadata?.daemonSessionState?.version
                !== (daemonSessionStateAvailable ? 1 : undefined);

            // Compared with what the server holds, not with a previous tick: `POST /v1/machines`
            // keeps an existing machine's metadata, so a machine first registered by a daemon that
            // predates an advertisement would otherwise never carry it. The same holds
            // for every static capability published only at startup.
            const channelSupportStale = JSON.stringify(this.machine.metadata?.channelSupport)
                !== JSON.stringify(CHANNEL_SUPPORT_CAPABILITY);
            const aiAuthSelectionStale = JSON.stringify(this.machine.metadata?.aiAuthSelection)
                !== JSON.stringify(AI_AUTH_SELECTION_CAPABILITY);

            this.syncResumeSessionRpcRegistration();

            if (cliAvailabilityChanged || resumeSupportChanged || cliVersionChanged || automationSupportChanged || autonomousQualityGateSupportChanged || automationServerKeyChanged || daemonSessionStateChanged || channelSupportStale || aiAuthSelectionStale) {
                this.lastKnownCLIAvailability = newAvailability;
                this.lastKnownResumeSupport = newResumeSupport;
                this.lastKnownCliVersion = newCliVersion;
                this.lastKnownAutomationRpcAvailable = this.automationRpcAvailable;
                this.lastKnownAutonomousQualityGateRpcAvailable = this.autonomousQualityGateRpcAvailable;
                this.lastKnownAutomationServerKeyVersion = this.automationServerKeyVersion;
                this.updateMachineMetadata((metadata) => ({
                    ...(metadata || {} as any),
                    cliAvailability: newAvailability,
                    resumeSupport: { ...newResumeSupport, rpcAvailable: !!this.resumeSessionHandler },
                    automationSupport: {
                        rpcAvailable: this.automationRpcAvailable,
                        serverBacked: this.automationServerKeyVersion !== null,
                        ...(this.automationServerKeyVersion !== null ? { keyVersion: this.automationServerKeyVersion } : {}),
                        sessionFollowup: true,
                        protocolVersion: this.automationProtocolVersion,
                    },
                    autonomousQualityGateSupport: {
                        apiVersion: 1,
                        rpcAvailable: this.autonomousQualityGateRpcAvailable,
                    },
                    additionalDirectories: ADDITIONAL_DIRECTORIES_CAPABILITY,
                    channelSupport: CHANNEL_SUPPORT_CAPABILITY,
                    aiAuthSelection: AI_AUTH_SELECTION_CAPABILITY,
                    daemonSessionState: daemonSessionStateAvailable ? { version: 1 } : undefined,
                    happyCliVersion: newCliVersion,
                })).catch((err) => {
                    logger.debug('[API MACHINE] Failed to update machine capabilities:', err);
                });
            }
        };
        publishKeepAlive();
        this.keepAliveInterval = setInterval(publishKeepAlive, 20000);
        logger.debug('[API MACHINE] Keep-alive started (20s interval)');
    }

    setRuntimeActivityProvider(provider: () => {
        activeSessionCount: number;
        activeAutomationCount: number;
    }): void {
        this.runtimeActivityProvider = provider;
    }

    /**
     * What this daemon can honestly say about its link to the server.
     *
     * Read by the daemon heartbeat so the local state file records a socket
     * that is down instead of a bare `running` that is true of the process
     * and false of everything anyone actually wants from it.
     */
    getConnectionHealth(): MachineConnectionHealth {
        const connected = this.socket?.connected === true;
        return {
            connected,
            reconnecting: this.reconnectInterval !== null,
            disconnectedForMs: connected || this.disconnectedSince === null
                ? null
                : Date.now() - this.disconnectedSince,
        };
    }

    private startConnectionSupervisor() {
        if (this.connectionSupervisorInterval) return;
        this.connectionSupervisorInterval = setInterval(() => {
            if (this.socket?.connected) {
                this.disconnectedSince = null;
                return;
            }
            if (this.disconnectedSince === null) this.disconnectedSince = Date.now();
            /*
             * A retry is already in flight, which is the ordinary shape of a
             * server that is down: not a defect, so nothing is reported.
             * `startSmartReconnect` would refuse to stack a second cadence on
             * its own — what this guard is actually for is keeping the line
             * below rare enough to mean something.
             */
            if (this.reconnectInterval) return;
            /*
             * Reached only when every edge-triggered path missed. Logged at
             * the moment of repair rather than on every tick: a line here
             * means a reconnect loop should have been running and was not,
             * which is a defect worth finding in the log, not a status beat.
             */
            const downFor = Math.round((Date.now() - this.disconnectedSince) / 1000);
            logger.debug(`[API MACHINE] Socket down ${downFor}s with nothing retrying — starting reconnect`);
            this.startSmartReconnect();
        }, CONNECTION_SUPERVISOR_INTERVAL_MS);
    }

    private stopConnectionSupervisor() {
        if (this.connectionSupervisorInterval) {
            clearInterval(this.connectionSupervisorInterval);
            this.connectionSupervisorInterval = null;
        }
    }

    private startSmartReconnect() {
        // A runtime whose credential is gone does not reconnect. Retrying would
        // present a dead bearer over and over while the parent already knows
        // this runtime is not authorised.
        if (this.credentialStopped) return;
        // Nor does one that is on its way out.
        if (this.shuttingDown) return;
        if (this.reconnectInterval) return;
        this.scheduleReconnectDial();
    }

    /** Ends the cadence and forgets any dial it was waiting on. */
    private stopSmartReconnect() {
        if (this.reconnectInterval) {
            clearTimeout(this.reconnectInterval);
            this.reconnectInterval = null;
        }
        this.reconnectDialStartedAt = null;
    }

    /**
     * True while a `socket.connect()` is still waiting for `connect` or
     * `connect_error`. Expires on its own so a handshake that resolves with
     * neither cannot wedge the cadence shut.
     */
    private isReconnectDialInFlight(): boolean {
        if (this.reconnectDialStartedAt === null) return false;
        if (Date.now() - this.reconnectDialStartedAt < RECONNECT_DIAL_TIMEOUT_MS) return true;
        this.reconnectDialStartedAt = null;
        return false;
    }

    private scheduleReconnectDial(overrideDelayMs?: number) {
        const delayMs = overrideDelayMs ?? reconnectDelayMs(this.reconnectAttempts);
        this.reconnectInterval = setTimeout(() => {
            this.reconnectInterval = null;
            /*
             * Every condition is re-read when the timer fires, not when it was
             * scheduled. A stop that arrives in between leaves this callback on
             * the queue, and it would otherwise reconnect with the credential
             * that just expired.
             */
            if (this.credentialStopped) return;
            if (this.socket.connected) {
                this.reconnectAttempts = 0;
                return;
            }
            if (this.isReconnectDialInFlight()) {
                // Stacking a second dial on an unresolved one is precisely what
                // duplicated the machine socket. Wait for this one to land.
                this.scheduleReconnectDial();
                return;
            }
            if (!shouldReconnect()) {
                logger.debug('[API MACHINE] Still not ready to reconnect');
                // Not a failed dial: `reconnectAttempts` stays where it is, so
                // the backoff cannot pace this branch. Poll on its own clock
                // instead of re-asking `shouldReconnect()` every base delay for
                // as long as the machine stays shut.
                this.scheduleReconnectDial(RECONNECT_NOT_READY_POLL_MS);
                return;
            }
            this.reconnectAttempts += 1;
            this.reconnectDialStartedAt = Date.now();
            logger.debug(`[API MACHINE] Attempting reconnect (attempt ${this.reconnectAttempts})`);
            this.socket.connect();
            this.scheduleReconnectDial();
        }, delayMs);
    }

    private stopKeepAlive() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
            logger.debug('[API MACHINE] Keep-alive stopped');
        }
    }

    shutdown() {
        logger.debug('[API MACHINE] Shutting down');
        // Set before anything can fire `disconnect`, and never cleared: the
        // close below wakes the disconnect handler, which would otherwise start
        // the reconnect cadence right back up.
        this.shuttingDown = true;
        this.stopKeepAlive();
        this.machineResourceService.stop();
        this.stopConnectionSupervisor();
        for (const cdpPipe of this.browserCdpPipes.values()) cdpPipe.close();
        this.browserCdpPipes.clear();
        this.stopSmartReconnect();
        if (this.socket) {
            this.socket.close();
            logger.debug('[API MACHINE] Socket closed');
        }
    }
}

/** How long a freshly spawned websockify gets to answer on its web port. */
const VIEWER_SERVING_TIMEOUT_MS = 15_000;

/** How long a signalled viewer process gets to let go of its port. */
const VIEWER_STOP_RELEASE_TIMEOUT_MS = 3_000;

/** How long another viewer's screen gets to prove it is still there. */
const VIEWER_CONFIRM_DEAD_MS = 3_000;

/** Chrome's conventional CDP port, then a small range for extra profiles. */
const CDP_PORT_RANGE = [9222, 9223, 9224, 9225, 9226, 9227, 9228] as const;

/**
 * A distinct CDP port per profile. Reusing one port makes the second Chrome
 * fail to expose CDP at all, which surfaces later as an unexplainable
 * pairing timeout (specs/browser-setup-gui/ AC5).
 */
async function pickFreeCdpPort(): Promise<number | null> {
    for (const port of CDP_PORT_RANGE) {
        if (await isPortFree(port)) return port;
    }
    return null;
}

type RunningChrome = {
    cdpPort: number | null;
    userDataDir: string | null;
    display: string | null;
};

/** Chrome process facts that CDP itself does not expose. */
async function scanChromeProcesses(): Promise<RunningChrome[]> {
    let entries: string[];
    try {
        entries = await readdir('/proc');
    } catch {
        return [];
    }
    const running: RunningChrome[] = [];
    for (const pid of entries) {
        if (!/^\d+$/.test(pid)) continue;
        try {
            const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8');
            const port = readFlagFromCmdline(cmdline, '--remote-debugging-port');
            if (port === null) continue;
            const explicitDisplay = readFlagFromCmdline(cmdline, '--display');
            running.push({
                cdpPort: Number(port) || null,
                userDataDir: readFlagFromCmdline(cmdline, '--user-data-dir'),
                display: explicitDisplay
                    ?? readDisplayFromEnviron(await readFile(`/proc/${pid}/environ`, 'utf8')),
            });
        } catch {
            // The process may exit between listing /proc and reading it.
        }
    }
    return running;
}

/** Chrome needs a moment before its CDP endpoint answers. */
async function waitForCdp(cdpPort: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await isCdpReachable(cdpPort)) return true;
        await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return false;
}

function runShell(command: string): Promise<{ ok: boolean; output: string }> {
    return new Promise((resolve) => {
        exec(command, { timeout: 300_000 }, (error, stdout, stderr) => {
            resolve({ ok: !error, output: `${stdout}${stderr}`.trim() });
        });
    });
}

/** The CLI formatter colours its output; the app renders plain text. */
function stripAnsi(text: string): string {
    return text.replace(/\u001b\[[0-9;]*m/g, '');
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** First free port from the candidate list, or null when all are taken. */
async function pickFreePort(candidates: number[]): Promise<number | null> {
    for (const port of candidates) {
        if (await isPortFree(port)) return port;
    }
    return null;
}

/**
 * A viewer stack left running by a previous daemon, if any.
 *
 * Checks that the port actually serves noVNC rather than merely being bound —
 * adopting an unrelated service would hand the user someone else's page as
 * their browser screen.
 */
async function findRunningViewer(): Promise<{ webPort: number } | null> {
    for (const webPort of VIEWER_WEB_PORTS) {
        if (await isViewerServing(webPort)) return { webPort };
    }
    return null;
}

/**
 * Whether something is listening yet — the display server takes a moment to
 * bind.
 *
 * Only for the VNC port, which speaks no HTTP and so cannot be probed for
 * content. The noVNC web port has a real answer to ask for and uses
 * {@link waitForViewerServing} instead: a bind check there called a dead
 * listener ready and handed the user a screen that reset on open.
 */
/**
 * What it takes to find a slot's processes: the three facts every viewer
 * command line carries, and the pids if anyone wrote them down. A slot on its
 * own satisfies it, which is what lets an unrecorded stack be found.
 */
type ViewerSlotProcesses = {
    display: string;
    vncPort: number;
    webPort: number;
    processIds?: BrowserViewerLeaseRecord['processIds'];
};

/** The facts a relay token is minted on: which slot, and which websockify. */
function sameViewerLease(a: BrowserViewerLeaseRecord, b: BrowserViewerLeaseRecord): boolean {
    return a.viewerKey === b.viewerKey
        && a.slot === b.slot
        && a.webPort === b.webPort
        && a.display === b.display
        && a.processIds?.websockify === b.processIds?.websockify;
}

/** The other direction: waits for a signalled holder to let a port go. */
async function waitForPortRelease(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await isPortFree(port)) return true;
        if (Date.now() >= deadline) return false;
        await delay(100);
    }
}

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!(await isPortFree(port))) return true;
        await delay(300);
    }
    return false;
}

/**
 * Where the distro put noVNC's client assets. Debian/Ubuntu's `novnc`
 * package uses /usr/share/novnc; the tarball install commonly lands in
 * /usr/share/webapps/novnc. Falling back to the first existing path keeps
 * websockify from serving a 404 page that looks like a broken relay.
 */
function resolveNovncWebRoot(): string {
    const candidates = ['/usr/share/novnc', '/usr/share/webapps/novnc', '/usr/local/share/novnc'];
    return candidates.find((path) => existsSync(path)) ?? candidates[0];
}
