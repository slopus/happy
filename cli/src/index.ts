#!/usr/bin/env node

/**
 * CLI entry point for happy command
 * 
 * Simple argument parsing without any CLI framework dependencies
 */


import chalk from 'chalk'
import { start, StartOptions } from '@/ui/start'
import { existsSync, rmSync } from 'node:fs'
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

  initializeConfiguration(installationLocation)
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
        // Already processed, skip the next arg
        i++
      } else if (arg === '--happy-starting-mode') {
        options.startingMode = z.enum(['local', 'remote']).parse(args[++i])
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

${chalk.bold('Examples:')}
  happy                   Start a session with default settings
  happy -m opus           Use Claude Opus model
  happy -p plan           Use plan permission mode
  happy --auth            Force re-authentication before starting session
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
    if (settings.daemonAutoStartWhenRunningHappy === undefined) {

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
    if (settings.daemonAutoStartWhenRunningHappy) {
      console.log('Starting Happy background service...');
      if (!(await isDaemonRunning())) {
        console.log('Not running, starting...');
        // Make sure to start detached
        const happyPath = process.argv[1];
        const daemonProcess = spawn('node', [happyPath, 'daemon', 'start'], {
          detached: true,
          stdio: 'ignore',
          env: process.env,
        });
        daemonProcess.unref();
        console.log('Starting Happy background service... with pid: ', daemonProcess.pid);
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