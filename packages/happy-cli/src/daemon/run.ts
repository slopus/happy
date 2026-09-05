import fs from 'fs/promises';
import os from 'os';
import axios from 'axios';

import { ApiClient } from '@/api/api';
import { TrackedSession, SessionEncryptionData } from './types';
import { MachineMetadata, DaemonState, Metadata } from '@/api/types';
import { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import { logger } from '@/ui/logger';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { configuration } from '@/configuration';
import { startCaffeinate, stopCaffeinate } from '@/utils/caffeinate';
import packageJson from '../../package.json';
import { getEnvironmentInfo } from '@/ui/doctor';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { writeDaemonState, DaemonLocallyPersistedState, readDaemonState, acquireDaemonLock, releaseDaemonLock, readPersistedSessions, persistSession } from '@/persistence';
import type { PersistedSession } from '@/persistence';

import { cleanupDaemonState, isDaemonRunningCurrentlyInstalledHappyVersion, stopDaemon } from './controlClient';
import { startDaemonControlServer } from './controlServer';
import { statSync } from 'fs';
import { join } from 'path';
import { projectPath } from '@/projectPath';
import { getTmuxUtilities, isTmuxAvailable, parseTmuxSessionIdentifier, formatTmuxSessionIdentifier } from '@/utils/tmux';
import { expandEnvironmentVariables } from '@/utils/expandEnvVars';
import { detectCLIAvailability } from '@/utils/detectCLI';
import { buildResumeLaunch } from '@/resume/handleResumeCommand';
import { detectResumeSupport } from '@/resume/localHappyAgentAuth';
import { encodeBase64, decodeBase64, decrypt } from '@/api/encryption';
import { prepareCodexHomeWithAuth } from '@/codex/codexHome';
import { collectCodexUsageSnapshot, codexUsageSignature } from '@/codex/codexUsage';
import {
  buildSessionWorkerEnvironment,
  createDaemonStartupTraceContext,
  DaemonStartupTraceRegistry,
  logDaemonStartupStage,
  type DaemonStartupTraceContext,
  type StartupTraceWriter,
} from './sessionStartupTrace';

type TracedSpawnSessionOptions = SpawnSessionOptions & { traceId?: string };

/** Shell-escape a string for safe interpolation into tmux commands. */
function shellescape(s: string): string {
    return "'" + s.replace(/'/g, "'\\''") + "'";
}

function applyCodexNetworkEnv<T extends Record<string, string | undefined>>(env: T): T {
  const proxyUrl = env.HAPPY_CODEX_PROXY_URL || env.CODEX_PROXY_URL;
  if (!proxyUrl) {
    return env;
  }

  // Codex 访问 chatgpt.com；当 daemon 为 Claude 注入 ReClaude 代理时，
  // 这里需要把 Codex 子进程切到通用网络代理，避免流式响应被 ReClaude 中断。
  return {
    ...env,
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
  } as T;
}

export class DaemonSessionStartupIntegration {
  private readonly registry: DaemonStartupTraceRegistry;

  constructor(
    private readonly write?: StartupTraceWriter,
    private readonly now: () => number = Date.now,
  ) {
    this.registry = new DaemonStartupTraceRegistry(write, now);
  }

  get pendingTraceCount(): number {
    return this.registry.size;
  }

  buildWorkerEnvironment(
    mode: 'regular' | 'tmux',
    baseEnv: NodeJS.ProcessEnv,
    callerEnv: Record<string, string | undefined>,
    traceId?: unknown,
  ): NodeJS.ProcessEnv {
    const environment = buildSessionWorkerEnvironment(baseEnv, callerEnv, traceId);
    if (mode === 'regular') return environment;
    return Object.fromEntries(
      Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
  }

  childStarted(pid: number, trace: DaemonStartupTraceContext | undefined): void {
    if (trace) this.registry.associate(pid, trace);
    logDaemonStartupStage(trace, 'daemon.spawn.child_started', { outcome: 'success' }, this.write, this.now);
  }

  processWebhook(pid: number, sessionId: string, onValidWebhook: () => void): boolean {
    if (typeof sessionId !== 'string' || sessionId.trim().length === 0) return false;
    this.registry.webhookReceived(pid, sessionId);
    onValidWebhook();
    return true;
  }

  webhookTimeout(pid: number): void {
    this.registry.delete(pid);
  }

  childExited(pid: number): void {
    this.registry.delete(pid);
  }

  sessionStopped(pid: number): void {
    this.registry.delete(pid);
  }

  staleProcessPruned(pid: number): void {
    this.registry.delete(pid);
  }
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
};

export async function startDaemon(): Promise<void> {
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

  // Check if already running
  // Check if running daemon version matches current CLI version
  const runningDaemonVersionMatches = await isDaemonRunningCurrentlyInstalledHappyVersion();
  if (!runningDaemonVersionMatches) {
    // TODO: This hand-rolled self-restart path is awkward to reason about and awkward to test.
    // We should probably migrate this daemon to native system service management
    // (launchd/systemd, similar to OpenClaw's model), so startup/start-at-login and upgrades
    // are owned by the OS instead of by the daemon trying to replace itself in-process.
    logger.debug('[DAEMON RUN] Daemon version mismatch detected, restarting daemon with current CLI version');
    await stopDaemon();
  } else {
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

  try {
    // Start caffeinate
    const caffeinateStarted = startCaffeinate();
    if (caffeinateStarted) {
      logger.debug('[DAEMON RUN] Sleep prevention enabled');
    }

    // Ensure auth and machine registration BEFORE anything else
    const { credentials, machineId } = await authAndSetupMachineIfNeeded();
    logger.debug('[DAEMON RUN] Auth and machine setup complete');

    // Setup state - key by PID
    const pidToTrackedSession = new Map<number, TrackedSession>();

    // Retain session data after process exits so resume can still find it.
    // Pre-populate from disk so sessions survive daemon restarts.
    const sessionIdToFinishedSession = new Map<string, TrackedSession>();
    const persisted = readPersistedSessions();
    for (const [id, s] of Object.entries(persisted)) {
      sessionIdToFinishedSession.set(id, {
        startedBy: 'persisted',
        happySessionId: id,
        happySessionMetadataFromLocalWebhook: s.metadata,
        encryption: {
          encryptionKey: decodeBase64(s.encryptionKey),
          encryptionVariant: s.encryptionVariant,
          seq: s.seq,
          metadataVersion: s.metadataVersion,
          agentStateVersion: s.agentStateVersion,
        },
        pid: 0,
      });
    }
    if (Object.keys(persisted).length > 0) {
      logger.debug(`[DAEMON RUN] Loaded ${Object.keys(persisted).length} persisted sessions from disk`);
    }

    // Session spawning awaiter system
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();
    const startupIntegration = new DaemonSessionStartupIntegration();

    // Helper functions
    const getCurrentChildren = () => Array.from(pidToTrackedSession.values());

    // Handle webhook from happy session reporting itself
    const onHappySessionWebhook = (sessionId: string, sessionMetadata: Metadata, encryption?: SessionEncryptionData) => {
      const pid = sessionMetadata.hostPid;
      startupIntegration.processWebhook(pid ?? 0, sessionId, () => {
        if (!pid) {
          logger.debug(`[DAEMON RUN] Session webhook missing hostPid for sessionId: ${sessionId}`);
          return;
        }

        logger.debug(`[DAEMON RUN] Session webhook: ${sessionId}, PID: ${pid}, started by: ${sessionMetadata.startedBy || 'unknown'}, hasEncryption: ${!!encryption}`);
        logger.debug(`[DAEMON RUN] Current tracked sessions before webhook: ${Array.from(pidToTrackedSession.keys()).join(', ')}`);

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
          });
        }

        // Check if we already have this PID (daemon-spawned)
        const existingSession = pidToTrackedSession.get(pid);

        if (existingSession && existingSession.startedBy === 'daemon') {
          // Update daemon-spawned session with reported data
          existingSession.happySessionId = sessionId;
          existingSession.happySessionMetadataFromLocalWebhook = sessionMetadata;
          existingSession.encryption = encryption;
          logger.debug(`[DAEMON RUN] Updated daemon-spawned session ${sessionId} with metadata`);

          // Resolve any awaiter for this PID
          const awaiter = pidToAwaiter.get(pid);
          if (awaiter) {
            pidToAwaiter.delete(pid);
            awaiter(existingSession);
            logger.debug(`[DAEMON RUN] Resolved session awaiter for PID ${pid}`);
          }
        } else if (!existingSession) {
          // New session started externally
          const trackedSession: TrackedSession = {
            startedBy: 'happy directly - likely by user from terminal',
            happySessionId: sessionId,
            happySessionMetadataFromLocalWebhook: sessionMetadata,
            encryption,
            pid
          };
          pidToTrackedSession.set(pid, trackedSession);
          logger.debug(`[DAEMON RUN] Registered externally-started session ${sessionId}`);
        }
      });
    };

    // Spawn a new session (sessionId reserved for future --resume functionality)
    const spawnSession = async (options: TracedSpawnSessionOptions): Promise<SpawnSessionResult> => {
      const trace = createDaemonStartupTraceContext(options);

      const { directory, sessionId, machineId, approvedNewDirectoryCreation = true } = options;
      let directoryCreated = false;

      try {
        await fs.access(directory);
        logger.debug('[DAEMON RUN] Spawn directory exists');
      } catch (error) {
        logger.debug('[DAEMON RUN] Spawn directory does not exist');

        // Check if directory creation is approved
        if (!approvedNewDirectoryCreation) {
          logger.debug('[DAEMON RUN] Spawn directory creation not approved');
          return {
            type: 'requestToApproveDirectoryCreation',
            directory
          };
        }

        try {
          await fs.mkdir(directory, { recursive: true });
          logger.debug('[DAEMON RUN] Spawn directory created');
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

          logger.debug('[DAEMON RUN] Spawn directory creation failed', { errorCode: 'directory-create-failed' });
          return {
            type: 'error',
            errorMessage
          };
        }
      }

      try {

        // Build environment variables for session spawning
        // Authentication tokens are resolved here

        // Resolve authentication token if provided
        const authEnv: Record<string, string> = {};
        if (options.token) {
          if (options.agent === 'codex') {
            authEnv.CODEX_HOME = await prepareCodexHomeWithAuth(options.token);
          } else { // Assuming claude
            authEnv.CLAUDE_CODE_OAUTH_TOKEN = options.token;
          }
        }

        let extraEnv: Record<string, string> = {
          ...authEnv,
          ...(options.environmentVariables ?? {}),
        };
        delete extraEnv.HAPPY_SESSION_STARTUP_TRACE_ID;
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
        // Expand ${VAR} references from daemon's process.env
        // This ensures variable substitution works in both tmux and non-tmux modes
        // Example: ANTHROPIC_AUTH_TOKEN="${Z_AI_AUTH_TOKEN}" → ANTHROPIC_AUTH_TOKEN="sk-real-key"
        extraEnv = expandEnvironmentVariables(extraEnv, process.env);

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
          logger.warn('[DAEMON RUN] Session environment is invalid', { errorCode: 'unresolved-environment-variable' });
          return {
            type: 'error',
            errorMessage
          };
        }

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
          logger.debug('[DAEMON RUN] Attempting to spawn session in tmux');

          const tmux = getTmuxUtilities(tmuxSessionName);

          // Construct command for the CLI
          const cliPath = join(projectPath(), 'dist', 'index.mjs');
          const agent = options.agent ?? 'opencode';
          if (!['ask', 'claude', 'codex', 'gemini', 'opencode', 'openclaw'].includes(agent)) {
            return {
              type: 'error',
              errorMessage: `Unsupported agent type: '${options.agent}'. Please update your CLI to the latest version.`
            };
          }
          const resumeId = agent === 'claude'
            ? options.resumeClaudeSessionId
            : (agent === 'codex' ? options.resumeCodexThreadId : undefined);
          const resumeFragment = resumeId
            ? ` --resume ${shellescape(resumeId)}`
            : '';
          const agentCommand = agent === 'opencode' ? 'acp opencode' : agent;
          const fullCommand = `node --no-warnings --no-deprecation ${cliPath} ${agentCommand} --happy-starting-mode remote --started-by daemon${resumeFragment}`;

          // Spawn in tmux with environment variables
          // IMPORTANT: Pass complete environment (process.env + extraEnv) because:
          // 1. tmux sessions need daemon's expanded auth variables (e.g., ANTHROPIC_AUTH_TOKEN)
          // 2. Regular spawn uses env: { ...process.env, ...extraEnv }
          // 3. tmux needs explicit environment via -e flags to ensure all variables are available
          const windowName = `happy-${Date.now()}-${agent}`;
          const tmuxEnv = startupIntegration.buildWorkerEnvironment(
            'tmux', process.env, extraEnv, trace?.traceId,
          ) as Record<string, string>;
          const sessionEnv = agent === 'codex' ? applyCodexNetworkEnv(tmuxEnv) : tmuxEnv;
          if (agent === 'codex' && sessionEnv.HTTP_PROXY) {
            logger.debug(`[DAEMON RUN] Applied Codex network proxy from HAPPY_CODEX_PROXY_URL/CODEX_PROXY_URL`);
          }

          const tmuxResult = await tmux.spawnInTmux([fullCommand], {
            sessionName: tmuxSessionName,
            windowName: windowName,
            cwd: directory
          }, sessionEnv);  // Pass complete environment for tmux session

          if (tmuxResult.success) {
            logger.debug('[DAEMON RUN] Successfully spawned in tmux');

            // Validate we got a PID from tmux
            if (!tmuxResult.pid) {
              throw new Error('Tmux window created but no PID returned');
            }

            // Create a tracked session for tmux windows - now we have the real PID!
            const trackedSession: TrackedSession = {
              startedBy: 'daemon',
              pid: tmuxResult.pid, // Real PID from tmux -P flag
              tmuxSessionId: tmuxResult.sessionId,
              directoryCreated,
              message: directoryCreated
                ? `The path '${directory}' did not exist. We created a new folder and spawned a new session in tmux session '${tmuxSessionName}'. Use 'tmux attach -t ${tmuxSessionName}' to view the session.`
                : `Spawned new session in tmux session '${tmuxSessionName}'. Use 'tmux attach -t ${tmuxSessionName}' to view the session.`
            };

            // Add to tracking map so webhook can find it later
            pidToTrackedSession.set(tmuxResult.pid, trackedSession);
            startupIntegration.childStarted(tmuxResult.pid, trace);

            // Wait for webhook to populate session with happySessionId (exact same as regular flow)
            logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${tmuxResult.pid} (tmux)`);

            return new Promise((resolve) => {
              // Set timeout for webhook (same as regular flow)
              const timeout = setTimeout(() => {
                pidToAwaiter.delete(tmuxResult.pid!);
                startupIntegration.webhookTimeout(tmuxResult.pid!);
                logger.debug(`[DAEMON RUN] Session webhook timeout for PID ${tmuxResult.pid} (tmux)`);
                resolve({
                  type: 'error',
                  errorMessage: `Session webhook timeout for PID ${tmuxResult.pid} (tmux)`
                });
              }, 90_000); // Same timeout as regular sessions

              // Register awaiter for tmux session (exact same as regular flow)
              pidToAwaiter.set(tmuxResult.pid!, (completedSession) => {
                clearTimeout(timeout);
                logger.debug(`[DAEMON RUN] Session ${completedSession.happySessionId} fully spawned with webhook (tmux)`);
                resolve({
                  type: 'success',
                  sessionId: completedSession.happySessionId!
                });
              });
            });
          } else {
            logger.debug('[DAEMON RUN] Failed to spawn in tmux; using regular spawning');
            useTmux = false;
          }
        }

        // Regular process spawning (fallback or if tmux not available)
        if (!useTmux) {
          logger.debug(`[DAEMON RUN] Using regular process spawning`);

          // Construct arguments for the CLI.
          let agentCommand: string;
          let args: string[];
          switch (options.agent) {
            case 'ask':
              agentCommand = 'ask';
              args = [agentCommand];
              break;
            case 'claude':
              agentCommand = 'claude';
              args = [agentCommand];
              break;
            case 'codex':
              agentCommand = 'codex';
              args = [agentCommand];
              break;
            case 'gemini':
              agentCommand = 'gemini';
              args = [agentCommand];
              break;
            case 'opencode':
            case undefined:
              agentCommand = 'opencode';
              args = ['acp', 'opencode'];
              break;
            case 'openclaw':
              agentCommand = 'openclaw';
              args = [agentCommand];
              break;
            default:
              return {
                type: 'error',
                errorMessage: `Unsupported agent type: '${options.agent}'. Please update your CLI to the latest version.`
              };
          }
          args.push('--happy-starting-mode', 'remote', '--started-by', 'daemon');

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
          return spawnTrackedHappyProcess({
            args,
            cwd: directory,
            env: (() => {
              const workerEnv = startupIntegration.buildWorkerEnvironment(
                'regular', process.env, extraEnv, trace?.traceId,
              );
              return agentCommand === 'codex' ? applyCodexNetworkEnv(workerEnv) : workerEnv;
            })(),
            directoryCreated,
            message: directoryCreated ? `The path '${directory}' did not exist. We created a new folder and spawned a new session there.` : undefined,
            trace,
          });
        }

        // This should never be reached, but TypeScript requires a return statement
        return {
          type: 'error',
          errorMessage: 'Unexpected error in session spawning'
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.debug('[DAEMON RUN] Failed to spawn session', { errorCode: 'child-spawn-failed' });
        logDaemonStartupStage(trace, 'daemon.spawn.child_started', {
          outcome: 'error',
          errorCode: 'child-spawn-failed',
        });
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
      trace,
    }: {
      args: string[];
      cwd: string;
      env: NodeJS.ProcessEnv;
      directoryCreated?: boolean;
      message?: string;
      trace?: DaemonStartupTraceContext;
    }): Promise<SpawnSessionResult> => {
      const happyProcess = spawnHappyCLI(args, {
        cwd,
        detached: true,
        stdio: 'ignore',
        env: startupIntegration.buildWorkerEnvironment('regular', {}, env, trace?.traceId),
      });

      if (!happyProcess.pid) {
        logger.debug('[DAEMON RUN] Failed to spawn process - no PID returned');
        logDaemonStartupStage(trace, 'daemon.spawn.child_started', {
          outcome: 'error',
          errorCode: 'child-pid-missing',
        });
        return Promise.resolve({
          type: 'error',
          errorMessage: 'Failed to spawn Happy process - no PID returned'
        });
      }

      logger.debug(`[DAEMON RUN] Spawned process with PID ${happyProcess.pid}`);

      const trackedSession: TrackedSession = {
        startedBy: 'daemon',
        pid: happyProcess.pid,
        childProcess: happyProcess,
        directoryCreated,
        message,
      };

      pidToTrackedSession.set(happyProcess.pid, trackedSession);
      startupIntegration.childStarted(happyProcess.pid, trace);

      happyProcess.on('exit', (code, signal) => {
        logger.debug(`[DAEMON RUN] Child PID ${happyProcess.pid} exited with code ${code}, signal ${signal}`);
        if (happyProcess.pid) {
          onChildExited(happyProcess.pid);
        }
      });

      happyProcess.on('error', () => {
        logger.debug('[DAEMON RUN] Child process error', { errorCode: 'child-process-error' });
        if (happyProcess.pid) {
          onChildExited(happyProcess.pid);
        }
      });

      logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${happyProcess.pid}`);

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          pidToAwaiter.delete(happyProcess.pid!);
          startupIntegration.webhookTimeout(happyProcess.pid!);
          logger.debug(`[DAEMON RUN] Session webhook timeout for PID ${happyProcess.pid}`);
          resolve({
            type: 'error',
            errorMessage: `Session webhook timeout for PID ${happyProcess.pid}`
          });
        }, 90_000); // Cold-start Codex/Claude workers can take >60s to report the session webhook

        pidToAwaiter.set(happyProcess.pid!, (completedSession) => {
          clearTimeout(timeout);
          logger.debug(`[DAEMON RUN] Session ${completedSession.happySessionId} fully spawned with webhook`);
          resolve({
            type: 'success',
            sessionId: completedSession.happySessionId!
          });
        });
      });
    };

    const findTrackedSessionById = (happySessionId: string): TrackedSession | undefined => {
      for (const session of pidToTrackedSession.values()) {
        if (session.happySessionId === happySessionId) return session;
      }
      return sessionIdToFinishedSession.get(happySessionId);
    };

    const fetchServerSessionSnapshot = async (
      sessionId: string,
      encryptionKey: Uint8Array,
      encryptionVariant: 'legacy' | 'dataKey',
    ): Promise<{ metadata: Metadata; seq: number; metadataVersion: number } | null> => {
      try {
        const response = await axios.get(`${configuration.serverUrl}/v1/sessions`, {
          headers: { Authorization: `Bearer ${credentials.token}` },
          timeout: 10_000,
        });
        const sessions = (response.data as { sessions: Array<{
          id: string;
          metadata: string;
          seq: number;
          metadataVersion: number;
        }> }).sessions;
        const matched = sessions.find(s => s.id === sessionId);
        if (!matched) return null;
        const decrypted = decrypt(encryptionKey, encryptionVariant, decodeBase64(matched.metadata));
        if (!decrypted) return null;
        return {
          metadata: decrypted as Metadata,
          seq: matched.seq,
          metadataVersion: matched.metadataVersion,
        };
      } catch (error) {
        logger.debug(`[DAEMON RUN] Failed to fetch session snapshot from server: ${error instanceof Error ? error.message : error}`);
        return null;
      }
    };

    const resumeSession = async (happySessionId: string, options?: { model?: string; permissionMode?: string; effort?: string | null }): Promise<SpawnSessionResult> => {
      try {
        const tracked = findTrackedSessionById(happySessionId);
        if (!tracked) {
          // Fallback for "imported" mirror sessions: sessions pushed directly to the
          // relay by push-to-happy.mjs are not tracked in this daemon's memory. We
          // resume them by spawning a fresh Happy session that runs
          // `claude --resume <claudeSessionId>` in the recorded working directory.
          // The mapping (happySessionId -> claudeSessionId + directory) is stored in
          // plaintext at ~/.happy/imported-sessions.json (no E2E key needed here).
          try {
            const importedPath = join(os.homedir(), '.happy', 'imported-sessions.json');
            const imported = JSON.parse(await fs.readFile(importedPath, 'utf8')) as Record<string, { claudeSessionId?: string; directory?: string }>;
            const entry = imported[happySessionId];
            if (entry?.claudeSessionId && entry?.directory) {
              logger.debug(`[DAEMON RUN] Resuming imported mirror session ${happySessionId} -> claude --resume ${entry.claudeSessionId} @ ${entry.directory}`);
              return spawnSession({
                directory: entry.directory,
                resumeClaudeSessionId: entry.claudeSessionId,
                agent: 'claude',
              });
            }
          } catch (e) {
            logger.debug(`[DAEMON RUN] imported-sessions lookup failed: ${e instanceof Error ? e.message : e}`);
          }
          return { type: 'error', errorMessage: `Session ${happySessionId} is not tracked by this daemon. It may have been started before the daemon or on another machine.` };
        }
        if (!tracked.happySessionMetadataFromLocalWebhook) {
          return { type: 'error', errorMessage: `Session ${happySessionId} has no metadata. Cannot resume.` };
        }
        if (!tracked.encryption) {
          return { type: 'error', errorMessage: `Session ${happySessionId} has no stored encryption data. It was likely started before this feature was available. Restart the daemon and start a new session to enable resume.` };
        }

        // Webhook metadata and versions are startup snapshots. Always refresh
        // before resume so Codex history replay starts with the persisted sync
        // cursor instead of racing a later websocket update-session event.
        let metadata = tracked.happySessionMetadataFromLocalWebhook;
        const serverSnapshot = await fetchServerSessionSnapshot(
          happySessionId,
          tracked.encryption.encryptionKey,
          tracked.encryption.encryptionVariant,
        );
        if (serverSnapshot) {
          metadata = serverSnapshot.metadata;
          tracked.happySessionMetadataFromLocalWebhook = serverSnapshot.metadata;
          tracked.encryption.seq = serverSnapshot.seq;
          tracked.encryption.metadataVersion = serverSnapshot.metadataVersion;
        }

        const launch = buildResumeLaunch(
          { id: happySessionId, active: true, metadata },
          { startedBy: 'daemon', claudeStartingMode: 'remote' },
        );

        if (options?.model) {
          launch.args.push('--model', options.model);
        }
        if (options?.permissionMode) {
          launch.args.push('--permission-mode', options.permissionMode);
        }
        if (options?.effort) {
          launch.args.push('--effort', options.effort);
        }

        await fs.access(launch.cwd);

        return spawnTrackedHappyProcess({
          args: launch.args,
          cwd: launch.cwd,
          env: {
            ...process.env,
            HAPPY_RECONNECT_SESSION_ID: happySessionId,
            HAPPY_RECONNECT_ENCRYPTION_KEY: encodeBase64(tracked.encryption.encryptionKey),
            HAPPY_RECONNECT_ENCRYPTION_VARIANT: tracked.encryption.encryptionVariant,
            HAPPY_RECONNECT_SEQ: String(tracked.encryption.seq),
            HAPPY_RECONNECT_METADATA_VERSION: String(tracked.encryption.metadataVersion),
            HAPPY_RECONNECT_AGENT_STATE_VERSION: String(tracked.encryption.agentStateVersion),
            HAPPY_RECONNECT_METADATA_JSON: JSON.stringify(metadata),
          },
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : (error && typeof error === 'object' ? JSON.stringify(error) : String(error));
        logger.debug(`[DAEMON RUN] Failed to resume session: ${errorMessage}`, error instanceof Error ? error.stack : undefined);
        return {
          type: 'error',
          errorMessage: `Failed to resume session: ${errorMessage}`,
        };
      }
    };

    // Stop a session by sessionId or PID fallback
    const stopSession = (sessionId: string): boolean => {
      logger.debug(`[DAEMON RUN] Attempting to stop session ${sessionId}`);

      // Try to find by sessionId first
      for (const [pid, session] of pidToTrackedSession.entries()) {
        if (session.happySessionId === sessionId ||
          (sessionId.startsWith('PID-') && pid === parseInt(sessionId.replace('PID-', '')))) {

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
          startupIntegration.sessionStopped(pid);
          logger.debug(`[DAEMON RUN] Removed session ${sessionId} from tracking`);
          return true;
        }
      }

      logger.debug(`[DAEMON RUN] Session ${sessionId} not found`);
      return false;
    };

    // Handle child process exit — preserve session data for resume
    const onChildExited = (pid: number) => {
      const session = pidToTrackedSession.get(pid);
      if (session?.happySessionId && session.encryption) {
        sessionIdToFinishedSession.set(session.happySessionId, session);
        logger.debug(`[DAEMON RUN] Process PID ${pid} exited, preserved session ${session.happySessionId} for resume`);
      } else {
        logger.debug(`[DAEMON RUN] Removing exited process PID ${pid} from tracking`);
      }
      pidToTrackedSession.delete(pid);
      startupIntegration.childExited(pid);
    };

    // Start control server
    const { port: controlPort, stop: stopControlServer } = await startDaemonControlServer({
      getChildren: getCurrentChildren,
      stopSession,
      spawnSession,
      requestShutdown: () => requestShutdown('happy-cli'),
      onHappySessionWebhook
    });

    // Write initial daemon state (no lock needed for state file)
    const fileState: DaemonLocallyPersistedState = {
      pid: process.pid,
      httpPort: controlPort,
      startTime: new Date().toLocaleString(),
      startedWithCliVersion: packageJson.version,
      daemonLogPath: logger.logFilePath
    };
    writeDaemonState(fileState);
    logger.debug('[DAEMON RUN] Daemon state written');

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
      startedAt: Date.now()
    };

    // Create API client
    const api = await ApiClient.create(credentials);

    // Get or create machine
    const machine = await api.getOrCreateMachine({
      machineId,
      metadata: initialMachineMetadata,
      daemonState: initialDaemonState
    });
    logger.debug(`[DAEMON RUN] Machine registered: ${machine.id}`);

    // Create realtime machine session
    const apiMachine = api.machineSyncClient(machine);

    // Set RPC handlers
    apiMachine.setRPCHandlers({
      spawnSession,
      resumeSession,
      stopSession,
      requestShutdown: () => requestShutdown('happy-app')
    });

    // Connect to server
    apiMachine.connect();

    let lastCodexUsageScanAt = 0;
    let lastCodexUsageSignature: string | null = null;
    const codexUsageRefreshIntervalMs = parseInt(process.env.HAPPY_CODEX_USAGE_REFRESH_INTERVAL || '300000');
    const syncCodexUsage = async (force: boolean = false): Promise<void> => {
      const now = Date.now();
      if (!force && now - lastCodexUsageScanAt < codexUsageRefreshIntervalMs) {
        return;
      }
      if (!apiMachine.isConnected()) {
        return;
      }

      lastCodexUsageScanAt = now;
      try {
        const codexUsage = await collectCodexUsageSnapshot();
        const signature = codexUsageSignature(codexUsage);
        if (!force && signature === lastCodexUsageSignature) {
          return;
        }
        lastCodexUsageSignature = signature;
        await apiMachine.updateDaemonState((state: DaemonState | null) => ({
          ...(state || {}),
          status: state?.status || 'running',
          pid: process.pid,
          httpPort: controlPort,
          startedAt: state?.startedAt || Date.now(),
          codexUsage,
        }));
      } catch (error) {
        logger.debug('[DAEMON RUN] Failed to sync Codex usage snapshot', error);
      }
    };

    const initialCodexUsageTimer = setTimeout(() => {
      syncCodexUsage(true).catch((error) => {
        logger.debug('[DAEMON RUN] Initial Codex usage sync failed', error);
      });
    }, 5000);

    // Every 60 seconds:
    // 1. Prune stale sessions
    // 2. Check if daemon needs update
    // 3. If outdated, restart with latest version
    // 4. Write heartbeat
    const heartbeatIntervalMs = parseInt(process.env.HAPPY_DAEMON_HEARTBEAT_INTERVAL || '60000');
    let heartbeatRunning = false
    const restartOnStaleVersionAndHeartbeat = setInterval(async () => {
      if (heartbeatRunning) {
        return;
      }
      heartbeatRunning = true;

      if (process.env.DEBUG) {
        logger.debug(`[DAEMON RUN] Health check started at ${new Date().toLocaleString()}`);
      }

      // Prune stale sessions
      for (const [pid, _] of pidToTrackedSession.entries()) {
        try {
          // Check if process is still alive (signal 0 doesn't kill, just checks)
          process.kill(pid, 0);
        } catch (error) {
          // Process is dead, remove from tracking
          logger.debug(`[DAEMON RUN] Removing stale session with PID ${pid} (process no longer exists)`);
          pidToTrackedSession.delete(pid);
          startupIntegration.staleProcessPruned(pid);
        }
      }

      // Check if daemon needs update by detecting whether `dist/index.mjs` was
      // replaced on disk since the daemon started (npm install rewrites the file).
      // Skip if we never captured an initial mtime (dev mode).
      let bundleReplaced = false;
      if (initialBundleMtimeMs > 0) {
        try {
          const currentMtimeMs = statSync(bundlePath).mtimeMs;
          bundleReplaced = currentMtimeMs !== initialBundleMtimeMs;
        } catch {
          // File temporarily missing (e.g. mid-install) — retry on next heartbeat.
        }
      }
      if (bundleReplaced) {
        // TODO: We probably do not want to keep this in-process self-restart logic long-term.
        // A native service manager would make startup and upgrades much simpler: the CLI would
        // ask the OS to start the latest daemon instead of hand-rolling respawn/kill behavior here.
        logger.debug('[DAEMON RUN] Daemon bundle replaced on disk, handing off to new daemon');

        clearInterval(restartOnStaleVersionAndHeartbeat);

        // Release ownership BEFORE spawning the new daemon. Otherwise the spawned
        // `happy daemon start` reads our still-present daemon.state.json, sees
        // isDaemonRunningCurrentlyInstalledHappyVersion() === true, and exits —
        // leaving nothing running once we also exit.
        apiMachine.shutdown();
        await stopControlServer();
        await cleanupDaemonState();
        await releaseDaemonLock(daemonLockHandle);
        await stopCaffeinate();

        try {
          spawnHappyCLI(['daemon', 'start'], {
            detached: true,
            stdio: 'ignore'
          });
        } catch (error) {
          logger.debug('[DAEMON RUN] Failed to spawn new daemon, this is quite likely to happen during integration tests as we are cleaning out dist/ directory', error);
        }

        process.exit(0);
      }

      // Before wrecklessly overriting the daemon state file, we should check if we are the ones who own it
      // Race condition is possible, but thats okay for the time being :D
      const daemonState = await readDaemonState();
      if (daemonState && daemonState.pid !== process.pid) {
        logger.debug('[DAEMON RUN] Somehow a different daemon was started without killing us. We should kill ourselves.')
        requestShutdown('exception', 'A different daemon was started without killing us. We should kill ourselves.')
      }

      // Heartbeat
      try {
        const updatedState: DaemonLocallyPersistedState = {
          pid: process.pid,
          httpPort: controlPort,
          startTime: fileState.startTime,
          startedWithCliVersion: packageJson.version,
          lastHeartbeat: new Date().toLocaleString(),
          daemonLogPath: fileState.daemonLogPath
        };
        writeDaemonState(updatedState);
        if (process.env.DEBUG) {
          logger.debug(`[DAEMON RUN] Health check completed at ${updatedState.lastHeartbeat}`);
        }
      } catch (error) {
        logger.debug('[DAEMON RUN] Failed to write heartbeat', error);
      }

      await syncCodexUsage(false);

      heartbeatRunning = false;
    }, heartbeatIntervalMs); // Every 60 seconds in production

    // Setup signal handlers
    const cleanupAndShutdown = async (source: 'happy-app' | 'happy-cli' | 'os-signal' | 'exception', errorMessage?: string) => {
      logger.debug(`[DAEMON RUN] Starting proper cleanup (source: ${source}, errorMessage: ${errorMessage})...`);

      // Clear health check interval
      if (restartOnStaleVersionAndHeartbeat) {
        clearInterval(restartOnStaleVersionAndHeartbeat);
        logger.debug('[DAEMON RUN] Health check interval cleared');
      }
      clearTimeout(initialCodexUsageTimer);

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
      await cleanupDaemonState();
      await stopCaffeinate();
      await releaseDaemonLock(daemonLockHandle);

      logger.debug('[DAEMON RUN] Cleanup completed, exiting process');
      process.exit(0);
    };

    logger.debug('[DAEMON RUN] Daemon started successfully, waiting for shutdown request');

    // Wait for shutdown request
    const shutdownRequest = await resolvesWhenShutdownRequested;
    await cleanupAndShutdown(shutdownRequest.source, shutdownRequest.errorMessage);
  } catch (error) {
    logger.debug('[DAEMON RUN][FATAL] Failed somewhere unexpectedly - exiting with code 1', error);
    process.exit(1);
  }
}
