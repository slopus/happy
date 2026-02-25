/**
 * Slack integration hook for runClaude's onInit extension point
 *
 * Implements the StartOptions.onInit callback signature.
 * When passed to runClaude({ onInit: slackOnInit }), it creates a Slack
 * thread for the session and wires up bidirectional message forwarding.
 *
 * All Slack-specific logic is contained here — runClaude.ts itself has
 * zero knowledge of Slack.
 */

import { readSlackConfig } from '@/slack/slackConfig'
import { SlackBridge } from '@/slack/slackBridge'
import type { Session } from '@/claude/session'
import type { MessageQueue2 } from '@/utils/MessageQueue2'
import type { EnhancedMode, PermissionMode } from '@/claude/loop'
import { logger } from '@/ui/logger'
import { basename } from 'node:path'

/**
 * onInit hook for Slack integration.
 *
 * Matches the `StartOptions.onInit` signature. Returns lifecycle hooks
 * that runClaude will call at the appropriate times, or null if Slack
 * is not configured / initialization fails.
 */
export async function slackOnInit(ctx: {
    sessionId: string
    workingDirectory: string
    model: string | undefined
    messageQueue: MessageQueue2<EnhancedMode>
    permissionMode: PermissionMode
    apiSession: { updateMetadata: (fn: (m: any) => any) => void }
}): Promise<{
    onSessionReady?: (session: Session) => void
    onCleanup?: (reason?: string) => Promise<void>
} | null> {
    const slackConfig = await readSlackConfig()
    if (!slackConfig) {
        logger.debug('[Slack] No config found, skipping integration')
        return null
    }

    const bridge = await SlackBridge.maybeCreate({
        config: slackConfig,
        sessionId: ctx.sessionId,
        sessionTitle: `${basename(ctx.workingDirectory)} | ${ctx.model || 'default'}`,
        messageQueue: ctx.messageQueue,
        defaultPermissionMode: ctx.permissionMode,
    })

    if (!bridge) {
        logger.debug('[Slack] Bridge creation failed, skipping integration')
        return null
    }

    await bridge.createThread()
    logger.debug('[Slack] Thread created for session')

    ctx.apiSession.updateMetadata((m: any) => ({
        ...m,
        slackChannelId: slackConfig.channelId,
        slackThreadTs: bridge.threadTs,
    }))

    return {
        onSessionReady(session: Session): void {
            session.addSDKMessageCallback((msg) => bridge.onSDKMessage(msg))

            // Wire up Block Kit permission buttons when handler becomes available
            // (PermissionHandler is created inside claudeRemoteLauncher, AFTER onSessionReady)
            session.onPermissionHandlerReady((handler) => {
                bridge.setupPermissionBridge(handler)
            })
        },
        async onCleanup(reason?: string): Promise<void> {
            await bridge.close(reason)
        },
    }
}
