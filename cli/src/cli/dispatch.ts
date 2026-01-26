import { execFileSync } from 'node:child_process';

import chalk from 'chalk';
import { z } from 'zod';

import { PERMISSION_MODES, isPermissionMode } from '@/api/types';
import { runClaude, StartOptions } from '@/claude/runClaude';
import { claudeCliPath } from '@/claude/claudeLocal';
import { isDaemonRunningCurrentlyInstalledHappyVersion } from '@/daemon/controlClient';
import { logger } from '@/ui/logger';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { runDoctorCommand } from '@/ui/doctor';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import packageJson from '../../package.json';
import type { TerminalRuntimeFlags } from '@/terminal/terminalRuntimeFlags';
import { commandRegistry } from '@/cli/commandRegistry';

export async function dispatchCli(params: Readonly<{
  args: string[];
  terminalRuntime: TerminalRuntimeFlags | null;
  rawArgv: string[];
}>): Promise<void> {
  const { args, terminalRuntime, rawArgv } = params;

  // If --version is passed - do not log, its likely daemon inquiring about our version
  if (!args.includes('--version')) {
    logger.debug('Starting happy CLI with args: ', rawArgv);
  }

  // Check if first argument is a subcommand
  const subcommand = args[0];

  // Headless tmux launcher (CLI flow)
  if (args.includes('--tmux')) {
    // If user is asking for help/version, don't start a session.
    if (args.includes('-h') || args.includes('--help') || args.includes('-v') || args.includes('--version')) {
      const idx = args.indexOf('--tmux');
      if (idx !== -1) args.splice(idx, 1);
    } else {
      const disallowed = new Set(['doctor', 'auth', 'connect', 'notify', 'daemon', 'install', 'uninstall', 'logout', 'attach']);
      if (subcommand && disallowed.has(subcommand)) {
        console.error(chalk.red('Error:'), '--tmux can only be used when starting a session.');
        process.exit(1);
      }

      try {
        const { startHappyHeadlessInTmux } = await import('@/terminal/startHappyHeadlessInTmux');
        await startHappyHeadlessInTmux(args);
      } catch (error) {
        console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
        if (process.env.DEBUG) {
          console.error(error)
        }
        process.exit(1)
      }
      return;
    }
  }
  const commandHandler = (subcommand ? commandRegistry[subcommand] : undefined);
  if (commandHandler) {
    await commandHandler({ args, rawArgv, terminalRuntime });
    return;
  }

  {

    // If the first argument is claude, remove it
    if (args.length > 0 && args[0] === 'claude') {
      args.shift()
    }

    // Parse command line arguments for main command
    const options: StartOptions = {}
    let showHelp = false
    let showVersion = false
    const unknownArgs: string[] = [] // Collect unknown args to pass through to claude

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]

      if (arg === '-h' || arg === '--help') {
        showHelp = true
        // Also pass through to claude
        unknownArgs.push(arg)
      } else if (arg === '-v' || arg === '--version') {
        showVersion = true
        // Also pass through to claude (will show after our version)
        unknownArgs.push(arg)
      } else if (arg === '--happy-starting-mode') {
        options.startingMode = z.enum(['local', 'remote']).parse(args[++i])
      } else if (arg === '--yolo') {
        // Shortcut for --dangerously-skip-permissions
        unknownArgs.push('--dangerously-skip-permissions')
	      } else if (arg === '--started-by') {
	        options.startedBy = args[++i] as 'daemon' | 'terminal'
	      } else if (arg === '--permission-mode') {
	        if (i + 1 >= args.length) {
	          console.error(chalk.red(`Missing value for --permission-mode. Valid values: ${PERMISSION_MODES.join(', ')}`))
	          process.exit(1)
	        }
	        const value = args[++i]
	        if (!isPermissionMode(value)) {
	          console.error(chalk.red(`Invalid --permission-mode value: ${value}. Valid values: ${PERMISSION_MODES.join(', ')}`))
	          process.exit(1)
	        }
	        options.permissionMode = value
	      } else if (arg === '--permission-mode-updated-at') {
	        if (i + 1 >= args.length) {
	          console.error(chalk.red('Missing value for --permission-mode-updated-at (expected: unix ms timestamp)'))
	          process.exit(1)
	        }
	        const raw = args[++i]
	        const parsedAt = Number(raw)
	        if (!Number.isFinite(parsedAt) || parsedAt <= 0) {
	          console.error(chalk.red(`Invalid --permission-mode-updated-at value: ${raw}. Expected a positive number (unix ms)`))
	          process.exit(1)
	        }
	        options.permissionModeUpdatedAt = Math.floor(parsedAt)
	      } else if (arg === '--js-runtime') {
	        const runtime = args[++i]
	        if (runtime !== 'node' && runtime !== 'bun') {
	          console.error(chalk.red(`Invalid --js-runtime value: ${runtime}. Must be 'node' or 'bun'`))
	          process.exit(1)
	        }
        options.jsRuntime = runtime
      } else if (arg === '--existing-session') {
        // Used by daemon to reconnect to an existing session (for inactive session resume)
        options.existingSessionId = args[++i]
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

    // Show help
    if (showHelp) {
      console.log(`
${chalk.bold('happy')} - Claude Code On the Go

${chalk.bold('Usage:')}
	  happy [options]         Start Claude with mobile control
	  happy auth              Manage authentication
	  happy codex             Start Codex mode
	  happy opencode          Start OpenCode mode (ACP)
	  happy gemini            Start Gemini mode (ACP)
  happy connect           Connect AI vendor API keys
  happy notify            Send push notification
  happy daemon            Manage background service that allows
                            to spawn new sessions away from your computer
  happy doctor            System diagnostics & troubleshooting

${chalk.bold('Examples:')}
  happy                    Start session
  happy --yolo             Start with bypassing permissions
                            happy sugar for --dangerously-skip-permissions
  happy --js-runtime bun   Use bun instead of node to spawn Claude Code
  happy --claude-env ANTHROPIC_BASE_URL=http://127.0.0.1:3456
                           Use a custom API endpoint (e.g., claude-code-router)
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
        const claudeHelp = execFileSync(claudeCliPath, ['--help'], { encoding: 'utf8' })
        console.log(claudeHelp)
      } catch (e) {
        console.log(chalk.yellow('Could not retrieve claude help. Make sure claude is installed.'))
      }
      
      process.exit(0)
    }

    // Show version
    if (showVersion) {
      console.log(`happy version: ${packageJson.version}`)
      // Don't exit - continue to pass --version to Claude Code
    }

    // Normal flow - auth and machine setup
    const {
      credentials
    } = await authAndSetupMachineIfNeeded();

    // Always auto-start daemon for simplicity
    logger.debug('Ensuring Happy background service is running & matches our version...');

    if (!(await isDaemonRunningCurrentlyInstalledHappyVersion())) {
      logger.debug('Starting Happy background service...');

      // Use the built binary to spawn daemon
      const daemonProcess = spawnHappyCLI(['daemon', 'start-sync'], {
        detached: true,
        stdio: 'ignore',
        env: process.env
      })
      daemonProcess.unref();

      // Give daemon a moment to write PID & port file
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    // Start the CLI
    try {
      options.terminalRuntime = terminalRuntime;
      await runClaude(credentials, options);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
  }
}
