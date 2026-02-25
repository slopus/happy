/**
 * Slack Command Handler
 *
 * Provides subcommands for configuring and running the Slack bot integration.
 *
 * Usage:
 *   happy slack setup     Interactive setup wizard
 *   happy slack status    Show config and connection state
 *
 * @module commands/slack
 */

import chalk from 'chalk'
import inquirer from 'inquirer'
import axios from 'axios'
import { readSlackConfig, writeSlackConfig } from '@/slack/slackConfig'
import { configuration } from '@/configuration'
import { logger } from '@/ui/logger'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { slackOnInit } from '@/slack/slackIntegration'
import { runClaude } from '@/claude/runClaude'
import type { StartOptions } from '@/claude/runClaude'
import type { SlackConfig } from '@/slack/types'
import type { PermissionMode } from '@/claude/loop'

/**
 * Mask a token string for display, showing only the prefix and last 4 characters.
 */
function maskToken(token: string): string {
  if (token.length <= 10) return token.slice(0, 5) + '****'
  return token.slice(0, 5) + '****' + token.slice(-4)
}

/**
 * Main entry point for `happy slack <subcommand>`.
 */
export async function handleSlackCommand(args: string[]): Promise<void> {
  const subcommand = args[0]

  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    printSlackHelp()
    return
  }

  switch (subcommand) {
    case 'setup':
      await handleSlackSetup()
      break
    case 'status':
      await handleSlackStatus()
      break
    default:
      // No subcommand or unknown flags → start Slack session
      await handleSlackStart(args)
      break
  }
}

/**
 * Start a Slack-integrated Claude session.
 * Validates config, authenticates, and launches runClaude with Slack hooks.
 */
async function handleSlackStart(args: string[]): Promise<void> {
  const slackConfig = await readSlackConfig()
  if (!slackConfig) {
    console.error(chalk.red('Slack not configured. Run "happy slack setup" first.'))
    process.exit(1)
  }

  // Override server URL if configured in Slack config
  if (slackConfig.serverUrl) {
    ;(configuration as any).serverUrl = slackConfig.serverUrl
  }

  if (slackConfig.channelName) {
    console.log(chalk.gray(`Slack: #${slackConfig.channelName} (${slackConfig.channelId})`))
  } else {
    console.log(chalk.gray(`Slack: ${slackConfig.channelId}`))
  }
  if (slackConfig.serverUrl) {
    console.log(chalk.gray(`Server: ${slackConfig.serverUrl}`))
  }

  const { credentials } = await authAndSetupMachineIfNeeded()

  const options: StartOptions = {
    startingMode: 'remote',
    onInit: slackOnInit,
  }

  const claudeArgs: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--model' || arg === '-m') {
      options.model = args[++i]
    } else if (arg === '--permission-mode') {
      options.permissionMode = args[++i] as PermissionMode
    } else if (arg === '--started-by') {
      options.startedBy = args[++i] as 'daemon' | 'terminal'
    } else if (arg === '--js-runtime') {
      options.jsRuntime = args[++i] as any
    } else {
      claudeArgs.push(arg)
    }
  }

  if (claudeArgs.length > 0) {
    options.claudeArgs = claudeArgs
  }

  logger.debug('[happy slack] Starting with Slack integration')
  await runClaude(credentials, options)
}

/**
 * Interactive setup wizard for Slack integration.
 * Prompts for tokens and channel, validates with Slack API, and saves config.
 */
