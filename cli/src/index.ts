#!/usr/bin/env node

/**
 * CLI entry point for happy command
 * 
 * Simple argument parsing without any CLI framework dependencies
 */


import chalk from 'chalk'
import { start, StartOptions } from '@/ui/start'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { initializeConfiguration, configuration } from '@/configuration'
import { initLoggerWithGlobalConfiguration, logger } from './ui/logger'
import { readCredentials, readSettings, writeSettings } from './persistence/persistence'
import { doAuth } from './ui/auth'
import packageJson from '../package.json'
import { z } from 'zod'
import { spawn } from 'child_process'
import { startDaemon, isDaemonRunning, stopDaemon } from './daemon/run'
import { install } from './daemon/install'
import { uninstall } from './daemon/uninstall'

(async () => {

  const args = process.argv.slice(2)

  // Parse global options first
  let installationLocation: 'global' | 'local'
    = (args.includes('--local') || process.env.HANDY_LOCAL) ? 'local' : 'global'
  
  // Parse server URL if provided
  let serverUrl: string | undefined
  const serverUrlIndex = args.indexOf('--happy-server-url')
  if (serverUrlIndex !== -1 && serverUrlIndex + 1 < args.length) {
    serverUrl = args[serverUrlIndex + 1]
  }

  initializeConfiguration(installationLocation, serverUrl)
  initLoggerWithGlobalConfiguration()

  logger.debug('Starting happy CLI with args: ', process.argv)

  // Check if first argument is a subcommand
  const subcommand = args[0]

  if (subcommand === 'logout') {
    try {
      await cleanKey();
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
    if (daemonSubcommand === 'start') {
      await startDaemon()
      process.exit(0)
    } else if (daemonSubcommand === 'stop') {
      await stopDaemon()
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
  happy daemon start            Start the daemon
  happy daemon stop             Stop the daemon
  sudo happy daemon install     Install the daemon (requires sudo)
  sudo happy daemon uninstall   Uninstall the daemon (requires sudo)

${chalk.bold('Note:')} The daemon runs in the background and provides persistent services.
Currently only supported on macOS.
`)
      }
    return;
  } else {
    // Parse command line arguments for main command
    const options: StartOptions = {}
    let showHelp = false
    let showVersion = false
    let forceAuth = false

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]

      if (arg === '-h' || arg === '--help') {
        showHelp = true
      } else if (arg === '-v' || arg === '--version') {
        showVersion = true
      } else if (arg === '--auth' || arg === '--login') {
        forceAuth = true
      } else if (arg === '-m' || arg === '--model') {
        options.model = args[++i]
      } else if (arg === '-p' || arg === '--permission-mode') {
        // Use zod to validate the permission mode
        options.permissionMode = z.enum(['auto', 'default', 'plan']).parse(args[++i])
      } else if (arg === '--local') {
        // Already processed, skip
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
      } else if (arg === '--daemon-spawn') {
        options.daemonSpawn = true
      } else if (arg === '--happy-server-url') {
        // Already processed in global options, skip the value
        i++
      } else {
        console.error(chalk.red(`Unknown argument: ${arg}`))
        process.exit(1)
      }
    }

    // Show help
    if (showHelp) {
      console.log(`
${chalk.bold('happy')} - Claude Code session sharing

${chalk.bold('Usage:')}
  happy [options]
  happy logout     Logs out of your account and removes data directory
  happy daemon     Manage the background daemon (macOS only)

${chalk.bold('Options:')}
  -h, --help              Show this help message
  -v, --version           Show version
  -m, --model <model>     Claude model to use (default: sonnet)
  -p, --permission-mode   Permission mode: auto, default, or plan
  --auth, --login         Force re-authentication
  --claude-env KEY=VALUE  Set environment variable for Claude Code
  --claude-arg ARG        Pass additional argument to Claude CLI

  [Daemon Management]
  --happy-daemon-start    Start the daemon in background
  --happy-daemon-stop     Stop the daemon
  --happy-daemon-install  Install daemon to run on startup
  --happy-daemon-uninstall  Uninstall daemon from startup

  [Advanced]
  --local < global | local >
      Will use .happy folder in the current directory for storing your private key and debug logs. 
      You will require re-login each time you run this in a new directory.
  --happy-starting-mode <interactive|remote>
      Set the starting mode for new sessions (default: remote)
  --happy-server-url <url>
      Set the server URL (overrides HANDY_SERVER_URL environment variable)

${chalk.bold('Examples:')}
  happy                   Start a session with default settings
  happy -m opus           Use Claude Opus model
  happy -p plan           Use plan permission mode
  happy --auth            Force re-authentication before starting session
  happy --claude-env KEY=VALUE
                          Set environment variable for Claude Code
  happy --claude-arg --option
                          Pass argument to Claude CLI
  happy logout            Logs out of your account and removes data directory
`)
      process.exit(0)
    }

    // Show version
    if (showVersion) {
      console.log(packageJson.version)
      process.exit(0)
    }

    // Load credentials
    let credentials = await readCredentials()
    if (!credentials || forceAuth) { // No credentials found or force auth requested
      let res = await doAuth();
      if (!res) {
        process.exit(1);
      }
      credentials = res;
    }

    // Onboarding flow for daemon installation
    const settings = await readSettings() || { onboardingCompleted: false };
    const experimentalFeatures = process.env.EXPERIMENTAL_FEATURES === '1' || process.env.EXPERIMENTAL_FEATURES === 'true';
    if (experimentalFeatures && settings.daemonAutoStartWhenRunningHappy === undefined) {

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
      settings.daemonAutoStartWhenRunningHappy = shouldAutoStart;
      
      if (shouldAutoStart) {
        console.log(chalk.green('✓ Happy will start the background service automatically'));
        console.log(chalk.gray('  The service will run whenever you use the happy command'));
      } else {
        console.log(chalk.yellow('  You can enable this later by running: happy daemon install'));
      }
      
      await writeSettings(settings);
    }

    // Auto-start daemon if enabled
    if (experimentalFeatures && settings.daemonAutoStartWhenRunningHappy) {
      console.log('Starting Happy background service...');
      
      if (!(await isDaemonRunning())) {
        // Make sure to start detached
        const happyPath = process.argv[1];
        
        // When running with tsx, happyPath is the TypeScript file
        // When running the built binary, happyPath is the binary itself
        // We need to determine which case we're in
        const isBuiltBinary = happyPath.endsWith('/bin/happy') || happyPath.endsWith('\\bin\\happy');
        
        // Build daemon args
        const daemonArgs = ['daemon', 'start'];
        if (serverUrl) {
          daemonArgs.push('--happy-server-url', serverUrl);
        }
        if (installationLocation === 'local') {
          daemonArgs.push('--local');
        }
        
        const daemonProcess = isBuiltBinary 
          ? spawn(happyPath, daemonArgs, {
              detached: true,
              stdio: ['ignore', 'inherit', 'inherit'], // Show stdout/stderr for debugging
              env: {
                ...process.env,
                HANDY_SERVER_URL: serverUrl || process.env.HANDY_SERVER_URL, // Pass through server URL
                HANDY_LOCAL: process.env.HANDY_LOCAL, // Pass through local flag
              },
            })
          : spawn('npx', ['tsx', happyPath, ...daemonArgs], {
              detached: true,
              stdio: ['ignore', 'inherit', 'inherit'], // Show stdout/stderr for debugging
              env: {
                ...process.env,
                HANDY_SERVER_URL: serverUrl || process.env.HANDY_SERVER_URL, // Pass through server URL
                HANDY_LOCAL: process.env.HANDY_LOCAL, // Pass through local flag
              },
            });
        daemonProcess.unref();
        
        // Give daemon a moment to write PID file
        await new Promise(resolve => setTimeout(resolve, 200));
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
  const happyDir = configuration.happyDir

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