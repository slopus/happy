import { DIFFICULTY_CLASSIFIER_REVISION } from './difficultyRoutingArtifacts';
import { healInstallArtifacts } from './installArtifactsHeal';
import fs from 'fs/promises';
import os from 'os';
import * as tmp from 'tmp';
import axios from 'axios';
import * as z from 'zod';
import { AUTOMATION_PROTOCOL_VERSION, SCRIPT_AUTOMATION_PROTOCOL_VERSION } from '@slopus/happy-wire';
import { createHash } from 'node:crypto';
import { createScriptAutomationWorker, ScriptRequestError } from './automations/scriptAutomationWorker';
import { prepareManagedScriptRuntime, recoverManagedScriptContainers } from './automations/managedScriptRuntime';
import { runManagedScript } from './automations/managedScriptRunner';

import { ApiClient } from '@/api/api';
import { TrackedSession, SessionEncryptionData } from './types';
import { MachineMetadata, DaemonState, Metadata, Machine } from '@/api/types';
import {
  type RecoverSessionOptions,
  type RecoverSessionResult,
  type ResumeSessionResult,
  type SpawnSessionOptions,
  type SpawnSessionResult,
} from '@/modules/common/registerCommonHandlers';
import { logger } from '@/ui/logger';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { configuration } from '@/configuration';
import { startCaffeinate, stopCaffeinate } from '@/utils/caffeinate';
import packageJson from '../../package.json';
import { getEnvironmentInfo } from '@/ui/doctor';
import { captureSpawnOutputStdio, preflightInstalledHappyCLI, spawnHappyCLI, startDetachedHappyCLI } from '@/utils/spawnHappyCLI';
import {
  writeDaemonState,
  writeDaemonStateDebounced,
  flushDaemonState,
  DaemonLocallyPersistedState,
  PersistedTrackedSession,
  readDaemonState,
  acquireDaemonLock,
  readDaemonLockHolderPid,
  releaseDaemonLock,
  isPidAlive,
  readPersistedSessions,
  persistSession,
  readCredentials,
} from '@/persistence';
import { decideResumeCredentials, readStagedTokenFromHomeDir, tokensShareIdentity } from './resumeCredentials';

import { cleanupDaemonState, isDaemonRunningCurrentlyInstalledHappyVersion, stopDaemon } from './controlClient';
import { preflightDaemonControlServer, startDaemonControlServer } from './controlServer';
import { BrowserBridge } from './browserBridge';
import { BrowserSessionBrokerClient } from './browserSessionBrokerContract';
import { getDaemonTerminalSessionCount } from './daemonTerminalSessions';
import { startBrowserBridgeServer, DEFAULT_BROWSER_BRIDGE_PORT, resolveBrowserBridgeHost } from './browserBridgeServer';
import { readOrCreateBrowserBridgeToken } from './browserBridgeToken';
import { prepareBrowserNativeMessaging, registerBrowserNativeHost } from './browserNativeHostRegistration';
import { resolveExtensionDir, resolveExtensionId } from '@/commands/browser';
import { handoffToReplacedBundle, prepareDaemonStartup, resolveStatePreservation } from './handoff';
import { resolveDaemonStateOwnership } from './daemonStateOwnership';
import { createPortRegistry } from './portRegistry';
import { stageUserCredentials, unstageUserCredentials, sweepOrphanUserHomeDirs } from './stageUserCredentials';
import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { projectPath } from '@/projectPath';
import { getTmuxUtilities, isTmuxAvailable, parseTmuxSessionIdentifier, formatTmuxSessionIdentifier } from '@/utils/tmux';
import { expandEnvironmentVariables } from '@/utils/expandEnvVars';
import {
  AI_AUTH_SELECTION_CAPABILITY,
  applyAppliedAiAuthSourceEnv,
  applyConfirmedPromptDeliveryFlag,
  buildManagedSessionSpawnEnvironment,
  buildResumedSessionSpawnEnvironment,
  buildSpawnRequestEnvironment,
  captureSaycodeAgentEnvironment,
  honorsManagedAiCredentials,
  overlayManagedCredentialEnvironment,
  SESSION_LINEAGE_ENV_PREFIXES,
  stripManagedCredentialConflicts,
  verifyAiAuthSelection,
} from './sessionEnv';
import type { AiAuthSource } from '@/usage/aiAuthSource';
import { detectCLIAvailability } from '@/utils/detectCLI';
import { buildResumeLaunch } from '@/resume/handleResumeCommand';
import { detectResumeSupport } from '@/resume/localHappyAgentAuth';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import {
  DIFFICULTY_ROUTING_MAX_INPUT_CHARS,
  DIFFICULTY_ROUTING_MAX_INPUT_TOKENS,
  DIFFICULTY_ROUTING_POLICY_VERSION,
} from '@/difficultyRouting';
import {
  DifficultyRoutingClassifierHost,
  createDifficultyRoutingHostKey,
  type DifficultyRoutingRelayRequest,
} from './difficultyRoutingClassifierHost';
import {
  resolveInheritedSpawnEnvironment,
  resolveRegularSpawnAgentArgs,
  resolveTmuxSpawnAgentCommand,
  shouldFilterSpawnCredentials,
} from './spawnAgentCommand';
import { applyServerSessionSnapshot, parseServerSessionSnapshot, type ServerSessionSnapshot } from './serverSessionSnapshot';
import {
  buildReconnectSessionEnvironment,
  hasReliableResumeBaseline,
  resolveResumeBaselineSeq,
} from './reconnectSessionEnv';
import {
  decideAutomationResumePreflight,
  hasLiveDaemonChild,
  resolveAutomationDirectoryMatch,
  shareInFlight,
} from './resumeGuards';
import { decideResumeCursorPersist } from './resumeCursorPersistence';
import { stageInitialPromptEnvironment } from '@/utils/initialPrompt';
import {
  removeDeferredContinuationContextFile,
  stageDeferredContinuationContext,
  sweepOrphanDeferredContinuationContextFiles,
} from '@/utils/deferredContinuationContext';
import {
  reportSandboxDependencyPreflight,
  reportSandboxExecutionPreflight,
} from '@/sandbox/dependencyPreflight';
import { startLogHousekeeping } from '@/ui/logHousekeepingRunner';
import {
  readDaemonSessionIdleReaperConfig,
  runDaemonSessionIdleReaperTick,
  readIdleStopGuardConfig,
  evaluateIdleStopGuard,
  evaluateBusyOnlyStopGuard,
  resolveStopSessionMode,
  restoreSessionStartTimes,
  readEmptySessionReaperMs,
  sweepEmptySessions,
  sweepZombieSessions,
  type StopSessionContext,
  type StopSessionResult,
} from './sessionIdleReaper';
import { createBrowserTaskSessionBroker, spawnResumedWithBrowserTaskRegistration, startBrowserTaskReconciliation, type BrowserTaskSessionBroker } from './browserTaskBroker';
import { findBrowserAttentionSession, startBrowserAttentionWatcher } from './browserAttentionDelivery';
import {
  createProcFs,
  createProcProcessProbe,
  stopSessionWithVerifiedExit,
} from './sessionExitVerification';
import {
  resolveOrphanAdoption,
  collectStartupOrphans,
  resolveTrackedPidOwner,
  resolveRecoveredPendingPromotion,
  decideRecoveredPendingWebhook,
  classifyRecoveredTrackedProcess,
} from './orphanAdoption';
import {
  hydrateRecoveredSessionFromPersisted,
  hydrateTrackedSessionFromPersisted,
  mergeTrackedSessionWebhook,
} from './persistedSessionHydration';
import { resolveManagedRuntimeIdentity, managedProvisioningPath } from './managedRuntimeIdentity';
import { createDaemonSessionStateHandler } from './daemonSessionState';
import { acquireManagedWriterLock } from './managedWriterLock';
import {
    inspectManagedDaemonStateLayout,
    managedDaemonStateDir,
} from './managedDaemonStateLayout';
import { createManagedReceiptStore } from './managedReceiptStore';
import { createByosOfflineReceiveWiring } from '@/daemon/byosOfflineReceiveWiring';
import { createManagedRpcHandlers, type ManagedChildExitNote, type ManagedRpcHandlers, type ManagedRuntimeFacts } from './managedRpcHandlers';
import { createManagedAiAuthStore } from '@/managed/managedAiAuthStore';
import {
  decideManagedStopRoute,
  launchManagedSpawn,
  stopManagedGeneration,
} from './managedSpawnLaunch';
import { createManagedLaunchRegistry } from './launch/managedLaunchRegistry';
import { createManagedReportAuthority } from './launch/managedReportCredential';
import { createManagedReportVerifier } from './launch/verifyManagedReport';
import { teardownManagedRuntime as runManagedTeardown } from './managedTeardown';
import { createAutomationStore } from './automations/automationStore';
import { rebaseAutomationsOnLaunch } from './automations/automationDomain';
import { runAutomationTick } from './automations/automationTick';
import { createLessonHostSupervisor } from '@/memory/lessonHostSupervisor';
import { applyLessonLaunchEnvironment } from '@/memory/lessonLaunchEnvironment';
import {
  createLessonReviewOutcomeStore,
  lessonReviewOutcomePath,
  lessonSettingsPath,
} from '@/memory/lessonSettingsStore';
import { createLessonGrantVerifier, lessonGrantAudience, type LessonGrantVerifier } from '@/memory/lessonGrantVerifier';
import { fetchLessonGrantPublicKey, requestLessonSnapshotGrant } from '@/memory/lessonHostRuntime';
import { createAutomationTickRunner } from './automations/automationTickRunner';
import {
  decideAutomationAwareHandoff,
  resumeAutomationRunnersAfterFailedHandoff,
} from './daemonHandoffAutomationGate';
import { runAutomationScript } from './automations/runAutomationScript';
import { queryGithubPullRequestFiles, queryGithubPullRequests } from './automations/queryGithubPullRequests';
import { queryGithubIssues } from './automations/queryGithubIssues';
import {
  isGithubTriggerWorktreeDirectoryInUse,
  prepareGithubTriggerWorktree,
  removeGithubTriggerWorktree,
} from './automations/githubTriggerWorktree';
import {
  createGithubIssueProgressMarker,
  removeGithubIssueProgressMarker,
  resolveGithubIssueProgressMarkerIdentity,
} from './automations/githubIssueProgressMarker';
import {
  dispatchAutomationAgentTask,
  maintainAutomationAgentTaskLease,
} from './automations/automationAgentTaskBridge';
import {
  loadOrCreateMachineAutomationKey,
  updateMachineAutomationKeyRegistration,
} from './automations/machineAutomationKey';
import {
  createServerAutomationCache,
  decryptSessionFollowupDaemonPayload,
  decryptServerAutomationPayload,
} from './automations/serverAutomationCache';
import { createServerAutomationRuntimeStore } from './automations/serverAutomationRuntimeStore';
import { fetchAutomationProjectEnvironment } from './automations/automationProjectEnvironment';
import {
  runServerAutomationTick,
  type ServerAutomationExecutorInput,
} from './automations/serverAutomationExecutor';
import {
  createSessionFollowupSyncState,
  runSessionFollowupTick,
  type EncryptedFollowupMessage,
} from './automations/sessionFollowupRunner';
import {
  exchangeAutomationMcpCallerGrant,
  linkAutomationProjectSession,
  linkSpawnedProjectSession,
  type AutomationMcpSpawnContext,
} from './automations/automationMcpCallerGrant';
import { preflightAutomationConnectors } from './automations/automationConnectorPreflight';
import { resolveDaemonAllowedRoot } from '@/modules/common/resolveAllowedRoot';
import { getProcessStartedAt } from '@/utils/processStartTime';
import { waitForSessionWebhook } from './spawnWebhookWait';
import { persistExplicitStep } from '@/orchestrator/state/persistExplicitStep';
import { materializeSpawnBootstrapFiles } from './materializeSpawnBootstrapFiles';
import tweetnacl from 'tweetnacl';
import {
  injectMcpCallerGrant,
  McpCallerGrantEnvelopeConsumer,
  prepareMcpChildEnvironment,
} from './mcpCallerGrantEnvelope';
import { createClaudeSwapSupervisor } from './claudeSwapSupervisor';
import { createNodeAiCredentialRuntime } from './aiCredentialRuntime';
import { resolveReconnectableSession, type ReconnectableHappySession } from '@/resume/resolveHappySession';
import { claudeCheckSession } from '@/claude/utils/claudeCheckSession';
import { CodexAppServerClient } from '@/codex/codexAppServerClient';
import {
  classifyRecoveryLookupError,
  decideUntrackedSessionRecovery,
} from './sessionRecovery';
import {
  ADDITIONAL_DIRECTORIES_CAPABILITY,
  prepareAdditionalDirectories,
  reapplyAdditionalDirectoriesOnResume,
} from './additionalDirectories';
import { mergeAdditionalDirectoriesIntoSandboxEnvironment } from '@/utils/additionalDirectoriesEnv';
import {
  injectCheckpointSpawnContext,
  readCheckpointSpawnContext,
} from '@/checkpoint/checkpointSpawnContext';
import {
  createCheckpointRpcHandlers,
  type CheckpointRpcSessionAuthority,
} from '@/checkpoint/checkpointRpc';
import { createCheckpointEventPublisher } from '@/checkpoint/checkpointEventPublisher';
import { resolveCheckpointSessionAuthority } from './checkpointSessionAuthority';
import { restartCheckpointProtectedSession } from './checkpointProtectedRestart';
import { stopServerProcess } from './stopServer';
import { AutonomousQualityGateRunStore } from './autonomousQualityGateStore';
import { AutonomousQualityGateDaemonRegistry } from './autonomousQualityGateRegistry';
import {
  mergeCumulativeRuntimeCounter,
  runtimeReportBelongsToTrackedProcess,
  shouldAcceptSessionRuntimeReport,
} from './sessionRuntimeCounters';
import { captureAutonomousWorktreeFingerprint } from './autonomousQualityGateFingerprint';
import { runAutonomousQualityGatePhase } from './autonomousQualityGateRunner';
import { sendAutonomousQualityGateRepair } from './autonomousQualityGateMessageSender';
import { createAutonomousQualityGateRpcHandlers } from './autonomousQualityGateRpc';
import { resolveManagedFilesystemFacts } from '@/managed/managedRuntimeFacts';
import { readManagedRestoreState } from '@/managed/managedRestoreState';
import { resolveManagedVolumeBinding } from '@/managed/managedVolumeBinding';
import {
    observeManagedVolume,
    readFsUuidForDevice,
    readMountinfoText,
} from '@/managed/managedRuntimeObserver';
import { verifyOpenPathDevice } from '@/managed/managedRuntimeDurability';
import { MANAGED_PROJECT_ROOT } from './managedRuntimeIdentity';
import { createManagedSupervisorReadiness } from './managedSupervisorReadiness';
import { readManagedLauncherBinding } from './launch/managedLauncherBinding';
import {
  readManagedDaemonCredential,
  replaceManagedDaemonCredential,
} from './managedDaemonCredential';
import { readManagedCredentialAction } from './managedCredentialWatch';
import { enforceLeaseRenewal } from './managedGenerationRearm';
import { systemMonotonicNow } from '@/launcher/supervisor';
import { createLauncherClient, createUnixSocketRequest } from './launch/launcherClient';
import { defaultProvisioningDeps } from './managedRuntimeIdentity';

/** Shell-escape a string for safe interpolation into tmux commands. */
function shellescape(s: string): string {
    return "'" + s.replace(/'/g, "'\\''") + "'";
}

// Prepare initial metadata
// Suffix host with `-dev` for the HAPPY_VARIANT=dev variant so the dev daemon
// is visually distinct from the stable one in the machine list (they otherwise
// share the same hostname and look identical).
const hostSuffix = process.env.HAPPY_VARIANT === 'dev' ? '-dev' : '';
export const initialMachineMetadata: MachineMetadata = {
  host: os.hostname() + hostSuffix,
  platform: os.platform(),
  happyCliVersion: packageJson.version,
  homeDir: os.homedir(),
  happyHomeDir: configuration.happyHomeDir,
  happyLibDir: projectPath(),
  cliAvailability: detectCLIAvailability(),
  resumeSupport: { ...detectResumeSupport(), rpcAvailable: true },
  automationSupport: {
    rpcAvailable: true,
    sessionFollowup: true,
    protocolVersion: AUTOMATION_PROTOCOL_VERSION,
  },
  additionalDirectories: ADDITIONAL_DIRECTORIES_CAPABILITY,
  /*
   * Only engines that can do *both* halves: register the channel RPCs, and produce an
   * authoritative final answer the channel may relay.
   *
   * `grok` (and every other ACP agent) registers the RPCs but is deliberately absent. ACP's
   * `AgentMessage` model output carries only `textDelta`/`fullText` — no phase, no final marker —
   * and `AcpBackend.sendPrompt` discards the `PromptResponse` whose `stopReason` is the one
   * authoritative terminal it does receive. Without a per-segment final marker there is no way to
   * tell an answer from commentary, and R14 does not allow guessing, so ACP is unsupported rather
   * than approximately supported. See the spec notes for the concrete work that would change it.
   */
  /*
   * Two different questions, and only one of them has its own list.
   *
   * `engines` is who can execute an external channel turn — and, because a runtime that executes
   * one also publishes its approval waits, it is equally the set that emits `channel-permission`
   * with `kind: 'desktop-only'` (R8/R9). Both Claude and Codex do; Gemini and the ACP handler do
   * neither, which is why they are absent.
   *
   * `approvals.engines` is the narrower question: who can have a prompt *answered* from a
   * messenger. Only Claude. The prompt→turn binding, the one-shot consume and the dedicated
   * `channel-permission` RPC live in the Claude launcher's ordered queue
   * (`claude/claudeRemoteLauncher.ts` + `channel/channelPermissionWiring.ts`). Codex reaches its
   * approvals through `codexAppServerClient`'s own request/response methods, registers no
   * dedicated RPC, and binds every observed prompt as unanswerable — so listing it here would
   * advertise a button whose answers have no route.
   */
  channelSupport: {
    protocolVersion: 1,
    engines: ['claude', 'codex'],
    approvals: { protocolVersion: 1, engines: ['claude'] },
  },
  aiAuthSelection: AI_AUTH_SELECTION_CAPABILITY,
};

/**
 * The host owns this call's deadline and passes its own signal: recomputing one here from
 * `request.deadlineAt` would read an absolute instant produced on another machine, and a v2
 * request has no such field at all. The body echoes the negotiated contract so the server can
 * refuse a signed v2 grant presented as v1.
 */
async function authorizeDifficultyRoutingRequest(request: DifficultyRoutingRelayRequest, signal: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(`${resolveAplusDifficultyRoutingOrigin()}/api/me/difficulty-routing/validate-grant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Happy-Client': `cli-coding-session/${configuration.currentCliVersion}`,
      },
      body: JSON.stringify({
        signedGrant: request.signedGrant,
        requestId: request.requestId,
        sourceMachineId: request.sourceMachineId,
        hostMachineId: request.hostMachineId,
        hostProcessKeyId: request.hostProcessKeyId,
        policyRevision: request.policyRevision,
        ...(request.timingVersion === 2 ? { timingVersion: 2 as const, remainingMs: request.remainingMs } : {}),
      }),
      signal,
    });
    if (!response.ok) return false;
    const body = await response.json().catch(() => null) as { ok?: unknown } | null;
    return body?.ok === true;
  } catch {
    return false;
  }
}

/**
 * `unavailable` is deliberately distinct from `disabled`: a deployment that
 * does not serve this A+ route at all (no `HAPPY_APLUS_MCP_CONFIG_URL`, so the
 * origin falls back to the web app) answers 404 forever, and the poll below
 * must be able to tell that apart from an org that simply has not elected this
 * machine. Only the first deserves backoff.
 */
type DifficultyRoutingHostElection = 'enabled' | 'disabled' | 'unavailable';

async function readDifficultyRoutingHostElection(input: {
  machineId: string;
  hostProcessKeyId: string;
  token: string;
}): Promise<DifficultyRoutingHostElection> {
  try {
    const response = await fetch(`${resolveAplusDifficultyRoutingOrigin()}/api/me/difficulty-routing/host-election`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.token}`,
        'Content-Type': 'application/json',
        'X-Happy-Client': `cli-coding-session/${configuration.currentCliVersion}`,
      },
      body: JSON.stringify({
        machineId: input.machineId,
        hostProcessKeyId: input.hostProcessKeyId,
      }),
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return 'unavailable';
    const body = await response.json().catch(() => null) as { ok?: unknown; enabled?: unknown } | null;
    if (body?.ok !== true) return 'unavailable';
    return body.enabled === true ? 'enabled' : 'disabled';
  } catch {
    return 'unavailable';
  }
}

export const DIFFICULTY_ROUTING_ELECTION_POLL_MS = 15_000;
const DIFFICULTY_ROUTING_ELECTION_MAX_POLL_MS = 15 * 60_000;

/**
 * Doubling delay while the route stays unreachable, capped at 15 minutes. A
 * daemon pointed at a deployment without the route issues a handful of
 * requests an hour instead of 240, and still notices within 15 minutes when
 * the route comes back.
 */
export function nextDifficultyRoutingElectionDelayMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return DIFFICULTY_ROUTING_ELECTION_POLL_MS;
  return Math.min(
    DIFFICULTY_ROUTING_ELECTION_POLL_MS * 2 ** consecutiveFailures,
    DIFFICULTY_ROUTING_ELECTION_MAX_POLL_MS,
  );
}

export function startDifficultyRoutingElectionPoll(input: {
  host: DifficultyRoutingClassifierHost;
  machineId: string;
  hostProcessKeyId: string;
  token: string;
}): () => void {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let consecutiveFailures = 0;
  const refresh = async () => {
    const election = await readDifficultyRoutingHostElection({
      machineId: input.machineId,
      hostProcessKeyId: input.hostProcessKeyId,
      token: input.token,
    });
    if (disposed) return;
    consecutiveFailures = election === 'unavailable' ? consecutiveFailures + 1 : 0;
    input.host.setEnabled(election === 'enabled');
    timer = setTimeout(() => { void refresh(); }, nextDifficultyRoutingElectionDelayMs(consecutiveFailures));
    timer.unref?.();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (timer) clearTimeout(timer);
    timer = null;
    process.off('exit', dispose);
    input.host.setEnabled(false);
  };
  void refresh();
  process.once('exit', dispose);
  return dispose;
}

function resolveAplusDifficultyRoutingOrigin(): string {
  const configured = process.env.HAPPY_APLUS_MCP_CONFIG_URL;
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // Fall through to the configured web app URL.
    }
  }
  return configuration.webappUrl;
}

/**
 * The advertised difficulty-routing block must come from THIS run, not from
 * whatever the server still has stored. `createDifficultyRoutingHostKey()`
 * mints a fresh box keypair on every daemon start and `POST /v1/machines`
 * leaves an already-registered machine's metadata untouched, so spreading the
 * stored block here would republish the previous run's hostProcessKeyId and
 * hostProcessPublicKey forever — clients would keep sealing relay requests to
 * a public key whose secret key died with the previous process. Everything
 * outside the block is still the server's to keep.
 */
export function buildDifficultyRoutingMetadataUpdate(input: {
  stored: MachineMetadata | null;
  baseMetadata: MachineMetadata;
  ready: boolean;
}): MachineMetadata {
  return {
    ...(input.stored ?? input.baseMetadata),
    difficultyRouting: {
      ...input.baseMetadata.difficultyRouting!,
      ready: input.ready,
    },
  };
}

function startDifficultyRoutingMetadataPoll(input: {
  apiMachine: { updateMachineMetadata(handler: (metadata: MachineMetadata | null) => MachineMetadata): Promise<void> };
  host: DifficultyRoutingClassifierHost;
  baseMetadata: MachineMetadata;
}): void {
  let disposed = false;
  let lastReady: boolean | null = null;
  const refresh = async () => {
    const ready = input.host.capability().ready;
    if (disposed || ready === lastReady) return;
    lastReady = ready;
    try {
      await input.apiMachine.updateMachineMetadata((metadata) => buildDifficultyRoutingMetadataUpdate({
        stored: metadata,
        baseMetadata: input.baseMetadata,
        ready,
      }));
    } catch {
      lastReady = null;
    }
  };
  void refresh();
  const timer = setInterval(() => { void refresh(); }, 5_000);
  timer.unref?.();
  process.once('exit', () => {
    disposed = true;
    clearInterval(timer);
  });
}

/**
 * Whether this daemon runs script automations.
 *
 * Managed runtimes do not. The script worker prepares and recovers its own
 * Docker containers and ticks on its own schedule, none of which goes through
 * `spawnSession` — so the lease, epoch and budget checks that admit a managed
 * run never see that work. The decision gates the whole initialisation rather
 * than the tick, which is what keeps `prepare` and `recover` from running and
 * leaves the automation protocol advertised at its legacy version.
 *
 * BYOS is unchanged: without the managed marker this is the same feature flag
 * it has always been.
 */
export function shouldRunScriptAutomations(input: {
    managedRuntimeActive: boolean;
    enabled: string | undefined;
}): boolean {
    if (input.managedRuntimeActive) return false;
    return input.enabled === '1';
}

