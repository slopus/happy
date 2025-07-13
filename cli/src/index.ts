#!/usr/bin/env node

/**
 * CLI entry point for happy command
 * 
 * Simple argument parsing without any CLI framework dependencies
 */

import { start } from '@/ui/start'
import chalk from 'chalk'

const args = process.argv.slice(2)

// Parse command line arguments
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

${chalk.bold('Options:')}
  -h, --help              Show this help message
  -v, --version           Show version
  -m, --model <model>     Claude model to use (default: sonnet)
  -p, --permission-mode   Permission mode: auto, default, or plan

${chalk.bold('Examples:')}
  happy                   Start a session with default settings
  happy -m opus           Use Claude Opus model
  happy -p plan           Use plan permission mode
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