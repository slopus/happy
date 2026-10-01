#!/usr/bin/env node

/**
 * Happy runtime command implementation loaded by the lightweight CLI bootstrap.
 *
 * Simple argument parsing without any CLI framework dependencies
 */


import { takeStandaloneLaunchBootstrap } from '@/daemon/standaloneLaunchProtocol'
import { configuration } from '@/configuration'
import chalk from 'chalk'
import { runClaude, StartOptions } from '@/claude/runClaude'
import { runCodex } from '@/codex/runCodex'
import { assertProviderExecArguments } from '@/launcher/providerEntry'
import { logger } from './ui/logger'
import { readCredentials, readSettings } from './persistence'
import { authAndSetupMachineIfNeeded } from './ui/auth'
import packageJson from '../package.json'
import { z } from 'zod'
import { startDaemon } from './daemon/run'
import { checkIfDaemonRunningAndCleanupStaleState, isDaemonRunningCurrentlyInstalledHappyVersion, stopDaemon } from './daemon/controlClient'
import { getLatestDaemonLog } from './ui/logger'
import { killRunawayHappyProcesses } from './daemon/doctor'
import { install } from './daemon/install'
import { uninstall } from './daemon/uninstall'
import { ApiClient } from './api/api'
import { runDoctorCommand, runDoctorDaemon } from './ui/doctor'
import { listDaemonSessions, stopDaemonSession } from './daemon/controlClient'
import { handleAuthCommand } from './commands/auth'
import { handleConnectCommand } from './commands/connect'
import { handleSandboxCommand } from './commands/sandbox'
import { handleBrowserCommand } from './commands/browser'
import { handleServerCommand } from './commands/server'
import { handleDataKeyCommand } from './commands/datakey'
import { captureSpawnOutputStdio, spawnHappyCLI } from './utils/spawnHappyCLI'
import { claudeCliPath } from './claude/claudeLocal'
import { execFileSync } from 'node:child_process'
import { extractNoSandboxFlag } from './utils/sandboxFlags'
import { handleResumeCommand } from '@/resume/handleResumeCommand'
import { ensureDaemonRunning } from './daemon/ensureDaemonRunning'
import { handleCodexCommand } from './commands/codexCommand'
import { runPreToolUseCli } from './hooks/runPreToolUseCli'
import { preflightDaemonControlServer } from './daemon/controlServer'
import { resolveMcpConfigPresetUrl } from './aplus/mcpConfigPresets'
import { readManagedStartup } from '@/managed/managedStartup';
import { resolveDaemonMcpConfigEnvironment } from './daemon/daemonMcpConfig'
import { waitForDaemonStart } from './daemon/waitForDaemonStart'


