import fs from 'fs/promises';
import os from 'os';
import * as tmp from 'tmp';

import { ApiClient } from '@/api/api';
import { TrackedSession } from './types';
import { MachineMetadata, DaemonState, Metadata } from '@/api/types';
import { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import { logger } from '@/ui/logger';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { configuration } from '@/configuration';
import { startCaffeinate, stopCaffeinate } from '@/utils/caffeinate';
import packageJson from '../../package.json';
import { getEnvironmentInfo } from '@/ui/doctor';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { writeDaemonState, DaemonLocallyPersistedState, readDaemonState, acquireDaemonLock, releaseDaemonLock, readSettings, getActiveProfile, getEnvironmentVariables, validateProfileForAgent, getProfileEnvironmentVariables } from '@/persistence';

import { cleanupDaemonState, isDaemonRunningCurrentlyInstalledHappyVersion, stopDaemon } from './controlClient';
import { startDaemonControlServer } from './controlServer';
import { readFileSync } from 'fs';
import { execSync, exec, type ChildProcess } from 'child_process';
import { join } from 'path';
import { projectPath } from '@/projectPath';
import { getTmuxUtilities, isTmuxAvailable, parseTmuxSessionIdentifier, formatTmuxSessionIdentifier } from '@/utils/tmux';
import { expandEnvironmentVariables } from '@/utils/expandEnvVars';
import {
  appendOutputChunk,
  buildOrchestratorEnv,
  buildOutputSummary,
  mapFinishStatus,
  type OrchestratorCancelPayload,
  type OrchestratorDispatchPayload,
  type OrchestratorFinishStatus,
} from '@/orchestrator/common';
import { normalizeGeminiOutputText } from './orchestratorOutput';

const ORCHESTRATOR_WATCHDOG_GRACE_MS = 5_000;
const ORCHESTRATOR_OUTPUT_CAPTURE_LIMIT = 64_000;
const ORCHESTRATOR_SHUTDOWN_WAIT_MS = 8_000;

// Prepare initial metadata
export const initialMachineMetadata: MachineMetadata = {
  host: os.hostname(),
  platform: os.platform(),
  happyCliVersion: packageJson.version,
  homeDir: os.homedir(),
  happyHomeDir: configuration.happyHomeDir,
  happyLibDir: projectPath()
};

// Get environment variables for a profile, filtered for agent compatibility
async function getProfileEnvironmentVariablesForAgent(
  profileId: string,
  agentType: 'claude' | 'codex' | 'gemini'
): Promise<Record<string, string>> {
  try {
    const settings = await readSettings();
    const profile = settings.profiles.find(p => p.id === profileId);

    if (!profile) {
      logger.debug(`[DAEMON RUN] Profile ${profileId} not found`);
      return {};
    }

    // Check if profile is compatible with the agent
    if (!validateProfileForAgent(profile, agentType)) {
      logger.debug(`[DAEMON RUN] Profile ${profileId} not compatible with agent ${agentType}`);
      return {};
    }

    // Get environment variables from profile (new schema)
    const envVars = getProfileEnvironmentVariables(profile);

    logger.debug(`[DAEMON RUN] Loaded ${Object.keys(envVars).length} environment variables from profile ${profileId} for agent ${agentType}`);
    return envVars;
  } catch (error) {
    logger.debug('[DAEMON RUN] Failed to get profile environment variables:', error);
    return {};
  }
}

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
    let api!: ApiClient;

    // Setup state - key by PID
    const pidToTrackedSession = new Map<number, TrackedSession>();

    // Session spawning awaiter system
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();

    // Helper functions
    const getCurrentChildren = () => Array.from(pidToTrackedSession.values());

    type ManagedOrchestratorExecution = {
      payload: OrchestratorDispatchPayload;
      child: ChildProcess;
      startedAtIso: string;
      cancelRequested: boolean;
      watchdogTriggered: boolean;
      detectedChildSessionId: string | null;
      startReportPromise: Promise<void>;
      finishReportPromise: Promise<void> | null;
      stdout: string;
      stderr: string;
      stdoutLineBuffer: string;
      watchdogTimer: NodeJS.Timeout | null;
      killTimer: NodeJS.Timeout | null;
    };

    const parseCodexSessionId = (value: string): string | null => {
      const match = value.match(/session id:\s*([0-9a-fA-F-]{36})/i);
      return match?.[1] ?? null;
    };

    const parseGeminiSessionIdFromLine = (line: string): string | null => {
      const trimmed = line.trim();
      if (!trimmed) {
        return null;
      }
      try {
        const parsed = JSON.parse(trimmed) as { session_id?: unknown };
        if (typeof parsed.session_id === 'string' && parsed.session_id.trim().length > 0) {
          return parsed.session_id.trim();
        }
      } catch (_error) {
        return null;
      }
      return null;
    };

    const executionIdToManagedExecution = new Map<string, ManagedOrchestratorExecution>();

    const clearExecutionTimers = (execution: ManagedOrchestratorExecution) => {
      if (execution.watchdogTimer) {
        clearTimeout(execution.watchdogTimer);
        execution.watchdogTimer = null;
      }
      if (execution.killTimer) {
        clearTimeout(execution.killTimer);
        execution.killTimer = null;
      }
    };

    const requestExecutionTermination = (execution: ManagedOrchestratorExecution) => {
      if (execution.child.killed) {
        return;
      }

      try {
        execution.child.kill('SIGTERM');
      } catch (error) {
        logger.debug(`[ORCHESTRATOR] Failed to send SIGTERM for execution ${execution.payload.executionId}`, error);
      }

      if (execution.killTimer) {
        return;
      }
      execution.killTimer = setTimeout(() => {
        execution.killTimer = null;
        if (execution.child.exitCode !== null || execution.child.signalCode !== null) {
          return;
        }
        try {
          execution.child.kill('SIGKILL');
        } catch (error) {
          logger.debug(`[ORCHESTRATOR] Failed to send SIGKILL for execution ${execution.payload.executionId}`, error);
        }
      }, ORCHESTRATOR_WATCHDOG_GRACE_MS);
    };

    const reportExecutionFinish = async (execution: ManagedOrchestratorExecution, opts: {
      status: OrchestratorFinishStatus;
      exitCode: number | null;
      signal: string | null;
      errorCode?: string | null;
      errorMessage?: string | null;
    }) => {
      if (execution.finishReportPromise) {
        await execution.finishReportPromise;
        return;
      }
      execution.finishReportPromise = (async () => {
        const normalizedStdout = execution.payload.provider === 'gemini'
          ? normalizeGeminiOutputText(execution.stdout)
          : execution.stdout.trim();
        const outputText = [normalizedStdout, execution.stderr.trim()].filter(Boolean).join('\n');
        const outputSummary = buildOutputSummary(normalizedStdout, execution.stderr);

        try {
          await api.reportOrchestratorExecutionFinish({
            executionId: execution.payload.executionId,
            dispatchToken: execution.payload.dispatchToken,
            status: opts.status,
            finishedAt: new Date().toISOString(),
            exitCode: opts.exitCode,
            signal: opts.signal,
            outputSummary: outputSummary ?? undefined,
            outputText: outputText || undefined,
            childSessionId: execution.detectedChildSessionId ?? undefined,
            errorCode: opts.errorCode,
            errorMessage: opts.errorMessage,
          });
        } catch (error) {
          logger.debug(`[ORCHESTRATOR] Failed to report finish for execution ${execution.payload.executionId}`, error);
        } finally {
          clearExecutionTimers(execution);
          executionIdToManagedExecution.delete(execution.payload.executionId);
        }
      })();
      await execution.finishReportPromise;
    };

    const finalizeExecution = async (executionId: string, exitCode: number | null, signal: string | null) => {
      const execution = executionIdToManagedExecution.get(executionId);
      if (!execution) {
        return;
      }

      if (!execution.detectedChildSessionId && execution.payload.provider === 'gemini' && execution.payload.executionType === 'initial') {
        const parsed = parseGeminiSessionIdFromLine(execution.stdoutLineBuffer);
        if (parsed) {
          execution.detectedChildSessionId = parsed;
        }
      }

      const status = mapFinishStatus({
        watchdogTriggered: execution.watchdogTriggered,
        cancelRequested: execution.cancelRequested,
        exitCode,
      });

      await execution.startReportPromise;
      await reportExecutionFinish(execution, {
        status,
        exitCode,
        signal,
        errorCode: status === 'timeout'
          ? 'WATCHDOG_TIMEOUT'
          : status === 'failed'
            ? 'PROCESS_EXIT_NON_ZERO'
            : undefined,
        errorMessage: status === 'timeout'
          ? `Execution exceeded timeout (${execution.payload.timeoutMs}ms)`
          : status === 'failed'
            ? `Process exited with code ${exitCode ?? 'unknown'}${signal ? ` (signal ${signal})` : ''}`
            : undefined,
      });
    };

    const handleOrchestratorDispatch = async (payload: OrchestratorDispatchPayload): Promise<{ accepted: boolean; duplicate?: boolean }> => {
      const existing = executionIdToManagedExecution.get(payload.executionId);
      if (existing) {
        if (existing.payload.dispatchToken !== payload.dispatchToken) {
          throw new Error(`Execution ${payload.executionId} already running with different dispatchToken`);
        }
        return { accepted: true, duplicate: true };
      }

      const oneshotEnv = buildOrchestratorEnv(payload);
      const child = spawnHappyCLI(['orchestrator-oneshot', '--provider', payload.provider], {
        cwd: os.homedir(),
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...oneshotEnv,
        },
      });

      const execution: ManagedOrchestratorExecution = {
        payload,
        child,
        startedAtIso: new Date().toISOString(),
        cancelRequested: false,
        watchdogTriggered: false,
        detectedChildSessionId: payload.childSessionId ?? null,
        startReportPromise: Promise.resolve(),
        finishReportPromise: null,
        stdout: '',
        stderr: '',
        stdoutLineBuffer: '',
        watchdogTimer: null,
        killTimer: null,
      };
      execution.startReportPromise = api.reportOrchestratorExecutionStart({
        executionId: payload.executionId,
        dispatchToken: payload.dispatchToken,
        startedAt: execution.startedAtIso,
        pid: child.pid,
      }).catch((error) => {
        logger.debug(`[ORCHESTRATOR] Failed to report start for execution ${payload.executionId}`, error);
      });
      executionIdToManagedExecution.set(payload.executionId, execution);

      child.stdout?.on('data', (chunk: Buffer | string) => {
        const text = chunk.toString();
        execution.stdout = appendOutputChunk(execution.stdout, text, ORCHESTRATOR_OUTPUT_CAPTURE_LIMIT);

        if (!execution.detectedChildSessionId) {
          if (payload.provider === 'codex' && payload.executionType === 'initial') {
            const probe = `${execution.stdoutLineBuffer}${text}`;
            const parsed = parseCodexSessionId(probe);
            if (parsed) {
              execution.detectedChildSessionId = parsed;
            }
            execution.stdoutLineBuffer = probe.slice(-256);
          } else if (payload.provider === 'gemini' && payload.executionType === 'initial') {
            execution.stdoutLineBuffer += text;
            const lines = execution.stdoutLineBuffer.split(/\r?\n/);
            execution.stdoutLineBuffer = lines.pop() ?? '';
            for (const line of lines) {
              const parsed = parseGeminiSessionIdFromLine(line);
              if (parsed) {
                execution.detectedChildSessionId = parsed;
                break;
              }
            }
          }
        }
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        execution.stderr = appendOutputChunk(execution.stderr, chunk.toString(), ORCHESTRATOR_OUTPUT_CAPTURE_LIMIT);
      });

      child.once('error', async (error) => {
        execution.stderr = appendOutputChunk(execution.stderr, `\n${error.message}\n`, ORCHESTRATOR_OUTPUT_CAPTURE_LIMIT);
        await execution.startReportPromise;
        await reportExecutionFinish(execution, {
          status: execution.watchdogTriggered ? 'timeout' : (execution.cancelRequested ? 'cancelled' : 'failed'),
          exitCode: execution.child.exitCode,
          signal: execution.child.signalCode,
          errorCode: 'SPAWN_ERROR',
          errorMessage: error.message,
        });
      });

      child.once('exit', async (code, signal) => {
        await finalizeExecution(payload.executionId, code, signal);
      });

      execution.watchdogTimer = setTimeout(() => {
        execution.watchdogTimer = null;
        execution.watchdogTriggered = true;
        requestExecutionTermination(execution);
      }, payload.timeoutMs);

      return { accepted: true };
    };

    const handleOrchestratorCancel = async (payload: OrchestratorCancelPayload): Promise<{ accepted: boolean; notFound?: boolean }> => {
      const execution = executionIdToManagedExecution.get(payload.executionId);
      if (!execution) {
        return { accepted: true, notFound: true };
      }
      if (execution.payload.dispatchToken !== payload.dispatchToken) {
        throw new Error(`dispatchToken mismatch for execution ${payload.executionId}`);
      }

      execution.cancelRequested = true;
      requestExecutionTermination(execution);
      return { accepted: true };
    };

    const stopAllOrchestratorExecutions = async (): Promise<void> => {
      const executions = Array.from(executionIdToManagedExecution.values());
      if (executions.length === 0) {
        return;
      }

      logger.debug(`[ORCHESTRATOR] Stopping ${executions.length} running orchestrator execution(s)`);
      for (const execution of executions) {
        execution.cancelRequested = true;
        requestExecutionTermination(execution);
      }

      const deadline = Date.now() + ORCHESTRATOR_SHUTDOWN_WAIT_MS;
      while (executionIdToManagedExecution.size > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };

    // Handle webhook from happy session reporting itself
    const onHappySessionWebhook = (sessionId: string, sessionMetadata: Metadata) => {
      logger.debugLargeJson(`[DAEMON RUN] Session reported`, sessionMetadata);

      const pid = sessionMetadata.hostPid;
      if (!pid) {
        logger.debug(`[DAEMON RUN] Session webhook missing hostPid for sessionId: ${sessionId}`);
        return;
      }

      logger.debug(`[DAEMON RUN] Session webhook: ${sessionId}, PID: ${pid}, started by: ${sessionMetadata.startedBy || 'unknown'}`);
      logger.debug(`[DAEMON RUN] Current tracked sessions before webhook: ${Array.from(pidToTrackedSession.keys()).join(', ')}`);

      // Check if we already have this PID (daemon-spawned)
      const existingSession = pidToTrackedSession.get(pid);

      if (existingSession && existingSession.startedBy === 'daemon') {
        // Update daemon-spawned session with reported data
        existingSession.happySessionId = sessionId;
        existingSession.happySessionMetadataFromLocalWebhook = sessionMetadata;
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
          pid
        };
        pidToTrackedSession.set(pid, trackedSession);
        logger.debug(`[DAEMON RUN] Registered externally-started session ${sessionId}`);
      }
    };

    // Spawn a new session (sessionId reserved for future --resume functionality)
    const spawnSession = async (options: SpawnSessionOptions): Promise<SpawnSessionResult> => {
      logger.debugLargeJson('[DAEMON RUN] Spawning session', options);

      const { directory, sessionId, resumeSessionId, sessionTitle, skipForkSession, machineId, approvedNewDirectoryCreation = true } = options;
      const isClaudeAgent = !options.agent || options.agent === 'claude';
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

      try {

        // Build environment variables with explicit precedence layers:
        // Layer 1 (base): Authentication tokens - protected, cannot be overridden
        // Layer 2 (middle): Profile environment variables - GUI profile OR CLI local profile
        // Layer 3 (top): Auth tokens again to ensure they're never overridden

        // Layer 1: Resolve authentication token if provided
        const authEnv: Record<string, string> = {};
        if (options.token) {
          if (options.agent === 'codex') {

            // Create a temporary directory for Codex
            const codexHomeDir = tmp.dirSync();

            // Write the token to the temporary directory
            fs.writeFile(join(codexHomeDir.name, 'auth.json'), options.token);

            // Set the environment variable for Codex
            authEnv.CODEX_HOME = codexHomeDir.name;
          } else { // Assuming claude
            authEnv.CLAUDE_CODE_OAUTH_TOKEN = options.token;
          }
        }

        // Layer 2: Profile environment variables
        // Priority: GUI-provided profile > CLI local active profile > none
        let profileEnv: Record<string, string> = {};

        if (options.environmentVariables && Object.keys(options.environmentVariables).length > 0) {
          // GUI provided profile environment variables - highest priority for profile settings
          profileEnv = options.environmentVariables;
          logger.info(`[DAEMON RUN] Using GUI-provided profile environment variables (${Object.keys(profileEnv).length} vars)`);
          logger.debug(`[DAEMON RUN] GUI profile env var keys: ${Object.keys(profileEnv).join(', ')}`);
        } else {
          // Fallback to CLI local active profile
          try {
            const settings = await readSettings();
            if (settings.activeProfileId) {
              logger.debug(`[DAEMON RUN] No GUI profile provided, loading CLI local active profile: ${settings.activeProfileId}`);

              // Get profile environment variables filtered for agent compatibility
              profileEnv = await getProfileEnvironmentVariablesForAgent(
                settings.activeProfileId,
                options.agent || 'claude'
              );

              logger.debug(`[DAEMON RUN] Loaded ${Object.keys(profileEnv).length} environment variables from CLI local profile for agent ${options.agent || 'claude'}`);
              logger.debug(`[DAEMON RUN] CLI profile env var keys: ${Object.keys(profileEnv).join(', ')}`);
            } else {
              logger.debug('[DAEMON RUN] No CLI local active profile set');
            }
          } catch (error) {
            logger.debug('[DAEMON RUN] Failed to load CLI local profile environment variables:', error);
            // Continue without profile env vars - this is not a fatal error
          }
        }

        // Final merge: Profile vars first, then auth (auth takes precedence to protect authentication)
        let extraEnv = { ...profileEnv, ...authEnv };
        if (resumeSessionId && isClaudeAgent) {
          extraEnv.HAPPY_CLAUDE_BACKFILL = '1';
          extraEnv.HAPPY_CLAUDE_BACKFILL_MAX_MESSAGES = '200';
          extraEnv.HAPPY_CLAUDE_BACKFILL_MAX_USER_MESSAGES = '20';
          extraEnv.HAPPY_CLAUDE_RESUME_SESSION_ID = resumeSessionId;
          if (skipForkSession) {
            extraEnv.HAPPY_CLAUDE_SKIP_FORK_SESSION = '1';
          }
        }
        if (resumeSessionId && options.agent === 'gemini') {
          extraEnv.HAPPY_GEMINI_RESUME_SESSION_ID = resumeSessionId;
          extraEnv.HAPPY_GEMINI_BACKFILL = '1';
        }
        if (resumeSessionId && options.agent === 'codex') {
          extraEnv.HAPPY_CODEX_RESUME_FILE = resumeSessionId;
          extraEnv.HAPPY_CODEX_BACKFILL = '1';
        }
        // Session title - passed to all agents (Claude, Codex, Gemini)
        if (sessionTitle) {
          extraEnv.HAPPY_SESSION_TITLE = sessionTitle;
        }
        // Worktree metadata - passed to agent process so initial metadata includes it
        if (options.worktreeBasePath) {
          extraEnv.HAPPY_WORKTREE_BASE_PATH = options.worktreeBasePath;
        }
        if (options.worktreeBranchName) {
          extraEnv.HAPPY_WORKTREE_BRANCH_NAME = options.worktreeBranchName;
        }
        // Multi-repo workspace metadata
        if (options.workspaceRepos && options.workspaceRepos.length > 0) {
          extraEnv.HAPPY_WORKSPACE_REPOS = JSON.stringify(options.workspaceRepos);
        }
        if (options.workspacePath) {
          extraEnv.HAPPY_WORKSPACE_PATH = options.workspacePath;
        }
        // Extra MCP servers (e.g., DooTask MCP) - serialized as JSON env var
        if (options.mcpServers && options.mcpServers.length > 0) {
          extraEnv.HAPPY_EXTRA_MCP_SERVERS = JSON.stringify(options.mcpServers);
        }
        logger.debug(`[DAEMON RUN] Final environment variable keys (before expansion) (${Object.keys(extraEnv).length}): ${Object.keys(extraEnv).join(', ')}`);

        // Expand ${VAR} references from daemon's process.env
        // This ensures variable substitution works in both tmux and non-tmux modes
        // Example: ANTHROPIC_AUTH_TOKEN="${Z_AI_AUTH_TOKEN}" → ANTHROPIC_AUTH_TOKEN="sk-real-key"
        extraEnv = expandEnvironmentVariables(extraEnv, process.env);
        logger.debug(`[DAEMON RUN] After variable expansion: ${Object.keys(extraEnv).join(', ')}`);

        // Fail-fast validation: Check that any auth variables present are fully expanded
        // Only validate variables that are actually set (different agents need different auth)
        const potentialAuthVars = ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_HOME', 'AZURE_OPENAI_API_KEY', 'TOGETHER_API_KEY'];
        const unexpandedAuthVars = potentialAuthVars.filter(varName => {
          const value = extraEnv[varName];
          // Only fail if variable IS SET and contains unexpanded ${VAR} references
          return value && typeof value === 'string' && value.includes('${');
        });

        if (unexpandedAuthVars.length > 0) {
          // Extract the specific missing variable names from unexpanded references
          const missingVarDetails = unexpandedAuthVars.map(authVar => {
            const value = extraEnv[authVar];
            const unresolvedMatch = value?.match(/\$\{([A-Z_][A-Z0-9_]*)(:-[^}]*)?\}/);
            const missingVar = unresolvedMatch ? unresolvedMatch[1] : 'unknown';
            return `${authVar} references \${${missingVar}} which is not defined`;
          });

          const errorMessage = `Authentication will fail - environment variables not found in daemon: ${missingVarDetails.join('; ')}. ` +
            `Ensure these variables are set in the daemon's environment (not just your shell) before starting sessions.`;
          logger.warn(`[DAEMON RUN] ${errorMessage}`);
          return {
            type: 'error',
            errorMessage
          };
        }

        // Execute setup scripts before spawning AI agent
        if (options.repoScripts && options.repoScripts.length > 0) {
          const sequentialScripts = options.repoScripts.filter(s => s.setupScript && !s.parallelSetup);
          const parallelScripts = options.repoScripts.filter(s => s.setupScript && s.parallelSetup);

          // Run sequential setup scripts first
          for (const script of sequentialScripts) {
            logger.info(`[DAEMON] Running setup script for ${script.repoDisplayName}...`);
            try {
              execSync(script.setupScript!, { cwd: script.worktreePath, stdio: 'pipe', timeout: 300000 });
              logger.info(`[DAEMON] Setup script completed for ${script.repoDisplayName}`);
            } catch (err: any) {
              logger.warn(`[DAEMON] Setup script failed for ${script.repoDisplayName}: ${err.message}`);
            }
          }

          // Start parallel setup scripts (fire and forget)
          for (const script of parallelScripts) {
            logger.info(`[DAEMON] Running parallel setup for ${script.repoDisplayName}...`);
            const child = exec(script.setupScript!, { cwd: script.worktreePath });
            child.on('exit', (code: number | null) => {
              if (code === 0) {
                logger.info(`[DAEMON] Parallel setup completed for ${script.repoDisplayName}`);
              } else {
                logger.warn(`[DAEMON] Parallel setup failed for ${script.repoDisplayName} (exit code ${code})`);
              }
            });
          }

          // TODO: devServerScript execution — requires long-running process management
          // (start after setup, track child process, kill on session exit/archive).
          // Currently the field is defined in types and UI but not executed.
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
          const sessionDesc = tmuxSessionName || 'current/most recent session';
          logger.debug(`[DAEMON RUN] Attempting to spawn session in tmux: ${sessionDesc}`);

          const tmux = getTmuxUtilities(tmuxSessionName);

          // Construct command for the CLI
          const cliPath = join(projectPath(), 'dist', 'index.mjs');
          // Determine agent command - support claude, codex, and gemini
          const agent = options.agent === 'gemini' ? 'gemini' : (options.agent === 'codex' ? 'codex' : 'claude');
          const forkFlag = skipForkSession ? '' : ' --fork-session';
          const resumeArgs = resumeSessionId && isClaudeAgent ? ` --resume ${resumeSessionId}${forkFlag}` : '';
          const fullCommand = `node --no-warnings --no-deprecation ${cliPath} ${agent} --happy-starting-mode remote --started-by daemon${resumeArgs}`;

          // Spawn in tmux with environment variables
          // IMPORTANT: Pass complete environment (process.env + extraEnv) because:
          // 1. tmux sessions need daemon's expanded auth variables (e.g., ANTHROPIC_AUTH_TOKEN)
          // 2. Regular spawn uses env: { ...process.env, ...extraEnv }
          // 3. tmux needs explicit environment via -e flags to ensure all variables are available
          const windowName = `happy-${Date.now()}-${agent}`;
          const tmuxEnv: Record<string, string> = {};

          // Add all daemon environment variables (filtering out undefined)
          for (const [key, value] of Object.entries(process.env)) {
            if (value !== undefined) {
              tmuxEnv[key] = value;
            }
          }

          // Add extra environment variables (these should already be filtered)
          Object.assign(tmuxEnv, extraEnv);

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
            const trackedSession: TrackedSession = {
              startedBy: 'daemon',
              pid: tmuxResult.pid, // Real PID from tmux -P flag
              tmuxSessionId: tmuxResult.sessionId,
              directoryCreated,
              message: directoryCreated
                ? `The path '${directory}' did not exist. We created a new folder and spawned a new session in tmux session '${tmuxSessionName}'. Use 'tmux attach -t ${tmuxSessionName}' to view the session.`
                : `Spawned new session in tmux session '${tmuxSessionName}'. Use 'tmux attach -t ${tmuxSessionName}' to view the session.`,
              repoScripts: options.repoScripts
            };

            // Add to tracking map so webhook can find it later
            pidToTrackedSession.set(tmuxResult.pid, trackedSession);

            // Wait for webhook to populate session with happySessionId (exact same as regular flow)
            logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${tmuxResult.pid} (tmux)`);

            return new Promise((resolve) => {
              // Set timeout for webhook (same as regular flow)
              const timeout = setTimeout(() => {
                pidToAwaiter.delete(tmuxResult.pid!);
                logger.debug(`[DAEMON RUN] Session webhook timeout for PID ${tmuxResult.pid} (tmux)`);
                resolve({
                  type: 'error',
                  errorMessage: `Session webhook timeout for PID ${tmuxResult.pid} (tmux)`
                });
              }, 15_000); // Same timeout as regular sessions

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
            logger.debug(`[DAEMON RUN] Failed to spawn in tmux: ${tmuxResult.error}, falling back to regular spawning`);
            useTmux = false;
          }
        }

        // Regular process spawning (fallback or if tmux not available)
        if (!useTmux) {
          logger.debug(`[DAEMON RUN] Using regular process spawning`);

          // Construct arguments for the CLI - support claude, codex, and gemini
          let agentCommand: string;
          switch (options.agent) {
            case 'claude':
            case undefined:
              agentCommand = 'claude';
              break;
            case 'codex':
              agentCommand = 'codex';
              break;
            case 'gemini':
              agentCommand = 'gemini';
              break;
            default:
              return {
                type: 'error',
                errorMessage: `Unsupported agent type: '${options.agent}'. Please update your CLI to the latest version.`
              };
          }
          const args = [
            agentCommand,
            '--happy-starting-mode', 'remote',
            '--started-by', 'daemon'
          ];
          if (resumeSessionId && isClaudeAgent) {
            args.push('--resume', resumeSessionId);
            if (!skipForkSession) {
              args.push('--fork-session');
            }
          }

          // TODO: In future, sessionId could be used with --resume to continue existing sessions
          // For now, we ignore it - each spawn creates a new session
          const happyProcess = spawnHappyCLI(args, {
            cwd: directory,
            detached: true,  // Sessions stay alive when daemon stops
            stdio: ['ignore', 'pipe', 'pipe'],  // Capture stdout/stderr for debugging
            env: {
              ...process.env,
              ...extraEnv
            }
          });

          // Log output for debugging
          if (process.env.DEBUG) {
            happyProcess.stdout?.on('data', (data) => {
              logger.debug(`[DAEMON RUN] Child stdout: ${data.toString()}`);
            });
            happyProcess.stderr?.on('data', (data) => {
              logger.debug(`[DAEMON RUN] Child stderr: ${data.toString()}`);
            });
          }

          if (!happyProcess.pid) {
            logger.debug('[DAEMON RUN] Failed to spawn process - no PID returned');
            return {
              type: 'error',
              errorMessage: 'Failed to spawn Happy process - no PID returned'
            };
          }

          logger.debug(`[DAEMON RUN] Spawned process with PID ${happyProcess.pid}`);

          const trackedSession: TrackedSession = {
            startedBy: 'daemon',
            pid: happyProcess.pid,
            childProcess: happyProcess,
            directoryCreated,
            message: directoryCreated ? `The path '${directory}' did not exist. We created a new folder and spawned a new session there.` : undefined,
            repoScripts: options.repoScripts
          };

          pidToTrackedSession.set(happyProcess.pid, trackedSession);

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

          // Wait for webhook to populate session with happySessionId
          logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${happyProcess.pid}`);

          return new Promise((resolve) => {
            // Set timeout for webhook
            const timeout = setTimeout(() => {
              pidToAwaiter.delete(happyProcess.pid!);
              logger.debug(`[DAEMON RUN] Session webhook timeout for PID ${happyProcess.pid}`);
              resolve({
                type: 'error',
                errorMessage: `Session webhook timeout for PID ${happyProcess.pid}`
              });
              // 15 second timeout - I have seen timeouts on 10 seconds
              // even though session was still created successfully in ~2 more seconds
            }, 15_000);

            // Register awaiter
            pidToAwaiter.set(happyProcess.pid!, (completedSession) => {
              clearTimeout(timeout);
              logger.debug(`[DAEMON RUN] Session ${completedSession.happySessionId} fully spawned with webhook`);
              resolve({
                type: 'success',
                sessionId: completedSession.happySessionId!
              });
            });
          });
        }

        // This should never be reached, but TypeScript requires a return statement
        return {
          type: 'error',
          errorMessage: 'Unexpected error in session spawning'
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.debug('[DAEMON RUN] Failed to spawn session:', error);
        return {
          type: 'error',
          errorMessage: `Failed to spawn session: ${errorMessage}`
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
          logger.debug(`[DAEMON RUN] Removed session ${sessionId} from tracking`);
          return true;
        }
      }

      logger.debug(`[DAEMON RUN] Session ${sessionId} not found`);
      return false;
    };

    // Run cleanup scripts for a tracked session if its worktrees have changes
    const runCleanupScripts = (session: TrackedSession) => {
      if (!session.repoScripts || session.repoScripts.length === 0) return;

      for (const script of session.repoScripts) {
        if (!script.cleanupScript) continue;
        try {
          const status = execSync('git status --porcelain', {
            cwd: script.worktreePath, encoding: 'utf-8', timeout: 10000
          });
          if (status.trim()) {
            logger.info(`[DAEMON] Running cleanup script for ${script.repoDisplayName}...`);
            execSync(script.cleanupScript, {
              cwd: script.worktreePath, stdio: 'pipe', timeout: 300000
            });
            logger.info(`[DAEMON] Cleanup script completed for ${script.repoDisplayName}`);
          } else {
            logger.debug(`[DAEMON] No changes in ${script.repoDisplayName}, skipping cleanup`);
          }
        } catch (err: any) {
          logger.warn(`[DAEMON] Cleanup script failed for ${script.repoDisplayName}: ${err.message}`);
        }
      }
    };

    // Handle child process exit
    const onChildExited = (pid: number) => {
      logger.debug(`[DAEMON RUN] Removing exited process PID ${pid} from tracking`);
      const session = pidToTrackedSession.get(pid);
      if (session) {
        runCleanupScripts(session);
      }
      pidToTrackedSession.delete(pid);
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

    // Prepare initial daemon state
    const initialDaemonState: DaemonState = {
      status: 'offline',
      pid: process.pid,
      httpPort: controlPort,
      startedAt: Date.now()
    };

    // Create API client
    api = await ApiClient.create(credentials);

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
      stopSession,
      requestShutdown: () => requestShutdown('happy-app'),
      orchestratorDispatch: handleOrchestratorDispatch,
      orchestratorCancel: handleOrchestratorCancel,
    });

    // Connect to server
    apiMachine.connect();

    // Update machine metadata on server (ensures version is current after daemon restart)
    // Merge with current metadata to preserve fields set by the app (e.g. displayName)
    apiMachine.updateMachineMetadata((current) => ({ ...current, ...initialMachineMetadata })).catch((error) => {
      logger.debug('[DAEMON RUN] Failed to update machine metadata', error);
    });

    // Every 60 seconds:
    // 1. Prune stale sessions
    // 2. Check if daemon needs update
    // 3. If outdated, restart with latest version
    // 4. Write heartbeat
    const heartbeatIntervalMsRaw = Number(process.env.HAPPY_DAEMON_HEARTBEAT_INTERVAL);
    const heartbeatIntervalMs = Number.isFinite(heartbeatIntervalMsRaw) && heartbeatIntervalMsRaw > 0
      ? heartbeatIntervalMsRaw
      : 60_000;
    let heartbeatRunning = false
    const restartOnStaleVersionAndHeartbeat = setInterval(async () => {
      if (heartbeatRunning) {
        return;
      }
      heartbeatRunning = true;

      if (process.env.DEBUG) {
        logger.debug(`[DAEMON RUN] Health check started at ${new Date().toLocaleString()}`);
      }

      // Prune stale sessions (and run cleanup scripts for any that had workspace repos)
      for (const [pid, _] of pidToTrackedSession.entries()) {
        try {
          // Check if process is still alive (signal 0 doesn't kill, just checks)
          process.kill(pid, 0);
        } catch (error) {
          // Process is dead, run cleanup and remove from tracking
          logger.debug(`[DAEMON RUN] Removing stale session with PID ${pid} (process no longer exists)`);
          onChildExited(pid);
        }
      }

      // Check if daemon needs update
      // If version on disk is different from the one in package.json - we need to restart
      // BIG if - does this get updated from underneath us on npm upgrade?
      let projectVersion: string;
      try {
        projectVersion = JSON.parse(readFileSync(join(projectPath(), 'package.json'), 'utf-8')).version;
      } catch (error) {
        // package.json may be temporarily missing or corrupted during npm upgrade
        logger.debug('[DAEMON RUN] Failed to read package.json for version check, skipping this heartbeat', error);
        heartbeatRunning = false;
        return;
      }
      if (projectVersion !== configuration.currentCliVersion) {
        logger.debug('[DAEMON RUN] Daemon is outdated, triggering self-restart with latest version, clearing heartbeat interval');

        clearInterval(restartOnStaleVersionAndHeartbeat);

        // Spawn new daemon through the CLI
        // We do not need to clean ourselves up - we will be killed by
        // the CLI start command.
        // 1. It will first check if daemon is running (yes in this case)
        // 2. If the version is stale (it will read daemon.state.json file and check startedWithCliVersion) & compare it to its own version
        // 3. Next it will start a new daemon with the latest version with daemon-sync :D
        // Done!
        try {
          spawnHappyCLI(['daemon', 'start'], {
            detached: true,
            stdio: 'ignore'
          });
        } catch (error) {
          logger.debug('[DAEMON RUN] Failed to spawn new daemon, this is quite likely to happen during integration tests as we are cleaning out dist/ directory', error);
        }

        // So we can just hang forever
        logger.debug('[DAEMON RUN] Hanging for a bit - waiting for CLI to kill us because we are running outdated version of the code');
        await new Promise(resolve => setTimeout(resolve, 10_000));
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

      // Update daemon state before shutting down
      await apiMachine.updateDaemonState((state: DaemonState | null) => ({
        ...state,
        status: 'shutting-down',
        shutdownRequestedAt: Date.now(),
        shutdownSource: source
      }));

      // Give time for metadata update to send
      await new Promise(resolve => setTimeout(resolve, 100));

      await stopAllOrchestratorExecutions();

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