async function handleSlackSetup(): Promise<void> {
  console.log('')
  console.log(chalk.bold('Slack Integration Setup'))
  console.log('')

  // Load existing config for defaults
  const existing = await readSlackConfig()

  // Always show the guide
  printAppManifest()

  if (existing) {
    console.log(chalk.green('  Existing config detected. Press Enter to keep current values.'))
    console.log('')
  }

  // --- Token input ---
  const tokenAnswers = await inquirer.prompt([
    {
      type: 'input',
      name: 'botToken',
      message: existing?.botToken
        ? `Bot Token (xoxb-...) [${maskToken(existing.botToken)}]:`
        : 'Bot Token (xoxb-...):',
      validate: (input: string) => {
        if (!input && existing?.botToken) return true
        if (!input.startsWith('xoxb-')) return 'Bot token must start with xoxb-'
        return true
      },
    },
    {
      type: 'input',
      name: 'appToken',
      message: existing?.appToken
        ? `App-Level Token (xapp-...) [${maskToken(existing.appToken)}]:`
        : 'App-Level Token (xapp-...):',
      validate: (input: string) => {
        if (!input && existing?.appToken) return true
        if (!input.startsWith('xapp-')) return 'App-level token must start with xapp-'
        return true
      },
    },
  ])

  const botToken = tokenAnswers.botToken || existing?.botToken
  const appToken = tokenAnswers.appToken || existing?.appToken

  // --- Validate credentials ---
  console.log('')
  console.log(chalk.gray('Validating credentials with Slack...'))

  try {
    const response = await axios.post(
      'https://slack.com/api/auth.test',
      {},
      { headers: { Authorization: `Bearer ${botToken}` } }
    )

    if (!response.data.ok) {
      console.error(chalk.red(`Slack validation failed: ${response.data.error}`))
      process.exit(1)
    }

    console.log(chalk.green(`  Authenticated as: ${response.data.user} (team: ${response.data.team})`))
  } catch (error: any) {
    console.error(chalk.red(`Failed to connect to Slack API: ${error.message}`))
    process.exit(1)
  }

  // --- Channel selection ---
  console.log(chalk.gray('  Fetching channels...'))
  console.log('')

  let channelId: string
  let channelName: string | undefined

  const channels = await fetchBotChannels(botToken)

  if (channels.length > 0) {
    const joinedCount = channels.filter((ch) => ch.isMember).length
    console.log(chalk.gray(`  ${channels.length} channels found (${joinedCount} joined). Type to search.`))
    console.log('')

    const { selectedChannel } = await (inquirer as any).prompt([
      {
        type: 'search',
        name: 'selectedChannel',
        message: 'Select a channel:',
        source: (term: string | undefined) => {
          const query = (term || '').toLowerCase()
          const filtered = query
            ? channels.filter((ch) => ch.name.toLowerCase().includes(query))
            : channels
          return filtered.map((ch) => {
            const joined = ch.isMember ? chalk.cyan(' (joined)') : ''
            const current = ch.id === existing?.channelId ? chalk.green(' (current)') : ''
            return { name: `#${ch.name}${joined}${current}`, value: ch.id }
          })
        },
        pageSize: 15,
      },
    ])

    channelId = selectedChannel
    channelName = channels.find((ch) => ch.id === selectedChannel)?.name
  } else {
    // Couldn't fetch channels — fall back to manual input
    console.log(chalk.yellow('  Could not fetch channels. The bot may not be invited to any channel yet.'))
    console.log('')
    const { manualId } = await inquirer.prompt([
      {
        type: 'input',
        name: 'manualId',
        message: 'Channel ID (e.g. C0123456789):',
        default: existing?.channelId,
        validate: (input: string) => input.trim() ? true : 'Channel ID is required',
      },
    ])
    channelId = manualId
  }

  // Fetch channel name if we don't have it yet
  if (!channelName) {
    try {
      const infoResponse = await axios.get(
        'https://slack.com/api/conversations.info',
        {
          params: { channel: channelId },
          headers: { Authorization: `Bearer ${botToken}` },
        }
      )
      if (infoResponse.data.ok) {
        channelName = infoResponse.data.channel?.name
      }
    } catch {
      logger.debug('[slack] Could not fetch channel name')
    }
  }

  // Ensure bot is in the selected channel
  await ensureBotInChannel(botToken, channelId)

  // --- Notify user selection ---
  console.log('')
  console.log(chalk.gray('  Fetching workspace members...'))

  let notifyUserId: string | undefined
  const members = await fetchWorkspaceMembers(botToken)

  if (members.length > 0) {
    const currentName = existing?.notifyUserId
      ? members.find((m) => m.id === existing.notifyUserId)?.name
      : undefined
    const hint = currentName ? ` (current: ${currentName})` : ''
    console.log(chalk.gray(`  ${members.length} members found.${hint} Type to search.`))
    console.log('')

    const { selectedUser } = await (inquirer as any).prompt([
      {
        type: 'search',
        name: 'selectedUser',
        message: 'Mention you on session start (select yourself):',
        source: (term: string | undefined) => {
          const query = (term || '').toLowerCase()
          const filtered = query
            ? members.filter((m) =>
                m.name.toLowerCase().includes(query) ||
                m.realName.toLowerCase().includes(query))
            : members
          const results = filtered.map((m) => {
            const current = m.id === existing?.notifyUserId ? chalk.green(' (current)') : ''
            return { name: `${m.realName} (@${m.name})${current}`, value: m.id }
          })
          results.push({ name: chalk.gray('  Skip (no mention)'), value: '__skip__' })
          return results
        },
        pageSize: 15,
      },
    ])
    notifyUserId = selectedUser === '__skip__' ? undefined : selectedUser
  } else {
    console.log(chalk.yellow('  Could not fetch members (may need users:read scope).'))
    console.log(chalk.yellow('  Reinstall the app after updating the manifest.'))
    // Fall back to manual input
    const { manualUserId } = await inquirer.prompt([
      {
        type: 'input',
        name: 'manualUserId',
        message: existing?.notifyUserId
          ? `Your Slack Member ID [${existing.notifyUserId}] (optional):`
          : 'Your Slack Member ID (optional):',
      },
    ])
    notifyUserId = manualUserId || existing?.notifyUserId || undefined
  }

  // --- Server URL (optional) ---
  const defaultServerUrl = 'https://api.cluster-fluster.com'
  const { serverUrlInput } = await inquirer.prompt([
    {
      type: 'input',
      name: 'serverUrlInput',
      message: existing?.serverUrl
        ? `Happy Server URL [${existing.serverUrl}]:`
        : `Happy Server URL [${defaultServerUrl}]:`,
    },
  ])
  const serverUrl = serverUrlInput || existing?.serverUrl || undefined

  const config: SlackConfig = {
    botToken,
    appToken,
    channelId,
    channelName,
    ...(notifyUserId ? { notifyUserId } : {}),
    ...(serverUrl ? { serverUrl } : {}),
    defaultPermissionMode: 'default',
  }

  await writeSlackConfig(config)

  console.log('')
  console.log(chalk.green('  Slack configuration saved.'))
  if (channelName) {
    console.log(chalk.gray(`  Channel: #${channelName} (${channelId})`))
  }
  console.log('')
  console.log(chalk.yellow.bold('  Security Warning:'))
  console.log(chalk.yellow('  When running in Slack mode, tool calls from messages in the'))
  console.log(chalk.yellow('  configured channel are auto-approved based on the permission mode.'))
  console.log(chalk.yellow('  Ensure only trusted users have access to this Slack channel.'))
  console.log('')
  console.log(chalk.gray('  Run "slaphappy slack" to start a session.'))
}