(async () => {
  const args = process.argv.slice(2)

  // If --version is passed - do not log, its likely daemon inquiring about our version
  if (!args.includes('--version')) {
    logger.debug('Starting happy CLI with args: ', process.argv)
  }

  // Check if first argument is a subcommand
  const subcommand = args[0]

  // Log which subcommand was detected (for debugging)
  if (!args.includes('--version')) {
  }

  if (subcommand === 'doctor') {
    // Check for clean subcommand
    if (args[1] === 'clean') {
      if (args.slice(2).some(a => a === '--help' || a === '-h')) {
        console.log(`
${chalk.bold('happy doctor clean')} - Kill all happy-related processes (daemon + sessions)

${chalk.bold('Usage:')}
  happy doctor clean

${chalk.bold('Warning:')} This is destructive — it terminates the daemon and every running session.
Conversation history is preserved on the server, but in-flight tool calls are interrupted.
`)
        process.exit(0)
      }
      const result = await killRunawayHappyProcesses()
      console.log(`Cleaned up ${result.killed} runaway processes`)
      if (result.errors.length > 0) {
        console.log('Errors:', result.errors)
      }
      process.exit(0)
    }
    await runDoctorCommand();
    return;
  } else if (subcommand === 'auth') {
    // Handle auth subcommands
    try {
      await handleAuthCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'connect') {
    // Handle connect subcommands
    try {
      await handleConnectCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'browser') {
    try {
      await handleBrowserCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'managed-boot') {
    /*
     * The root boot stage of a managed runtime, run by the image entrypoint
     * **before** the daemon and before anything runs as the agent uid.
     *
     * It is a separate command rather than a step inside `daemon start` for
     * two reasons: it needs root and the daemon does not, and the supervisor it
     * starts has to outlive the daemon — a daemon restart that also restarted
     * the ledger's owner would lose the lease enforcement for children that are
     * still running.
     *
     * On a machine with no provisioning marker this exits 0 and does nothing:
     * BYOS is not a failure. A marker that exists and cannot be trusted exits
     * non-zero, and the entrypoint must not start the agent after that.
     */
    const { runManagedRuntimeBoot, defaultManagedRuntimeBootDeps } = await import('@/managed/managedRuntimeBoot');
    const outcome = await runManagedRuntimeBoot(defaultManagedRuntimeBootDeps());
    if (outcome.ok) {
      /*
       * This command returns while the process keeps running — the supervisor's
       * socket and watchdog are what hold it open. So the checkpoint consumer
       * the boot started is still ticking here, and a stop arriving mid-attempt
       * would otherwise leave an archive uploaded with no pointer at it: a
       * checkpoint that exists and that nothing can find.
       *
       * Bounded, and it re-raises the signal afterwards, so nothing here makes
       * the machine harder to stop. With no consumer running it installs
       * nothing.
       */
      const { drainManagedCheckpointTicksOnSignal } = await import('@/managed/checkpoint/managedCheckpointTicks');
      drainManagedCheckpointTicksOnSignal({
        ticks: outcome.checkpointTicks,
        onStopped: ({ signal, pendingPublication }) => {
          // 고정 분류자만. 어떤 신호였는지, 정산 못 한 발행이 남았는지.
          console.log(`managed runtime boot: checkpoint consumer stopped on ${signal}`
            + `${pendingPublication ? ' (publication pending)' : ''}`);
        },
      });
      console.log(`managed runtime boot: supervisor listening (${outcome.published})`);
      return;
    }
    if (outcome.reason === 'not-managed') return;
    /*
     * The reason is a fixed classifier, and so is the detail. Paths, tokens and
     * provider text stay out of both — this line lands in image build and boot
     * logs.
     *
     * The detail is printed because without it every way a marker can be
     * untrustworthy arrives as one word, and the operator's next step is
     * exactly the part that would be missing: which rule refused, and which of
     * the isolation probe's checks was the one that did not hold.
     */
    console.error(
      chalk.red('managed runtime boot refused:'),
      outcome.detail ? `${outcome.reason} (${outcome.detail})` : outcome.reason,
    );
    process.exit(1);
    return;
  } else if (subcommand === 'sandbox') {
    try {
      await handleSandboxCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'server') {
    try {
      await handleServerCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'datakey') {
    // aplus §6-1 — dataKey-활성 전환 관리 (specs/e2ee-cli-datakey-activation)
    try {
      await handleDataKeyCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'bye') {
    console.log('Bye!');
    process.exit(0);
  } else if (subcommand === 'hooks') {
    // `happy hooks pre-tool-use` — invoked by Claude Code via .claude/settings.json
    const hookName = args[1];
    if (hookName === 'pre-tool-use') {
      const exit = await runPreToolUseCli({
        cwd: process.cwd(),
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
      });
      process.exit(exit);
    }
    console.error(`Unknown hook: ${hookName}`);
    process.exit(1);
  } else if (subcommand === 'resume') {
    try {
      await handleResumeCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'codex') {
    // Handle codex command
    try {
      await handleCodexCommand(args.slice(1));
      // Do not force exit here; allow instrumentation to show lingering handles
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'gemini') {
    // Handle gemini subcommands
    const geminiSubcommand = args[1];

    // Handle "happy gemini model set <model>" command
    if (geminiSubcommand === 'model' && args[2] === 'set' && args[3]) {
      const modelName = args[3];
      const validModels = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];

      if (!validModels.includes(modelName)) {
        console.error(`Invalid model: ${modelName}`);
        console.error(`Available models: ${validModels.join(', ')}`);
        process.exit(1);
      }

      try {
        const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('fs');
        const { join } = require('path');
        const { homedir } = require('os');

        const configDir = join(homedir(), '.gemini');
        const configPath = join(configDir, 'config.json');

        // Create directory if it doesn't exist
        if (!existsSync(configDir)) {
          mkdirSync(configDir, { recursive: true });
        }

        // Read existing config or create new one
        let config: any = {};
        if (existsSync(configPath)) {
          try {
            config = JSON.parse(readFileSync(configPath, 'utf-8'));
          } catch (error) {
            // Ignore parse errors, start fresh
            config = {};
          }
        }

        // Update model in config
        config.model = modelName;

        // Write config back
        writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
        console.log(`✓ Model set to: ${modelName}`);
        console.log(`  Config saved to: ${configPath}`);
        console.log(`  This model will be used in future sessions.`);
        process.exit(0);
      } catch (error) {
        console.error('Failed to save model configuration:', error);
        process.exit(1);
      }
    }

    // Handle "happy gemini model get" command
    if (geminiSubcommand === 'model' && args[2] === 'get') {
      try {
        const { existsSync, readFileSync } = require('fs');
        const { join } = require('path');
        const { homedir } = require('os');

        const configPaths = [
          join(homedir(), '.gemini', 'config.json'),
          join(homedir(), '.config', 'gemini', 'config.json'),
        ];

        let model: string | null = null;
        for (const configPath of configPaths) {
          if (existsSync(configPath)) {
            try {
              const config = JSON.parse(readFileSync(configPath, 'utf-8'));
              model = config.model || config.GEMINI_MODEL || null;
              if (model) break;
            } catch (error) {
              // Ignore parse errors
            }
          }
        }

        if (model) {
          console.log(`Current model: ${model}`);
        } else if (process.env.GEMINI_MODEL) {
          console.log(`Current model: ${process.env.GEMINI_MODEL} (from GEMINI_MODEL env var)`);
        } else {
          console.log('Current model: gemini-2.5-pro (default)');
        }
        process.exit(0);
      } catch (error) {
        console.error('Failed to read model configuration:', error);
        process.exit(1);
      }
    }

    // Handle "happy gemini project set <project-id>" command
    if (geminiSubcommand === 'project' && args[2] === 'set' && args[3]) {
      const projectId = args[3];

      try {
        const { saveGoogleCloudProjectToConfig } = await import('@/gemini/utils/config');
        const { readCredentials } = await import('@/persistence');
        const { ApiClient } = await import('@/api/api');

        // Try to get current user email from Happy cloud token
        let userEmail: string | undefined = undefined;
        try {
          const credentials = await readCredentials();
          if (credentials) {
            const api = await ApiClient.create(credentials);
            const vendorToken = await api.getVendorToken('gemini');
            if (vendorToken?.oauth?.id_token) {
              const parts = vendorToken.oauth.id_token.split('.');
              if (parts.length === 3) {
                const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
                userEmail = payload.email;
              }
            }
          }
        } catch {
          // If we can't get email, project will be saved globally
        }

        saveGoogleCloudProjectToConfig(projectId, userEmail);
        console.log(`✓ Google Cloud Project set to: ${projectId}`);
        if (userEmail) {
          console.log(`  Linked to account: ${userEmail}`);
        }
        console.log(`  This project will be used for Google Workspace accounts.`);
        process.exit(0);
      } catch (error) {
        console.error('Failed to save project configuration:', error);
        process.exit(1);
      }
    }

    // Handle "happy gemini project get" command
    if (geminiSubcommand === 'project' && args[2] === 'get') {
      try {
        const { readGeminiLocalConfig } = await import('@/gemini/utils/config');
        const config = readGeminiLocalConfig();

        if (config.googleCloudProject) {
          console.log(`Current Google Cloud Project: ${config.googleCloudProject}`);
          if (config.googleCloudProjectEmail) {
            console.log(`  Linked to account: ${config.googleCloudProjectEmail}`);
          } else {
            console.log(`  Applies to: all accounts (global)`);
          }
        } else if (process.env.GOOGLE_CLOUD_PROJECT) {
          console.log(`Current Google Cloud Project: ${process.env.GOOGLE_CLOUD_PROJECT} (from env var)`);
        } else {
          console.log('No Google Cloud Project configured.');
          console.log('');
          console.log('If you see "Authentication required" error, you may need to set a project:');
          console.log('  happy gemini project set <your-project-id>');
          console.log('');
          console.log('This is required for Google Workspace accounts.');
          console.log('Guide: https://goo.gle/gemini-cli-auth-docs#workspace-gca');
        }
        process.exit(0);
      } catch (error) {
        console.error('Failed to read project configuration:', error);
        process.exit(1);
      }
    }

    // Handle "happy gemini project" (no subcommand) - show help
    if (geminiSubcommand === 'project' && !args[2]) {
      console.log('Usage: happy gemini project <command>');
      console.log('');
      console.log('Commands:');
      console.log('  set <project-id>   Set Google Cloud Project ID');
      console.log('  get                Show current Google Cloud Project ID');
      console.log('');
      console.log('Google Workspace accounts require a Google Cloud Project.');
      console.log('If you see "Authentication required" error, set your project ID.');
      console.log('');
      console.log('Guide: https://goo.gle/gemini-cli-auth-docs#workspace-gca');
      process.exit(0);
    }

    // Handle gemini command (ACP-based agent)
    try {
      const { runGemini } = await import('@/gemini/runGemini');

      // Parse startedBy argument
      let startedBy: 'daemon' | 'terminal' | undefined = undefined;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--started-by') {
          startedBy = args[++i] as 'daemon' | 'terminal';
        }
      }

      const {
        credentials
      } = await authAndSetupMachineIfNeeded();
      await ensureDaemonRunning()

      await runGemini({credentials, startedBy});
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'acp' || subcommand === 'grok') {
    try {
      const { runAcp, resolveAcpAgentConfig, parseAcpSubcommandArgs } = await import('@/agent/acp');

      const { startedBy, verbose, acpArgs } = parseAcpSubcommandArgs(args.slice(1));

      // `happy grok` is `happy acp grok` with the agent name pinned, so every
      // remaining flag (-m, --reasoning-effort, ...) still reaches the Grok CLI.
      const resolved = resolveAcpAgentConfig(subcommand === 'grok' ? ['grok', ...acpArgs] : acpArgs);
      // Captured by index.ts before provider modules loaded; only a daemon launch carries one.
      const standaloneLaunch = takeStandaloneLaunchBootstrap(process.env);
      const { credentials } = await authAndSetupMachineIfNeeded();
      await ensureDaemonRunning()

      await runAcp({
        credentials,
        startedBy,
        verbose,
        agentName: resolved.agentName,
        command: resolved.command,
        args: resolved.args,
        ...(standaloneLaunch ? { standaloneLaunch } : {}),
      });
      // runAcp has flushed and closed its session. Leave now, like runClaude: left to
      // drain on its own the process lingered ~10s, which a Windows app close waits out.
      process.exit(0)
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'openclaw') {
    try {
      const { runOpenClaw } = await import('@/openclaw/runOpenClaw');

      let startedBy: 'daemon' | 'terminal' | undefined = undefined;
      let verbose = false;
      let gatewayUrl: string | undefined;
      let gatewayToken: string | undefined;
      let gatewayPassword: string | undefined;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--started-by') {
          startedBy = args[++i] as 'daemon' | 'terminal';
        } else if (args[i] === '--verbose') {
          verbose = true;
        } else if (args[i] === '--gateway-url') {
          gatewayUrl = args[++i];
        } else if (args[i] === '--gateway-token') {
          gatewayToken = args[++i];
        } else if (args[i] === '--gateway-password') {
          gatewayPassword = args[++i];
        }
      }

      const { credentials } = await authAndSetupMachineIfNeeded();
      await ensureDaemonRunning()

      await runOpenClaw({
        credentials,
        startedBy,
        verbose,
        gatewayUrl,
        gatewayToken,
        gatewayPassword,
      });
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'logout') {
    // Keep for backward compatibility - redirect to auth logout
    console.log(chalk.yellow('Note: "happy logout" is deprecated. Use "happy auth logout" instead.\n'));
    try {
      await handleAuthCommand(['logout']);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'notify') {
    // Handle notification command
    try {
      await handleNotifyCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'daemon') {
    // Show daemon management help
    const daemonSubcommand = args[1]

    if (daemonSubcommand === 'list') {
      try {
        const sessions = await listDaemonSessions()

        if (sessions.length === 0) {
          console.log('No active sessions this daemon is aware of (they might have been started by a previous version of the daemon)')
        } else {
          console.log('Active sessions:')
          console.log(JSON.stringify(sessions, null, 2))
        }
      } catch (error) {
        console.log('No daemon running')
      }
      return

    } else if (daemonSubcommand === 'stop-session') {
      const sessionId = args[2]
      if (!sessionId) {
        console.error('Session ID required')
        process.exit(1)
      }

      try {
        const success = await stopDaemonSession(sessionId)
        console.log(success ? 'Session stopped' : 'Failed to stop session')
      } catch (error) {
        console.log('No daemon running')
      }
      return

    } else if (daemonSubcommand === 'start') {
      // Optional preset name (e.g. `happy daemon start saycode`) resolves to
      // HAPPY_APLUS_MCP_CONFIG_URL so it doesn't need to be exported by hand.
      // An explicitly set env var always wins over the preset.
      let daemonEnv = process.env
      const mcpConfigPreset = args[2]
      if (mcpConfigPreset && !process.env.HAPPY_APLUS_MCP_CONFIG_URL) {
        const presetUrl = resolveMcpConfigPresetUrl(mcpConfigPreset)
        if (!presetUrl) {
          console.error(`Unknown mcp-config preset: ${mcpConfigPreset}`)
          process.exit(1)
        }
        daemonEnv = { ...process.env, HAPPY_APLUS_MCP_CONFIG_URL: presetUrl }
      }
      daemonEnv = await resolveDaemonMcpConfigEnvironment(daemonEnv, { persistExplicit: true })

      // Spawn detached daemon process.
      // stdio is captured, never ignored: if start-sync dies before its logger
      // is up it leaves no daemon log at all, and its stderr is then the only
      // record of why. On 2026-08-25 that output was discarded, this branch
      // printed "Failed to start daemon", and the machine sat without a daemon
      // for six hours with nothing to diagnose.
      const child = spawnHappyCLI(['daemon', 'start-sync'], {
        detached: true,
        stdio: captureSpawnOutputStdio('daemon-start-sync.log', `daemon start from pid ${process.pid}`),
        env: daemonEnv
      });
      let childExited = false;
      child.once('exit', () => { childExited = true });
      child.unref();

      // Wait until the daemon is up or start-sync has exited. A fixed 5s failed a slow Windows PC
      // whose daemon wrote its state at 6.9s; 25s stays inside startDetachedHappyCLI's 30s.
      const started = await waitForDaemonStart({
        isRunning: checkIfDaemonRunningAndCleanupStaleState,
        childExited: () => childExited,
        now: () => Date.now(),
        sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      }, { timeoutMs: 25_000, pollMs: 100 }) === 'started';

      if (started) {
        console.log('Daemon started successfully');
      } else {
        console.error('Failed to start daemon');
        process.exit(1);
      }
      process.exit(0);
    } else if (daemonSubcommand === 'preflight') {
      await preflightDaemonControlServer()
      process.exit(0)
    } else if (daemonSubcommand === 'start-sync') {
      const daemonEnv = await resolveDaemonMcpConfigEnvironment(process.env, { persistExplicit: true })
      if (daemonEnv.HAPPY_APLUS_MCP_CONFIG_URL) {
        process.env.HAPPY_APLUS_MCP_CONFIG_URL = daemonEnv.HAPPY_APLUS_MCP_CONFIG_URL
      }
      await startDaemon()
      process.exit(0)
    } else if (daemonSubcommand === 'stop') {
      await stopDaemon()
      process.exit(0)
    } else if (daemonSubcommand === 'status') {
      await runDoctorDaemon()
      process.exit(0)
    } else if (daemonSubcommand === 'logs') {
      // Simply print the path to the latest daemon log file
      const latest = await getLatestDaemonLog()
      if (!latest) {
        console.log('No daemon logs found')
      } else {
        console.log(latest.path)
      }
      process.exit(0)
    } else if (daemonSubcommand === 'install') {
      try {
        await install()
      } catch (error) {
        console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
        process.exit(1)
      }
    } else if (daemonSubcommand === 'uninstall') {
      try {
        await uninstall()
      } catch (error) {
        console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
        process.exit(1)
      }
    } else {
      console.log(`
${chalk.bold('happy daemon')} - Daemon management

${chalk.bold('Usage:')}
  happy daemon start [preset]     Start the daemon (detached). Optional preset
                                   (e.g. "saycode") sets HAPPY_APLUS_MCP_CONFIG_URL.
  happy daemon stop                Stop the daemon (sessions stay alive)
  happy daemon status              Show daemon status
  happy daemon list                List active sessions

  If you want to kill all happy related processes run
  ${chalk.cyan('happy doctor clean')}

${chalk.bold('Note:')} The daemon runs in the background and manages Claude sessions.

${chalk.bold('To clean up runaway processes:')} Use ${chalk.cyan('happy doctor clean')}
`)
    }
    return;
  } else {

    // If the first argument is claude, remove it
    if (args.length > 0 && args[0] === 'claude') {
      args.shift()
    }

    // Parse command line arguments for main command
    const options: StartOptions = {}
    let showHelp = false
    let showVersion = false
    let chromeOverride: boolean | undefined = undefined  // Track explicit --chrome or --no-chrome
    const unknownArgs: string[] = [] // Collect unknown args to pass through to claude
    const parsedSandboxFlag = extractNoSandboxFlag(args)
    options.noSandbox = parsedSandboxFlag.noSandbox
    args.length = 0
    args.push(...parsedSandboxFlag.args)

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]

      if (arg === '-h' || arg === '--help') {
        showHelp = true
        // Also pass through to claude
        unknownArgs.push(arg)
      } else if (arg === '-v' || arg === '--version') {
        showVersion = true
      } else if (arg === '--happy-starting-mode') {
        options.startingMode = z.enum(['local', 'remote']).parse(args[++i])
      } else if (arg === '--yolo') {
        // Shortcut for --dangerously-skip-permissions
        unknownArgs.push('--dangerously-skip-permissions')
      } else if (arg === '--model') {
        options.model = args[++i]
      } else if (arg === '--started-by') {
        options.startedBy = args[++i] as 'daemon' | 'terminal'
      } else if (arg === '--js-runtime') {
        const runtime = args[++i]
        if (runtime !== 'node' && runtime !== 'bun') {
          console.error(chalk.red(`Invalid --js-runtime value: ${runtime}. Must be 'node' or 'bun'`))
          process.exit(1)
        }
        options.jsRuntime = runtime
      } else if (arg === '--claude-env') {
        // Parse KEY=VALUE environment variable to pass to Claude
        const envArg = args[++i]
        if (envArg && envArg.includes('=')) {
          const eqIndex = envArg.indexOf('=')
          const key = envArg.substring(0, eqIndex)
          const value = envArg.substring(eqIndex + 1)
          options.claudeEnvVars = options.claudeEnvVars || {}
          options.claudeEnvVars[key] = value
        } else {
          console.error(chalk.red(`Invalid --claude-env format: ${envArg}. Expected KEY=VALUE`))
          process.exit(1)
        }
      } else if (arg === '--chrome') {
        chromeOverride = true
        // We'll add --chrome to claudeArgs after resolving settings default
      } else if (arg === '--no-chrome') {
        chromeOverride = false
        // Happy-specific flag to disable chrome even if default is on
      } else if (arg === '--settings') {
        // Intercept --settings flag - Happy uses this internally for session hooks
        const settingsValue = args[++i] // consume the value
        console.warn(chalk.yellow(`⚠️  Warning: --settings is used internally by Happy for session tracking.`))
        console.warn(chalk.yellow(`   Your settings file "${settingsValue}" will be ignored.`))
        console.warn(chalk.yellow(`   To configure Claude, edit ~/.claude/settings.json instead.`))
        // Don't pass through to claudeArgs
      } else {
        // Pass unknown arguments through to claude
        unknownArgs.push(arg)
        // Check if this arg expects a value (simplified check for common patterns)
        if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
          unknownArgs.push(args[++i])
        }
      }
    }

    // Add unknown args to claudeArgs
    if (unknownArgs.length > 0) {
      options.claudeArgs = [...(options.claudeArgs || []), ...unknownArgs]
    }

    // Resolve Chrome mode: explicit flag > settings > false
    const settings = await readSettings()
    const chromeEnabled = chromeOverride ?? settings.chromeMode ?? false
    if (chromeEnabled) {
      options.claudeArgs = [...(options.claudeArgs || []), '--chrome']
    }

    // Show help
    //
    // Contract with aplus-dev-studio web-ui: it greps this output for the
    // literal "happy grok" to decide whether a machine can spawn Grok at all
    // (packages/web-ui/src/lib/sync/agentLoginProbe.ts). Daemons predating
    // Grok support reject the agent with "Unsupported agent type", so the
    // picker hides Grok when the substring is missing. Reflowing or renaming
    // that line silently removes Grok from the session picker.
    if (showHelp) {
      console.log(`
${chalk.bold('happy')} - Claude Code On the Go

${chalk.bold('Usage:')}
  happy [options]         Start Claude with mobile control
  happy auth              Manage authentication
  happy resume            Resume a previous Happy session by Happy session ID
  happy codex             Start Codex mode
  happy gemini            Start Gemini mode (ACP)
  happy grok              Start Grok mode (ACP)
  happy acp               Start a generic ACP-compatible agent
  happy connect           Connect AI vendor API keys
  happy sandbox           Configure and manage OS-level sandboxing
  happy browser           Pair the Chrome extension that lets a session
                            drive your logged-in browser
  happy notify            Send push notification
  happy daemon            Manage background service that allows
                            to spawn new sessions away from your computer
  happy doctor            System diagnostics & troubleshooting

${chalk.bold('Examples:')}
  happy                    Start session
  happy resume cmmij8      Resume a previous session by Happy session ID
  happy --yolo             Start with bypassing permissions
                            happy sugar for --dangerously-skip-permissions
  happy --chrome           Enable Chrome browser access for this session
  happy --no-chrome        Disable Chrome even if default is on
  happy --no-sandbox       Disable Happy sandbox for this session
  happy --js-runtime bun   Use bun instead of node to spawn Claude Code
  happy --claude-env ANTHROPIC_BASE_URL=http://127.0.0.1:3456
                           Use a custom API endpoint (e.g., claude-code-router)
  happy grok -m grok-4.6   Start Grok on a specific model
  happy acp gemini         Start Gemini via generic ACP runner
  happy acp -- opencode --acp
                           Start a custom ACP command
  happy acp opencode --verbose
                           Print raw ACP backend/envelope events
  happy auth login --force Authenticate
  happy doctor             Run diagnostics

${chalk.bold('Happy supports ALL Claude options!')}
  Use any claude flag with happy as you would with claude. Our favorite:

  happy --resume

${chalk.gray('─'.repeat(60))}
${chalk.bold.cyan('Claude Code Options (from `claude --help`):')}
`)

      // Run claude --help and display its output
      // Use execFileSync directly with claude CLI for runtime-agnostic compatibility
      try {
        const claudeHelp = execFileSync(claudeCliPath, ['--help'], { encoding: 'utf8', windowsHide: true })
        console.log(claudeHelp)
      } catch (e) {
        console.log(chalk.yellow('Could not retrieve claude help. Make sure claude is installed.'))
      }

      process.exit(0)
    }

    // Show version
    if (showVersion) {
      console.log(`happy version: ${packageJson.version}`)
      process.exit(0)
    }

    // A managed Cloud spawn brings its own session and a bearer scoped to it.
    // It authenticates no account, registers no machine, and starts no daemon:
    // there is no local user here, and the runtime it runs inside is what the
    // control plane already knows about.
    // Captured by index.ts before provider modules loaded; only a daemon launch carries one.
    const standaloneLaunch = takeStandaloneLaunchBootstrap(process.env);
    const managed = await readManagedStartup(process.env, Date.now(), configuration.serverUrl);
    if (managed && standaloneLaunch) {
      console.error(chalk.red('Error:'), 'Managed runtime cannot adopt a standalone launch')
      process.exit(1)
    }
    if (managed) {
      /*
       * The arguments this process was started with, against the plan that was
       * approved for it.
       *
       * Checked here rather than in the image entry: bundling that check into
       * the image entry splits it into a sibling chunk the image does not
       * install, and the runtime then fails on a missing module instead of on a
       * bad plan. The plan's own policy stays where it is; this is the place
       * that can see what actually reached `argv`.
       */
      assertProviderExecArguments(process.argv.slice(2), process.env);
      try {
        /*
         * The agent the envelope was approved and billed for.
         *
         * Always starting Claude ran a Codex envelope on a different provider:
         * the model the parent priced, the gateway route it signed and the
         * capability it issued all say `codex`, and the process would have
         * talked to Anthropic. The envelope is the authority on which of the
         * two this is.
         */
        if (managed.envelope.agent === 'codex') {
          // Codex takes one object: the principal and the start options are
          // fields on it, not two arguments.
          await runCodex({
            principal: { kind: 'managed', startup: managed },
            ...(options.startedBy ? { startedBy: options.startedBy } : {}),
            ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
          });
        } else {
          await runClaude({ kind: 'managed', startup: managed }, options);
        }
      } catch (error) {
        console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
        process.exit(1)
      }
      return;
    }

    // Normal flow - auth and machine setup
    const {
      credentials
    } = await authAndSetupMachineIfNeeded();
    await ensureDaemonRunning()

    // Start the CLI
    try {
      await runClaude({ kind: 'account', credentials }, standaloneLaunch ? { ...options, standaloneLaunch } : options);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
  }
})();


/**
 * Handle notification command
 */
async function handleNotifyCommand(args: string[]): Promise<void> {
  let message = ''
  let title = ''
  let showHelp = false

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '-p' && i + 1 < args.length) {
      message = args[++i]
    } else if (arg === '-t' && i + 1 < args.length) {
      title = args[++i]
    } else if (arg === '-h' || arg === '--help') {
      showHelp = true
    } else {
      console.error(chalk.red(`Unknown argument for notify command: ${arg}`))
      process.exit(1)
    }
  }

  if (showHelp) {
    console.log(`
${chalk.bold('happy notify')} - Send notification

${chalk.bold('Usage:')}
  happy notify -p <message> [-t <title>]    Send notification with custom message and optional title
  happy notify -h, --help                   Show this help

${chalk.bold('Options:')}
  -p <message>    Notification message (required)
  -t <title>      Notification title (optional, defaults to "Happy")

${chalk.bold('Examples:')}
  happy notify -p "Deployment complete!"
  happy notify -p "System update complete" -t "Server Status"
  happy notify -t "Alert" -p "Database connection restored"
`)
    return
  }

  if (!message) {
    console.error(chalk.red('Error: Message is required. Use -p "your message" to specify the notification text.'))
    console.log(chalk.gray('Run "happy notify --help" for usage information.'))
    process.exit(1)
  }

  // Load credentials
  let credentials = await readCredentials()
  if (!credentials) {
    console.error(chalk.red('Error: Not authenticated. Please run "happy auth login" first.'))
    process.exit(1)
  }

  console.log(chalk.blue('📱 Sending push notification...'))

  try {
    // Create API client and send push notification
    const api = await ApiClient.create(credentials);

    // Use custom title or default to "Happy"
    const notificationTitle = title || 'Happy'

    // Send the push notification
    api.push().sendToAllDevices(
      notificationTitle,
      message,
      {
        source: 'cli',
        timestamp: Date.now()
      }
    )

    console.log(chalk.green('✓ Push notification sent successfully!'))
    console.log(chalk.gray(`  Title: ${notificationTitle}`))
    console.log(chalk.gray(`  Message: ${message}`))
    console.log(chalk.gray('  Check your mobile device for the notification.'))

    // Give a moment for the async operation to start
    await new Promise(resolve => setTimeout(resolve, 1000))

  } catch (error) {
    console.error(chalk.red('✗ Failed to send push notification'))
    throw error
  }
}
