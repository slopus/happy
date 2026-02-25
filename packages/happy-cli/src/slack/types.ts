/**
 * Type definitions for Slack integration
 *
 * Defines Zod schemas and TypeScript types for Slack configuration
 * and session state management.
 */

import { z } from 'zod'

/** Zod schema for Slack bot/app configuration stored in ~/.happy/slack.json */
export const SlackConfigSchema = z.object({
  botToken: z.string().startsWith('xoxb-'),
  appToken: z.string().startsWith('xapp-'),
  channelId: z.string(),
  channelName: z.string().optional(),
  notifyUserId: z.string().optional(),
  serverUrl: z.string().url().optional(),
  defaultPermissionMode: z.enum([
    'default', 'acceptEdits', 'bypassPermissions', 'plan'
  ]).default('default'),
})

export type SlackConfig = z.infer<typeof SlackConfigSchema>

/** Runtime state for an active Slack-driven Claude session */
export interface SlackSessionState {
  threadTs: string
  channel: string
  active: boolean
  claudeSessionId: string | null
}
