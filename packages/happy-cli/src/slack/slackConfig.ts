/**
 * Slack configuration persistence
 *
 * Reads and writes Slack config from ~/.happy/slack.json.
 * Supports environment variable overrides for bot token, app token,
 * and channel ID.
 */

import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { configuration } from '@/configuration'
import { SlackConfigSchema } from '@/slack/types'
import type { SlackConfig } from '@/slack/types'
import { logger } from '@/ui/logger'

/** Path to the Slack configuration file */
const slackConfigFile = join(configuration.happyHomeDir, 'slack.json')

/**
 * Apply environment variable overrides to a Slack config object.
 * Env vars take precedence over file-based values.
 */
function applyEnvOverrides(config: SlackConfig): SlackConfig {
  return {
    ...config,
    botToken: process.env.HAPPY_SLACK_BOT_TOKEN ?? config.botToken,
    appToken: process.env.HAPPY_SLACK_APP_TOKEN ?? config.appToken,
    channelId: process.env.HAPPY_SLACK_CHANNEL_ID ?? config.channelId,
    notifyUserId: process.env.HAPPY_SLACK_NOTIFY_USER_ID ?? config.notifyUserId,
  }
}

/**
 * Read Slack configuration from ~/.happy/slack.json with env var overrides.
 * Returns null if the file does not exist or contains invalid data.
 */
export async function readSlackConfig(): Promise<SlackConfig | null> {
  // If all required env vars are set, we can construct config without a file
  if (
    process.env.HAPPY_SLACK_BOT_TOKEN &&
    process.env.HAPPY_SLACK_APP_TOKEN &&
    process.env.HAPPY_SLACK_CHANNEL_ID
  ) {
    const envOnly: unknown = {
      botToken: process.env.HAPPY_SLACK_BOT_TOKEN,
      appToken: process.env.HAPPY_SLACK_APP_TOKEN,
      channelId: process.env.HAPPY_SLACK_CHANNEL_ID,
      ...(process.env.HAPPY_SLACK_NOTIFY_USER_ID && { notifyUserId: process.env.HAPPY_SLACK_NOTIFY_USER_ID }),
    }
    const result = SlackConfigSchema.safeParse(envOnly)
    if (result.success) {
      return result.data
    }
    logger.warn(`Invalid Slack config from environment variables: ${result.error.message}`)
  }

  if (!existsSync(slackConfigFile)) {
    return null
  }

  try {
    const content = await readFile(slackConfigFile, 'utf8')
    const raw = JSON.parse(content)
    const result = SlackConfigSchema.safeParse(raw)
    if (!result.success) {
      logger.warn(`Invalid Slack config in ${slackConfigFile}: ${result.error.message}`)
      return null
    }
    return applyEnvOverrides(result.data)
  } catch (error: any) {
    logger.warn(`Failed to read Slack config: ${error.message}`)
    return null
  }
}

/**
 * Write Slack configuration to ~/.happy/slack.json.
 * File is created with 0600 permissions (owner read/write only)
 * since it contains sensitive tokens.
 */
export async function writeSlackConfig(config: SlackConfig): Promise<void> {
  if (!existsSync(configuration.happyHomeDir)) {
    await mkdir(configuration.happyHomeDir, { recursive: true })
  }

  await writeFile(slackConfigFile, JSON.stringify(config, null, 2), { mode: 0o600 })
}
