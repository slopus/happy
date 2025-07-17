#!/usr/bin/env node

/**
 * CLI entry point for happy command
 * 
 * Simple argument parsing without any CLI framework dependencies
 */

import { start } from '@/ui/start'
import chalk from 'chalk'
import { existsSync, unlinkSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)

// Check if first argument is a subcommand
const subcommand = args[0]

if (subcommand === 'clean') {
  cleanKey().catch((error: Error) => {
    console.error(chalk.red('Error:'), error.message)
    if (process.env.DEBUG) {
      console.error(error)
    }
    process.exit(1)
  })
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
  happy clean             Remove happy data directory (requires phone reconnection)

${chalk.bold('Options:')}
  -h, --help              Show this help message
  -v, --version           Show version
  -m, --model <model>     Claude model to use (default: sonnet)
  -p, --permission-mode   Permission mode: auto, default, or plan

${chalk.bold('Examples:')}
  happy                   Start a session with default settings
  happy -m opus           Use Claude Opus model
  happy -p plan           Use plan permission mode
  happy clean             Remove happy data directory and authentication
`)
    process.exit(0)
  }

  // Show version
  if (showVersion) {
    console.log('0.1.0')
    process.exit(0)
  }

  // Start the CLI
  start(options).catch((error: Error) => {
    console.error(chalk.red('Error:'), error.message)
    if (process.env.DEBUG) {
      console.error(error)
    }
    process.exit(1)
  })
}

/**
 * Clean subcommand - remove the happy data directory after confirmation
 */
async function cleanKey(): Promise<void> {
  const handyDir = join(homedir(), '.handy')

  // Check if handy directory exists
  if (!existsSync(handyDir)) {
    console.log(chalk.yellow('No happy data directory found at:'), handyDir)
    return
  }

  console.log(chalk.blue('Found happy data directory at:'), handyDir)
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
      rmSync(handyDir, { recursive: true, force: true })
      console.log(chalk.green('✓ Happy data directory removed successfully'))
      console.log(chalk.blue('ℹ️  You will need to reconnect your phone on the next session'))
    } catch (error) {
      throw new Error(`Failed to remove data directory: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  } else {
    console.log(chalk.blue('Operation cancelled'))
  }
}