export async function startDaemon(): Promise<void> {
  // The daemon can be auto-(re)started by any happy CLI child — including a
  // resumed/forked session that carries HAPPY_RECONNECT_*/HAPPY_FORK* in its
  // environment. Those variables are per-spawn instructions, not daemon
  // state; if they survive here they leak into every child we spawn and all
  // new sessions reconnect to one poisoned session (2026-07-19 incident).
  for (const key of Object.keys(process.env)) {
    if (SESSION_LINEAGE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      logger.debug(`[DAEMON RUN] Scrubbing inherited session lineage env: ${key}`);
      delete process.env[key];
    }
  }

  // 이 머신이 샌드박스를 쓸 수 있는지 기동 시점에 한 번 확인한다. checkDependencies()
  // 는 원래 initialize() 안에서만 불려서, 의존성이 빠진 머신은 AgentTask 워커가 실제로
  // 뜰 때까지 그 사실을 몰랐다 — 증상은 몇 분 뒤 네트워크 호출 실패로 나타나 원인과
  // 멀리 떨어졌다(2026-08-28: socat 부재).
  reportSandboxDependencyPreflight();

  // 의존성이 다 있어도 비특권 컨테이너에서는 감싼 자식이 namespace 생성에서 죽는다
  // (2026-09-10 기본 Docker 프로브). 격리가 필수인 머신에서만, 실제로 감싼 명령을
  // 한 번 돌려 그 사실을 기동 로그에 남긴다 — 활성화 판단의 근거다. 진단이므로
  // 실패해도 데몬 기동을 막지 않는다.
  void reportSandboxExecutionPreflight();

  // We don't have cleanup function at the time of server construction
  // Control flow is:
  // 1. Create promise that will resolve when shutdown is requested
  // 2. Setup signal handlers to resolve this promise with the source of the shutdown
  // 3. Once our setup is complete - if all goes well - we await this promise
  // 4. When it resolves we can cleanup and exit
  //
  // In case the setup malfunctions - our signal handlers will not properly
  // shut down. We will force exit the process with code 1.
  let requestShutdown: (source: 'happy-app' | 'happy-cli' | 'os-signal' | 'exception', errorMessage?: string) => void;
  let resolvesWhenShutdownRequested = new Promise<({ source: 'happy-app' | 'happy-cli' | 'os-signal' | 'exception', errorMessage?: string })>((resolve) => {
    requestShutdown = (source, errorMessage) => {
      logger.debug(`[DAEMON RUN] Requesting shutdown (source: ${source}, errorMessage: ${errorMessage})`);

      // Fallback - in case startup malfunctions - we will force exit the process with code 1
      setTimeout(async () => {
        logger.debug('[DAEMON RUN] Startup malfunctioned, forcing exit with code 1');

        // Give time for logs to be flushed
        await new Promise(resolve => setTimeout(resolve, 100))

        process.exit(1);
      }, 1_000);

      // Start graceful shutdown
      resolve({ source, errorMessage });
    };
  });

  // Setup signal handlers
  process.on('SIGINT', () => {
    logger.debug('[DAEMON RUN] Received SIGINT');
    requestShutdown('os-signal');
  });

  process.on('SIGTERM', () => {
    logger.debug('[DAEMON RUN] Received SIGTERM');
    requestShutdown('os-signal');
  });

  process.on('uncaughtException', (error) => {
    logger.debug('[DAEMON RUN] FATAL: Uncaught exception', error);
    logger.debug(`[DAEMON RUN] Stack trace: ${error.stack}`);
    requestShutdown('exception', error.message);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.debug('[DAEMON RUN] FATAL: Unhandled promise rejection', reason);
    logger.debug(`[DAEMON RUN] Rejected promise:`, promise);
    const error = reason instanceof Error ? reason : new Error(`Unhandled promise rejection: ${reason}`);
    logger.debug(`[DAEMON RUN] Stack trace: ${error.stack}`);
    requestShutdown('exception', error.message);
  });

  process.on('exit', (code) => {
    logger.debug(`[DAEMON RUN] Process exiting with code: ${code}`);
  });

  process.on('beforeExit', (code) => {
    logger.debug(`[DAEMON RUN] Process about to exit with code: ${code}`);
  });

  logger.debug('[DAEMON RUN] Starting daemon process...');
  logger.debugLargeJson('[DAEMON RUN] Environment', getEnvironmentInfo());

  const startupDisposition = await prepareDaemonStartup({
    preflightCandidate: preflightDaemonControlServer,
    runningVersionMatches: isDaemonRunningCurrentlyInstalledHappyVersion,
    stopRunningDaemon: async () => {
      // TODO: This hand-rolled self-restart path is awkward to reason about and awkward to test.
      // We should probably migrate this daemon to native system service management
      // (launchd/systemd, similar to OpenClaw's model), so startup/start-at-login and upgrades
      // are owned by the OS instead of by the daemon trying to replace itself in-process.
      logger.debug('[DAEMON RUN] Daemon version mismatch detected, restarting daemon with current CLI version');
      // Snapshot before the stop: the daemon we're about to stop runs its own
      // shutdown code, and older ones delete the state file outright — with it
      // goes the only record of the live sessions we're inheriting.
      const before = await readDaemonState();
      await stopDaemon();
      const restored = resolveStatePreservation({ before, after: await readDaemonState() });
      if (restored) {
        writeDaemonState(restored);
        logger.debug(
          `[DAEMON RUN] Previous daemon removed its state file on stop; restored ${restored.trackedSessions?.length ?? 0} session record(s) for recovery`,
        );
      }
    },
  });
  if (startupDisposition === 'already-running') {
    logger.debug('[DAEMON RUN] Daemon version matches, keeping existing daemon');
    console.log('Daemon already running with matching version');
    process.exit(0);
  }

  // Acquire exclusive lock (proves daemon is running)
  const daemonLockHandle = await acquireDaemonLock(5, 200);
  if (!daemonLockHandle) {
    logger.debug('[DAEMON RUN] Daemon lock file already held, another daemon is running');
    process.exit(0);
  }

  // At this point we should be safe to startup the daemon:
  // 1. Not have a stale daemon state
  // 2. Should not have another daemon process running

  let stopLogHousekeeping: () => void = () => undefined;
  let stopClaudeSwapSupervisor: () => void = () => undefined;
  let stopScriptWorker: () => Promise<void> = async () => undefined;
  let stopBrowserAttention: () => Promise<void> = async () => undefined;
  try {
    // npm 12 blocks install scripts it was not told to allow, so a plain
    // `npm i -g` can leave the postinstall artifacts behind. Restore them before
    // any RPC (ripgrep, terminal) can need them. Never throws.
    await healInstallArtifacts();

    // Start caffeinate
    const caffeinateStarted = startCaffeinate();
    if (caffeinateStarted) {
      logger.debug('[DAEMON RUN] Sleep prevention enabled');
    }

    /*
     * ── Which kind of machine this is, decided before any authentication ──
     *
     * The ordinary path authenticates a **person**: with no credential on disk
     * it opens an interactive flow, and it invents a machine id with
     * `randomUUID()`. Neither is right in a cloud runtime — there is nobody at a
     * terminal, and the parent already registered this runtime's Machine and
     * holds its id. A daemon that generated its own would publish readiness on
     * an address nobody is listening on.
     *
     * So the marker is read first and the branch is taken here. It has to be
     * *before* the auth call rather than after it: after, a managed runtime
     * whose credential was missing would already have run the person's flow.
     */
    const managedMarkerPath = managedProvisioningPath();
    const managedIdentity = resolveManagedRuntimeIdentity(managedMarkerPath);
    if (managedIdentity.status === 'refused') {
      // Two different refusals share this branch: a marker that exists and
      // cannot be trusted, and — on Linux with no marker at all — a path where
      // one could be planted (`absenceRefusal`). The detail names which
      // component refused, and without it a BYOS operator is told about a
      // marker that is not there.
      throw new Error(
        `[managed] runtime identity refused (${managedIdentity.reason}`
        + `${managedIdentity.detail ? `: ${managedIdentity.detail}` : ''}); refusing to start`,
      );
    }
    const managedCredential = managedIdentity.status === 'active'
      ? readManagedDaemonCredential({
        stateDir: managedIdentity.identity.stateDir,
        // The marker says which Machine this runtime is; the credential is
        // compared against it rather than believed.
        expectedMachineId: managedIdentity.identity.happyMachineId,
        now: Date.now(),
        deps: defaultProvisioningDeps,
      })
      : null;
    if (managedCredential && !managedCredential.ok) {
      // Never a fallback. "No managed credential" must not become "authenticate
      // as a person instead", which ends with a cloud runtime holding an
      // account bearer that reaches every session on that account.
      throw new Error(
        `[managed] daemon credential unusable (${managedCredential.reason}); refusing to start`,
      );
    }

    // Ensure auth and machine registration BEFORE anything else
    const { credentials, machineId, serverPublicKey } = managedCredential?.ok
      ? {
        credentials: {
          token: managedCredential.credential.token,
          encryption: {
            type: 'dataKey' as const,
            publicKey: managedCredential.credential.accountPublicKey,
            machineKey: managedCredential.credential.machineKey,
          },
        },
        machineId: managedCredential.credential.machineId,
        serverPublicKey: null,
      }
      : await authAndSetupMachineIfNeeded();
    logger.debug('[DAEMON RUN] Auth and machine setup complete');

    // ── Managed runtime admission, decided before anything can accept work ──
    //
    // This runs ahead of the control server, the RPC listener and session
    // restoration on purpose. Deciding later leaves a window in which the
    // legacy spawn entry points are already reachable on a runtime that should
    // never have served them.
    //
    // Resolved exactly once: a later edit to the provisioning file cannot flip
    // a running daemon's mode. `refused` does not fall back to BYOS — a marker
    // that exists but cannot be trusted is a downgrade attempt, and reopening
    // the legacy path is the outcome it is after.
    let managedWriterLockHeld = false;
    /**
     * T07-L1b: the managed receipt learns what the daemon already knows about
     * its child — verified runtime reports (turns, idle) and the pid vanishing.
     * Assigned once the handlers exist; before that there is no receipt to tell.
     */
    let managedNoteSessionRuntime: ((sessionId: string, pid: number, report: {
      assistantTurns?: number; lastTurnEndAt?: number;
      thinking: boolean; hasOpenToolCall: boolean; pendingUserInput: boolean;
    }) => void) | null = null;
    let managedNoteChildExited: ((pid: number) => ManagedChildExitNote) | null = null;
    /**
     * The runtime's own view of itself, for a status read.
     *
     * Nothing here is cached as "ready": the mount is re-read, the completion
     * record is re-read through its trusted path, and the isolation backend is
     * asked again. A status that answered from a snapshot would keep saying
     * ready after the thing it described stopped being true.
     */
    let managedRuntimeFacts: () => ManagedRuntimeFacts | Promise<ManagedRuntimeFacts> = () => ({
      filesystem: { ok: false, reason: 'root-not-mounted' },
      restore: { status: 'pending', checkpointId: null, manifestDigest: null },
      isolation: { verified: false, backend: 'privileged-launch-supervisor' },
    });
    /**
     * The privileged launch backend, if this runtime has one.
     *
     * It is not created here: the supervisor is a **separate root process**
     * that owns the IPC socket, the watchdog and the durable manifest, and it
     * outlives this daemon on purpose — killing the daemon must not become an
     * unbounded lease extension. What happens here is only that the daemon
     * finds it and speaks to it.
     *
     * It stays `null` when the trusted boot path left no binding. That is
     * fail-closed and it is deliberate: every handler that needs a proof
     * refuses without one, which is the right answer, whereas a daemon that
     * invented a backend would answer "proven stopped" about generations that
     * are still running.
     */
    let managedFencingBackend: ReturnType<typeof createLauncherClient> | null = null;
    let releaseManagedWriterLock: (() => Promise<void>) | null = null;
    if (managedIdentity.status === 'active') {
      const lock = await acquireManagedWriterLock({ runtimeId: managedIdentity.identity.runtimeId });
      if (!lock.ok) {
        // Never steal and never guess: another writer may hold the receipts.
        throw new Error(`[managed] writer lock unavailable (${lock.reason}); refusing to start`);
      }
      managedWriterLockHeld = true;
      releaseManagedWriterLock = lock.release;

      // The address in the marker has to be the machine this daemon actually
      // registered as. A provisioner that wrote one id while the daemon
      // registered another leaves the parent publishing readiness for a
      // machine nobody is listening on — and, worse, possibly for somebody
      // else's. Compared here rather than trusted, and a mismatch refuses the
      // start rather than degrading to the legacy path.
      if (managedIdentity.identity.happyMachineId !== machineId) {
        throw new Error(
          '[managed] provisioned Happy machine id does not match the registered machine; refusing to start',
        );
      }


      /*
       * Where the supervisor is comes from the **canonical state directory**
       * the provisioning marker named, written there by the trusted boot path
       * before the agent uid existed. There is no environment fallback: an
       * inherited value is chosen by whoever started this process, and a daemon
       * pointed at somebody else's socket is told whatever that socket likes.
       *
       * The boot token stops here. It is handed to the client and never put
       * into the environment a provider later inherits.
       */
      const launcher = readManagedLauncherBinding({
        stateDir: managedIdentity.identity.stateDir,
        deps: defaultProvisioningDeps,
      });
      let readinessLauncher: Parameters<typeof createManagedSupervisorReadiness>[0]['launcher'] = null;
      if (launcher.ok) {
        const client = createLauncherClient({
          token: launcher.binding.token,
          deps: createUnixSocketRequest(launcher.binding.socketPath),
        });
        managedFencingBackend = client;
        readinessLauncher = { binding: launcher.binding, hello: client.hello };
        logger.debug('[managed] privileged launch backend bound');
      } else {
        // Named, not detailed: the reason is a fixed classifier, and the paths
        // and token behind it are not log material.
        logger.debug(`[managed] no privileged launch backend (${launcher.reason})`);
      }

      const supervisorReadiness = createManagedSupervisorReadiness({
        admitted: managedIdentity,
        markerPath: managedMarkerPath,
        launcher: readinessLauncher,
      });
      const observeSupervisorReadiness = async () => {
        const observation = await supervisorReadiness.observe();
        if (!observation.verified) {
          try { logger.debug(`[managed] supervisor readiness ${observation.reason}`); }
          catch { /* Diagnostic failure cannot change the readiness result. */ }
        }
        return observation;
      };
      await observeSupervisorReadiness();

      /*
       * The volume seal: written **once**, on the boot that observed it.
       *
       * The provider id comes from the marker only root can write, and the
       * device and filesystem identity are observed here — the runtime cannot
       * derive the first and the parent cannot see the other two, which is why
       * the three are bound together rather than any one of them being taken
       * as the answer. An unobservable volume seals nothing: not knowing is
       * not evidence, and a seal written on a guess is what would later let a
       * volume full of real work be called freshly initialised.
       */
      const identityForFacts = managedIdentity.identity;
      const volume = await resolveManagedVolumeBinding({
        stateDir: identityForFacts.stateDir,
        providerVolumeId: identityForFacts.providerVolumeId,
        observe: () => observeManagedVolume({ projectRoot: MANAGED_PROJECT_ROOT }),
        deps: defaultProvisioningDeps,
      });
      if (!volume.ok) {
        logger.debug(`[managed] volume not bound (${volume.reason})`);
      }

      /*
       * A status read answers with what this daemon can actually verify, and
       * verifies it **again on every read**.
       *
       * Nothing below is cached: the mount table is re-read, the filesystem
       * identity is re-read, the completion record is re-read through its
       * trusted path, and the isolation backend is asked again. A status that
       * answered from a snapshot would keep saying ready after the volume was
       * detached or the backend stopped answering — and the parent dispatches
       * on that answer.
       *
       * Without a seal every axis stays at its fail-closed value. That is not
       * a degraded mode to be improved by assuming something: a runtime that
       * cannot say which volume it is on has nothing to compare a record to.
       */
      const bound = volume.ok ? volume.binding : null;
      managedRuntimeFacts = async () => {
        const observation = await observeSupervisorReadiness();
        return {
          filesystem: bound === null
            ? { ok: false, reason: 'volume-evidence-unavailable' }
            : resolveManagedFilesystemFacts({
              mountinfo: readMountinfoText() ?? '',
              projectRoot: MANAGED_PROJECT_ROOT,
              binding: bound,
              readFsUuid: (device) => readFsUuidForDevice(device),
              verifyOpenDevice: verifyOpenPathDevice,
            }),
          restore: bound === null
            ? { status: 'pending', checkpointId: null, manifestDigest: null }
            : readManagedRestoreState({
              stateDir: identityForFacts.stateDir,
              // The record is read **against the volume that is mounted now**,
              // not against the one it claims to describe. A record beside a
              // different filesystem is a record about something else.
              volume: { volumeId: bound.providerVolumeId, deviceUuid: bound.fsUuid },
              deps: defaultProvisioningDeps,
            }),
          isolation: {
            verified: observation.verified,
            backend: identityForFacts.isolation.backend,
          },
        };
      };
      logger.debug(`[managed] runtime ${managedIdentity.identity.runtimeId} admitted`);
    }
    let machineAutomationKey = loadOrCreateMachineAutomationKey(configuration.automationKeyFile);
    const mcpCallerGrantKeyPair = tweetnacl.box.keyPair();
    const difficultyRoutingHostKey = createDifficultyRoutingHostKey();
    const difficultyRoutingHost = new DifficultyRoutingClassifierHost(difficultyRoutingHostKey, {
      authorize: authorizeDifficultyRoutingRequest,
    });
    const difficultyRoutingMachineMetadata: MachineMetadata = {
      ...initialMachineMetadata,
      difficultyRouting: {
        version: 1,
        protocol: DIFFICULTY_ROUTING_POLICY_VERSION,
        hostProcessKeyId: difficultyRoutingHostKey.id,
        hostProcessPublicKey: encodeBase64(difficultyRoutingHostKey.publicKey),
        // Advertised from the base metadata, not only from `host.capability()`: the readiness
        // refresh rebuilds `difficultyRouting` from this object, so anything missing here is
        // dropped the first time readiness changes.
        timingVersions: [1, 2],
        maxRelayTtlMs: 3000,
        classifier: {
          kind: 'transformers-binary',
          modelMaxInputTokens: DIFFICULTY_ROUTING_MAX_INPUT_TOKENS,
          maxInputChars: DIFFICULTY_ROUTING_MAX_INPUT_CHARS,
          onnxSha256: '444c99b6f4d417e50859f73e1557db11943a2ad073ce4050a65f1b7d39403038',
          tokenizerJsonSha256: 'acadd7d076a55a97edf9fb0521a0a2e9cf8cbbdd62e4d793f2aa3d1900916356',
          revision: DIFFICULTY_CLASSIFIER_REVISION,
        },
        limits: {
          concurrency: 1,
          queueSize: 8,
          requestDeadlineMs: 1000,
        },
      },
    };
    const mcpCallerGrantConsumer = new McpCallerGrantEnvelopeConsumer({
      machineId,
      secretKey: mcpCallerGrantKeyPair.secretKey,
    });

    // Setup state - key by PID
    const pidToTrackedSession = new Map<number, TrackedSession>();
    /**
     * Generations this daemon launched through the supervisor, by pid.
     *
     * The daemon's ordinary stop path signals a pid; for these it must not.
     * Keeping the key here is what lets that path tell the two apart.
     */
    const managedGenerationForPid = new Map<number, { runId: string; attemptId: string; epoch: number }>();
    /**
     * Which launch each managed report is allowed to be. Filled between the
     * supervisor's two phases and read by the control server's verifier.
     */
    const managedLaunchRegistry = createManagedLaunchRegistry();
    /**
     * The control server's port, read at launch rather than captured.
     *
     * The dispatch surface is built before the server is listening; a value
     * captured here would be the one from before it had a port.
     */
    let managedControlPortValue = 0;
    const managedControlPort = () => managedControlPortValue;
    /** Who may report, keyed by generation. Revoked wherever one stops. */
    const managedReportAuthority = createManagedReportAuthority({
      discard: (launchId) => managedLaunchRegistry.discard(launchId),
    });
    /**
     * The backend, with report authority revoked on every stop that reaches it.
     *
     * Wrapped rather than added at each call site: this is the one place every
     * backend stop passes through, and a stop path that forgot to revoke is
     * exactly the gap this closes. Revoked **before** the stop is requested —
     * after it, a report racing the request would still be admitted.
     */
    const managedReportRevokingBackend = (
      backend: NonNullable<typeof managedFencingBackend>,
    ) => ({
      ...backend,
      requestStop: async (input: { runId: string; attemptId: string; epoch: number; pgid: number | null }) => {
        managedReportAuthority.revoke(input);
        return backend.requestStop(input);
      },
    });
    /**
     * The wall-clock instant a launch may report until: its write lease, and
     * nothing added to it.
     *
     * An earlier version put a floor under this so a nearly-expired lease still
     * left the child room to say it started. That floor could exceed the lease,
     * which is authority to report for a generation that has lost the right to
     * write — the very thing binding to the lease was meant to prevent. A lease
     * with no room left is a launch that should not have happened, and
     * `prepare` already refuses one that is gone.
     */
    /**
     * The one monotonic clock the managed daemon reads.
     *
     * `leaseExpiresMonotonic` crosses to the supervisor, which enforces it
     * against `systemMonotonicNow` (`/proc/uptime`, system-wide). The daemon
     * used `process.hrtime.bigint()` — also monotonic, but read from a
     * different clock domain (`CLOCK_MONOTONIC`) with its own arbitrary
     * origin, and one that counts suspension differently from boot-time
     * uptime. Neither origin is knowable from the other, so two readers of the
     * same deadline are comparing two different numbers; that is not a skew
     * that averages out, it is two different deadlines. Reading one shared
     * function removes the assumption rather than estimating the offset.
     * (No Fly suspend has been reproduced here — the domains differ on paper
     * and that is enough reason not to mix them.)
     *
     * Both daemon sites read this, so they cannot drift apart from each other
     * either — moving only one would extend report authority past the lease
     * it is supposed to be bound to.
     */
    const managedMonotonicNow = (): number => systemMonotonicNow();
    const managedReportExpiryFor = (leaseExpiresMonotonic: number): number =>
      Date.now() + (leaseExpiresMonotonic - managedMonotonicNow());
    const managedReportVerifier = createManagedReportVerifier({
      registry: managedLaunchRegistry,
      now: Date.now,
    });
    // Only placeholders restored from the previous daemon belong here. A new
    // spawn in this process still has a live webhook awaiter and must retain
    // PENDING_SPAWN_OWNER protection until that webhook arrives.
    const recoveredPendingSpawnStartedAt = new Map<number, number>();
    const unverifiedRecoveredHomeDirs: string[] = [];
    const unverifiedRecoveredContextFiles: string[] = [];
    // When a session was adopted from a previous daemon, keyed by PID. Feeds the
    // idle guard's grace window — an adopted session keeps its real age, so it
    // can be reap-eligible the instant it is adopted.
    const pidToAdoptedAt = new Map<number, number>();
    const deadSessionsToCleanup: PersistedTrackedSession[] = [];

    // Read once and share: session recovery, the orphan home-dir sweep and the
    // finished-session map all need the same snapshot, and nothing writes
    // sessions.json in between.
    const persistedSessions = readPersistedSessions();

    // Recover sessions from previous daemon run
    const previousState = await readDaemonState();
    if (previousState?.trackedSessions?.length) {
      logger.debug(`[DAEMON RUN] Found ${previousState.trackedSessions.length} sessions from previous daemon (state: ${previousState.state || 'unknown'})`);
      for (const persisted of previousState.trackedSessions) {
        const processIdentity = classifyRecoveredTrackedProcess({
          pid: persisted.pid,
          recordedStartedAt: persisted.startedAt,
          isPidAlive,
          getProcessStartedAt,
        });
        if (processIdentity === 'verified') {
          const recovered: TrackedSession = {
            // The state file records who and where, but not the session's
            // encryption or resume cursor. Without them preserveSessionForResume
            // bails, so the reaper would later kill this session without ever
            // writing its cursor to disk and resume would refuse for good
            // (2026-08-15 incident). sessions.json has both.
            ...(persisted.happySessionId
              ? hydrateTrackedSessionFromPersisted(persistedSessions[persisted.happySessionId])
              : {}),
            startedBy: persisted.startedBy,
            pid: persisted.pid,
            directory: persisted.directory,
            happySessionId: persisted.happySessionId,
            resumeTargetSessionId: persisted.resumeTargetSessionId,
            tmuxSessionId: persisted.tmuxSessionId,
            // The state file's staged home dir is the more current one; fall
            // back to the persisted record rather than clobbering it.
            ...(persisted.userHomeDir ? { userHomeDir: persisted.userHomeDir } : {}),
            ...(persisted.deferredContinuationContextFile
              ? { deferredContinuationContextFile: persisted.deferredContinuationContextFile }
              : {}),
          };
          pidToTrackedSession.set(persisted.pid, recovered);
          if (!persisted.happySessionId) {
            recoveredPendingSpawnStartedAt.set(persisted.pid, persisted.startedAt);
          }
          logger.debug(`[DAEMON RUN] Recovered alive session PID ${persisted.pid}, sessionId: ${persisted.happySessionId || 'pending'}`);
        } else if (processIdentity === 'unverified') {
          if (persisted.userHomeDir) unverifiedRecoveredHomeDirs.push(persisted.userHomeDir);
          if (persisted.deferredContinuationContextFile) {
            unverifiedRecoveredContextFiles.push(persisted.deferredContinuationContextFile);
          }
          logger.debug(
            `[DAEMON RUN] Skipped unverified previous session PID ${persisted.pid}, sessionId: ${persisted.happySessionId || 'pending'}`,
          );
        } else {
          deadSessionsToCleanup.push(persisted);
          logger.debug(
            `[DAEMON RUN] Previous session PID ${persisted.pid} is ${processIdentity} (sessionId: ${persisted.happySessionId || 'pending'})`,
          );
        }
      }
    } else if (!previousState) {
      // Silence here used to hide the whole failure: a lost state file looks
      // exactly like a first-ever start, so sessions orphaned by the previous
      // daemon left no trace in the log. Adoption below still recovers them —
      // this line is what makes the recovery visible when it happens.
      logger.debug('[DAEMON RUN] No previous daemon state found; any sessions left by a previous daemon must be adopted');
    }

    // Sweep stale /tmp/happy-session-* directories from previous runs. Any
    // directory we don't claim through a live tracked session is removed so
    // credentials and logs don't accumulate across crashes or ungraceful
    // restarts.
    try {
      const liveHomeDirs = Array.from(pidToTrackedSession.values())
        .map((s) => s.userHomeDir)
        .filter((d): d is string => typeof d === 'string');
      // Resumable sessions keep their staged identity across restarts
      // (2026-07-23 incident) — their dirs are claimed, not orphans.
      const resumableHomeDirs = Object.values(persistedSessions)
        .map((s) => s.userHomeDir)
        .filter((d): d is string => typeof d === 'string');
      const removed = await sweepOrphanUserHomeDirs([
        ...liveHomeDirs,
        ...unverifiedRecoveredHomeDirs,
        ...resumableHomeDirs,
      ]);
      if (removed.length > 0) {
        logger.debug(`[DAEMON RUN] Swept ${removed.length} orphan user home dir(s) from /tmp`);
      }
    } catch (e) {
      logger.debug(`[DAEMON RUN] Orphan sweep failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    try {
      const pendingContextFiles = [
        ...Array.from(pidToTrackedSession.values())
          .map((session) => session.deferredContinuationContextFile)
          .filter((file): file is string => typeof file === 'string'),
        ...unverifiedRecoveredContextFiles,
        ...Object.values(persistedSessions)
          .map((session) => session.deferredContinuationContextFile)
          .filter((file): file is string => typeof file === 'string'),
      ];
      const removed = await sweepOrphanDeferredContinuationContextFiles(
        configuration.happyHomeDir,
        pendingContextFiles,
      );
      if (removed.length > 0) {
        logger.debug(`[DAEMON RUN] Swept ${removed.length} orphan deferred continuation context file(s)`);
      }
    } catch (e) {
      logger.debug(`[DAEMON RUN] Deferred continuation context sweep failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Retain session data after process exits so resume can still find it.
    // Pre-populate from disk so sessions survive daemon restarts.
    const sessionIdToFinishedSession = new Map<string, TrackedSession>();
    for (const [id, s] of Object.entries(persistedSessions)) {
      sessionIdToFinishedSession.set(id, {
        ...hydrateTrackedSessionFromPersisted(s),
        startedBy: 'persisted',
        happySessionId: id,
        pid: 0,
      });
    }
    if (Object.keys(persistedSessions).length > 0) {
      logger.debug(`[DAEMON RUN] Loaded ${Object.keys(persistedSessions).length} persisted sessions from disk`);
    }

    // Session spawning awaiter system
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();

    // Helper functions
    const getCurrentChildren = () => Array.from(pidToTrackedSession.values());
    const autonomousQualityGateStore = await AutonomousQualityGateRunStore.open(
      join(configuration.happyHomeDir, 'autonomous-quality-gates.json'),
    );
    const autonomousQualityGateRegistry = new AutonomousQualityGateDaemonRegistry({
      store: autonomousQualityGateStore,
      capture: captureAutonomousWorktreeFingerprint,
      runPhase: (phase, cwd, signal) => runAutonomousQualityGatePhase(phase, { cwd, signal }),
      sendRepair: async (sessionId, message, options) => {
        const session = getCurrentChildren().find(candidate => candidate.happySessionId === sessionId);
        if (!session?.encryption) throw new Error(`Session encryption unavailable for ${sessionId}`);
        await sendAutonomousQualityGateRepair({
          sessionId,
          message,
          token: credentials.token,
          serverUrl: configuration.serverUrl,
          encryption: session.encryption,
          signal: options.signal,
          timeoutMs: options.timeoutMs,
        });
      },
      resolveSessionDirectory: async (sessionId, requestedDirectory) => {
        const session = getCurrentChildren().find(candidate => candidate.happySessionId === sessionId);
        const sessionDirectory = session?.happySessionMetadataFromLocalWebhook?.path ?? session?.directory;
        if (!sessionDirectory) return null;
        try {
          const [canonicalSessionDirectory, canonicalRequestedDirectory] = await Promise.all([
            fs.realpath(sessionDirectory),
            fs.realpath(requestedDirectory),
          ]);
          return canonicalSessionDirectory === canonicalRequestedDirectory
            ? canonicalSessionDirectory
            : null;
        } catch {
          return null;
        }
      },
      getSessionRuntime: (sessionId) => {
        const runtime = getCurrentChildren().find(candidate => candidate.happySessionId === sessionId)?.runtime;
        return {
          idle: !!runtime && !runtime.thinking && !runtime.hasOpenToolCall && !runtime.pendingUserInput,
          ...(runtime?.assistantTurns !== undefined ? { turns: runtime.assistantTurns } : {}),
          ...(runtime?.providerTokens !== undefined ? { tokens: runtime.providerTokens } : {}),
          ...(runtime?.lastTurnEndAt !== undefined ? { lastTurnEndAt: runtime.lastTurnEndAt } : {}),
        };
      },
      onPersistenceError: error => logger.warn('[AUTONOMOUS QUALITY GATE] Failed to persist runtime state', error),
    });

    // Serialize tracked sessions for disk persistence
    const sessionStartTimes = restoreSessionStartTimes({
      trackedSessions: getCurrentChildren(),
      persistedSessions: previousState?.trackedSessions ?? [],
      now: Date.now(),
    });
    /**
     * Put an adopted session into tracking. Shared by the startup sweep and the
     * report-driven path so both get identical bookkeeping.
     */
    const trackAdoptedSession = (sessionId: string, session: TrackedSession, startedAt: number) => {
      // Carry over the encryption material loaded from disk. findTrackedSessionById
      // prefers the tracked map over the resumable-session map, so an adopted
      // session without it would shadow the resumable record and make resume fail
      // with "no stored encryption data" — worse than not adopting at all.
      const resumable = sessionIdToFinishedSession.get(sessionId);
      if (resumable?.encryption) {
        session.encryption = resumable.encryption;
      }
      recoveredPendingSpawnStartedAt.delete(session.pid);
      pidToTrackedSession.set(session.pid, session);
      sessionStartTimes.set(session.pid, startedAt);
      pidToAdoptedAt.set(session.pid, Date.now());
    };

    // Adopt live sessions the persisted store knows about but we don't. The
    // report-driven path (onHappySessionRuntime) only catches sessions that
    // still talk; a session whose runtime is wedged is silent forever, and
    // nothing else would ever put it in front of the zombie sweep. Runs on
    // every startup, not just when the previous state was lost — a partially
    // written state file leaves the same gap.
    try {
      const startupOrphans = collectStartupOrphans({
        persistedSessions,
        trackedPids: new Set(pidToTrackedSession.keys()),
        isPidAlive,
        getProcessStartedAt,
        now: Date.now(),
      });
      for (const orphan of startupOrphans) {
        trackAdoptedSession(orphan.sessionId, orphan.session, orphan.startedAt);
        logger.debug(
          `[DAEMON RUN] Adopted orphan session ${orphan.sessionId} at startup (pid ${orphan.session.pid}, startedBy ${orphan.session.startedBy})`,
        );
      }
      if (startupOrphans.length > 0) {
        logger.debug(`[DAEMON RUN] Adopted ${startupOrphans.length} orphan session(s) left by a previous daemon`);
      }
    } catch (e) {
      logger.debug(`[DAEMON RUN] Startup orphan adoption failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    const serializeTrackedSessions = (): PersistedTrackedSession[] => {
      return Array.from(pidToTrackedSession.values()).map(s => ({
        pid: s.pid,
        directory: s.directory,
        happySessionId: s.happySessionId,
        resumeTargetSessionId: s.resumeTargetSessionId,
        startedBy: s.startedBy,
        tmuxSessionId: s.tmuxSessionId,
        startedAt: sessionStartTimes.get(s.pid) ?? Date.now(),
        userHomeDir: s.userHomeDir,
        deferredContinuationContextFile: s.deferredContinuationContextFile,
      }));
    };

    // Forward declaration — assigned after fileState is available
    let persistTrackedSessions: () => void = () => {};

    const releaseRecoveredPendingAfterPidReuse = (pid: number) => {
      const stalePending = pidToTrackedSession.get(pid);
      recoveredPendingSpawnStartedAt.delete(pid);
      pidToTrackedSession.delete(pid);
      sessionStartTimes.delete(pid);
      pidToAdoptedAt.delete(pid);
      persistTrackedSessions();
      logger.debug(`[DAEMON RUN] Released recovered pending spawn after PID reuse was detected (pid ${pid})`);
      if (stalePending?.userHomeDir) {
        void unstageUserCredentials(stalePending.userHomeDir).then(
          () => logger.debug(`[DAEMON RUN] Unstaged reused-PID pending home dir ${stalePending.userHomeDir}`),
          (error) => logger.debug(
            `[DAEMON RUN] Failed to unstage reused-PID pending home dir: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
      removeDeferredContinuationContextFile(stalePending?.deferredContinuationContextFile);
    };

    // Handle webhook from happy session reporting itself
    const onHappySessionWebhook = (sessionId: string, sessionMetadata: Metadata, encryption?: SessionEncryptionData) => {
      logger.debugLargeJson(`[DAEMON RUN] Session reported`, sessionMetadata);

      const pid = sessionMetadata.hostPid;
      if (!pid) {
        logger.debug(`[DAEMON RUN] Session webhook missing hostPid for sessionId: ${sessionId}`);
        return;
      }

      logger.debug(`[DAEMON RUN] Session webhook: ${sessionId}, PID: ${pid}, started by: ${sessionMetadata.startedBy || 'unknown'}, hasEncryption: ${!!encryption}`);
      logger.debug(`[DAEMON RUN] Current tracked sessions before webhook: ${Array.from(pidToTrackedSession.keys()).join(', ')}`);

      // A resumed child re-persists this record at startup, before it has
      // reported any runtime. Carry the preserved skip-baseline forward or the
      // rewrite drops it, and a child that dies inside that window would resume
      // from the server head again — swallowing the very messages it was
      // resumed to deliver (2026-08-05 incident).
      const preserved = sessionIdToFinishedSession.get(sessionId);
      const inheritedLastProcessedSeq = preserved?.runtime?.lastProcessedSeq ?? preserved?.persistedLastProcessedSeq;
      let existingSession = pidToTrackedSession.get(pid);
      let rejectedRecoveredPendingReason: string | undefined;
      const recoveredPendingStartedAt = recoveredPendingSpawnStartedAt.get(pid);
      if (existingSession && recoveredPendingStartedAt !== undefined) {
        const decision = decideRecoveredPendingWebhook({
          sessionId,
          hostPid: pid,
          tracked: existingSession,
          resumable: preserved,
          recoveredPendingStartedAt,
          isPidAlive,
          getProcessStartedAt,
        });
        if (decision.action === 'promote') {
          existingSession = decision.session;
          recoveredPendingSpawnStartedAt.delete(pid);
          pidToTrackedSession.set(pid, existingSession);
        } else if (decision.action === 'release-and-register-external') {
          releaseRecoveredPendingAfterPidReuse(pid);
          existingSession = undefined;
        } else {
          rejectedRecoveredPendingReason = decision.reason;
          existingSession = undefined;
        }
      }

      // Persist encryption data to disk so it survives daemon restarts
      if (encryption) {
        persistSession(sessionId, {
          encryptionKey: encodeBase64(encryption.encryptionKey),
          encryptionVariant: encryption.encryptionVariant,
          seq: encryption.seq,
          metadataVersion: encryption.metadataVersion,
          agentStateVersion: encryption.agentStateVersion,
          metadata: sessionMetadata,
          savedAt: Date.now(),
          lastProcessedSeq: inheritedLastProcessedSeq,
          agentEnvironment: existingSession?.agentEnvironment ?? preserved?.agentEnvironment,
          deferredContinuationContextFile:
            existingSession?.deferredContinuationContextFile
            ?? preserved?.deferredContinuationContextFile,
        });
      }

      if (rejectedRecoveredPendingReason) {
        logger.debug(
          `[DAEMON RUN] Ignoring recovered pending webhook ${sessionId} for PID ${pid}: ${rejectedRecoveredPendingReason}`,
        );
        return;
      }

      // Check if we already have this PID (daemon-spawned)
      if (existingSession && existingSession.startedBy === 'daemon') {
        // Update daemon-spawned session with reported data
        recoveredPendingSpawnStartedAt.delete(pid);
        existingSession = mergeTrackedSessionWebhook({
          tracked: existingSession,
          sessionId,
          metadata: sessionMetadata,
          ...(encryption ? { encryption } : {}),
          ...(inheritedLastProcessedSeq !== undefined
            ? { persistedLastProcessedSeq: inheritedLastProcessedSeq }
            : {}),
        });
        pidToTrackedSession.set(pid, existingSession);
        if (!sessionStartTimes.has(pid)) {
          sessionStartTimes.set(pid, Date.now());
        }
        logger.debug(`[DAEMON RUN] Updated daemon-spawned session ${sessionId} with metadata`);

        // Resolve any awaiter for this PID
        const awaiter = pidToAwaiter.get(pid);
        if (awaiter) {
          pidToAwaiter.delete(pid);
          awaiter(existingSession);
          logger.debug(`[DAEMON RUN] Resolved session awaiter for PID ${pid}`);
        }

        persistTrackedSessions();
      } else if (!existingSession) {
        // New session started externally
        const trackedSession: TrackedSession = {
          startedBy: 'happy directly - likely by user from terminal',
          happySessionId: sessionId,
          happySessionMetadataFromLocalWebhook: sessionMetadata,
          encryption,
          pid,
          persistedLastProcessedSeq: inheritedLastProcessedSeq,
        };
        recoveredPendingSpawnStartedAt.delete(pid);
        pidToTrackedSession.set(pid, trackedSession);
        sessionStartTimes.set(pid, Date.now());
        logger.debug(`[DAEMON RUN] Registered externally-started session ${sessionId}`);
        persistTrackedSessions();
      }
    };

    /**
     * Take over a live session this daemon isn't tracking. Returns the adopted
     * session, or undefined when it can't be identified (logged, not thrown).
     */
    const adoptOrphanSession = (sessionId: string, hostPid?: number): TrackedSession | undefined => {
      // Read from disk rather than the startup snapshot: the previous daemon may
      // have written this session's record moments before it died.
      const adoption = resolveOrphanAdoption({
        sessionId,
        ...(hostPid !== undefined ? { hostPid } : {}),
        persistedSessions: readPersistedSessions(),
        isPidAlive,
        trackedPidOwner: (pid) => resolveTrackedPidOwner(pidToTrackedSession.get(pid)),
        now: Date.now(),
      });

      if (!adoption.adopted) {
        logger.debug(`[DAEMON RUN] Cannot adopt untracked session ${sessionId}: ${adoption.reason}`);
        return undefined;
      }

      const { session, startedAt } = adoption;
      trackAdoptedSession(sessionId, session, startedAt);
      persistTrackedSessions();
      logger.debug(
        `[DAEMON RUN] Adopted orphan session ${sessionId} (pid ${session.pid}, startedBy ${session.startedBy}, age ${Math.round((Date.now() - startedAt) / 60_000)}m)`,
      );
      return session;
    };

    const onHappySessionRuntime = (
      sessionId: string,
      runtime: {
        reportSeq?: number;
        thinking?: boolean;
        hasOpenToolCall?: boolean;
        pendingUserInput?: boolean;
        lastUserInteractionAt?: number;
        lastTurnEndAt?: number;
        assistantTurns?: number;
        providerTokens?: number;
        launchedBackgroundJob?: boolean;
        lastProcessedSeq?: number;
        mode?: 'local' | 'remote';
        updatedAt: number;
      },
      reporter?: { hostPid?: number },
    ) => {
      let trackedSession = getCurrentChildren().find(session => session.happySessionId === sessionId);
      if (!trackedSession && reporter?.hostPid !== undefined) {
        const promotion = resolveRecoveredPendingPromotion({
          sessionId,
          hostPid: reporter.hostPid,
          tracked: pidToTrackedSession.get(reporter.hostPid),
          resumable: sessionIdToFinishedSession.get(sessionId),
          recoveredPendingStartedAt: recoveredPendingSpawnStartedAt.get(reporter.hostPid),
          isPidAlive,
          getProcessStartedAt,
        });
        if (promotion.promoted) {
          trackedSession = promotion.session;
          recoveredPendingSpawnStartedAt.delete(reporter.hostPid);
          pidToTrackedSession.set(reporter.hostPid, trackedSession);
          persistTrackedSessions();
          logger.debug(
            `[DAEMON RUN] Promoted recovered pending spawn to session ${sessionId} (pid ${reporter.hostPid})`,
          );
        } else if (promotion.reason === 'pid-reused') {
          // The pending record belongs to the process that previously owned
          // this PID. Release it before orphan adoption or its sentinel owner
          // would permanently block the actual reporter now using the PID.
          releaseRecoveredPendingAfterPidReuse(reporter.hostPid);
        }
      }
      if (!trackedSession) {
        // A session we don't know about is reporting to us: it outlived the
        // daemon that spawned it (version upgrade, crash, lost state file) and
        // found us by re-reading daemon.state.json. Dropping the report leaves
        // it untracked forever — no reaper iterates anything but this map, so
        // not even the absolute idle cut would ever reach it.
        trackedSession = adoptOrphanSession(sessionId, reporter?.hostPid);
        if (!trackedSession) {
          return;
        }
      }

      if (!runtimeReportBelongsToTrackedProcess(trackedSession.pid, reporter?.hostPid)) {
        logger.debug(
          `[DAEMON RUN] Ignoring runtime report for ${sessionId} from stale pid ${reporter?.hostPid}`,
        );
        return;
      }

      const prev = trackedSession.runtime;
      if (!shouldAcceptSessionRuntimeReport(prev?.reportSeq, runtime.reportSeq)) {
        return;
      }
      const lastUserInteractionAt = mergeCumulativeRuntimeCounter(
        prev?.lastUserInteractionAt,
        runtime.lastUserInteractionAt,
      );
      const lastTurnEndAt = mergeCumulativeRuntimeCounter(prev?.lastTurnEndAt, runtime.lastTurnEndAt);
      const assistantTurns = mergeCumulativeRuntimeCounter(prev?.assistantTurns, runtime.assistantTurns);
      const providerTokens = mergeCumulativeRuntimeCounter(prev?.providerTokens, runtime.providerTokens);
      // Sticky once set: a conversation that ever launched a background job
      // stays exempt from the turn-end reap for the rest of its life.
      const launchedBackgroundJob = runtime.launchedBackgroundJob || prev?.launchedBackgroundJob;
      // Monotonic: a delayed or older-CLI report must never move the resume
      // skip baseline backwards.
      const lastProcessedSeq = runtime.lastProcessedSeq !== undefined || prev?.lastProcessedSeq !== undefined
        ? Math.max(runtime.lastProcessedSeq ?? 0, prev?.lastProcessedSeq ?? 0)
        : undefined;
      const mode = runtime.mode ?? prev?.mode;
      trackedSession.runtime = {
        ...(runtime.reportSeq !== undefined ? { reportSeq: runtime.reportSeq } : {}),
        thinking: runtime.thinking ?? prev?.thinking ?? false,
        hasOpenToolCall: runtime.hasOpenToolCall ?? prev?.hasOpenToolCall ?? false,
        pendingUserInput: runtime.pendingUserInput ?? prev?.pendingUserInput ?? false,
        ...(lastUserInteractionAt !== undefined ? { lastUserInteractionAt } : {}),
        ...(lastTurnEndAt !== undefined ? { lastTurnEndAt } : {}),
        ...(assistantTurns !== undefined ? { assistantTurns } : {}),
        ...(providerTokens !== undefined ? { providerTokens } : {}),
        ...(launchedBackgroundJob ? { launchedBackgroundJob } : {}),
        ...(lastProcessedSeq !== undefined ? { lastProcessedSeq } : {}),
        ...(mode !== undefined ? { mode } : {}),
        updatedAt: runtime.updatedAt,
      };
      autonomousQualityGateRegistry.noteSessionRuntime(sessionId, {
        idle: !trackedSession.runtime.thinking
          && !trackedSession.runtime.hasOpenToolCall
          && !trackedSession.runtime.pendingUserInput,
        userInput: lastUserInteractionAt !== undefined
          && lastUserInteractionAt !== prev?.lastUserInteractionAt,
        turns: trackedSession.runtime.assistantTurns,
        tokens: trackedSession.runtime.providerTokens,
        lastTurnEndAt: trackedSession.runtime.lastTurnEndAt,
      });
      // The same merged report, on the managed receipt (L1b). Verified above
      // against the tracked process, whose pid is the receipt's identity.
      managedNoteSessionRuntime?.(sessionId, trackedSession.pid, {
        ...(trackedSession.runtime.assistantTurns !== undefined ? { assistantTurns: trackedSession.runtime.assistantTurns } : {}),
        ...(trackedSession.runtime.lastTurnEndAt !== undefined ? { lastTurnEndAt: trackedSession.runtime.lastTurnEndAt } : {}),
        thinking: trackedSession.runtime.thinking ?? false,
        hasOpenToolCall: trackedSession.runtime.hasOpenToolCall ?? false,
        pendingUserInput: trackedSession.runtime.pendingUserInput ?? false,
      });

      // The cursor only exists in memory until something writes it. A daemon
      // killed without its clean-stop handlers takes it to the grave and the
      // session can never be resumed — see persistResumeCursorIfDue.
      persistResumeCursorIfDue(trackedSession);
    };

    let resolveManagedAiCredentialEnvironment = async (
      _agent: string | undefined,
    ): Promise<Record<string, string>> => ({});

    // Spawn a new session (sessionId reserved for future --resume functionality)
    // Execution machine H only: per-session Agent Browser grants via the Runtime broker.
    // A corrupt revocation queue disables browser grants (fail closed) and is left for repair.
    let browserTaskBroker: BrowserTaskSessionBroker | undefined;
    try {
      browserTaskBroker = createBrowserTaskSessionBroker(process.env, undefined, {
        pendingRevocationsFile: join(configuration.happyHomeDir, 'browser-task-revocations.json'),
      });
    } catch (error) {
      logger.warn(`[DAEMON RUN] Browser task broker disabled: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    const stopBrowserTaskReconciliation = startBrowserTaskReconciliation(browserTaskBroker);
    const reportBrowserTaskRevokeFailure = (error: unknown): void => {
      logger.warn(`[DAEMON RUN] ${error instanceof Error ? error.message : 'Browser task revocation failed'}`);
    };

    const spawnSession = async (
      options: SpawnSessionOptions,
      trustedMcpContext?: AutomationMcpSpawnContext,
    ): Promise<SpawnSessionResult> => {
      // Spawn options can contain the encrypted one-use envelope as well as
      // unrelated project secrets. Log only routing metadata so neither the
      // envelope nor a client-supplied plaintext grant becomes replayable log
      // material while DEBUG is enabled.
      logger.debug(
        `[DAEMON RUN] Spawning session agent=${options.agent} directory=${options.directory}`
        + ` callerGrant=${trustedMcpContext ? 'automation' : options.mcpCallerGrantEnvelope ? 'envelope' : 'absent'}`,
      );

      // Lesson eligibility uses the registered daemon machine, not an optional RPC field.
      const { directory, sessionId, approvedNewDirectoryCreation = true } = options;
      let directoryCreated = false;

      try {
        await fs.access(directory);
        logger.debug(`[DAEMON RUN] Directory exists: ${directory}`);
      } catch (error) {
        logger.debug(`[DAEMON RUN] Directory doesn't exist, creating: ${directory}`);

        // Check if directory creation is approved
        if (!approvedNewDirectoryCreation) {
          logger.debug(`[DAEMON RUN] Directory creation not approved for: ${directory}`);
          return {
            type: 'requestToApproveDirectoryCreation',
            directory
          };
        }

        try {
          await fs.mkdir(directory, { recursive: true });
          logger.debug(`[DAEMON RUN] Successfully created directory: ${directory}`);
          directoryCreated = true;
        } catch (mkdirError: any) {
          let errorMessage = `Unable to create directory at '${directory}'. `;

          // Provide more helpful error messages based on the error code
          if (mkdirError.code === 'EACCES') {
            errorMessage += `Permission denied. You don't have write access to create a folder at this location. Try using a different path or check your permissions.`;
          } else if (mkdirError.code === 'ENOTDIR') {
            errorMessage += `A file already exists at this path or in the parent path. Cannot create a directory here. Please choose a different location.`;
          } else if (mkdirError.code === 'ENOSPC') {
            errorMessage += `No space left on device. Your disk is full. Please free up some space and try again.`;
          } else if (mkdirError.code === 'EROFS') {
            errorMessage += `The file system is read-only. Cannot create directories here. Please choose a writable location.`;
          } else {
            errorMessage += `System error: ${mkdirError.message || mkdirError}. Please verify the path is valid and you have the necessary permissions.`;
          }

          logger.debug(`[DAEMON RUN] Directory creation failed: ${errorMessage}`);
          return {
            type: 'error',
            errorMessage
          };
        }
      }

      let stagedDeferredContinuationContextFile: string | undefined;
      let browserTaskRegistration: { registrationId: string; sessionSecret: string } | undefined;
      const releaseBrowserTaskRegistration = async (): Promise<void> => {
        const registration = browserTaskRegistration;
        browserTaskRegistration = undefined;
        if (registration) await browserTaskBroker?.revoke({ registrationId: registration.registrationId }).catch(reportBrowserTaskRevokeFailure);
      };
      const cleanupStagedDeferredContinuationContext = (): void => {
        if (!stagedDeferredContinuationContextFile) return;
        const file = stagedDeferredContinuationContextFile;
        stagedDeferredContinuationContextFile = undefined;
        removeDeferredContinuationContextFile(file);
      };

      try {
        const additionalDirectoryResult = await prepareAdditionalDirectories({
          requested: options.additionalDirectories,
          primaryDirectory: directory,
          allowedRoot: resolveDaemonAllowedRoot(process.env, os.homedir()),
        });
        const finishSpawn = async (
          spawn: Promise<SpawnSessionResult>,
          appliedAiAuthSource?: AiAuthSource,
        ): Promise<SpawnSessionResult> => {
          try {
            const result = await spawn;
            if (result.type !== 'success') {
              cleanupStagedDeferredContinuationContext();
            }
            // The Happy session id exists only now; an unbound registration never issues a grant.
            // Attribute the registration to the session's host pid, never to this restartable daemon.
            if (browserTaskRegistration && !(result.type === 'success'
              && await browserTaskBroker?.bind(browserTaskRegistration.registrationId, result.sessionId,
                Array.from(pidToTrackedSession.values()).find((session) => session.happySessionId === result.sessionId)?.pid))) {
              await releaseBrowserTaskRegistration();
            }
            if (result.type !== 'success') return result;
            const reported: SpawnSessionResult = appliedAiAuthSource === undefined
              ? result
              : { ...result, appliedAiAuthSource };
            if (options.additionalDirectories === undefined) return reported;
            return {
              ...reported,
              additionalDirectories: {
                version: 1,
                accepted: additionalDirectoryResult.accepted,
                skipped: additionalDirectoryResult.skipped,
              },
            };
          } catch (error) {
            cleanupStagedDeferredContinuationContext();
            await releaseBrowserTaskRegistration();
            throw error;
          }
        };

        if (trustedMcpContext && options.mcpCallerGrantEnvelope) {
          return {
            type: 'error',
            errorMessage: 'MCP caller grant has conflicting trusted and envelope sources',
          };
        }
        let mcpCallerGrant: string | undefined = trustedMcpContext?.mcpCallerGrant;
        let hasAuthoritativeProjectBinding = trustedMcpContext !== undefined;
        const mcpConfigProjectId = trustedMcpContext?.mcpConfigProjectId
          ?? options.mcpConfigProjectId?.trim()
          ?? null;
        if (options.mcpCallerGrantEnvelope) {
          const consumed = mcpCallerGrantConsumer.consume(
            options.mcpCallerGrantEnvelope,
            { projectId: mcpConfigProjectId },
          );
          if (!consumed.ok) {
            return {
              type: 'error',
              errorMessage: `MCP caller grant rejected (${consumed.reason})`,
            };
          }
          mcpCallerGrant = consumed.grant;
          hasAuthoritativeProjectBinding = true;
        }
        if (options.bootstrapFiles) {
          await materializeSpawnBootstrapFiles(directory, options.bootstrapFiles);
        }
        if (options.axStep) {
          await persistExplicitStep(directory, options.axStep);
        }

        // Build environment variables for session spawning
        // Authentication tokens are resolved here

        // Resolve authentication token if provided
        const authEnv: Record<string, string> = {};
        if (options.token) {
          if (options.agent === 'codex') {

            // Create a temporary directory for Codex
            const codexHomeDir = tmp.dirSync();

            // Write the token to the temporary directory
            await fs.writeFile(join(codexHomeDir.name, 'auth.json'), options.token);

            // Set the environment variable for Codex
            authEnv.CODEX_HOME = codexHomeDir.name;
          } else { // Assuming claude
            authEnv.CLAUDE_CODE_OAUTH_TOKEN = options.token;
          }
        }

        // When the requesting user's Happy credentials are provided, write them
        // to a per-spawn access.key so the child CLI registers its session under
        // the user's account rather than inheriting the daemon's credentials
        // from ~/.happy-dev/access.key.
        let stagedUserHomeDir: string | undefined;
        if (options.happyToken && options.happySecret) {
          // Pass our own daemon.state.json so the staged home still lets the
          // child find this daemon's HTTP port for its startup webhook —
          // HAPPY_HOME_DIR relocates that lookup too, not just access.key.
          const { homeDir } = await stageUserCredentials(
            options.happyToken,
            options.happySecret,
            configuration.daemonStateFile,
          );
          authEnv.HAPPY_HOME_DIR = homeDir;
          stagedUserHomeDir = homeDir;
          logger.debug(`[DAEMON RUN] User credentials staged at ${homeDir}/access.key`);
        }

        // `machine-personal` 은 이 머신의 자기 로그인을 고른 것이다. 관리 자격을
        // 해석해 두면 overlayManagedCredentialEnvironment 가 마지막에 덮어 항상
        // 이긴다 — 그래서 해석 자체를 하지 않는다.
        const managedAiCredentialEnvironment = honorsManagedAiCredentials(options.aiAuthSelection)
          ? await resolveManagedAiCredentialEnvironment(options.agent)
          : {};
        let extraEnv: Record<string, string> = injectMcpCallerGrant(
          stripManagedCredentialConflicts(
            buildSpawnRequestEnvironment(authEnv, options.environmentVariables),
            managedAiCredentialEnvironment,
          ),
          mcpCallerGrant,
          process.env.HAPPY_APLUS_MCP_CONFIG_URL,
          mcpConfigProjectId,
          options.expectedConnectors,
          'spawn',
        );
        extraEnv = injectCheckpointSpawnContext(extraEnv, undefined);
        if (options.parentSessionId) {
          extraEnv.HAPPY_FORKED_FROM_SESSION_ID = options.parentSessionId;
        }
        if (options.forkedFromMessageId) {
          extraEnv.HAPPY_FORKED_FROM_MESSAGE_ID = options.forkedFromMessageId;
        }
        // For fork: spawned Happy CLI needs to know which Claude JSONL to
        // backfill into the fresh Happy session row. Without this, the
        // SDK reads the JSONL silently as context but never re-emits the
        // historical messages, so the app shows an empty chat.
        if (options.resumeClaudeSessionId) {
          extraEnv.HAPPY_FORK_CLAUDE_SESSION_ID = options.resumeClaudeSessionId;
        }
        if (options.resumeCodexThreadId) {
          extraEnv.HAPPY_FORK_CODEX_THREAD_ID = options.resumeCodexThreadId;
        }
        // Requester identity for the new session's metadata (specs/session-created-by).
        // Re-supplied on every spawn, not lineage — see SESSION_LINEAGE_ENV_PREFIXES.
        if (options.createdByAccountId) {
          extraEnv.HAPPY_CREATED_BY_ACCOUNT_ID = options.createdByAccountId;
        }
        if (options.createdByDisplayName) {
          extraEnv.HAPPY_CREATED_BY_DISPLAY_NAME = options.createdByDisplayName;
        }
        logger.debug(`[DAEMON RUN] Environment variable keys (before expansion) (${Object.keys(extraEnv).length}): ${Object.keys(extraEnv).join(', ')}`);

        // Expand ${VAR} references from daemon's process.env
        // This ensures variable substitution works in both tmux and non-tmux modes
        // Example: ANTHROPIC_AUTH_TOKEN="${Z_AI_AUTH_TOKEN}" → ANTHROPIC_AUTH_TOKEN="sk-real-key"
        extraEnv = expandEnvironmentVariables(extraEnv, process.env);
        logger.debug(`[DAEMON RUN] After variable expansion: ${Object.keys(extraEnv).join(', ')}`);

        // Fail fast if any passed-through environment variable still contains an
        // unresolved ${VAR} reference after expansion.
        const unresolvedEnvEntries = Object.entries(extraEnv).flatMap(([key, value]) => {
          if (typeof value !== 'string' || !value.includes('${')) {
            return [];
          }

          const unresolvedMatch = value.match(/\$\{([^}]+)\}/);
          if (!unresolvedMatch) {
            return [];
          }

          const expression = unresolvedMatch[1];
          const defaultSeparatorIndex = expression.indexOf(':-');
          const missingVar = defaultSeparatorIndex === -1
            ? expression
            : expression.slice(0, defaultSeparatorIndex);

          return [`${key} references \${${missingVar}} which is not defined`];
        });

        if (unresolvedEnvEntries.length > 0) {
          const errorMessage = `Session environment is invalid - environment variables not found in daemon: ${unresolvedEnvEntries.join('; ')}. ` +
            `Ensure these variables are set in the daemon's environment before starting sessions.`;
          logger.warn(`[DAEMON RUN] ${errorMessage}`);
          return {
            type: 'error',
            errorMessage
          };
        }
        /*
         * The state root and who injects lessons, in one place shared with the
         * resume path so the two cannot drift.
         *
         * Settings, the spending ledger and the review outcome live under the
         * daemon's home, so a session whose own `HAPPY_HOME_DIR` was relocated
         * for another user's credentials must still read them there.
         *
         * Ownership is decided now and fixed for the child's lifetime: the
         * host boots lazily, so "ready" moves during a session, and a marker
         * that followed it would either silence CML's native hook halfway
         * through or let both inject across the switch.
         */
        const lessonLaunch = await applyLessonLaunchEnvironment({
          environment: extraEnv,
          // The credential the child will actually authenticate with.
          callerToken: options.happyToken,
          daemonToken: credentials.token,
          daemonHomeDir: configuration.happyHomeDir,
          projectId: hasAuthoritativeProjectBinding ? mcpConfigProjectId : null,
          hasSessionAuthority: hasAuthoritativeProjectBinding && Boolean(mcpCallerGrant),
          eligible: Boolean(
            // A managed runtime loads no settings sources, so there is no
            // native hook to stand down and no account credential to be a
            // host with.
            managedIdentity.status !== 'active'
            && lessonStudioOrigin
            && machineId,
          ),
          /*
           * Proof, not a prediction: the supervisor opens the project through
           * the same signed grant a turn would. A `null` here means the studio
           * refused, the key is missing or the store will not open — all of
           * which keep supported launches behind the host policy gate.
           */
          hostIsReady: async () => Boolean(
            mcpConfigProjectId && await lessonHosts.ensureOpen(mcpConfigProjectId),
          ),
        });
        logger.debug(`[lesson-host] owner=${lessonLaunch.decision.owner} (${lessonLaunch.decision.reason})`);
        extraEnv = lessonLaunch.environment;
        extraEnv = injectCheckpointSpawnContext(extraEnv, mcpConfigProjectId && hasAuthoritativeProjectBinding
          ? {
            projectId: mcpConfigProjectId,
            worktreeId: null,
            checkpointRoot: join(configuration.happyHomeDir, 'checkpoints'),
          }
          : undefined);
        // Managed credentials are already validated by the credential runtime.
        // Overlay them only after caller variable expansion so secret text such
        // as `${...}` is never interpreted as a daemon environment reference.
        extraEnv = overlayManagedCredentialEnvironment(
          extraEnv,
          managedAiCredentialEnvironment,
        );

        // Set after the caller's environment has been merged and expanded, so
        // an external RPC cannot switch it off by supplying the same key. The
        // caller's `HAPPY_MANAGED_` keys were already stripped upstream; this
        // is the daemon's own decision, taken from an internal spawn option
        // rather than anything the caller sent.
        //
        // It only turns on stricter delivery for this launch. It is not an
        // identity, and nothing may read it as one.
        const requireInitialPromptAck = options.requireInitialPromptAck === true;

        // Initial prompt (scheduled automations 등): 불투명한 사용자 텍스트라
        // 위의 ${VAR} 확장·검증을 통과시키면 안 된다 — 프롬프트 속 "${FOO}"는
        // 참조가 아니라 내용이다. 그래서 확장/검증 이후에 주입한다. tmux 경로와
        // 일반 경로 모두 extraEnv를 그대로 사용하므로 이 한 곳이면 충분하다.
        if (options.initialPrompt) {
          // 큰 프롬프트(AgentTask 리뷰는 diff 를 인라인한다)를 env 값으로 넘기면
          // Linux 의 단일 env 한도(MAX_ARG_STRLEN)에 걸려 spawn 이 E2BIG 으로
          // 죽는다. 한도 이상이면 파일로 넘기고 경로만 env 에 싣는다.
          const stagedPrompt = await stageInitialPromptEnvironment(options.initialPrompt);
          Object.assign(extraEnv, stagedPrompt.env);
          if (options.initialPromptLocalId) {
            extraEnv.HAPPY_INITIAL_PROMPT_LOCAL_ID = options.initialPromptLocalId;
          }
        }
        if (options.appendSystemPrompt !== undefined) {
          extraEnv.HAPPY_INITIAL_APPEND_SYSTEM_PROMPT = options.appendSystemPrompt;
        }
        if (options.saycodeSystemPromptEnabled !== undefined) {
          extraEnv.HAPPY_INITIAL_SAYCODE_SYSTEM_PROMPT_ENABLED = String(
            options.saycodeSystemPromptEnabled,
          );
        }
        if (options.saycodePromptBlocks && Object.keys(options.saycodePromptBlocks).length > 0) {
          extraEnv.HAPPY_INITIAL_SAYCODE_PROMPT_BLOCKS = JSON.stringify(options.saycodePromptBlocks);
        }
        // Initial model/effort seed: 사용자 입력 문자열이므로 initialPrompt와
        // 같은 이유로 ${VAR} 확장·검증 이후에 주입한다. 소비(read+delete)는
        // 자식 CLI(runClaude/runCodex)가 정확히 한 번 수행한다.
        if (options.model) {
          extraEnv.HAPPY_INITIAL_MODEL = options.model;
        }
        if (options.effort) {
          extraEnv.HAPPY_INITIAL_EFFORT = options.effort;
        }
        if (options.exitAfterFirstTurn) {
          extraEnv.HAPPY_AUTOMATION_RUN_ONCE = '1';
        }
        if (options.deferredContinuationContext) {
          const staged = await stageDeferredContinuationContext(
            options.deferredContinuationContext,
            configuration.happyHomeDir,
          );
          stagedDeferredContinuationContextFile = staged.file;
          extraEnv.HAPPY_DEFERRED_CONTINUATION_CONTEXT_FILE = staged.file;
        }
        if (additionalDirectoryResult.accepted.length > 0) {
          extraEnv.HAPPY_ADDITIONAL_DIRECTORIES = JSON.stringify(additionalDirectoryResult.accepted);
          mergeAdditionalDirectoriesIntoSandboxEnvironment(
            extraEnv,
            additionalDirectoryResult.accepted,
          );
        }
        browserTaskRegistration = await browserTaskBroker?.register();
        if (browserTaskRegistration) {
          // Session process only; it removes the secret from its env before spawning claude.
          extraEnv.HAPPY_BROWSER_TASK_SESSION_SECRET = browserTaskRegistration.sessionSecret;
        }

        // Isolated sessions must not inherit unrelated daemon credentials.
        const hasSandbox = extraEnv.HAPPY_PROJECT_SANDBOX_CONFIG !== undefined;
        const filterInheritedCredentials = shouldFilterSpawnCredentials({
          sandboxEnabled: hasSandbox,
          permissionMode: options.permissionMode,
          isolatedAutomation: options.filterInheritedCredentials,
        });
        const inheritedSpawnEnvironment = resolveInheritedSpawnEnvironment({
          agent: options.agent,
          env: process.env,
          filterCredentials: filterInheritedCredentials,
        });

        // Check if tmux is available and should be used
        const tmuxAvailable = await isTmuxAvailable();
        let useTmux = tmuxAvailable;

        // Get tmux session name from environment variables (now set by profile system)
        // Empty string means "use current/most recent session" (tmux default behavior)
        let tmuxSessionName: string | undefined = extraEnv.TMUX_SESSION_NAME;

        // If tmux is not available or session name is explicitly undefined, fall back to regular spawning
        // Note: Empty string is valid (means use current/most recent tmux session)
        if (!tmuxAvailable || tmuxSessionName === undefined) {
          useTmux = false;
          if (tmuxSessionName !== undefined) {
            logger.debug(`[DAEMON RUN] tmux session name specified but tmux not available, falling back to regular spawning`);
          }
        }

        if (useTmux && tmuxSessionName !== undefined) {
          // Try to spawn in tmux session
          const sessionDesc = tmuxSessionName || 'current/most recent session';
          logger.debug(`[DAEMON RUN] Attempting to spawn session in tmux: ${sessionDesc}`);

          const tmux = getTmuxUtilities(tmuxSessionName);

          // Construct command for the CLI
          const cliPath = join(projectPath(), 'dist', 'index.mjs');
          // Determine agent command - support claude, codex, gemini, openclaw, opencode.
          const agent = resolveTmuxSpawnAgentCommand(options.agent);
          if (!agent) {
            return finishSpawn(Promise.resolve({
              type: 'error',
              errorMessage: `Unsupported agent type: '${options.agent}'. Please update your CLI to the latest version.`
            }));
          }
          const resumeId = agent === 'claude'
            ? options.resumeClaudeSessionId
            : (agent === 'codex' ? options.resumeCodexThreadId : undefined);
          const resumeFragment = resumeId
            ? ` --resume ${shellescape(resumeId)}`
            : '';
          const permissionFragment = options.permissionMode
            ? ` --permission-mode ${shellescape(options.permissionMode)}`
            : ' --dangerously-skip-permissions';
          const fullCommand = `node --no-warnings --no-deprecation ${cliPath} ${agent} --happy-starting-mode remote --started-by daemon${permissionFragment}${resumeFragment}`;

          // Spawn in tmux with environment variables
          // IMPORTANT: Pass complete environment (process.env + extraEnv) because:
          // 1. tmux sessions need daemon's expanded auth variables (e.g., ANTHROPIC_AUTH_TOKEN)
          // 2. Regular spawn uses env: { ...process.env, ...extraEnv }
          // 3. tmux needs explicit environment via -e flags to ensure all variables are available
          const windowName = `happy-${Date.now()}-${agent}`;
          // Explicit agent auth and task callbacks are overlaid after inherited
          // credentials are filtered, so isolated tasks keep only what they need.
          const tmuxEnv = applyAppliedAiAuthSourceEnv(applyConfirmedPromptDeliveryFlag(
            buildManagedSessionSpawnEnvironment(
              inheritedSpawnEnvironment,
              extraEnv,
              managedAiCredentialEnvironment,
            ),
            requireInitialPromptAck,
          ), Object.keys(managedAiCredentialEnvironment).length > 0);
          // 최종 env 를 만든 **뒤** 선택과 대조한다. 어긋나면 대체하지 않고 멈춘다.
          const tmuxSelection = verifyAiAuthSelection(options.aiAuthSelection, tmuxEnv);
          if (tmuxSelection.rejection) {
            return finishSpawn(Promise.resolve({
              type: 'error',
              errorMessage: tmuxSelection.rejection,
            }));
          }

          const tmuxResult = await tmux.spawnInTmux([fullCommand], {
            sessionName: tmuxSessionName,
            windowName: windowName,
            cwd: directory
          }, tmuxEnv);  // Pass complete environment for tmux session

          if (tmuxResult.success) {
            logger.debug(`[DAEMON RUN] Successfully spawned in tmux session: ${tmuxResult.sessionId}, PID: ${tmuxResult.pid}`);

            // Validate we got a PID from tmux
            if (!tmuxResult.pid) {
              throw new Error('Tmux window created but no PID returned');
            }

            // Create a tracked session for tmux windows - now we have the real PID!
            const agentEnvironment = captureSaycodeAgentEnvironment(tmuxEnv);
            const deferredContinuationContextFile = tmuxEnv.HAPPY_DEFERRED_CONTINUATION_CONTEXT_FILE;
            const trackedSession: TrackedSession = {
              startedBy: 'daemon',
              pid: tmuxResult.pid, // Real PID from tmux -P flag
              directory,
              tmuxSessionId: tmuxResult.sessionId,
              directoryCreated,
              userHomeDir: stagedUserHomeDir,
              ...(agentEnvironment ? { agentEnvironment } : {}),
              ...(deferredContinuationContextFile ? { deferredContinuationContextFile } : {}),
              message: directoryCreated
                ? `The path '${directory}' did not exist. We created a new folder and spawned a new session in tmux session '${tmuxSessionName}'. Use 'tmux attach -t ${tmuxSessionName}' to view the session.`
                : `Spawned new session in tmux session '${tmuxSessionName}'. Use 'tmux attach -t ${tmuxSessionName}' to view the session.`
            };

            // Add to tracking map so webhook can find it later
            recoveredPendingSpawnStartedAt.delete(tmuxResult.pid);
            pidToTrackedSession.set(tmuxResult.pid, trackedSession);
            sessionStartTimes.set(tmuxResult.pid, Date.now());
            persistTrackedSessions();

            return finishSpawn(waitForSessionWebhook({
              pid: tmuxResult.pid,
              pidToAwaiter,
              label: '(tmux)',
              logger,
            }), tmuxSelection.appliedSource);
          } else {
            logger.debug(`[DAEMON RUN] Failed to spawn in tmux: ${tmuxResult.error}, falling back to regular spawning`);
            useTmux = false;
          }
        }

        // Regular process spawning (fallback or if tmux not available)
        if (!useTmux) {
          logger.debug(`[DAEMON RUN] Using regular process spawning`);

          // Construct arguments for the CLI - support claude, codex, gemini,
          // openclaw, and opencode (opencode runs over ACP: `happy acp opencode`).
          const agentArgs = resolveRegularSpawnAgentArgs(options.agent);
          if (!agentArgs) {
            return finishSpawn(Promise.resolve({
              type: 'error',
              errorMessage: `Unsupported agent type: '${options.agent}'. Please update your CLI to the latest version.`
            }));
          }
          const agentCommand = agentArgs[0];
          const args = [
            ...agentArgs,
            '--happy-starting-mode', 'remote',
            '--started-by', 'daemon',
            ...(options.permissionMode
              ? ['--permission-mode', options.permissionMode]
              : ['--dangerously-skip-permissions']),
          ];

          // Resume ids attach the new Happy session to a pre-existing provider
          // conversation created by the fork / duplicate RPC.
          if (options.resumeClaudeSessionId && agentCommand === 'claude') {
            args.push('--resume', options.resumeClaudeSessionId);
          }
          if (options.resumeCodexThreadId && agentCommand === 'codex') {
            args.push('--resume', options.resumeCodexThreadId);
          }

          // TODO: In future, sessionId could be used with --resume to continue existing sessions
          // For now, we ignore it - each spawn creates a new session
          // scrub: 상속된 lineage env(HAPPY_RECONNECT_*/HAPPY_FORK*)가 새
          // 세션을 기존 세션에 재접속시키는 것을 차단. extraEnv 의 명시적
          // fork 값들은 scrub 이후에 덮어써져 그대로 전달된다.
          const spawnEnvironment = applyAppliedAiAuthSourceEnv(applyConfirmedPromptDeliveryFlag(
            buildManagedSessionSpawnEnvironment(
              inheritedSpawnEnvironment,
              extraEnv,
              managedAiCredentialEnvironment,
            ),
            requireInitialPromptAck,
          ), Object.keys(managedAiCredentialEnvironment).length > 0);
          // 최종 env 를 만든 **뒤** 선택과 대조한다. 어긋나면 대체하지 않고 멈춘다.
          const spawnSelection = verifyAiAuthSelection(options.aiAuthSelection, spawnEnvironment);
          if (spawnSelection.rejection) {
            return finishSpawn(Promise.resolve({
              type: 'error',
              errorMessage: spawnSelection.rejection,
            }));
          }

          return finishSpawn(spawnTrackedHappyProcess({
            args,
            cwd: directory,
            env: spawnEnvironment,
            directoryCreated,
            message: directoryCreated ? `The path '${directory}' did not exist. We created a new folder and spawned a new session there.` : undefined,
            userHomeDir: stagedUserHomeDir,
          }), spawnSelection.appliedSource);
        }

        // This should never be reached, but TypeScript requires a return statement
        return finishSpawn(Promise.resolve({
          type: 'error',
          errorMessage: 'Unexpected error in session spawning'
        }));
      } catch (error) {
        cleanupStagedDeferredContinuationContext();
        await releaseBrowserTaskRegistration();
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.debug('[DAEMON RUN] Failed to spawn session:', error);
        return {
          type: 'error',
          errorMessage: `Failed to spawn session: ${errorMessage}`
        };
      }
    };

    const spawnTrackedHappyProcess = ({
      args,
      cwd,
      env,
      directoryCreated = false,
      message,
      userHomeDir,
      resumeTargetSessionId,
    }: {
      args: string[];
      cwd: string;
      env: NodeJS.ProcessEnv;
      directoryCreated?: boolean;
      message?: string;
      userHomeDir?: string;
      /**
       * Set for resume spawns, where the target session is known before the
       * child reports itself. Makes the child visible to hasLiveDaemonChild
       * from spawn onward instead of only after its session webhook lands.
       */
      resumeTargetSessionId?: string;
    }): Promise<SpawnSessionResult> => {
      const happyProcess = spawnHappyCLI(args, {
        cwd,
        detached: true,
        stdio: 'ignore',
        env,
      });

      if (!happyProcess.pid) {
        logger.debug('[DAEMON RUN] Failed to spawn process - no PID returned');
        return Promise.resolve({
          type: 'error',
          errorMessage: 'Failed to spawn Happy process - no PID returned'
        });
      }

      logger.debug(`[DAEMON RUN] Spawned process with PID ${happyProcess.pid}`);

      const agentEnvironment = captureSaycodeAgentEnvironment(env);
      const deferredContinuationContextFile = env.HAPPY_DEFERRED_CONTINUATION_CONTEXT_FILE;
      const trackedSession: TrackedSession = {
        startedBy: 'daemon',
        pid: happyProcess.pid,
        directory: cwd,
        childProcess: happyProcess,
        directoryCreated,
        message,
        userHomeDir,
        ...(resumeTargetSessionId ? { resumeTargetSessionId } : {}),
        ...(agentEnvironment ? { agentEnvironment } : {}),
        ...(deferredContinuationContextFile ? { deferredContinuationContextFile } : {}),
      };

      recoveredPendingSpawnStartedAt.delete(happyProcess.pid);
      pidToTrackedSession.set(happyProcess.pid, trackedSession);
      sessionStartTimes.set(happyProcess.pid, Date.now());
      persistTrackedSessions();

      happyProcess.on('exit', (code, signal) => {
        logger.debug(`[DAEMON RUN] Child PID ${happyProcess.pid} exited with code ${code}, signal ${signal}`);
        if (happyProcess.pid) {
          onChildExited(happyProcess.pid);
        }
      });

      happyProcess.on('error', (error) => {
        logger.debug(`[DAEMON RUN] Child process error:`, error);
        if (happyProcess.pid) {
          onChildExited(happyProcess.pid);
        }
      });

      return waitForSessionWebhook({
        pid: happyProcess.pid,
        pidToAwaiter,
        logger,
      });
    };

    const findTrackedSessionById = (happySessionId: string): TrackedSession | undefined => {
      for (const session of pidToTrackedSession.values()) {
        if (session.happySessionId === happySessionId) return session;
      }
      return sessionIdToFinishedSession.get(happySessionId);
    };

    const preserveSessionForResume = (session: TrackedSession, reason: string): boolean => {
      // Silence here hid the whole 2026-08-15 failure: the reaper logged a clean
      // stop while this bailed, so nothing recorded that the session had just
      // been killed in a state no resume could recover from.
      if (!session.happySessionId || !session.encryption) {
        logger.debug(
          `[DAEMON RUN] Cannot preserve session ${session.happySessionId ?? `pid ${session.pid}`} for resume (${reason}):`
          + ` ${!session.happySessionId ? 'no session id' : 'no encryption data'}`,
        );
        return false;
      }

      sessionIdToFinishedSession.set(session.happySessionId, session);
      if (session.happySessionMetadataFromLocalWebhook) {
        persistSession(session.happySessionId, {
          encryptionKey: encodeBase64(session.encryption.encryptionKey),
          encryptionVariant: session.encryption.encryptionVariant,
          seq: session.encryption.seq,
          metadataVersion: session.encryption.metadataVersion,
          agentStateVersion: session.encryption.agentStateVersion,
          metadata: session.happySessionMetadataFromLocalWebhook,
          savedAt: Date.now(),
          userHomeDir: session.userHomeDir,
          lastProcessedSeq: session.runtime?.lastProcessedSeq ?? session.persistedLastProcessedSeq,
          agentEnvironment: session.agentEnvironment,
          deferredContinuationContextFile: session.deferredContinuationContextFile,
        });
      }
      logger.debug(`[DAEMON RUN] Preserved session ${session.happySessionId} for resume (${reason})`);
      return true;
    };

    /**
     * Last time this daemon wrote a resume cursor to disk, by happy session id.
     * Only a throttle input — the authoritative "what is on disk" value is
     * `session.persistedLastProcessedSeq`.
     */
    const resumeCursorPersistedAt = new Map<string, number>();

    /**
     * Keeps the on-disk resume cursor current while the session is running.
     *
     * Without this the cursor reaches disk only through
     * `preserveSessionForResume`, so a daemon that dies without its clean-stop
     * handlers (pod eviction, OOM, SIGKILL) strands every session it was
     * running: the persisted record keeps its start-time snapshot and resume
     * refuses with `SESSION_CURSOR_MISSING` forever.
     */
    const persistResumeCursorIfDue = (session: TrackedSession): void => {
      const sessionId = session.happySessionId;
      const metadata = session.happySessionMetadataFromLocalWebhook;
      if (!sessionId || !session.encryption || !metadata) return;

      const cursor = session.runtime?.lastProcessedSeq;
      const now = Date.now();
      if (!decideResumeCursorPersist({
        cursor,
        persistedCursor: session.persistedLastProcessedSeq,
        lastPersistAt: resumeCursorPersistedAt.get(sessionId),
        now,
      })) return;

      persistSession(sessionId, {
        encryptionKey: encodeBase64(session.encryption.encryptionKey),
        encryptionVariant: session.encryption.encryptionVariant,
        seq: session.encryption.seq,
        metadataVersion: session.encryption.metadataVersion,
        agentStateVersion: session.encryption.agentStateVersion,
        metadata,
        savedAt: now,
        userHomeDir: session.userHomeDir,
        lastProcessedSeq: cursor,
        agentEnvironment: session.agentEnvironment,
        deferredContinuationContextFile: session.deferredContinuationContextFile,
      });
      session.persistedLastProcessedSeq = cursor;
      resumeCursorPersistedAt.set(sessionId, now);
      logger.debug(`[DAEMON RUN] Persisted resume cursor ${cursor} for session ${sessionId}`);
    };

    const fetchServerSessionSnapshot = async (sessionId: string, encryption: SessionEncryptionData, token?: string): Promise<ServerSessionSnapshot | null> => {
      try {
        // `/v1/sessions` returns only the account's 150 most-recently-updated
        // sessions. On a shared daemon account that window can be under a day,
        // so a session idle longer than that would never be found — resume
        // refuses forever even though the server still has it (2026-08-27
        // incident). `/v2/sessions/lookup` looks up this one id directly with
        // no window.
        const response = await axios.post(`${configuration.serverUrl}/v2/sessions/lookup`, {
          ids: [sessionId],
        }, {
          headers: { Authorization: `Bearer ${token ?? credentials.token}` },
          timeout: 10_000,
        });
        const snapshot = parseServerSessionSnapshot(
          (response.data as { sessions?: unknown }).sessions,
          sessionId,
          encryption,
        );
        if (!snapshot) {
          logger.debug(`[DAEMON RUN] Server lookup for session ${sessionId} returned no matching record`);
        }
        return snapshot;
      } catch (error) {
        logger.debug(`[DAEMON RUN] Failed to fetch session snapshot from server: ${error instanceof Error ? error.message : error}`);
        return null;
      }
    };

    type ResumeSessionOptions = {
      model?: string;
      permissionMode?: string;
      environmentVariables?: Record<string, string>;
      mcpCallerGrantEnvelope?: string;
      mcpConfigProjectId?: string;
      expectedConnectors?: string[];
      /** Present = replace the roots granted at spawn (a live child is left untouched). */
      additionalDirectories?: string[];
      checkpointRestart?: true;
      automation?: {
        directory: string;
        initialPrompt: string;
        environmentVariables: Record<string, string>;
        exitAfterFirstTurn: true;
      };
    };

    const spawnResumedSession = async (happySessionId: string, options?: ResumeSessionOptions): Promise<ResumeSessionResult> => {
      try {
        if (hasLiveDaemonChild(happySessionId, pidToTrackedSession.values(), isPidAlive)) {
          if (options?.automation) {
            return {
              type: 'error',
              code: 'SESSION_LIVE',
              errorMessage: `Session ${happySessionId} is still running and cannot accept automation environment changes.`,
            };
          }
          logger.debug(`[DAEMON RUN] Resume requested for ${happySessionId} but a live child is already attached — reusing it`);
          return { type: 'success', sessionId: happySessionId };
        }

        const tracked = findTrackedSessionById(happySessionId);
        if (!tracked) {
          return {
            type: 'error',
            code: 'SESSION_NOT_TRACKED',
            errorMessage: `Session ${happySessionId} is not tracked by this daemon. It may have been started before the daemon or on another machine.`,
          };
        }
        if (!tracked.happySessionMetadataFromLocalWebhook) {
          return {
            type: 'error',
            code: 'SESSION_METADATA_MISSING',
            errorMessage: `Session ${happySessionId} has no metadata. Cannot resume.`,
          };
        }
        if (!tracked.encryption) {
          return {
            type: 'error',
            code: 'SESSION_ENCRYPTION_MISSING',
            errorMessage: `Session ${happySessionId} has no stored encryption data. It was likely started before this feature was available. Restart the daemon and start a new session to enable resume.`,
          };
        }
        if (!options?.checkpointRestart) {
          const checkpointAuthority = await resolveCheckpointSessionAuthority({
            sessionId: happySessionId,
            trackedSession: tracked,
            checkpointRoot: join(configuration.happyHomeDir, 'checkpoints'),
            platform: process.platform,
          });
          if (
            checkpointAuthority?.protection.status === 'unavailable'
            && checkpointAuthority.protection.reason === 'excluded-path'
          ) {
            return {
              type: 'error',
              code: 'SESSION_RESUME_FAILED',
              errorMessage: `Session ${happySessionId} requires the dedicated checkpoint restart action.`,
            };
          }
        }

        // 2026-07-23 incident: pin preflight and child to ONE identity.
        // A child that syncs under a different account than the session owner
        // gets identical-looking 404s and exits — never spawn that child.
        const diskCredentials = await readCredentials();
        const credentialDecision = decideResumeCredentials({
          trackedUserHomeDir: tracked.userHomeDir,
          stagedToken: tracked.userHomeDir ? await readStagedTokenFromHomeDir(tracked.userHomeDir) : null,
          daemonToken: credentials.token,
          diskToken: diskCredentials?.token ?? null,
        });
        if (credentialDecision.kind === 'refuse') {
          return {
            type: 'error',
            code: 'SESSION_IDENTITY_MISMATCH',
            errorMessage: `Cannot resume session ${happySessionId}: ${credentialDecision.reason}`,
          };
        }
        if (options?.automation
            && !tokensShareIdentity(credentialDecision.token, credentials.token)) {
          return {
            type: 'error',
            code: 'SESSION_IDENTITY_MISMATCH',
            errorMessage: `Cannot safely resume session ${happySessionId}: it belongs to a different Happy account.`,
          };
        }
        if (!hasReliableResumeBaseline({
          reportedSeq: tracked.runtime?.lastProcessedSeq,
          persistedSeq: tracked.persistedLastProcessedSeq,
        })) {
          return {
            type: 'error',
            code: 'SESSION_CURSOR_MISSING',
            errorMessage: `Cannot safely resume session ${happySessionId}: no processed-message cursor is available.`,
          };
        }

        // Webhook metadata may be stale after the original child exits. Fetch a
        // fresh server snapshot before resuming. The snapshot is fetched with
        // the token the child will actually use, so an account mismatch fails
        // here (session not visible) instead of after spawn.
        const serverSnapshot = await fetchServerSessionSnapshot(happySessionId, tracked.encryption, credentialDecision.token);
        if (!serverSnapshot) {
          return {
            type: 'error',
            code: 'SESSION_SERVER_UNAVAILABLE',
            errorMessage: `Cannot safely resume session ${happySessionId}: latest server metadata is unavailable. Retry when the server is reachable.`,
          };
        }
        // The skip baseline is the last seq the previous child delivered to its
        // agent loop — NOT the server head: messages that arrived while the
        // session had no process exist on the server but were never processed,
        // and a head baseline silently swallows them (2026-08-05 incident).
        const baselineSeq = resolveResumeBaselineSeq({
          reportedSeq: tracked.runtime?.lastProcessedSeq,
          persistedSeq: tracked.persistedLastProcessedSeq,
          webhookSeq: tracked.encryption.seq,
          serverSeq: serverSnapshot.seq,
        });
        const reconnectEnvironment = buildReconnectSessionEnvironment({
          sessionId: happySessionId,
          encryption: tracked.encryption,
          serverSnapshot,
          baselineSeq,
        });
        const previousSeq = tracked.encryption.seq;
        const metadata = applyServerSessionSnapshot(tracked, serverSnapshot);
        logger.debug(`[DAEMON RUN] Refreshed session ${happySessionId} snapshot for resume`, {
          previousSeq,
          nextSeq: tracked.encryption.seq,
          baselineSeq,
        });

        const launch = buildResumeLaunch(
          { id: happySessionId, active: true, metadata },
          {
            startedBy: 'daemon',
            claudeStartingMode: 'remote',
          },
        );

        if (options?.model) {
          launch.args.push('--model', options.model);
        }
        if (options?.permissionMode) {
          launch.args.push('--permission-mode', options.permissionMode);
        } else if (options?.automation) {
          // The isolated automation prompt elevates only its own queue item.
          // Keep the process default gated until run-once exits after it.
          launch.args.push('--permission-mode', 'default');
        }

        if (options?.automation
            && await resolveAutomationDirectoryMatch(
              launch.cwd,
              options.automation.directory,
            ) !== true) {
          return {
            type: 'error',
            code: 'SESSION_DIRECTORY_MISMATCH',
            errorMessage: `Session ${happySessionId} belongs to a different directory.`,
          };
        }

        await fs.access(launch.cwd);

        // resume 도 같은 단일 env 한도에 걸린다 — review_apply 는 원 세션을
        // 재개하면서 diff 가 인라인된 같은 프롬프트를 싣는다.
        const stagedResumePrompt = options?.automation
          ? await stageInitialPromptEnvironment(options.automation.initialPrompt)
          : null;

        const resumeAgent = launch.args[0] === 'codex' ? 'codex' : 'claude';
        const inheritedResumeEnvironment = resolveInheritedSpawnEnvironment({
          agent: resumeAgent,
          env: process.env,
          filterCredentials: options?.automation !== undefined,
        });
        const priorCheckpointContext = readCheckpointSpawnContext(tracked.agentEnvironment ?? {});
        const managedAiCredentialEnvironment = await resolveManagedAiCredentialEnvironment(resumeAgent);
        const mcpEnvironment = prepareMcpChildEnvironment({
          environmentVariables: overlayManagedCredentialEnvironment(buildResumedSessionSpawnEnvironment({
            inherited: inheritedResumeEnvironment,
            runtime: options?.environmentVariables,
            automation: options?.automation?.environmentVariables,
            explicit: {
              ...reconnectEnvironment,
              ...(tracked.deferredContinuationContextFile
                && existsSync(tracked.deferredContinuationContextFile)
                ? {
                  HAPPY_DEFERRED_CONTINUATION_CONTEXT_FILE:
                    tracked.deferredContinuationContextFile,
                }
                : {}),
              // user-credential 세션은 원래 계정의 스테이징 자격증명으로 복원 —
              // 없으면 위의 credentialDecision 이 이미 refuse 했다.
              ...(credentialDecision.kind === 'user-staged'
                ? { HAPPY_HOME_DIR: credentialDecision.homeDir }
                : {}),
              ...(options?.automation ? {
                ...stagedResumePrompt!.env,
                HAPPY_AUTOMATION_RESUME_PROMPT: '1',
                HAPPY_AUTOMATION_RUN_ONCE: '1',
              } : {}),
            },
            agentEnvironment: tracked.agentEnvironment,
            sessionId: happySessionId,
          }), managedAiCredentialEnvironment),
          mcpCallerGrantEnvelope: options?.mcpCallerGrantEnvelope,
          mcpConfigProjectId: options?.mcpConfigProjectId,
          expectedConnectors: options?.expectedConnectors,
          lifecycle: 'resume',
          trustedConfigUrl: process.env.HAPPY_APLUS_MCP_CONFIG_URL,
        }, mcpCallerGrantConsumer);
        if (!mcpEnvironment.ok) {
          return {
            type: 'error',
            code: 'MCP_CALLER_GRANT_REJECTED',
            errorMessage: `MCP caller grant rejected (${mcpEnvironment.reason})`,
          };
        }
        const checkpointProjectId = options?.mcpConfigProjectId?.trim()
          || priorCheckpointContext?.projectId;
        if (
          priorCheckpointContext
          && checkpointProjectId
          && priorCheckpointContext.projectId !== checkpointProjectId
        ) {
          return {
            type: 'error',
            code: 'SESSION_RESUME_FAILED',
            errorMessage: 'Checkpoint project binding cannot change while resuming a session',
          };
        }
        const authoritativeCheckpointProjectId = priorCheckpointContext?.projectId
          ?? (options?.mcpCallerGrantEnvelope ? checkpointProjectId : undefined);
        /*
         * Lesson wiring, re-established for the resumed child.
         *
         * `prepareMcpChildEnvironment` above strips every `HAPPY_LESSON_` and
         * `CLAUDE_MEMORY_` key, because a caller must not be able to forge
         * them — and that strip takes the daemon's own two with it. Without
         * this the first resume of any session lost its state root and its
         * owner marker, so the host went quiet and an inherited marker decided
         * who injects. Same helper as the fresh spawn, so the two agree.
         */
        const resumeLessonLaunch = await applyLessonLaunchEnvironment({
          environment: mcpEnvironment.environmentVariables,
          // What the resumed child will actually authenticate with, which the
          // credential decision above already resolved and verified.
          callerToken: credentialDecision.token,
          daemonToken: credentials.token,
          daemonHomeDir: configuration.happyHomeDir,
          projectId: authoritativeCheckpointProjectId ?? null,
          hasSessionAuthority: Boolean(authoritativeCheckpointProjectId
            && mcpEnvironment.environmentVariables.HAPPY_APLUS_MCP_CALLER_GRANT),
          eligible: Boolean(process.env.HAPPY_APLUS_MCP_CONFIG_URL && machineId),
          hostIsReady: async () => Boolean(
            authoritativeCheckpointProjectId
            && await lessonHosts.ensureOpen(authoritativeCheckpointProjectId),
          ),
        });
        logger.debug(`[lesson-host] resume owner=${resumeLessonLaunch.decision.owner} (${resumeLessonLaunch.decision.reason})`);
        const resumedEnvironment = applyAppliedAiAuthSourceEnv(injectCheckpointSpawnContext(
          resumeLessonLaunch.environment,
          authoritativeCheckpointProjectId
            ? {
              projectId: authoritativeCheckpointProjectId,
              worktreeId: priorCheckpointContext?.worktreeId ?? null,
              checkpointRoot: join(configuration.happyHomeDir, 'checkpoints'),
            }
            : undefined,
        ), Object.keys(managedAiCredentialEnvironment).length > 0);
        if (options?.additionalDirectories !== undefined) {
          // Roots registered while the session was stopped only reach the sandbox here:
          // the OS sandbox profile is fixed for the life of the child process.
          const reapplied = await reapplyAdditionalDirectoriesOnResume(resumedEnvironment, {
            requested: options.additionalDirectories,
            primaryDirectory: launch.cwd,
            allowedRoot: resolveDaemonAllowedRoot(process.env, os.homedir()),
          });
          if (!reapplied.applied) {
            logger.debug(`[DAEMON RUN] Kept the granted additional directories for ${happySessionId}: the requested list was rejected`);
          }
        }

        const result = await spawnResumedWithBrowserTaskRegistration({
          broker: browserTaskBroker,
          agentSessionId: happySessionId,
          env: resumedEnvironment,
          spawn: (env) => spawnTrackedHappyProcess({
            args: launch.args,
            cwd: launch.cwd,
            // resume 는 이 spawn 하나에 한해 lineage 를 명시적으로 부여한다 —
            // 상속분은 scrub 하고 이 세션의 값만 아래에서 다시 넣는다.
            env,
            userHomeDir: credentialDecision.kind === 'user-staged' ? credentialDecision.homeDir : undefined,
            resumeTargetSessionId: happySessionId,
          }),
          ownerPid: () => Array.from(pidToTrackedSession.values()).find((session) => session.happySessionId === happySessionId)?.pid,
          onRevokeFailure: reportBrowserTaskRevokeFailure,
        });
        return result.type === 'error'
          ? { ...result, code: 'SESSION_RESUME_FAILED' }
          : result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : (error && typeof error === 'object' ? JSON.stringify(error) : String(error));
        logger.debug(`[DAEMON RUN] Failed to resume session: ${errorMessage}`, error instanceof Error ? error.stack : undefined);
        return {
          type: 'error',
          code: 'SESSION_RESUME_FAILED',
          errorMessage: `Failed to resume session: ${errorMessage}`,
        };
      }
    };

    // Concurrent resume RPCs for the same session share one spawn (2026-08-05:
    // two RPCs 6.7s apart double-spawned a session; both children were later
    // empty-reaped together).
    const resumeInFlight = new Map<string, Promise<ResumeSessionResult>>();
    const resumeSession = (happySessionId: string, options?: ResumeSessionOptions): Promise<ResumeSessionResult> =>
      shareInFlight(resumeInFlight, happySessionId, () => spawnResumedSession(happySessionId, options));

    const checkpointRestartInFlight = new Map<string, Promise<void>>();
    const restartCheckpointSession = (authority: CheckpointRpcSessionAuthority): Promise<void> =>
      shareInFlight(checkpointRestartInFlight, authority.sessionId, async () => {
        await restartCheckpointProtectedSession(authority, {
          resolveTarget: async (sessionId) => {
            const tracked = findTrackedSessionById(sessionId);
            const sandboxConfig = tracked?.happySessionMetadataFromLocalWebhook?.sandbox;
            const context = readCheckpointSpawnContext(tracked?.agentEnvironment ?? {});
            if (!tracked?.directory || !tracked.encryption || !sandboxConfig || !context) return null;
            const projectPath = await fs.realpath(tracked.directory);
            return {
              sessionId,
              projectId: context.projectId,
              worktreeId: context.worktreeId,
              projectPath,
              pid: tracked.pid,
              active: pidToTrackedSession.get(tracked.pid) === tracked,
              knownStopped: tracked.startedBy !== 'persisted',
              sandboxConfig,
              terminate: async () => {
                if (pidToTrackedSession.get(tracked.pid) !== tracked) {
                  throw new Error('checkpoint protected restart target changed before termination');
                }
                if (!preserveSessionForResume(tracked, 'checkpoint-protection-disabled')) {
                  throw new Error('checkpoint protected restart cannot preserve the session');
                }
                await stopServerProcess({ pid: tracked.pid });
                if (pidToTrackedSession.get(tracked.pid) === tracked) {
                  pidToTrackedSession.delete(tracked.pid);
                  recoveredPendingSpawnStartedAt.delete(tracked.pid);
                  sessionStartTimes.delete(tracked.pid);
                  pidToAdoptedAt.delete(tracked.pid);
                  resumeCursorPersistedAt.delete(sessionId);
                  persistTrackedSessions();
                }
              },
            };
          },
          isProcessAlive: isPidAlive,
          resume: (sessionId, environmentVariables) => spawnResumedSession(sessionId, {
            environmentVariables,
            checkpointRestart: true,
          }),
        });
      });

    const verifyRecoveryNativeSession = async (session: ReconnectableHappySession): Promise<boolean> => {
      const metadata = session.metadata;
      if ((metadata.flavor === 'codex' || metadata.codexThreadId) && metadata.codexThreadId) {
        const client = new CodexAppServerClient();
        try {
          await client.connect();
          await client.readThread({ threadId: metadata.codexThreadId, includeTurns: false });
          return true;
        } catch (error) {
          logger.debug(`[DAEMON RUN] Codex recovery preflight failed for ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
          return false;
        } finally {
          await client.disconnect().catch(() => {});
        }
      }

      if ((metadata.flavor === 'claude' || metadata.claudeSessionId) && metadata.claudeSessionId) {
        return claudeCheckSession(metadata.claudeSessionId, metadata.path);
      }
      return false;
    };

    const spawnRecoveredSession = async (
      previousSessionId: string,
      options: RecoverSessionOptions,
    ): Promise<RecoverSessionResult> => {
      let serverSession: ReconnectableHappySession;
      try {
        serverSession = await resolveReconnectableSession(previousSessionId);
      } catch (error) {
        return { type: 'error', ...classifyRecoveryLookupError(error) };
      }

      const pathExists = await fs.access(serverSession.metadata.path).then(() => true).catch(() => false);
      const nativeSessionExists = pathExists
        ? await verifyRecoveryNativeSession(serverSession)
        : false;
      const persistedSession = readPersistedSessions()[serverSession.id];
      const decision = decideUntrackedSessionRecovery({
        serverSession,
        persistedSession,
        pathExists,
        nativeSessionExists,
      });

      if (decision.kind === 'refuse') {
        return {
          type: 'error',
          code: decision.code,
          errorMessage: decision.reason,
        };
      }

      if (decision.kind === 'same-session') {
        const recoveredPersisted = hydrateRecoveredSessionFromPersisted(
          persistedSession,
          decision.baselineSeq,
        );
        const recovered: TrackedSession = {
          ...recoveredPersisted,
          startedBy: 'recovered from persisted session',
          happySessionId: serverSession.id,
          happySessionMetadataFromLocalWebhook: serverSession.metadata,
          encryption: {
            encryptionKey: serverSession.encryptionKey,
            encryptionVariant: serverSession.encryptionVariant,
            seq: serverSession.seq,
            metadataVersion: serverSession.metadataVersion,
            agentStateVersion: serverSession.agentStateVersion,
          },
          pid: 0,
        };
        sessionIdToFinishedSession.set(serverSession.id, recovered);
        persistSession(serverSession.id, {
          encryptionKey: encodeBase64(serverSession.encryptionKey),
          encryptionVariant: serverSession.encryptionVariant,
          seq: serverSession.seq,
          metadataVersion: serverSession.metadataVersion,
          agentStateVersion: serverSession.agentStateVersion,
          metadata: serverSession.metadata,
          savedAt: Date.now(),
          userHomeDir: recoveredPersisted.userHomeDir,
          lastProcessedSeq: decision.baselineSeq,
          agentEnvironment: recoveredPersisted.agentEnvironment,
          deferredContinuationContextFile: recoveredPersisted.deferredContinuationContextFile,
        });

        const result = await spawnResumedSession(serverSession.id, {
          model: options.model,
          permissionMode: options.permissionMode,
          mcpCallerGrantEnvelope: options.mcpCallerGrantEnvelope,
          mcpConfigProjectId: options.mcpConfigProjectId,
          expectedConnectors: options.expectedConnectors,
        });
        if (result.type !== 'success') {
          return result.type === 'error'
            ? result
            : {
              type: 'error',
              code: 'SESSION_RESUME_FAILED',
              errorMessage: `Unexpected recovery result: ${result.type}`,
            };
        }
        return {
          type: 'success',
          sessionId: result.sessionId,
          previousSessionId: serverSession.id,
          recovery: 'same-session',
          initialPromptDelivered: false,
        };
      }

      const spawned = await spawnSession({
        directory: decision.directory,
        agent: decision.agent,
        environmentVariables: options.environmentVariables,
        permissionMode: options.permissionMode,
        mcpCallerGrantEnvelope: options.mcpCallerGrantEnvelope,
        mcpConfigProjectId: options.mcpConfigProjectId,
        expectedConnectors: options.expectedConnectors,
        ...(decision.agent === 'claude'
          ? { resumeClaudeSessionId: decision.resumeClaudeSessionId }
          : { resumeCodexThreadId: decision.resumeCodexThreadId }),
        parentSessionId: serverSession.id,
        createdByAccountId: serverSession.metadata.createdBy?.accountId,
        createdByDisplayName: serverSession.metadata.createdBy?.displayName,
        initialPrompt: options.initialPrompt,
        initialPromptLocalId: options.initialPromptLocalId,
        appendSystemPrompt: options.appendSystemPrompt,
        saycodeSystemPromptEnabled: options.saycodeSystemPromptEnabled,
        saycodePromptBlocks: options.saycodePromptBlocks,
      });
      if (spawned.type !== 'success') {
        return {
          type: 'error',
          code: 'SESSION_RESUME_FAILED',
          errorMessage: spawned.type === 'error'
            ? spawned.errorMessage
            : `Unexpected recovery result: ${spawned.type}`,
        };
      }
      return {
        type: 'success',
        sessionId: spawned.sessionId,
        previousSessionId: serverSession.id,
        recovery: 'new-session',
        initialPromptDelivered: true,
      };
    };
    const recoveryInFlight = new Map<string, Promise<RecoverSessionResult>>();
    const recoverSession = (
      happySessionId: string,
      options: RecoverSessionOptions,
    ): Promise<RecoverSessionResult> => shareInFlight(
      recoveryInFlight,
      happySessionId,
      () => spawnRecoveredSession(happySessionId, options),
    );

    const resumeAutomationSession: ServerAutomationExecutorInput['resumeSession'] = async (input) => {
      const trackedTarget = findTrackedSessionById(input.sessionId);
      const trackedDirectory = trackedTarget?.happySessionMetadataFromLocalWebhook?.path;
      const sameDirectory = trackedDirectory
        ? await resolveAutomationDirectoryMatch(trackedDirectory, input.directory)
        : null;
      const preflight = decideAutomationResumePreflight({
        resumeInFlight: resumeInFlight.has(input.sessionId),
        live: hasLiveDaemonChild(input.sessionId, pidToTrackedSession.values(), isPidAlive),
        sameDirectory,
      });
      if (preflight === 'fallback') {
        return {
          ok: false,
          error: 'target session belongs to a different directory',
          shouldFallback: true,
        };
      }
      if (preflight === 'busy') {
        return {
          ok: false,
          error: 'target session is already running or resuming',
          shouldFallback: false,
        };
      }
      const result = await shareInFlight(resumeInFlight, input.sessionId, () => spawnResumedSession(
        input.sessionId,
        {
          automation: {
            directory: input.directory,
            initialPrompt: input.initialPrompt,
            environmentVariables: input.environmentVariables,
            exitAfterFirstTurn: input.exitAfterFirstTurn,
          },
        },
      ));
      return result.type === 'success'
        ? { ok: true, sessionId: result.sessionId }
        : {
          ok: false,
          error: result.type === 'error' ? result.errorMessage : `unexpected resume result: ${result.type}`,
          shouldFallback: !hasLiveDaemonChild(
            input.sessionId,
            pidToTrackedSession.values(),
            isPidAlive,
          ),
        };
    };

    // Local idle guard config for policy-initiated (if-idle) stops. Read once;
    // env overrides are picked up on daemon restart, same as other knobs.
    const idleStopGuardConfig = readIdleStopGuardConfig(process.env);
    /**
     * On a managed runtime every session is a managed generation, so no session
     * here may be stopped by signalling its pid.
     */
    const managedRuntimeActive = managedIdentity.status === 'active';
    // Recovered sessions haven't had a chance to report runtime to this daemon
    // yet — the guard measures their report silence from this moment, not from
    // their (possibly days-old) session start.
    const daemonStartedAt = Date.now();

    // The entry `stopSession` below would pick, without touching it. Same two
    // conditions on purpose: the verification must snapshot the process the
    // stop will signal, not a different one.
    const findStopTarget = (sessionId: string): { pid: number; session: TrackedSession } | undefined => {
      for (const [pid, session] of pidToTrackedSession.entries()) {
        if (session.happySessionId === sessionId ||
          (sessionId.startsWith('PID-') && pid === parseInt(sessionId.replace('PID-', '')))) {
          return { pid, session };
        }
      }
      return undefined;
    };

    // Stop a session by sessionId or PID fallback.
    //
    // `context.mode` decides enforcement: 'force' (the default for user actions)
    // stops unconditionally; 'if-idle' — inferred for any idle/cleanup policy
    // source — first re-validates against the session's locally-observed activity
    // so a stale or wrong policy decision cannot kill a session the user is using.
    const stopSession = (sessionId: string, context?: StopSessionContext): StopSessionResult => {
      const mode = resolveStopSessionMode(context);
      logger.debug(`[DAEMON RUN] Attempting to stop session ${sessionId}`, {
        source: context?.source,
        reason: context?.reason,
        mode,
      });

      // Try to find by sessionId first
      for (const [pid, session] of pidToTrackedSession.entries()) {
        if (session.happySessionId === sessionId ||
          (sessionId.startsWith('PID-') && pid === parseInt(sessionId.replace('PID-', '')))) {

          if (mode === 'if-not-busy') {
            const decision = evaluateBusyOnlyStopGuard({ runtime: session.runtime });
            if (!decision.allow) {
              logger.debug(
                `[session-idle-guard] sessionId=${sessionId} source=${context?.source ?? 'unknown'} decision=deny guard=${decision.guard} mode=if-not-busy`,
              );
              return { stopped: false, reason: 'active', guard: decision.guard, activity: decision.activity };
            }
          } else if (mode === 'if-idle') {
            const decision = evaluateIdleStopGuard({
              runtime: session.runtime,
              sessionStartedAt: sessionStartTimes.get(pid),
              daemonStartedAt,
              startedBy: session.startedBy,
              adoptedAt: pidToAdoptedAt.get(pid),
              now: Date.now(),
              config: idleStopGuardConfig,
            });
            if (!decision.allow) {
              logger.debug(
                `[session-idle-guard] sessionId=${sessionId} source=${context?.source ?? 'unknown'} decision=deny guard=${decision.guard}`,
              );
              return { stopped: false, reason: 'active', guard: decision.guard, activity: decision.activity };
            }
            logger.debug(
              `[session-idle-guard] sessionId=${sessionId} source=${context?.source ?? 'unknown'} decision=allow`,
            );
          }

          autonomousQualityGateRegistry.noteSessionStopped(session.happySessionId ?? sessionId);
          preserveSessionForResume(session, `stop-session:${context?.source ?? mode}`);

          const managedRoute = decideManagedStopRoute({
            managedRuntimeActive,
            key: managedGenerationForPid.get(pid),
          });
          const managedKey = managedRoute.route === 'supervisor' ? managedRoute.key : undefined;
          if (managedRoute.route === 'refuse') {
            /*
             * A managed runtime's sessions are managed generations. This one is
             * not in the map — a daemon restart hydrates tracked sessions from
             * disk but not the generation identity, which is the supervisor's
             * to hold. Falling through would signal the pid, which stops
             * neither the generation's tools nor its broker and proves nothing.
             *
             * Refused rather than guessed: `managed:stop` carries the verified
             * run identity and is the way to stop it.
             */
            logger.debug(`[managed] refusing a PID-only stop for ${sessionId}: generation identity unknown`);
            return { stopped: false, reason: 'managed-generation', detail: managedRoute.detail };
          }
          if (managedKey) {
            /*
             * `process.kill(pid)` here would be a lie in two directions: the
             * generation's tools run in its cgroup under a different uid and
             * would survive, and nothing observes emptiness, so a "stopped"
             * would be reported for a run still holding the volume. The
             * supervisor kills the generation and proves it empty, and the
             * launcher takes that run's broker down with it.
             *
             * Tracking is left in place. Removing it on an unproven stop is
             * how a live child becomes invisible to the next sweep.
             */
            // Stopped generations do not get to keep reporting.
            managedReportAuthority.revoke(managedKey);
            void stopManagedGeneration({ backend: managedFencingBackend, key: managedKey })
              .then((outcome) => {
                logger.debug(
                  `[managed] supervisor stop for ${sessionId}: stopped=${outcome.stopped} detail=${outcome.detail}`,
                );
              })
              /*
               * The transport can reject. Left unhandled it takes the daemon
               * down (a single unhandled rejection is fatal here), and the
               * failure would be invisible either way. Tracking stays, so the
               * next stop or sweep tries again.
               */
              .catch((error) => {
                logger.debug(
                  `[managed] supervisor stop for ${sessionId} failed: ${error instanceof Error ? error.name : 'unknown'}`,
                );
              });
            return { stopped: false, reason: 'managed-generation', detail: 'supervisor-stop-requested' };
          }

          if (session.startedBy === 'daemon' && session.childProcess) {
            try {
              session.childProcess.kill('SIGTERM');
              logger.debug(`[DAEMON RUN] Sent SIGTERM to daemon-spawned session ${sessionId}`);
            } catch (error) {
              logger.debug(`[DAEMON RUN] Failed to kill session ${sessionId}:`, error);
            }
          } else {
            // For externally started sessions, try to kill by PID
            try {
              process.kill(pid, 'SIGTERM');
              logger.debug(`[DAEMON RUN] Sent SIGTERM to external session PID ${pid}`);
            } catch (error) {
              logger.debug(`[DAEMON RUN] Failed to kill external session PID ${pid}:`, error);
            }
          }

          pidToTrackedSession.delete(pid);
          recoveredPendingSpawnStartedAt.delete(pid);
          sessionStartTimes.delete(pid);
          pidToAdoptedAt.delete(pid);
          persistTrackedSessions();
          logger.debug(`[DAEMON RUN] Removed session ${sessionId} from tracking`);
          return { stopped: true };
        }
      }

      logger.debug(`[DAEMON RUN] Session ${sessionId} not found`);
      return { stopped: false, reason: 'not-found' };
    };

    // `stopped: true` above only means a SIGTERM was attempted — the kill call
    // is wrapped in a catch — and never that anything exited. A caller that
    // deletes the project next needs the stronger answer, so this variant
    // snapshots the session's process tree first and then watches those exact
    // processes exit.
    // It sends no signal of its own and never answers 'exited' without evidence.
    const sessionExitProbe = createProcProcessProbe(createProcFs());
    const stopSessionWithExitVerification = (sessionId: string, context?: StopSessionContext) =>
      stopSessionWithVerifiedExit({
        findTarget: () => {
          const target = findStopTarget(sessionId);
          return target ? { pid: target.pid, token: target.session } : undefined;
        },
        stop: () => stopSession(sessionId, context),
        probe: sessionExitProbe,
      });

    // Handle child process exit — preserve session data for resume
    const onChildExited = (pid: number) => {
      const tracked = pidToTrackedSession.get(pid);
      // A managed attempt's child is gone: its receipt records the exit (L1b).
      // An exit that cannot be recorded yet is the handlers' own obligation
      // (retried on maintenance), so tracking is released here regardless.
      if (managedNoteChildExited?.(pid) === 'deferred') {
        logger.debug(`[DAEMON RUN] Child exit of PID ${pid} not yet on a receipt; deferred`);
      }
      if (tracked?.happySessionId) autonomousQualityGateRegistry.noteSessionStopped(tracked.happySessionId);
      // Revokes the session's broker registration and every agent grant it received.
      if (tracked?.happySessionId) void browserTaskBroker?.revoke({ agentSessionId: tracked.happySessionId }).catch(reportBrowserTaskRevokeFailure);
      const preservedForResume = tracked ? preserveSessionForResume(tracked, `process-exit:${pid}`) : false;
      if (!preservedForResume) {
        logger.debug(`[DAEMON RUN] Removing exited process PID ${pid} from tracking`);
        removeDeferredContinuationContextFile(tracked?.deferredContinuationContextFile);
      }
      pidToTrackedSession.delete(pid);
      recoveredPendingSpawnStartedAt.delete(pid);
      sessionStartTimes.delete(pid);
      pidToAdoptedAt.delete(pid);
      if (tracked?.happySessionId) resumeCursorPersistedAt.delete(tracked.happySessionId);
      persistTrackedSessions();
      if (tracked?.userHomeDir) {
        const homeDir = tracked.userHomeDir;
        if (preservedForResume) {
          // 2026-07-23 incident (path a): deleting the staged credentials here
          // made a later resume spawn the child under the DAEMON's account —
          // its sync then 404'd against the user-owned session. A resumable
          // session keeps its staged identity; cleanup happens when the
          // session is removed from the resumable set or via the startup sweep.
          logger.debug(`[DAEMON RUN] Keeping staged user home dir ${homeDir} for resumable session ${tracked.happySessionId}`);
        } else {
          // Small delay lets the child flush any final writes before we unlink.
          setTimeout(() => {
            unstageUserCredentials(homeDir).then(
              () => logger.debug(`[DAEMON RUN] Unstaged user home dir ${homeDir}`),
              (err) => logger.debug(`[DAEMON RUN] Failed to unstage ${homeDir}: ${err instanceof Error ? err.message : String(err)}`),
            );
          }, 100);
        }
      }
    };

    // Per-project port registry (30000-40000), persisted at configuration.portRegistryFile
    const portRegistry = createPortRegistry({ filePath: configuration.portRegistryFile });

    // Scheduled automations (daemon/automations/). 기동 시 rebase는 다운타임
    // 동안 지나간 예정 시각의 소급 실행을 막는다(R8) — replaceAll로 즉시 반영.
    // 실행 틱은 아래 하트비트 루프에 얹힌다(별도 타이머 없음).
    const automationStore = createAutomationStore({ filePath: configuration.automationsFile });
    const serverAutomationCache = createServerAutomationCache({
      filePath: configuration.serverAutomationsCacheFile,
    });
    const serverAutomationRuntimeStore = createServerAutomationRuntimeStore({
      filePath: configuration.serverAutomationsRuntimeFile,
    });
    const storedAutomations = automationStore.list();
    const rebasedAutomations = rebaseAutomationsOnLaunch(storedAutomations, Date.now());
    // 참조가 그대로면 rebase 대상이 없었다는 뜻 — 쓰지 않는다. 자동화를 쓰지 않는
    // 사용자에게 빈 파일을 만들지 않고, 손상된 파일을 조사 전에 덮지도 않는다.
    if (rebasedAutomations !== storedAutomations) {
      automationStore.replaceAll(rebasedAutomations);
    }
    // 스크립트 cwd 검증 루트 — apiMachine의 머신 RPC 표면과 같은 규칙.
    const automationAllowedRoot = resolveDaemonAllowedRoot(process.env, os.homedir());
    // 겹침 가드(R5)용: 데몬이 추적 중인 자식 세션의 프로세스 생존 여부.
    const isAutomationSessionRunning = (sessionId: string): boolean => {
      for (const [pid, session] of pidToTrackedSession.entries()) {
        if (session.happySessionId === sessionId) return isPidAlive(pid);
      }
      return false;
    };
    const isAutomationDirectoryInUse = (directory: string): boolean => {
      return isGithubTriggerWorktreeDirectoryInUse({
        directory,
        sessions: pidToTrackedSession,
        isPidAlive,
      });
    };
    const spawnAutomationSession = async (
      input: {
        directory: string;
        initialPrompt: string;
        createdByAccountId: string | null;
        agent: 'claude' | 'codex' | 'gemini' | 'grok' | 'openclaw' | 'opencode';
        model?: string;
        effort?: string;
        permissionMode?: 'read-only';
        mcpSpawnContext?: AutomationMcpSpawnContext;
        expectedConnectors?: string[];
        filterInheritedCredentials?: boolean;
        environmentVariables?: Record<string, string>;
      },
    ): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> => {
      const result = await spawnSession({
        machineId,
        directory: input.directory,
        agent: input.agent,
        model: input.model,
        effort: input.effort,
        initialPrompt: input.initialPrompt,
        exitAfterFirstTurn: input.agent === 'claude' || input.agent === 'codex',
        ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
        // 세션 자체는 데몬 소유자 자격증명으로 등록된다(자동화에 사용자 토큰을
        // 저장하지 않는다 — credentials-at-rest 금지). 귀속 표시만 넘긴다.
        createdByAccountId: input.createdByAccountId ?? undefined,
        filterInheritedCredentials: input.filterInheritedCredentials,
        environmentVariables: input.environmentVariables,
        expectedConnectors: input.expectedConnectors,
      }, input.mcpSpawnContext);
      if (result.type === 'success') {
        return { ok: true, sessionId: result.sessionId };
      }
      return {
        ok: false,
        error: result.type === 'error' ? result.errorMessage : `unexpected spawn result: ${result.type}`,
      };
    };
    // detach 실행 + 자체 리엔트런시 가드(heartbeatRunning과 별개) — spawn의
    // webhook 대기(최대 60초×due 수)가 하트비트의 나머지 임무를 막지 않게.
    const automationTickRunner = createAutomationTickRunner({
      runTick: () => runAutomationTick({
        store: automationStore,
        now: Date.now(),
        runScript: (input) => runAutomationScript({ ...input, allowedRoot: automationAllowedRoot }),
        spawnSession: spawnAutomationSession,
        isSessionRunning: isAutomationSessionRunning,
        logDebug: (message) => logger.debug(`[DAEMON RUN] ${message}`),
      }),
      logDebug: (message) => logger.debug(`[DAEMON RUN] ${message}`),
    });

    // Prepare/migrate the token before exposing the helper manifest. Chrome
    // can launch the helper as soon as the manifest exists, and must not race
    // legacy-token migration by creating a different machine-wide token.
    const nativeMessaging = await prepareBrowserNativeMessaging({
      readToken: () => readOrCreateBrowserBridgeToken(configuration.browserBridgeTokenFile, {
        migrateFrom: configuration.legacyBrowserBridgeTokenFile
      }),
      registerHost: () => registerBrowserNativeHost({
        platform: process.platform,
        homeDir: os.homedir(),
        extensionId: resolveExtensionId(resolveExtensionDir()),
        helperPath: join(projectPath(), 'bin', 'happy-browser-native-host.mjs'),
      }),
      // Browser control can still be paired manually through `happy browser`.
      // A registration failure must not take the whole daemon down.
      onRegistrationError: (err) => logger.debug(`[DAEMON RUN] Browser Native Messaging host registration failed: ${err instanceof Error ? err.message : String(err)}`),
    });
    if (nativeMessaging.manifestPath) {
      logger.debug(`[DAEMON RUN] Browser Native Messaging host registered at ${nativeMessaging.manifestPath}`);
    }

    // Chrome extension bridge (specs/chrome-extension-bridge/). Listens on a
    // fixed loopback port because the extension cannot read daemon.state.json
    // to discover an ephemeral one. A bind failure (port taken) must not take
    // the daemon down — browser control is simply unavailable until restart.
    const browserSessionBroker = process.env.HAPPY_BROWSER_BROKER_SOCKET
      ? new BrowserSessionBrokerClient(process.env.HAPPY_BROWSER_BROKER_SOCKET)
      : null;
    const browserBridge = new BrowserBridge({
      authToken: nativeMessaging.token,
      ...(browserSessionBroker ? {
        onViewerActivity: (viewerKey: string) => {
          void browserSessionBroker.request({ op: 'touch', viewerKey }).then((response) => {
            if (!response.ok) logger.debug(`[DAEMON RUN] Browser bridge activity touch failed: ${response.code}`);
          }).catch((error) => {
            logger.debug(`[DAEMON RUN] Browser bridge activity touch failed: ${error instanceof Error ? error.message : String(error)}`);
          });
        },
      } : {}),
    });
    let stopBrowserBridge: () => Promise<void> = async () => {};
    try {
      const bridgeHost = resolveBrowserBridgeHost(process.env);
      const bridgeServer = await startBrowserBridgeServer({
        bridge: browserBridge,
        port: DEFAULT_BROWSER_BRIDGE_PORT,
        host: bridgeHost
      });
      stopBrowserBridge = bridgeServer.stop;
      if (bridgeHost !== '127.0.0.1') {
        logger.debug(`[DAEMON RUN] Browser bridge bound to ${bridgeHost} (HAPPY_BROWSER_BRIDGE_HOST) — not loopback-only`);
      }
    } catch (err) {
      logger.debug(`[DAEMON RUN] Browser bridge failed to start on ${DEFAULT_BROWSER_BRIDGE_PORT}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // /terminal (local-direct) needs the machine's E2EE key to decrypt open
    // params / encrypt frames the same way the relay path does, but the
    // machine object below doesn't exist until `api.getOrCreateMachine()`
    // resolves, well after this server starts — a ref the terminal route
    // reads lazily, rather than reordering daemon startup around it.
    let machineEncryptionForTerminalWs: { encryptionKey: Uint8Array; encryptionVariant: 'legacy' | 'dataKey' } | null = null;

    // Start control server
    const { port: controlPort, stop: stopControlServer, controlSecret } = await startDaemonControlServer({
      getChildren: getCurrentChildren,
      stopSession,
      spawnSession,
      requestShutdown: () => requestShutdown('happy-cli'),
      onHappySessionWebhook,
      onHappySessionRuntime,
      portRegistry,
      browserBridge,
      // 제어 서버의 파일 접근도 같은 잠금 정책을 따른다(HAPPY_RPC_ALLOWED_ROOT).
      allowedRoot: resolveDaemonAllowedRoot(process.env, os.homedir()),
      managedRuntime: managedIdentity.status === 'active',
      /*
       * Without this the control server refuses every managed report with
       * `no-launch-verifier` — the loopback bearer is readable by the agent's
       * own tools, so a report is only trusted once the launch registry says
       * which launch made it. The registry is filled at `register`, between
       * the supervisor's two phases, so a report can only arrive after the
       * launch it claims exists.
       */
      verifyManagedReport: async (claim) => managedReportVerifier(claim),
      getMachineEncryption: () => machineEncryptionForTerminalWs,
    });

    // The managed launch path hands this to each child with its credential.
    managedControlPortValue = controlPort;

    // Write initial daemon state (no lock needed for state file)
    const fileState: DaemonLocallyPersistedState = {
      pid: process.pid,
      httpPort: controlPort,
      startTime: new Date().toLocaleString(),
      startedWithCliVersion: packageJson.version,
      daemonLogPath: logger.logFilePath,
      state: 'running',
      trackedSessions: serializeTrackedSessions(),
      controlSecret,
    };
    writeDaemonState(fileState);
    logger.debug('[DAEMON RUN] Daemon state written');
    stopLogHousekeeping = startLogHousekeeping({
      logsDir: configuration.logsDir,
      currentLogPath: logger.logFilePath,
      debug: (message, details) => logger.debug(message, details),
    });

    // Now that fileState is available, assign the real implementation
    persistTrackedSessions = () => {
      writeDaemonStateDebounced({
        ...fileState,
        state: 'running',
        lastHeartbeat: new Date().toLocaleString(),
        trackedSessions: serializeTrackedSessions(),
      });
    };

    // Capture the bundled CLI's mtime at startup so the heartbeat can detect
    // when npm replaces `dist/index.mjs` on disk (= the user ran `npm i -g happy`).
    // We previously compared disk `package.json.version` to our bundled version,
    // but that produced infinite restart loops (#1107) when the manifest version
    // diverged from the bundled version (e.g. `happy-coder@0.13.1` deprecation
    // stub bumped package.json without rebuilding dist). File mtime is a more
    // reliable signal: it only changes when the bundle is actually replaced.
    const bundlePath = join(projectPath(), 'dist', 'index.mjs');
    let initialBundleMtimeMs = 0;
    try {
      initialBundleMtimeMs = statSync(bundlePath).mtimeMs;
    } catch {
      // dist/index.mjs not present (e.g. dev mode via tsx) — skip upgrade detection.
      logger.debug(`[DAEMON RUN] Bundle at ${bundlePath} not found; self-restart on upgrade disabled`);
    }

    // Prepare initial daemon state
    const initialDaemonState: DaemonState = {
      status: 'offline',
      pid: process.pid,
      httpPort: controlPort,
      startedAt: Date.now(),
      mcpCallerGrantPublicKey: encodeBase64(mcpCallerGrantKeyPair.publicKey),
    };

    // Create API client
    //
    // A managed runtime gets a **different principal**, not the account client
    // with a different token: it may read the Machine the parent registered and
    // nothing else — no registration, no account push, no key derivation.
    const api = managedCredential?.ok
      ? ApiClient.managedMachine({
        machineId: managedCredential.credential.machineId,
        token: managedCredential.credential.token,
        machineKey: managedCredential.credential.machineKey,
        // Validated against the server this process actually talks to. A
        // credential for another Happy is refused here rather than sent there.
        serverOrigin: managedCredential.credential.serverOrigin,
      })
      : await ApiClient.create(credentials);

    // Get or create machine.
    //
    // Defence in depth. getOrCreateMachine already degrades to offline mode for
    // every failure it recognises, but this is the startup path: anything it
    // does not recognise lands in the outer catch, which is a straight
    // process.exit(1). A daemon that exits is a daemon that is not there to
    // restart itself, and the whole point of it is to be present — so no
    // registration failure whatsoever is worth dying for.
    //
    // The degraded state is safe but not self-repairing: metadata and daemon
    // state versions reconcile against the server on the next update, but
    // nothing re-runs registration for the life of the process, so if the row
    // was never created the socket RPCs keep failing until the daemon restarts.
    let machine: Machine;
    if (managedCredential?.ok) {
      /*
       * Attached, not registered, and **not degraded to offline**.
       *
       * The offline fallback below is right for a laptop: a person's daemon
       * should keep serving local work when the network is down. Here it would
       * mean a cloud runtime answering the parent about a machine registration
       * that may not exist — and the parent dispatches on that answer. So a
       * managed runtime that cannot reach its own Machine does not start.
       */
      machine = await api.attachRegisteredMachine();
      logger.debug(`[DAEMON RUN] Managed machine attached: ${machine.id}`);
    } else try {
      machine = await api.getOrCreateMachine({
        machineId,
        metadata: difficultyRoutingMachineMetadata,
        daemonState: initialDaemonState,
        serverPublicKey
      });
      logger.debug(`[DAEMON RUN] Machine registered: ${machine.id}`);
    } catch (error) {
      logger.debug('[DAEMON RUN] Machine registration failed unexpectedly, starting offline', error);
      machine = api.buildOfflineMachine({
        machineId,
        metadata: difficultyRoutingMachineMetadata,
        daemonState: initialDaemonState
      });
    }
    // Local-direct terminal (/terminal) only needs the locally-derived
    // encryption key, not server registration — set it either way so an
    // offline-degraded daemon still serves same-machine desktop clients.
    machineEncryptionForTerminalWs = { encryptionKey: machine.encryptionKey, encryptionVariant: machine.encryptionVariant };
    startDifficultyRoutingElectionPoll({
      host: difficultyRoutingHost,
      machineId: machine.id,
      hostProcessKeyId: difficultyRoutingHostKey.id,
      token: credentials.token,
    });

    // Create realtime machine session
    const apiMachine = api.machineSyncClient(machine);
    startDifficultyRoutingMetadataPoll({
      apiMachine,
      host: difficultyRoutingHost,
      baseMetadata: difficultyRoutingMachineMetadata,
    });
    /** Set only for a managed runtime; the beat below keeps it current. */
    let managedCredentialState: {
      stateDir: string;
      machineId: string;
      current: { token: string; expiresAt: number };
    } | null = managedCredential?.ok && managedIdentity.status === 'active'
      ? {
        stateDir: managedIdentity.identity.stateDir,
        machineId: managedCredential.credential.machineId,
        current: {
          token: managedCredential.credential.token,
          expiresAt: managedCredential.credential.expiresAt,
        },
      }
      : null;
    let managedLeaseWatchdog: ReturnType<typeof setInterval> | null = null;
    /** Drains every in-flight managed operation; set once the handlers exist. */
    let managedDrainLeaseWork: (() => Promise<void>) | null = null;
    /** Refuses new managed RPC entries; set once the handlers exist. */
    let managedCloseEntries: (() => void) | null = null;

    /**
     * Shared by both exits — normal shutdown and the self-update replacement.
     *
     * The ordering lives in `managedTeardown.ts` so the daemon and its tests
     * exercise the same function rather than two descriptions of it.
     */
    const teardownManagedRuntime = async (): Promise<void> => runManagedTeardown({
      active: managedIdentity.status === 'active',
      stopWatchdog: () => {
        if (managedLeaseWatchdog) {
          clearInterval(managedLeaseWatchdog);
          managedLeaseWatchdog = null;
        }
      },
      closeEntries: () => managedCloseEntries?.(),
      drain: async () => { await managedDrainLeaseWork?.(); },
      // Only after the drain: work already inside must be able to record what
      // it did, or a launch that succeeded is left looking unfinished.
      closeWrites: () => { managedWriterLockHeld = false; },
      releaseLock: async () => {
        if (!releaseManagedWriterLock) return;
        const release = releaseManagedWriterLock;
        releaseManagedWriterLock = null;
        await release();
      },
      backendWired: managedFencingBackend !== null,
      logDebug: (message) => logger.debug(message),
    });

    // The managed dispatch surface. Identity and the writer lock were settled
    // during early bootstrap; this only builds what needs `spawnSession`.
    if (managedIdentity.status === 'active') {
      const identity = managedIdentity.identity;
      /*
       * The layout is read **before** the store is opened, under the writer lock
       * this startup already holds (acquired during early bootstrap). A runtime
       * whose receipts or lease are still in the state root is refused rather
       * than migrated: several renames cannot promise "nothing moved" when one
       * fails, and an empty leaf beside a populated old layout would restart
       * receipt de-duplication and read epoch 0 / seq 0 — re-admitting spent
       * requests and accepting superseded leases. Nothing here moves, rewrites
       * or re-owns a byte.
       */
      const layout = inspectManagedDaemonStateLayout(identity.stateDir);
      if (!layout.usable) {
        throw new Error(`managed daemon state layout refused: ${layout.reason} (${layout.detail})`);
      }
      const store = createManagedReceiptStore(managedDaemonStateDir(identity.stateDir), {
        assertHeld: (action) => {
          if (!managedWriterLockHeld) {
            throw new Error(`managed writer lock not held; refusing ${action}`);
          }
        },
      });
      /*
       * Captured so the checkpoint hand-off keeps the backend the guard
       * tested. The variable is settled during boot, but a closure that reads
       * it later would be answering with whatever it holds then, and this one
       * decides whether a parent-issued credential reaches the inbox at all.
       */
      const checkpointTargetBackend = managedFencingBackend;
      /*
       * Where personal Claude/Codex logins live on this runtime (R23).
       *
       * The provider uid comes from the marker, not from a request: the login
       * has to be readable by the uid that will run the agent, and by nothing
       * else on the machine. Built here because this is the only place that
       * holds both the verified identity and the RPC surface.
       */
      const managedAiAuthStore = createManagedAiAuthStore({
        provider: identity.isolation.provider,
        now: Date.now,
      });
      const managedHandlers = createManagedRpcHandlers({
        identity,
        store,
        aiAuth: managedAiAuthStore,
        /*
         * The managed path does **not** reuse `spawnSession`. That is the
         * ordinary daemon spawn — a detached `happy` child in the daemon's own
         * environment, with no broker, no provider plan and no separate
         * executor uid. It goes through the supervisor's two-phase launch
         * instead, and refuses when there is no supervisor to go through.
         *
         * The session already exists: the envelope carries the id the parent
         * created along with that session's own initial prompt, so nothing
         * here creates a session or delivers a prompt.
         */
        spawn: async (_request, context) => {
          logger.debug(
            `[managed] launching run=${context.runId} attempt=${context.attemptId} epoch=${context.epoch}`,
          );
          return launchManagedSpawn({
            backend: managedFencingBackend,
            context,
            /*
             * The child runs as a different uid and cannot read this daemon's
             * state file to find the port, so the address travels with the
             * launch credential instead. Loopback only.
             */
            reportBaseUrl: `http://127.0.0.1:${managedControlPort()}`,
            // Between the phases: the child is parked and has a pid, and has
            // not exec'd yet.
            register: ({ pid, sessionId, launchId, secret, encryption }) => {
              /*
               * Registered before the release, with the session the parent
               * created. Letting the first report choose the session would let
               * a child holding this launch's capability nail down another
               * Run's session as its own.
               */
              managedLaunchRegistry.register({
                launchId,
                scope: {
                  operationKey: context.operationKey,
                  runId: context.runId,
                  attemptId: context.attemptId,
                  epoch: context.epoch,
                  workspaceId: context.workspaceId,
                  projectId: context.projectId,
                },
                sessionId,
                hostPids: [pid],
                // From the envelope, not from whatever the first report says.
                encryption,
                /*
                 * Tied to this generation's write lease, not to a window of my
                 * own choosing. A fixed window cuts every activity report after
                 * it — the session is alive and the daemon stops seeing it — and
                 * an open-ended one outlives the right to write. The lease is
                 * the authority, so the report authority follows it.
                 */
                expiresAt: managedReportExpiryFor(context.leaseExpiresMonotonic),
                secret,
              });
              managedReportAuthority.grant({ key: context, pid, launchId });
              const trackedSession: TrackedSession = {
                startedBy: 'daemon',
                directory: context.envelope.directory,
                happySessionId: sessionId,
                pid,
              };
              pidToTrackedSession.set(pid, trackedSession);
              sessionStartTimes.set(pid, Date.now());
              managedGenerationForPid.set(pid, {
                runId: context.runId, attemptId: context.attemptId, epoch: context.epoch,
              });
              persistTrackedSessions();
            },
            unregister: ({ pid }) => {
              // The launch never happened; its report authority goes with it.
              managedReportAuthority.revoke(context);
              pidToTrackedSession.delete(pid);
              sessionStartTimes.delete(pid);
              managedGenerationForPid.delete(pid);
              persistTrackedSessions();
            },
            /*
             * The same webhook wait the ordinary spawn path uses: the child
             * POSTs `/session-started` with its pid and the daemon resolves
             * the awaiter. Reporting success before that would report a run
             * for a child that may never have got past `execve`.
             */
            waitForChildReady: async (pid) => {
              const result = await waitForSessionWebhook({ pid, pidToAwaiter, label: '(managed)', logger });
              if (result.type === 'success' && result.sessionId) {
                return { ready: true, sessionId: result.sessionId };
              }
              // The child's message is not carried back: it is the daemon's
              // own text, but the managed caller gets codes only.
              return { ready: false, detail: 'session-webhook-unconfirmed' };
            },
          });
        },
        // The daemon asks; the supervisor decides and proves. Absent when the
        // boot path bound none, and every path that needs a proof then refuses.
        ...(managedFencingBackend ? { fencingBackend: managedReportRevokingBackend(managedFencingBackend) } : {}),
        /*
         * Parent → daemon → supervisor → the checkpoint session's inbox. The
         * daemon holds the RPC but not the drain: the inbox lives beside the
         * tool session in the supervisor process, so the target crosses the
         * process boundary as bytes and the far side's answer is passed back
         * unfolded — a refusal there must not read here as an acceptance.
         *
         * Absent when no supervisor is wired, which `managed:checkpoint`
         * reports as `capability-unavailable` rather than accepting a target
         * that has nowhere to go.
         */
        ...(checkpointTargetBackend ? {
          acceptCheckpointTarget: (target: Record<string, unknown>, dispatchToken: string) =>
            checkpointTargetBackend.pushCheckpointTarget(target, dispatchToken),
        } : {}),
        /*
         * A generation's report authority lives exactly as long as its right to
         * write. Without this the registry entry lapses at the first lease and
         * every activity report after it is refused — the session is alive and
         * the daemon stops seeing it.
         *
         * A runtime lease names no run and widens the window for every
         * generation, so it renews all of them.
         */
        onLeaseRenewed: async ({
          runId, attemptId, epoch, leaseExpiresMonotonic, renewalSeq, grant,
        }) => {
          /*
           * And every generation's own deadline, which is a different clock.
           *
           * The supervisor arms a watchdog per generation at launch, from the
           * lease that was live then, and the only thing that moves it is the
           * IPC `renew`. Renewing here moved the report authority and nothing
           * else, so that watchdog still fired at the spawn-time deadline and
           * killed a generation whose right to write had been extended —
           * measured to `launch + leaseMs` within 9ms.
           *
           * **Runtime-scoped grants are the ones that matter.** The parent only
           * ever sends `managed:runtime-lease`; nothing in the product sends
           * the run-scoped `managed:lease`. A re-arm that required a `runId`
           * therefore never ran outside a harness, which is exactly how this
           * looked fixed while the product still killed every generation at
           * its spawn deadline. A runtime lease names no run because it widens
           * the window for **all** of them, so all of them are re-armed.
           *
           * A checkpoint is the worst place for the kill to land: `cgroup.kill`
           * arrives as the exit the quiescence gate was waiting for, and the
           * proof is destroyed by the runtime enforcing a lease that is no
           * longer the current one.
           */
          /*
           * One call. What it decides — relay the parent's statement before any
           * generation is re-armed, and treat a refusal at either step as an
           * enforcement refusal — lives in `managedGenerationRearm.ts` where a
           * test can reach it without booting a daemon.
           *
           * On a null backend: a successful managed boot writes the launcher
           * binding before READY (`managedRuntimeBoot.ts:623-652`,
           * `src/main.ts:139-160`, `docker/managed-runtime/entrypoint:95-141`)
           * and the daemon reads it into a client at `run.ts:582-595`; without
           * it the daemon still starts but `isolation.verified` is false
           * (`:656`) and the spawn backend is unavailable. So a null backend is
           * a degraded or refused state rather than a supported ready path.
           * A non-null one is not proof of a live listener either — the F2
           * hello that would is still pending.
           */
          return enforceLeaseRenewal({
            grant,
            lease: { epoch, runId, attemptId, renewalSeq, leaseExpiresMonotonic },
            backend: managedFencingBackend,
            liveGenerations: () => [...managedGenerationForPid.values()],
            onRefused: (code: string) => logger.debug(`[managed] lease renewal refused ${code}`),
          });
        },
        /*
         * Report capability follows the lease, and only once the lease is on
         * disk.
         *
         * It used to be published at the top of `onLeaseRenewed`, before the
         * enforcement answer and before the write: a refused renewal still
         * widened this runtime's right to report, and a failed write left that
         * right extended past a lease this runtime never recorded — `Astra`
         * reproduced the second as `isLeaseValid()` true past the old deadline
         * after a `disk-full` throw.
         *
         * This hook runs after `store.writeLease`, so both are closed: nothing
         * is published for a refusal, and nothing is published for a lease that
         * did not persist.
         */
        onLeaseCommitted: ({ runId, attemptId, epoch, leaseExpiresMonotonic }) => {
          const expiresAt = managedReportExpiryFor(leaseExpiresMonotonic);
          const scope = runId !== undefined && attemptId !== undefined
            ? { runId, attemptId, epoch }
            : { epoch };
          for (const launchId of managedReportAuthority.launchIdsFor(scope)) {
            managedLaunchRegistry.renew({ launchId, expiresAt });
          }
        },
        /*
         * The common termination path: stop RPC, promotion fence and lease
         * expiry all reach it, and it runs **before** the backend is asked, so
         * a report already in flight cannot land after the child is gone and
         * re-register state for a generation that no longer exists.
         */
        onGenerationTerminated: (key) => { managedReportAuthority.revoke(key); },
        isPidAlive,
        now: Date.now,
        // The same clock the supervisor enforces against; see
        // `managedMonotonicNow`.
        monotonicNow: managedMonotonicNow,
        // What this runtime can say about itself, read fresh on every status
        // request rather than captured once: a volume can be lost and an
        // isolation backend can stop answering, and a cached "ready" would
        // outlive both.
        runtimeFacts: () => managedRuntimeFacts(),
        /*
         * Takes a renewed bearer for the Machine this runtime already is.
         *
         * The judging belongs to the credential module: it carries the machine
         * key, the account key and the origin forward from the stored record
         * and refuses anything that is not this Machine, this origin, and
         * strictly later. This wiring supplies only where the file lives and
         * which Machine the **marker** says this is — never the request.
         *
         * On success the live socket takes it up too. `replaceToken` re-auths
         * by dropping the connection so the reconnect presents the new bearer:
         * the server revalidates the grant on every event against the token the
         * handshake carried, and refuses the superseded one once its renewal
         * grace ends. Writing the file alone would leave a runtime that looks
         * connected while everything it asks for fails.
         *
         * Only after the write. A socket re-authed with a bearer that was then
         * refused for the disk would be presenting a credential this runtime
         * does not have.
         *
         * And only after the **answer has left**. This runs inside the
         * `managed:credential` RPC; dropping the socket here drops the
         * response with it, and the parent — told nothing — pushes again
         * (seen on the first dev renewal: `io client disconnect` between the
         * handler returning and its response being sent). The grace the
         * server keeps for the superseded generation is what makes a moment's
         * delay safe.
         */
        replaceCredential: async (replacement) => {
          const outcome = await replaceManagedDaemonCredential({
            stateDir: identity.stateDir,
            expectedMachineId: identity.happyMachineId,
            replacement,
            now: Date.now(),
            deps: defaultProvisioningDeps,
          });
          if (outcome.ok) {
            setTimeout(() => apiMachine.replaceToken(replacement.token), 500).unref();
          }
          return outcome;
        },
      });
      // Installed before setRPCHandlers so the allowlist sweeps the handlers
      // the constructor already registered and intercepts the rest.
      apiMachine.setManagedRuntime(managedHandlers);
      managedDrainLeaseWork = () => managedHandlers.drainLeaseWork();
      managedNoteSessionRuntime = (sessionId, pid, report) => managedHandlers.noteSessionRuntime(sessionId, pid, report);
      managedNoteChildExited = (pid) => managedHandlers.noteChildExited(pid);
      managedCloseEntries = () => {
        managedHandlers.closeEntries();
        // A pending login is a child process and a verifier held in memory.
        // Neither survives this daemon, so both end with it rather than being
        // left for a supervisor to find.
        managedAiAuthStore.close();
      };
      // The handler serializes expiry against renewal and promotion, so the
      // interval only has to avoid piling work onto that queue: a tick is
      // skipped while the previous one is still outstanding.
      let watchdogBusy = false;
      managedLeaseWatchdog = setInterval(() => {
        if (watchdogBusy) return;
        watchdogBusy = true;
        void managedHandlers.runLeaseMaintenance().then((outcome) => {
          // Keyed on `actionRequired` alone: a refused stop under a *valid*
          // lease is exactly the case an `expired &&` condition would hide.
          if (outcome.actionRequired) {
            logger.debug(
              `[managed] action required (expired=${outcome.expired}); `
              + `${outcome.live.length} handed over, ${outcome.unstoppable.length} not accepted, `
              + `${outcome.pendingStopsRetried} stop(s) retried, storeUnreadable=${outcome.storeUnreadable}`,
            );
          }
        }).catch((error) => {
          logger.debug(`[managed] lease watchdog failed: ${(error as Error).message}`);
        }).finally(() => {
          watchdogBusy = false;
        });
      }, 5_000);
      managedLeaseWatchdog.unref();
    }
    const claudeSwapSupervisor = createClaudeSwapSupervisor(
      join(configuration.happyHomeDir, 'claude-swap-supervisor.json'),
    );
    stopClaudeSwapSupervisor = () => claudeSwapSupervisor.shutdown();
    await claudeSwapSupervisor.restore();
    const aiCredentialRuntime = createNodeAiCredentialRuntime(claudeSwapSupervisor);
    resolveManagedAiCredentialEnvironment = (agent) => aiCredentialRuntime.sessionEnvironment(agent);
    let activeServerAutomationLeaseCount = 0;
    let scriptWorker: ReturnType<typeof createScriptAutomationWorker> | null = null;
    if (shouldRunScriptAutomations({
        managedRuntimeActive: managedIdentity.status === 'active',
        enabled: process.env.HAPPY_SCRIPT_AUTOMATIONS_ENABLED,
    })) {
      try {
        const image = process.env.HAPPY_SCRIPT_RUNTIME_IMAGE;
        if (!image) throw new Error('SCRIPT_RUNTIME_IMAGE_REQUIRED');
        const studioConfigUrl = process.env.HAPPY_APLUS_MCP_CONFIG_URL;
        if (!studioConfigUrl) throw new Error('SCRIPT_STUDIO_AUTHORIZATION_REQUIRED');
        const studioUrl = new URL(studioConfigUrl);
        if (studioUrl.protocol !== 'https:' && !(studioUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(studioUrl.hostname))) throw new Error('SCRIPT_STUDIO_HTTPS_REQUIRED');
        const request = async (method: string, path: string, body?: unknown, baseUrl = configuration.serverUrl): Promise<unknown> => {
          try {
            const response = await axios.request({ method, url: new URL(path, baseUrl).href,
              headers: { Authorization: `Bearer ${credentials.token}` }, data: body, timeout: 10000,
              maxContentLength: 16 * 1024 * 1024, maxBodyLength: 12 * 1024 * 1024, proxy: false });
            return response.data;
          } catch (error) {
            if (axios.isAxiosError(error) && error.response) {
              const code = error.response.data?.error;
              throw new ScriptRequestError(error.response.status, typeof code === 'string' && /^[A-Z0-9_]{1,100}$/.test(code) ? code : 'SCRIPT_REQUEST_FAILED');
            }
            throw error;
          }
        };
        const profile = await request('GET', '/v1/account/profile') as { id?: unknown };
        if (typeof profile.id !== 'string' || !profile.id) throw new Error('SCRIPT_ACCOUNT_UNAVAILABLE');
        const ownerId = createHash('sha256').update(JSON.stringify([configuration.serverUrl, profile.id, machineId])).digest('hex');
        const directory = join(configuration.happyHomeDir, 'script-automations', ownerId);
        const temporaryRoot = join(directory, 'work');
        await prepareManagedScriptRuntime({ ownerId, directory: temporaryRoot, image });
        await request('GET', `/v1/machines/${encodeURIComponent(machineId)}/script-automations`);
        const authorize = async (runId: string, claimToken: string, secretRefs?: { [name: string]: string }) => {
          const response = await request('POST', '/api/automation/script-execution', { machineId, runId, claimToken,
            ...(secretRefs ? { secretRefs } : {}) }, studioUrl.origin);
          return z.object({ executionProof: z.string().min(1), secrets: z.record(z.string(), z.string()),
            approvedPrivateOrigins: z.array(z.string()) }).parse(response);
        };
        const worker = createScriptAutomationWorker({ machineId, accountId: profile.id,
          machineSecretKey: machineAutomationKey.secretKey, image, directory: join(directory, 'outbox'), request,
          recoverContainers: () => recoverManagedScriptContainers({ ownerId, directory: temporaryRoot }),
          execute: (input) => runManagedScript({ ...input, ownerId, temporaryRoot }),
          authorizeStart: async (_record, runId, token) => (await authorize(runId, token)).executionProof,
          resolveSecrets: async (_record, refs, runId, token) => {
            const { secrets, approvedPrivateOrigins } = await authorize(runId, token, refs);
            return { secrets, approvedPrivateOrigins };
          },
          log: (message) => logger.debug(`[script-automations] ${message}`) });
        await worker.recover();
        scriptWorker = worker;
        stopScriptWorker = () => worker.stop();
      } catch (error) {
        logger.debug(`[script-automations] Script runtime unavailable; capability remains disabled: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }
    const scriptAutomationTickRunner = createAutomationTickRunner({
      runTick: async () => { await scriptWorker?.tick(); },
      logDebug: (message) => logger.debug(`[script-automations] ${message}`),
    });
    apiMachine.setAutomationKey(machineAutomationKey, (keyVersion) => {
      machineAutomationKey = updateMachineAutomationKeyRegistration(
        configuration.automationKeyFile,
        machineAutomationKey,
        keyVersion,
      );
    }, scriptWorker ? SCRIPT_AUTOMATION_PROTOCOL_VERSION : AUTOMATION_PROTOCOL_VERSION);
    /*
     * The lesson host. The studio origin is the daemon's own configured value
     * — the same one the MCP config uses — never anything from a request, and
     * the bearer is this daemon's account credential. Absent either, the
     * supervisor still answers, and it answers `disabled`.
     */
    /*
     * One verifier for routing, built from the studio key this daemon fetched.
     * Null until that key is available, and a null verifier refuses every
     * lesson request rather than routing it on an unverified body.
     */
    let lessonRouteVerifier: LessonGrantVerifier | null = null;
    const lessonStudioOrigin = (() => {
      const configured = process.env.HAPPY_APLUS_MCP_CONFIG_URL;
      if (!configured) return null;
      try { return new URL(configured).origin; } catch { return null; }
    })();
    if (lessonStudioOrigin && machineId) {
      const lessonPublicKey = await fetchLessonGrantPublicKey({
        studioBaseUrl: lessonStudioOrigin,
        token: credentials.token,
        machineId,
      });
      if (lessonPublicKey) {
        try {
          lessonRouteVerifier = createLessonGrantVerifier({
            publicKeyBase64: lessonPublicKey,
            machineId,
            audience: lessonGrantAudience(lessonStudioOrigin),
          });
        } catch (error) {
          logger.debug(`[lesson-host] routing key unusable: ${(error as Error).message}`);
        }
      }
    }
    const lessonHosts = createLessonHostSupervisor({
      /*
       * Routing reads the signed `workspaceDir` out of the envelope. The
       * daemon deliberately does *not* supply a directory of its own: the MCP
       * caller grant it consumes at spawn signs a project and a machine but
       * never a path, so deriving the workspace from a spawn would let a valid
       * grant for one project open another project's store.
       */
      routeVerifier: () => lessonRouteVerifier,
      loadRouteVerifier: async () => {
        if (!lessonStudioOrigin || !machineId) return null;
        const key = await fetchLessonGrantPublicKey({
          studioBaseUrl: lessonStudioOrigin, token: credentials.token, machineId,
        });
        if (!key) return null;
        lessonRouteVerifier = createLessonGrantVerifier({
          publicKeyBase64: key, machineId, audience: lessonGrantAudience(lessonStudioOrigin),
        });
        return lessonRouteVerifier;
      },
      // Lets a turn or a review open a project nobody has clicked into yet.
      // The studio still decides, and still signs the path.
      requestSnapshotGrant: (projectId) => (lessonStudioOrigin && machineId
        ? requestLessonSnapshotGrant({
          studioBaseUrl: lessonStudioOrigin, token: credentials.token, machineId, projectId,
        })
        : Promise.resolve(null)),
      machineId: () => machineId,
      studioBaseUrl: () => lessonStudioOrigin,
      studioToken: () => credentials.token,
      // The shared helper, so the daemon and every session name the same file.
      settingsPathFor: (projectId) => lessonSettingsPath(configuration.happyHomeDir, projectId),
      // The worker writes this from the provider process; the UI reads it here.
      reviewOutcomeFor: (projectId) => createLessonReviewOutcomeStore(
        lessonReviewOutcomePath(configuration.happyHomeDir, projectId),
      ).read(),
    });
    await apiMachine.setLessonHosts(lessonHosts);
    apiMachine.setServerAutomationCache(serverAutomationCache);
    const serverAutomationTickRunner = createAutomationTickRunner({
      runTick: () => runServerAutomationTick({
        cache: serverAutomationCache,
        runtimeStore: serverAutomationRuntimeStore,
        machineSecretKey: machineAutomationKey.secretKey,
        now: Date.now(),
        transport: apiMachine.serverAutomationTransport(),
        decryptPayload: decryptServerAutomationPayload,
        runScript: (input) => runAutomationScript({ ...input, allowedRoot: automationAllowedRoot }),
        queryGithubPullRequests: (input) => queryGithubPullRequests({
          ...input,
          configUrl: process.env.HAPPY_APLUS_MCP_CONFIG_URL,
          machineToken: credentials.token,
          machineId,
          allowedRoot: automationAllowedRoot,
        }),
        queryGithubPullRequestFiles: (input) => queryGithubPullRequestFiles({
          ...input,
          allowedRoot: automationAllowedRoot,
        }),
        queryGithubIssues: (input) => queryGithubIssues({
          ...input,
          configUrl: process.env.HAPPY_APLUS_MCP_CONFIG_URL,
          machineToken: credentials.token,
          machineId,
          allowedRoot: automationAllowedRoot,
        }),
        notifyGithubTrigger: ({ title, body, url }) => {
          api.push().sendToAllDevices(title, body, { kind: 'github-trigger', url });
        },
        resolveGithubIssueProgressMarkerIdentity: (input) => resolveGithubIssueProgressMarkerIdentity({
          ...input,
          allowedRoot: automationAllowedRoot,
        }),
        createGithubIssueProgressMarker: (input) => createGithubIssueProgressMarker({
          ...input,
          allowedRoot: automationAllowedRoot,
        }),
        removeGithubIssueProgressMarker: (input) => removeGithubIssueProgressMarker({
          ...input,
          allowedRoot: automationAllowedRoot,
        }),
        dispatchAgentTask: (input) => dispatchAutomationAgentTask({
          ...input,
          configUrl: process.env.HAPPY_APLUS_MCP_CONFIG_URL,
          machineToken: credentials.token,
          machineId,
        }),
        maintainAgentTaskLease: (dispatch) => {
          activeServerAutomationLeaseCount += 1;
          maintainAutomationAgentTaskLease({
            dispatch,
            onStop: () => {
              activeServerAutomationLeaseCount = Math.max(0, activeServerAutomationLeaseCount - 1);
            },
          });
        },
        resolveProjectEnvironment: ({ runId, claimToken }) => fetchAutomationProjectEnvironment({
          configUrl: process.env.HAPPY_APLUS_MCP_CONFIG_URL,
          machineToken: credentials.token,
          machineId,
          runId,
          claimToken,
        }),
        resolveMcpSpawnContext: ({ runId, claimToken }) => exchangeAutomationMcpCallerGrant({
          configUrl: process.env.HAPPY_APLUS_MCP_CONFIG_URL,
          machineToken: credentials.token,
          machineId,
          runId,
          claimToken,
          logDebug: (message) => logger.debug(`[DAEMON RUN] [server-automation] ${message}`),
        }),
        preflightMcpConnectors: ({ runId, context }) => preflightAutomationConnectors({
          configUrl: process.env.HAPPY_APLUS_MCP_CONFIG_URL,
          machineToken: credentials.token,
          machineId,
          runId,
          context,
        }),
        linkSession: ({ runId, claimToken, sessionId }) => linkAutomationProjectSession({
          configUrl: process.env.HAPPY_APLUS_MCP_CONFIG_URL,
          machineToken: credentials.token,
          machineId,
          runId,
          claimToken,
          logDebug: (message) => logger.debug(`[DAEMON RUN] [server-automation] ${message}`),
          sessionId,
        }),
        resumeSession: resumeAutomationSession,
        spawnSession: spawnAutomationSession,
        prepareGithubWorktree: (input) => prepareGithubTriggerWorktree({
          ...input,
          managedRoot: join(configuration.happyHomeDir, 'automation-worktrees'),
        }),
        discardGithubWorktree: removeGithubTriggerWorktree,
        isSessionRunning: isAutomationSessionRunning,
        stopSession: (sessionId) => {
          stopSession(sessionId, {
            source: 'server-automation',
            reason: 'GitHub worker session outlived the runtime cap',
          });
        },
        isDirectoryInUse: isAutomationDirectoryInUse,
        logDebug: (message) => logger.debug(`[DAEMON RUN] ${message}`),
      }),
      logDebug: (message) => logger.debug(`[DAEMON RUN] ${message}`),
    });
    const sessionFollowupSyncState = createSessionFollowupSyncState();
    const sessionFollowupTickRunner = createAutomationTickRunner({
      runTick: () => runSessionFollowupTick({
        transport: apiMachine.sessionFollowupTransport(),
        decryptPayload: (followup) => decryptSessionFollowupDaemonPayload(
          followup,
          machineAutomationKey.secretKey,
        ),
        resolveSession: (sessionId) => {
          const tracked = findTrackedSessionById(sessionId);
          const directory = tracked?.happySessionMetadataFromLocalWebhook?.path ?? tracked?.directory;
          if (!tracked?.encryption || !directory) return null;
          return {
            sessionId,
            directory,
            encryptionKey: tracked.encryption.encryptionKey,
            encryptionVariant: tracked.encryption.encryptionVariant,
            live: hasLiveDaemonChild(sessionId, pidToTrackedSession.values(), isPidAlive),
          };
        },
        sameDirectory: async (left, right) => (
          await resolveAutomationDirectoryMatch(left, right)
        ) === true,
        fetchMessages: async ({ sessionId, afterSeq }) => {
          const messages: EncryptedFollowupMessage[] = [];
          let cursor = afterSeq;
          let complete = false;
          for (let page = 0; page < 100; page += 1) {
            const response = await axios.get<{
              messages?: Array<{
                seq?: unknown;
                localId?: unknown;
                content?: { t?: unknown; c?: unknown };
              }>;
              hasMore?: unknown;
            }>(`${configuration.serverUrl}/v3/sessions/${encodeURIComponent(sessionId)}/messages`, {
              params: { after_seq: cursor, limit: 500 },
              headers: { Authorization: `Bearer ${credentials.token}` },
              timeout: 60_000,
            });
            const pageMessages = Array.isArray(response.data.messages) ? response.data.messages : [];
            let maxSeq = cursor;
            for (const message of pageMessages) {
              if (!Number.isSafeInteger(message.seq) || (message.seq as number) <= cursor
                || message.content?.t !== 'encrypted' || typeof message.content.c !== 'string') {
                throw new Error('session-followup-message-invalid');
              }
              const seq = message.seq as number;
              maxSeq = Math.max(maxSeq, seq);
              messages.push({
                seq,
                localId: typeof message.localId === 'string' ? message.localId : null,
                contentCiphertext: message.content.c,
              });
            }
            if (response.data.hasMore !== true) {
              complete = true;
              break;
            }
            if (maxSeq === cursor) throw new Error('session-followup-pagination-stalled');
            cursor = maxSeq;
          }
          if (!complete) throw new Error('session-followup-pagination-limit');
          return messages;
        },
        decryptMessage: (binding, ciphertext) => decrypt(
          binding.encryptionKey,
          binding.encryptionVariant,
          decodeBase64(ciphertext),
        ),
        encryptUserMessage: (binding, message) => encodeBase64(encrypt(
          binding.encryptionKey,
          binding.encryptionVariant,
          message,
        )),
        ensureSessionRunning: async ({ sessionId }) => {
          // Share the same per-session resume fence as interactive and recovery
          // callers. Bypassing it can double-spawn when a user resume races the
          // follow-up daemon after an idle child exits.
          const result = await resumeSession(sessionId);
          return result.type === 'success'
            ? { ok: true }
            : {
              ok: false,
              error: result.type === 'error' ? result.errorMessage : `unexpected resume result: ${result.type}`,
              retryable: result.type === 'error' && [
                'SESSION_SERVER_UNAVAILABLE',
                'SESSION_ALIVE_ELSEWHERE',
              ].includes(result.code),
            };
        },
        logDebug: (message) => logger.debug(`[DAEMON RUN] ${message}`),
      }, sessionFollowupSyncState),
      logDebug: (message) => logger.debug(`[DAEMON RUN] ${message}`),
    });

    /*
     * The BYOS offline receiver.
     *
     * Absent when no parent origin is configured, and that is deliberate: the
     * adapter returns `undefined` rather than a handler that can only hold, so
     * an unconfigured deployment registers nothing instead of looking like a
     * queue that never drains.
     *
     * `unknown` is not `refused`. A refusal means the request never went out and
     * the parent may re-queue it; `unknown` means nobody can say, and the parent
     * must put it in front of a person. Only a receipt the server acknowledged
     * counts as accepted.
     *
     * Not registered on a managed runtime. This receiver posts as the account
     * (`readAccountToken`), and a managed runtime's `credentials.token` is a
     * managed-daemon token, not an account one — registering here would offer a
     * surface whose every delivery fails at the server, and would do it with a
     * bearer minted for a different purpose. Managed dispatch keeps its own
     * principal gate; nothing about it changes.
     */
    const byosOfflineReceive = managedRuntimeActive ? undefined : createByosOfflineReceiveWiring({
      machineId,
      happyHomeDir: configuration.happyHomeDir,
      serverUrl: configuration.serverUrl,
      readAccountToken: () => credentials.token,
      parentConfigUrl: process.env.HAPPY_APLUS_MCP_CONFIG_URL,
      findTrackedSession: (sessionId) => findTrackedSessionById(sessionId) ?? null,
      // The same per-session resume the follow-up runner uses; `resumeSession`
      // is this scope's closure, not a free function.
      ensureSessionRunning: async ({ sessionId }) => {
        const result = await resumeSession(sessionId);
        /*
         * The resume's own classifier, never its message. `errorMessage` is
         * free text assembled from whatever failed — a path, a spawn error, a
         * lookup fault — and this value travels back to the parent. The union
         * is closed: `code` for a refusal, and the result `type` for the one
         * other shape (`requestToApproveDirectoryCreation`), which is not an
         * error and must not be reported as one without saying which it was.
         */
        return result.type === 'success'
          ? { ok: true }
          : { ok: false, error: result.type === 'error' ? result.code : result.type };
      },
      onWakeFailed: ({ sessionId, reason }) => logger.debug(
        `[DAEMON RUN] byos-offline delivered but could not wake ${sessionId}: ${reason}`,
      ),
    });

    // Set RPC handlers
    apiMachine.setRPCHandlers({
      daemonSessionState: createDaemonSessionStateHandler(getCurrentChildren),
      byosOfflineReceive,
      difficultyRouting: difficultyRoutingHost,
      spawnSession,
      resumeSession,
      recoverSession,
      stopSession,
      stopSessionWithExitVerification,
      requestShutdown: () => requestShutdown('happy-app'),
      portRegistry,
      automationStore,
      aiCredentialRuntime,
      autonomousQualityGate: createAutonomousQualityGateRpcHandlers(autonomousQualityGateRegistry),
      checkpoint: createCheckpointRpcHandlers({
        checkpointRoot: join(configuration.happyHomeDir, 'checkpoints'),
        resolveAuthority: (sessionId) => resolveCheckpointSessionAuthority({
          sessionId,
          trackedSession: findTrackedSessionById(sessionId),
          checkpointRoot: join(configuration.happyHomeDir, 'checkpoints'),
          platform: process.platform,
        }),
        resolveEventPublisher: async (sessionId) => {
          const trackedSession = findTrackedSessionById(sessionId);
          if (!trackedSession?.encryption) return null;
          return createCheckpointEventPublisher({
            token: credentials.token,
            sessionId,
            encryption: trackedSession.encryption,
          });
        },
        restartSession: restartCheckpointSession,
      }),
      // specs/daemon-spawn-project-link — a session created by `agent spawn` has no way to
      // register itself with A+ (its credential does not authenticate /api/*), so the daemon
      // reports it here. The request is bounded inside linkSpawnedProjectSession and
      // settles before the RPC response so Desktop can load the child immediately.
      // A failed link is logged but never turns a live child into a failed spawn.
      linkSpawnedSession: async ({ sessionId, directory }) => {
        const result = await linkSpawnedProjectSession({
          configUrl: process.env.HAPPY_APLUS_MCP_CONFIG_URL,
          machineToken: credentials.token,
          machineId,
          sessionId,
          directory,
          logDebug: (message) => logger.debug(`[DAEMON RUN] [spawn-link] ${message}`),
        });
        if (!result.ok) {
          logger.debug(`[DAEMON RUN] [spawn-link] Spawned session project link failed: ${result.error}`);
        }
      },
    });
    const getRuntimeActivity = () => ({
      activeSessionCount: getCurrentChildren().filter((session) => isPidAlive(session.pid)).length
        + getDaemonTerminalSessionCount(),
      activeAutomationCount: Number(automationTickRunner.isRunning())
        + Number(serverAutomationTickRunner.isRunning())
        + Number(scriptAutomationTickRunner.isRunning())
        + Number(sessionFollowupTickRunner.isRunning())
        + activeServerAutomationLeaseCount,
    });
    apiMachine.setRuntimeActivityProvider(getRuntimeActivity);

    // Connect to server
    apiMachine.connect();

    // Emit session-end events for dead sessions from previous daemon run
    if (deadSessionsToCleanup.length > 0) {
      logger.debug(`[DAEMON RUN] Cleaning up ${deadSessionsToCleanup.length} dead sessions from previous run`);
      for (const dead of deadSessionsToCleanup) {
        if (!dead.happySessionId || !persistedSessions[dead.happySessionId]) {
          removeDeferredContinuationContextFile(dead.deferredContinuationContextFile);
        }
        if (dead.happySessionId) {
          api.postSessionEvent(dead.happySessionId, 'session-end', '').catch((error) => {
            logger.debug(`[DAEMON RUN] Failed to emit session-end for dead session ${dead.happySessionId}: ${error}`);
          });
        }
      }
    }

    // Every 60 seconds by default:
    // 1. Prune stale sessions
    // 2. Check if daemon needs update
    // 3. If outdated, restart with latest version
    // 4. Write heartbeat
    const heartbeatIntervalMsEnv = Number(process.env.HAPPY_DAEMON_HEARTBEAT_INTERVAL);
    const heartbeatIntervalMs = Number.isFinite(heartbeatIntervalMsEnv) && heartbeatIntervalMsEnv > 0
      ? heartbeatIntervalMsEnv
      : 60_000;
    const idleReaperConfig = readDaemonSessionIdleReaperConfig(process.env, { managedRuntimeActive });
    const emptySessionReaperMs = readEmptySessionReaperMs(process.env);
    let heartbeatRunning = false
    const restartOnStaleVersionAndHeartbeat = setInterval(async () => {
      if (heartbeatRunning) {
        return;
      }
      heartbeatRunning = true;

      if (process.env.DEBUG) {
        logger.debug(`[DAEMON RUN] Health check started at ${new Date().toLocaleString()}`);
      }

      /*
       * A managed runtime's credential is renewed by the parent while this
       * process runs, and it expires if nobody does.
       *
       * Checked on the beat that already exists rather than on a timer of its
       * own: a second loop would have to be stopped in every shutdown path,
       * and one that was missed would keep a dead runtime alive.
       *
       * A renewal only changes what the **next** connection presents. The live
       * socket authenticated when it opened and is left alone — dropping it to
       * apply a token it does not need would interrupt running work.
       */
      if (managedCredentialState) {
        const action = readManagedCredentialAction({
          stateDir: managedCredentialState.stateDir,
          expectedMachineId: managedCredentialState.machineId,
          current: managedCredentialState.current,
          now: Date.now(),
        });
        if (action.kind === 'renewed') {
          apiMachine.replaceToken(action.token);
          managedCredentialState.current = { token: action.token, expiresAt: action.expiresAt };
          logger.debug('[DAEMON RUN] Managed credential renewed');
        } else if (action.kind === 'stop') {
          // Not retried and not degraded: reconnecting with a dead bearer looks
          // like a network fault to everyone while the parent already knows
          // this runtime is no longer authorised.
          logger.debug(`[DAEMON RUN] Managed credential ${action.reason}; stopping the machine socket`);
          managedCredentialState = null;
          apiMachine.stopForExpiredCredential();
        }
      }

      // Prune stale sessions
      for (const [pid, _] of pidToTrackedSession.entries()) {
        if (!isPidAlive(pid)) {
          logger.debug(`[DAEMON RUN] Removing stale session with PID ${pid} (process no longer exists)`);
          onChildExited(pid);
        }
      }

      // Reclaim sessions whose runtime stopped reporting entirely (dead process
      // with a live PID). Independent of the server flow so a genuine leak
      // doesn't wait out the 24h idle cut.
      sweepZombieSessions({
        trackedSessions: getCurrentChildren(),
        sessionStartTimes,
        daemonStartedAt,
        stopSession,
        silenceMs: idleStopGuardConfig.hardCapMs,
        logDebug: (message) => logger.debug(`[DAEMON RUN] ${message}`),
      });

      // Reclaim never-used sessions (project opened, no prompt ever sent). These
      // report a live-but-idle runtime forever, so neither the zombie sweep nor
      // the turn-end reap catches them; without this they wait out the 24h cut.
      if (emptySessionReaperMs !== undefined) {
        sweepEmptySessions({
          trackedSessions: getCurrentChildren(),
          sessionStartTimes,
          stopSession,
          emptyReaperMs: emptySessionReaperMs,
          batchMax: idleReaperConfig.batchMax,
          logDebug: (message) => logger.debug(`[DAEMON RUN] ${message}`),
        });
      }

      if (!idleReaperConfig.disabled) {
        await runDaemonSessionIdleReaperTick({
          machineId,
          serverUrl: configuration.serverUrl,
          credentialsToken: credentials.token,
          trackedSessions: getCurrentChildren(),
          sessionStartTimes,
          stopSession,
          ...(idleReaperConfig.idleAfterMs !== undefined ? { idleAfterMs: idleReaperConfig.idleAfterMs } : {}),
          ...(idleReaperConfig.presenceStaleMs !== undefined ? { presenceStaleMs: idleReaperConfig.presenceStaleMs } : {}),
          ...(idleReaperConfig.turnEndReaperMs !== undefined ? { turnEndReaperMs: idleReaperConfig.turnEndReaperMs } : {}),
          batchMax: idleReaperConfig.batchMax,
          logDebug: (message) => logger.debug(`[DAEMON RUN] ${message}`),
        });
      }

      // Check if daemon needs update by detecting whether `dist/index.mjs` was
      // replaced on disk since the daemon started (npm install rewrites the file).
      // This must run before automation triggers. Starting a detached tick and
      // then tearing down the control server in the same heartbeat loses the
      // spawned session's webhook, report and project link.
      let bundleReplaced = false;
      if (initialBundleMtimeMs > 0) {
        try {
          const currentMtimeMs = statSync(bundlePath).mtimeMs;
          bundleReplaced = currentMtimeMs !== initialBundleMtimeMs;
        } catch {
          // File temporarily missing (e.g. mid-install) — retry on next heartbeat.
        }
      }
      const handoffDecision = decideAutomationAwareHandoff({
        bundleReplaced,
        legacyAutomationRunning: automationTickRunner.isRunning(),
        serverAutomationRunning: serverAutomationTickRunner.isRunning()
          || scriptAutomationTickRunner.isRunning()
          || sessionFollowupTickRunner.isRunning(),
        serverAutomationLeaseRunning: activeServerAutomationLeaseCount > 0,
        activeSessionCount: getRuntimeActivity().activeSessionCount,
      });

      if (handoffDecision === 'run-automations') {
        // Scheduled automations tick — 하트비트 케이던스로 기동하되 await하지
        // 않는다(detach). spawn webhook 대기가 하트비트의 나머지 임무(자가
        // 업그레이드 감지·상태 기록)를 막거나 heartbeatRunning 가드로 다음 틱을
        // 스킵시키지 않게 하기 위함이다. 중복 기동은 러너의 자체 가드가 막고,
        // 스킵된 due는 claim이 실행 직전에만 반영되므로 다음 tick이 집어간다.
        if (apiMachine.shouldRunLegacyAutomationScheduler()) automationTickRunner.trigger();
        serverAutomationTickRunner.trigger();
        scriptAutomationTickRunner.trigger();
        sessionFollowupTickRunner.trigger();
      } else {
        // Pause first so no later trigger can enter between the idle check and
        // teardown. A tick already in flight is allowed to finish normally.
        automationTickRunner.pause();
        serverAutomationTickRunner.pause();
        scriptAutomationTickRunner.pause();
        sessionFollowupTickRunner.pause();
      }

      if (handoffDecision === 'defer-handoff') {
        logger.debug('[DAEMON RUN] Daemon bundle replaced on disk, waiting for runtime activity to finish before handoff');
      } else if (handoffDecision === 'run-automations' && bundleReplaced) {
        logger.debug('[DAEMON RUN] Daemon bundle replaced on disk; sessions still active, automations keep running until they finish');
      }

      if (handoffDecision === 'handoff') {
        // TODO: We probably do not want to keep this in-process self-restart logic long-term.
        // A native service manager would make startup and upgrades much simpler: the CLI would
        // ask the OS to start the latest daemon instead of hand-rolling respawn/kill behavior here.
        logger.debug('[DAEMON RUN] Daemon bundle replaced on disk, preflighting new daemon before handoff');

        const handoffResult = await handoffToReplacedBundle({
          preflightReplacement: () => preflightInstalledHappyCLI(),
          canHandoff: () => {
            const activity = getRuntimeActivity();
            return activity.activeSessionCount === 0 && activity.activeAutomationCount === 0;
          },
          teardownCurrentDaemon: async () => {
            clearInterval(restartOnStaleVersionAndHeartbeat);

            // Release ownership BEFORE spawning the new daemon. Otherwise the spawned
            // `happy daemon start` reads our still-present daemon.state.json, sees
            // isDaemonRunningCurrentlyInstalledHappyVersion() === true, and exits —
            // leaving nothing running once we also exit.
            claudeSwapSupervisor.shutdown();
            apiMachine.shutdown();
            await stopControlServer();
            await stopBrowserBridge();
            await cleanupDaemonState();
            try {
              await teardownManagedRuntime();
            } finally {
              // The daemon lock is this process's, not the managed store's:
              // a teardown that keeps the writer lock still has to let go of
              // the lock file, or nothing can start after this exit.
              await releaseDaemonLock(daemonLockHandle);
              await stopCaffeinate();
            }
          },
          spawnReplacement: (attempt) => {
            logger.debug(`[DAEMON RUN] Spawning replacement daemon (attempt ${attempt})`);
            // startDetached, not spawnDetached: the replacement counts only
            // once `daemon start` confirms a daemon actually came up. On
            // 2026-08-25 it exec'd fine and then failed to start one, and
            // reporting success on exec alone cost six hours of no daemon.
            return startDetachedHappyCLI(['daemon', 'start'], {
              stdio: captureSpawnOutputStdio(
                'daemon-handoff-replacement.log',
                `handoff from pid ${process.pid} (attempt ${attempt})`,
              ),
            });
          },
        });

        if (handoffResult === 'handed-off') {
          logger.debug('[DAEMON RUN] Replacement daemon started; exiting');
          process.exit(0);
        }

        if (handoffResult === 'replacement-not-started') {
          // Teardown already released the socket, control server, state file
          // and lock, so this process is no longer a working daemon. Exiting
          // non-zero at least makes the machine's daemon loss visible instead
          // of leaving a hollow process behind.
          logger.debug('[DAEMON RUN] FATAL: replacement daemon never started after handoff; this machine now has no daemon');
          process.exit(1);
        }

        if (handoffResult === 'deferred') {
          logger.debug('[DAEMON RUN] Runtime activity started during preflight; deferring daemon handoff');
        } else {
          logger.debug('[DAEMON RUN] New daemon bundle preflight failed; keeping current daemon running');
          resumeAutomationRunnersAfterFailedHandoff({
            legacyAutomationEnabled: apiMachine.shouldRunLegacyAutomationScheduler(),
            legacyRunner: automationTickRunner,
            serverRunner: serverAutomationTickRunner,
          });
          sessionFollowupTickRunner.resume();
          scriptAutomationTickRunner.resume();
        }
      }

      // Before wrecklessly overriting the daemon state file, we should check if we are the ones who own it
      // Race condition is possible, but thats okay for the time being :D
      const daemonState = await readDaemonState();
      const lockHolderPid = readDaemonLockHolderPid();
      const ownership = resolveDaemonStateOwnership({
        recordedPid: daemonState?.pid,
        ownPid: process.pid,
        lockHolderPid,
        isProcessAlive: isPidAlive,
      });
      if (ownership.reason === 'foreign-daemon' || ownership.reason === 'foreign-without-lock') {
        // Whoever wrote the file is not us — say exactly what we saw, so the next
        // person reading this log does not have to correlate timestamps by hand.
        logger.debug(`[DAEMON RUN] daemon.state.json is owned by another process (${ownership.reason})`, {
          recordedPid: daemonState?.pid,
          lockHolderPid,
          ownPid: process.pid,
          startedWithCliVersion: daemonState?.startedWithCliVersion,
          httpPort: daemonState?.httpPort,
          daemonLogPath: daemonState?.daemonLogPath,
        });
      }
      if (ownership.yield) {
        logger.debug('[DAEMON RUN] Somehow a different daemon was started without killing us. We should kill ourselves.')
        requestShutdown('exception', 'A different daemon was started without killing us. We should kill ourselves.')
      } else if (ownership.reason === 'foreign-without-lock') {
        logger.debug('[DAEMON RUN] daemon.state.json was overwritten by a non-daemon process while we hold the daemon lock; reclaiming it on this heartbeat')
      }

      // Heartbeat
      try {
        // Recorded on the beat that already exists so the file says whether
        // this daemon can actually reach the server, not merely that its
        // process is alive — see specs/daemon-socket-watchdog/.
        const connection = apiMachine.getConnectionHealth();
        const updatedState: DaemonLocallyPersistedState = {
          pid: process.pid,
          httpPort: controlPort,
          startTime: fileState.startTime,
          startedWithCliVersion: packageJson.version,
          lastHeartbeat: new Date().toLocaleString(),
          daemonLogPath: fileState.daemonLogPath,
          state: 'running',
          socketConnected: connection.connected,
          ...(connection.disconnectedForMs === null
            ? {}
            : { socketDisconnectedSeconds: Math.round(connection.disconnectedForMs / 1000) }),
          trackedSessions: serializeTrackedSessions(),
          controlSecret: fileState.controlSecret,
        };
        writeDaemonState(updatedState);
        if (process.env.DEBUG) {
          logger.debug(`[DAEMON RUN] Health check completed at ${updatedState.lastHeartbeat}`);
        }
      } catch (error) {
        logger.debug('[DAEMON RUN] Failed to write heartbeat', error);
      }

      heartbeatRunning = false;
    }, heartbeatIntervalMs);

    // Setup signal handlers
    const cleanupAndShutdown = async (source: 'happy-app' | 'happy-cli' | 'os-signal' | 'exception', errorMessage?: string) => {
      logger.debug(`[DAEMON RUN] Starting proper cleanup (source: ${source}, errorMessage: ${errorMessage})...`);

      stopBrowserTaskReconciliation();
      await stopBrowserAttention();

      // Clear health check interval
      if (restartOnStaleVersionAndHeartbeat) {
        clearInterval(restartOnStaleVersionAndHeartbeat);
        logger.debug('[DAEMON RUN] Health check interval cleared');
      }
      stopLogHousekeeping();
      claudeSwapSupervisor.shutdown();
      scriptAutomationTickRunner.pause();
      await stopScriptWorker();
      // Closes every open project store. Flips its own closed flag first, so a
      // binding in flight stops resolving before the database goes away.
      await lessonHosts.close().catch((error) => logger.debug(
        `[lesson-host] shutdown: ${(error as Error).message}`,
      ));

      // Update daemon state before shutting down
      await apiMachine.updateDaemonState((state: DaemonState | null) => ({
        ...state,
        status: 'shutting-down',
        shutdownRequestedAt: Date.now(),
        shutdownSource: source
      }));

      // Give time for metadata update to send
      await new Promise(resolve => setTimeout(resolve, 100));

      apiMachine.shutdown();
      await stopControlServer();
      await stopBrowserBridge();

      // Preserve state file with stopped status and final session list
      flushDaemonState();
      writeDaemonState({
        ...fileState,
        state: 'stopped',
        stateReason: `Shutdown by ${source}${errorMessage ? ': ' + errorMessage : ''}`,
        lastHeartbeat: new Date().toLocaleString(),
        trackedSessions: serializeTrackedSessions(),
      });

      await stopCaffeinate();
      try {
        await teardownManagedRuntime();
      } finally {
        // Same as the handoff path: the lock file goes even when the managed
        // teardown refused to complete, and the failure still propagates.
        await releaseDaemonLock(daemonLockHandle);
      }

      logger.debug('[DAEMON RUN] Cleanup completed, exiting process');
      process.exit(0);
    };

    stopBrowserAttention = startBrowserAttentionWatcher({
      happyHomeDir: configuration.happyHomeDir,
      serverUrl: configuration.serverUrl,
      machineId,
      findSession: (sessionId) => findBrowserAttentionSession(
        sessionId, pidToTrackedSession.values(), sessionIdToFinishedSession, isPidAlive,
      ),
      isAlive: (pid) => pid > 0 && isPidAlive(pid),
      readToken: async (session) => session.userHomeDir
        ? readStagedTokenFromHomeDir(session.userHomeDir)
        : credentials.token,
      log: (message) => logger.debug(message),
    });

    logger.debug('[DAEMON RUN] Daemon started successfully, waiting for shutdown request');

    // Wait for shutdown request
    const shutdownRequest = await resolvesWhenShutdownRequested;
    await cleanupAndShutdown(shutdownRequest.source, shutdownRequest.errorMessage);
  } catch (error) {
    await stopBrowserAttention();
    stopLogHousekeeping();
    stopClaudeSwapSupervisor();
    await stopScriptWorker().catch((shutdownError) => logger.debug('[script-automations] Shutdown report remains in outbox', shutdownError));
    logger.debug('[DAEMON RUN][FATAL] Failed somewhere unexpectedly - exiting with code 1', error);
    process.exit(1);
  }
}