/**
 * Display current Slack configuration status with masked tokens.
 */
async function handleSlackStatus(): Promise<void> {
  const config = await readSlackConfig()

  console.log('')
  console.log(chalk.bold('Slack Integration Status'))
  console.log('')

  if (!config) {
    console.log(chalk.yellow('  Not configured. Run "happy slack setup" to get started.'))
    console.log('')
    return
  }

  console.log(`  Bot Token:        ${maskToken(config.botToken)}`)
  console.log(`  App Token:        ${maskToken(config.appToken)}`)
  console.log(`  Channel ID:       ${config.channelId}`)
  if (config.channelName) {
    console.log(`  Channel Name:     #${config.channelName}`)
  }
  console.log(`  Permission Mode:  ${config.defaultPermissionMode}`)

  // Show env var overrides
  const envOverrides: string[] = []
  if (process.env.HAPPY_SLACK_BOT_TOKEN) envOverrides.push('HAPPY_SLACK_BOT_TOKEN')
  if (process.env.HAPPY_SLACK_APP_TOKEN) envOverrides.push('HAPPY_SLACK_APP_TOKEN')
  if (process.env.HAPPY_SLACK_CHANNEL_ID) envOverrides.push('HAPPY_SLACK_CHANNEL_ID')

  if (envOverrides.length > 0) {
    console.log('')
    console.log(chalk.cyan(`  Env overrides active: ${envOverrides.join(', ')}`))
  }

  console.log('')
}

/**
 * Display a full step-by-step Slack App setup guide with manifest.
 */
