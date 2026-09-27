#!/usr/bin/env node

/**
 * Lightweight CLI bootstrap. Agent commands must be dispatched before loading
 * the Happy runtime because provider modules have import-time side effects.
 */
import { captureStandaloneLaunchBootstrap } from './daemon/standaloneLaunchProtocol'
import { handleAgentCommand } from './commands/agentCommand'

const args = process.argv.slice(2)
try { captureStandaloneLaunchBootstrap(process.env, args[0]) }
catch { console.error('Invalid standalone launch bootstrap'); process.exit(1) }

if (args[0] === 'agent') {
  try {
    process.exit(handleAgentCommand(args.slice(1)))
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : 'Unknown error')
    process.exit(1)
  }
} else if (args[0] === 'difficulty-routing-worker') {
  void import('./daemon/difficultyRoutingWorkerProcess')
} else {
  void import('./main')
}
