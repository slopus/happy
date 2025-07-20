#!/usr/bin/env node

/**
 * CLI entry point for happy command
 * 
 * Simple argument parsing without any CLI framework dependencies
 */


import chalk from 'chalk'
import { start } from '@/ui/start'
import { existsSync, rmSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { initializeConfiguration, configuration } from '@/configuration'
import { initLoggerWithGlobalConfiguration, logger } from './ui/logger'
import { readCredentials } from './persistence/persistence'
import { doAuth } from './ui/auth'

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
  } else if (subcommand === 'login' || subcommand === 'auth') {
    await doAuth();
    return;
  } else {
    // Parse command line arguments for main command
    const options: Record<string, string> = {}
    let showHelp = false
    let showVersion = false

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]

      if (arg === '-h' || arg === '--help') {
        showHelp = true
      } else if (arg === '-v' || arg === '--version') {
        showVersion = true
      } else if (arg === '-m' || arg === '--model') {
        options.model = args[++i]
      } else if (arg === '-p' || arg === '--permission-mode') {
        options.permissionMode = args[++i]
      } else if (arg === '--local') {
        // Already processed, skip the next arg
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
  happy login      Show your secret QR code
  happy auth       Same as login

${chalk.bold('Options:')}
  -h, --help              Show this help message
  -v, --version           Show version
  -m, --model <model>     Claude model to use (default: sonnet)
  -p, --permission-mode   Permission mode: auto, default, or plan

  [Advanced]
  --local < global | local >
      Will use .happy folder in the current directory for storing your private key and debug logs. 
      You will require re-login each time you run this in a new directory.
      Use with login to show either global or local QR code.

${chalk.bold('Examples:')}
  happy                   Start a session with default settings
  happy -m opus           Use Claude Opus model
  happy -p plan           Use plan permission mode
  happy logout            Logs out of your account and removes data directory
`)
      process.exit(0)
    }

    // Show version
    if (showVersion) {
      console.log('0.1.3')
      process.exit(0)
    }

    // Load credentials
    let credentials = await readCredentials()
    if (!credentials) { // No credentials found, show onboarding
      let res = await doAuth();
      if (!res) {
        process.exit(1);
      }
      credentials = res;
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