function printAppManifest(): void {
  const dim = chalk.gray
  const hi = chalk.cyan
  const step = (n: number, title: string) => chalk.bold.white(` STEP ${n} `) + ' ' + chalk.bold(title)
  const url = (u: string) => chalk.underline.cyan(u)
  const bar = dim('─'.repeat(60))

  const manifest = {
    display_information: {
      name: 'Claude Agent',
      description: 'Claude Code remote control via Slack threads',
      background_color: '#1a1a2e',
    },
    features: {
      bot_user: { display_name: 'claude-agent', always_online: true },
    },
    oauth_config: {
      scopes: {
        bot: ['chat:write', 'channels:history', 'channels:read', 'channels:join', 'reactions:write', 'reactions:read', 'users:read'],
      },
    },
    settings: {
      event_subscriptions: { bot_events: ['message.channels'] },
      socket_mode_enabled: true,
      org_deploy_enabled: false,
      token_rotation_enabled: false,
    },
  }

  console.log(bar)
  console.log(chalk.bold.cyan('  Slack App Setup Guide'))
  console.log(dim('  Create a Slack App to connect Claude to your workspace.'))
  console.log(bar)
  console.log('')

  // Step 1
  console.log(step(1, 'Create a Slack App'))
  console.log('')
  console.log(dim('  Open ') + url('https://api.slack.com/apps'))
  console.log(dim('  → ') + hi('"Create New App"') + dim(' → ') + hi('"From a manifest"'))
  console.log(dim('  → Select your workspace → Paste the JSON below → Create'))
  console.log('')
  console.log(dim('  ┌─ manifest.json ────────────────────────────────────'))
  for (const line of JSON.stringify(manifest, null, 2).split('\n')) {
    console.log(dim('  │ ') + hi(line))
  }
  console.log(dim('  └───────────────────────────────────────────────────'))
  console.log('')

  // Step 2
  console.log(step(2, 'Install & get Bot Token'))
  console.log('')
  console.log(dim('  In your app settings:'))
  console.log(dim('  → ') + hi('"OAuth & Permissions"') + dim(' → ') + hi('"Install to Workspace"'))
  console.log(dim('  → Copy the ') + chalk.bold.green('Bot User OAuth Token') + dim(' (starts with ') + hi('xoxb-') + dim(')'))
  console.log('')

  // Step 3
  console.log(step(3, 'Generate App-Level Token'))
  console.log('')
  console.log(dim('  → ') + hi('"Basic Information"') + dim(' → ') + hi('"App-Level Tokens"') + dim(' → ') + hi('"Generate Token"'))
  console.log(dim('  → Name: ') + hi('socket') + dim('  Scope: ') + hi('connections:write'))
  console.log(dim('  → Copy the token (starts with ') + hi('xapp-') + dim(')'))
  console.log('')

  // Step 4
  console.log(step(4, 'Enter tokens below'))
  console.log('')
  console.log(dim('  After creating the app, enter your tokens below.'))
  console.log(dim('  You will then select a channel from a list.'))
  console.log('')

  console.log(bar)
  console.log('')
}

/**
 * Fetch all public, non-archived channels in the workspace.
 * Shows progress during pagination for large workspaces.
 */
