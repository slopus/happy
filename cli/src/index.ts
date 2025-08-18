#!/usr/bin/env node

/**
 * CLI entry point for happy command
 * 
 * Simple argument parsing without any CLI framework dependencies
 */


import chalk from 'chalk'
import { start, StartOptions } from '@/start'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { configuration } from '@/configuration'
import { logger } from './ui/logger'
import { readCredentials, readSettings, updateSettings } from './persistence/persistence'
import { doAuth, authAndSetupMachineIfNeeded } from './ui/auth'
import packageJson from '../package.json'
import { z } from 'zod'
import { spawn } from 'child_process'
import { startDaemon } from './daemon/run'
import { isDaemonRunning, stopDaemon } from './daemon/utils'
import { install } from './daemon/install'
import { uninstall } from './daemon/uninstall'
import { ApiClient } from './api/api'
import { runDoctorCommand } from './ui/doctor'
import { listDaemonSessions, stopDaemonSession } from './daemon/controlClient'
import { projectPath } from './projectPath'
import { handleAuthCommand } from './commands/auth'
import { clearCredentials, clearMachineId, writeCredentials } from './persistence/persistence'


(async () => {
  const args = process.argv.slice(2)

  logger.debug('Starting happy CLI with args: ', process.argv)

  // Check if first argument is a subcommand
  const subcommand = args[0]

  if (subcommand === 'doctor') {
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
          console.log('No active sessions')
        } else {
          console.log('Active sessions:')
          // Clean up session data for display
          const cleanSessions = sessions.map(s => ({
            pid: s.pid,
            sessionId: s.happySessionId || `PID-${s.pid}`,
            startedBy: s.startedBy,
            directory: s.happySessionMetadataFromLocalWebhook?.directory || 'unknown'
          }))
          console.log(JSON.stringify(cleanSessions, null, 2))
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
      // Spawn detached daemon process
      const happyBinPath = join(projectPath(), 'bin', 'happy.mjs');
      const child = spawn(happyBinPath, ['daemon', 'start-sync'], {
        detached: true,
        stdio: 'ignore',
        env: process.env
      });
      child.unref();

      // Wait for daemon to write state file (up to 5 seconds)
      let started = false;
      for (let i = 0; i < 50; i++) {
        if (await isDaemonRunning()) {
          started = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      if (started) {
        console.log('Daemon started successfully');
      } else {
        console.error('Failed to start daemon');
        process.exit(1);
      }
      process.exit(0);
    } else if (daemonSubcommand === 'start-sync') {
      // This is the actual synchronous daemon start (called by detached process)
      await startDaemon()
      process.exit(0)
    } else if (daemonSubcommand === 'stop') {
      await stopDaemon()
      process.exit(0)
    } else if (daemonSubcommand === 'kill-runaway') {
      const { killRunawayHappyProcesses } = await import('./daemon/utils')
      const result = await killRunawayHappyProcesses()
      console.log(`Killed ${result.killed} runaway processes`)
      if (result.errors.length > 0) {
        console.log('Errors:', result.errors)
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
  happy daemon start            Start the daemon (detached)
  happy daemon start-sync       Start the daemon (synchronous, for internal use)
  happy daemon stop             Stop the daemon
  happy daemon list             List active sessions
  happy daemon stop-session <id>  Stop a specific session
  happy daemon kill-runaway     Kill all runaway Happy processes
  sudo happy daemon install     Install the daemon (requires sudo)
  sudo happy daemon uninstall   Uninstall the daemon (requires sudo)

${chalk.bold('Note:')} The daemon runs in the background and provides persistent services.
Installation is only supported on macOS.
`)
    }
    return;
  } else {
    // Parse command line arguments for main command
    const options: StartOptions = {}
    let showHelp = false
    let showVersion = false
    let forceAuth = false
    let forceAuthNew = false // New --force-auth flag

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]

      if (arg === '-h' || arg === '--help') {
        showHelp = true
      } else if (arg === '-v' || arg === '--version') {
        showVersion = true
      } else if (arg === '--auth' || arg === '--login') {
        // Keep for backward compatibility
        forceAuth = true
      } else if (arg === '--force-auth') {
        // New flag that properly clears everything
        forceAuthNew = true
      } else if (arg === '-m' || arg === '--model') {
        options.model = args[++i]
      } else if (arg === '-p' || arg === '--permission-mode') {
        // Use zod to validate the permission mode
        options.permissionMode = z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan']).parse(args[++i])
      } else if (arg === '--happy-starting-mode') {
        options.startingMode = z.enum(['local', 'remote']).parse(args[++i])
      } else if (arg === '--claude-env') {
        // Format: --claude-env KEY=VALUE
        const envVar = args[++i]
        const [key, value] = envVar.split('=', 2)
        if (!key || value === undefined) {
          console.error(chalk.red(`Invalid environment variable format: ${envVar}. Use KEY=VALUE`))
          process.exit(1)
        }
        options.claudeEnvVars = { ...options.claudeEnvVars, [key]: value }
      } else if (arg === '--claude-arg') {
        // Pass additional arguments to Claude CLI
        const claudeArg = args[++i]
        options.claudeArgs = [...(options.claudeArgs || []), claudeArg]
      } else if (arg === '--started-by') {
        options.startedBy = args[++i] as 'daemon' | 'terminal'
      } else {
        console.error(chalk.red(`Unknown argument: ${arg}`))
        process.exit(1)
      }
    }

    // Show help
    if (showHelp) {
      console.log(`
${chalk.bold('happy')} - Claude Code On the Go

${chalk.bold('Usage:')}
  happy [options]
  happy auth       Manage authentication
  happy notify     Send notification
  happy daemon     Manage the background daemon (macOS only)

${chalk.bold('Options:')}
  -h, --help              Show this help message
  -v, --version           Show version
  -m, --model <model>     Claude model to use (default: sonnet)
  -p, --permission-mode   Permission mode: default, acceptEdits, bypassPermissions, or plan
  --auth, --login         Re-authenticate (deprecated, use 'happy auth login')
  --force-auth            Force complete re-authentication (clears all data)
  --claude-env KEY=VALUE  Set environment variable for Claude Code
  --claude-arg ARG        Pass additional argument to Claude CLI


  [Advanced]
  --happy-starting-mode <local|remote>
      Set the starting mode for new sessions (default: remote)

${chalk.bold('Examples:')}
  happy                   Start a session with default settings
  happy -m opus           Use Claude Opus model
  happy -p plan           Use plan permission mode
  happy --force-auth      Force complete re-authentication
  happy auth login        Authenticate or check auth status
  happy auth show-backup  Get backup key for linking devices
  happy notify -p "Hello!"  Send notification
  happy --claude-env KEY=VALUE
                          Set environment variable for Claude Code
  happy --claude-arg --option
                          Pass argument to Claude CLI
  happy auth logout       Log out and remove authentication

${chalk.bold('Happy is a wrapper around Claude Code that enables remote control via mobile app.')}
${chalk.bold('Use "happy daemon" for background service management.')}
`)
      process.exit(0)
    }

    // Show version
    if (showVersion) {
      console.log(packageJson.version)
      process.exit(0)
    }

    // Ensure authentication and machine setup
    let credentials;

    if (forceAuthNew) {
      // New --force-auth flag: clear everything first as requested
      console.log(chalk.yellow('Force authentication requested...'));

      // Stop daemon if running
      try {
        await stopDaemon();
      } catch { }

      // Clear credentials and machine ID
      await clearCredentials();
      await clearMachineId();

      // Now do normal auth flow which will re-auth and setup machine
      const result = await authAndSetupMachineIfNeeded();
      credentials = result.credentials;

    } else if (forceAuth) {
      // Old --auth flag - fix the bug where it skipped machine setup
      console.log(chalk.yellow('Note: --auth is deprecated. Use "happy auth login" or --force-auth instead.\n'));

      // The bug was that doAuth() only returned credentials without setting up machine
      // Fix: Always ensure machine setup even with old --auth flag
      const res = await doAuth();
      if (!res) {
        process.exit(1);
      }
      // Save credentials then run full setup to ensure machine ID is created
      await writeCredentials(res);
      const result = await authAndSetupMachineIfNeeded();
      credentials = result.credentials;

    } else {
      // Normal flow - auth and machine setup
      const result = await authAndSetupMachineIfNeeded();
      credentials = result.credentials;
    }

    // Daemon auto-start preference (machine already set up)
    let settings = await readSettings();
    if (settings && settings.daemonAutoStartWhenRunningHappy === undefined) {

      console.log(chalk.cyan('\n🚀 Happy Daemon Setup\n'));
      // Ask about daemon auto-start
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout
      });

      console.log(chalk.cyan('\n📱 Happy can run a background service that allows you to:'));
      console.log(chalk.cyan('  • Spawn new conversations from your phone'));
      console.log(chalk.cyan('  • Continue closed conversations remotely'));
      console.log(chalk.cyan('  • Work with Claude while your computer has internet\n'));

      const answer = await new Promise<string>((resolve) => {
        rl.question(chalk.green('Would you like Happy to start this service automatically? (recommended) [Y/n]: '), resolve);
      });
      rl.close();

      const shouldAutoStart = answer.toLowerCase() !== 'n';

      settings = await updateSettings(settings => ({
        ...settings,
        daemonAutoStartWhenRunningHappy: shouldAutoStart
      }));

      if (shouldAutoStart) {
        console.log(chalk.green('✓ Happy will start the background service automatically'));
        console.log(chalk.gray('  The service will run whenever you use the happy command'));
      } else {
        console.log(chalk.yellow('  You can enable this later by running: happy daemon install'));
      }
    }

    // Auto-start daemon if enabled
    if (settings && settings.daemonAutoStartWhenRunningHappy) {
      logger.debug('Starting Happy background service...');

      if (!(await isDaemonRunning())) {
        // Use the built binary to spawn daemon
        const happyBinPath = join(projectPath(), 'bin', 'happy.mjs');

        const daemonProcess = spawn(happyBinPath, ['daemon', 'start-sync'], {
          detached: true,
          stdio: 'ignore',
          env: process.env
        })
        daemonProcess.unref();

        // Give daemon a moment to write PID file
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    // Start the CLI
    try {
      await start(credentials, options);
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
 * Clean subcommand - remove the happy data directory after confirmation
 */
async function cleanKey(): Promise<void> {
  const happyDir = configuration.happyHomeDir

  // Check if happy directory exists
  if (!existsSync(happyDir)) {
    console.log(chalk.yellow('No happy data directory found at:'), happyDir)
    return
  }

  console.log(chalk.blue('Found happy data directory at:'), happyDir)
  console.log(chalk.yellow('⚠️  This will remove all authentication data and require reconnecting your phone.'))

  // Ask for confirmation
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  })

  const answer = await new Promise<string>((resolve) => {
    rl.question(chalk.yellow('Are you sure you want to remove the happy data directory? (y/N): '), resolve)
  })

  rl.close()

  if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
    try {
      rmSync(happyDir, { recursive: true, force: true })
      console.log(chalk.green('✓ Happy data directory removed successfully'))
      console.log(chalk.blue('ℹ️  You will need to reconnect your phone on the next session'))
    } catch (error) {
      throw new Error(`Failed to remove data directory: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  } else {
    console.log(chalk.blue('Operation cancelled'))
  }
}

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
    console.error(chalk.red('Error: Not authenticated. Please run "happy --auth" first.'))
    process.exit(1)
  }

  console.log(chalk.blue('📱 Sending push notification...'))

  try {
    // Create API client and send push notification
    const api = new ApiClient(credentials.token, credentials.secret)

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