async function fetchBotChannels(botToken: string): Promise<{ id: string; name: string; isMember: boolean }[]> {
  const channels: { id: string; name: string; isMember: boolean }[] = []
  let cursor: string | undefined

  try {
    do {
      const response = await axios.get(
        'https://slack.com/api/conversations.list',
        {
          params: {
            types: 'public_channel',
            exclude_archived: true,
            limit: 1000,
            ...(cursor ? { cursor } : {}),
          },
          headers: { Authorization: `Bearer ${botToken}` },
          timeout: 15000,
        }
      )

      if (!response.data.ok) {
        logger.debug(`[slack] conversations.list failed: ${response.data.error}`)
        break
      }

      for (const ch of response.data.channels ?? []) {
        channels.push({ id: ch.id, name: ch.name, isMember: ch.is_member ?? false })
      }

      process.stdout.write(`\r${chalk.gray(`  ${channels.length} channels loaded...`)}`)
      cursor = response.data.response_metadata?.next_cursor || undefined
    } while (cursor)

    process.stdout.write('\r' + ' '.repeat(40) + '\r')
  } catch (error: any) {
    logger.debug(`[slack] Failed to fetch channels: ${error.message}`)
    process.stdout.write('\r' + ' '.repeat(40) + '\r')
  }

  // Joined channels first, then alphabetically
  channels.sort((a, b) => {
    if (a.isMember !== b.isMember) return a.isMember ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return channels
}

/**
 * Fetch active (non-bot, non-deleted) workspace members.
 * Requires the users:read scope.
 */
async function fetchWorkspaceMembers(botToken: string): Promise<{ id: string; name: string; realName: string }[]> {
  const members: { id: string; name: string; realName: string }[] = []
  let cursor: string | undefined

  try {
    do {
      const response = await axios.get(
        'https://slack.com/api/users.list',
        {
          params: {
            limit: 200,
            ...(cursor ? { cursor } : {}),
          },
          headers: { Authorization: `Bearer ${botToken}` },
          timeout: 15000,
        }
      )

      if (!response.data.ok) {
        logger.debug(`[slack] users.list failed: ${response.data.error}`)
        break
      }

      for (const m of response.data.members ?? []) {
        if (m.deleted || m.is_bot || m.id === 'USLACKBOT') continue
        members.push({
          id: m.id,
          name: m.name ?? m.id,
          realName: m.real_name ?? m.name ?? m.id,
        })
      }

      process.stdout.write(`\r${chalk.gray(`  ${members.length} members loaded...`)}`)
      cursor = response.data.response_metadata?.next_cursor || undefined
    } while (cursor)

    process.stdout.write('\r' + ' '.repeat(40) + '\r')
  } catch (error: any) {
    logger.debug(`[slack] Failed to fetch members: ${error.message}`)
    process.stdout.write('\r' + ' '.repeat(40) + '\r')
  }

  members.sort((a, b) => a.realName.localeCompare(b.realName))
  return members
}

/**
 * Join a channel if the bot is not already a member.
 */
async function ensureBotInChannel(botToken: string, channelId: string): Promise<void> {
  try {
    const response = await axios.post(
      'https://slack.com/api/conversations.join',
      { channel: channelId },
      {
        headers: {
          Authorization: `Bearer ${botToken}`,
          'Content-Type': 'application/json',
        },
      }
    )
    if (response.data.ok) {
      if (response.data.already_in_channel) {
        console.log(chalk.gray('  Bot is already in the channel.'))
      } else {
        console.log(chalk.green('  Bot joined the channel.'))
      }
    } else if (response.data.error === 'missing_scope') {
      console.log(chalk.yellow('  Could not join channel: missing "channels:join" scope.'))
      console.log(chalk.yellow('  → Go to app settings → OAuth & Permissions → "Reinstall to Workspace"'))
      console.log(chalk.yellow('  → Or /invite the bot manually in the channel.'))
    } else {
      console.log(chalk.yellow(`  Could not join channel: ${response.data.error}`))
      console.log(chalk.yellow('  You may need to /invite the bot manually.'))
    }
  } catch (error: any) {
    console.log(chalk.yellow(`  Could not join channel: ${error.message}`))
    console.log(chalk.yellow('  You may need to /invite the bot manually.'))
  }
}

function printSlackHelp(): void {
  console.log(`
${chalk.bold('happy slack')} - Slack bot integration

${chalk.bold('Usage:')}
  happy slack                Start Slack-integrated Claude session
  happy slack [options]      Start with options (passed through to Claude)
  happy slack setup          Interactive setup wizard
  happy slack status         Show current configuration

${chalk.bold('Options:')}
  --model, -m <model>       Claude model to use
  --permission-mode <mode>  Permission mode (default, acceptEdits, bypassPermissions)

${chalk.bold('Environment Variables (override saved config):')}
  HAPPY_SLACK_BOT_TOKEN     Slack bot token (xoxb-...)
  HAPPY_SLACK_APP_TOKEN     Slack app-level token (xapp-...)
  HAPPY_SLACK_CHANNEL_ID    Channel ID to listen on

${chalk.bold('Examples:')}
  happy slack setup
  happy slack --permission-mode bypassPermissions
  happy slack status
`)
}
