/**
 * Per-session bridge between a CLI session and a Slack thread
 *
 * Each SlackBridge instance manages one Slack thread that corresponds
 * to one Happy CLI session. It posts SDK messages to the thread and
 * routes thread replies back into the session's message queue.
 */

import type { SDKMessage, SDKResultMessage } from '@/claude/sdk'
import type { EnhancedMode, PermissionMode } from '@/claude/loop'
import type { SlackConfig } from '@/slack/types'
import type { MessageQueue2 } from '@/utils/MessageQueue2'
import type { PermissionHandler } from '@/claude/utils/permissionHandler'
import { SlackEventRouter } from '@/slack/slackEventRouter'
import { shouldPostToSlack, formatSDKMessageForSlack } from '@/slack/slackFormatter'
import { logger } from '@/ui/logger'

export interface SlackBridgeOptions {
    config: SlackConfig
    sessionId: string
    sessionTitle: string
    messageQueue: MessageQueue2<EnhancedMode>
    defaultPermissionMode: PermissionMode
}

type BridgeStatus = 'active' | 'idle' | 'completed' | 'error'

const STATUS_EMOJI: Record<BridgeStatus, string> = {
    active: '🟢',
    idle: '💤',
    completed: '✅',
    error: '❌',
}

export class SlackBridge {
    private router: SlackEventRouter
    private config: SlackConfig
    private sessionId: string
    private sessionTitle: string
    private messageQueue: MessageQueue2<EnhancedMode>
    private defaultPermissionMode: PermissionMode

    private _threadTs: string | null = null
    private headerTs: string | null = null
    private status: BridgeStatus = 'active'
    private turnCount = 0
    private totalCost = 0
    private processingTs: string | null = null
    private lastUserMessageTs: string | null = null

    private permissionHandler: PermissionHandler | null = null
    private permissionCallback: ((toolCallId: string, toolName: string, input: unknown) => void) | null = null
    /** Maps requestId → message ts for updating Block Kit messages after action */
    private permissionMessageTs = new Map<string, string>()

    get threadTs(): string | null {
        return this._threadTs
    }

    private constructor(
        router: SlackEventRouter,
        opts: SlackBridgeOptions,
    ) {
        this.router = router
        this.config = opts.config
        this.sessionId = opts.sessionId
        this.sessionTitle = opts.sessionTitle
        this.messageQueue = opts.messageQueue
        this.defaultPermissionMode = opts.defaultPermissionMode
    }

    /**
     * Create a SlackBridge if Slack is configured. Returns null on failure (noop).
     */
    static async maybeCreate(opts: SlackBridgeOptions): Promise<SlackBridge | null> {
        try {
            const router = SlackEventRouter.getInstance(opts.config)
            return new SlackBridge(router, opts)
        } catch (err) {
            logger.debug('[SlackBridge] Failed to create: ' + String(err))
            return null
        }
    }

    /**
     * Post the header message to create the thread, then register with the router.
     */
    async createThread(): Promise<void> {
        const headerText = this.formatHeader()

        try {
            const result = await this.router.webClient.chat.postMessage({
                token: this.config.botToken,
                channel: this.config.channelId,
                text: headerText,
            })

            this._threadTs = result.ts ?? null
            this.headerTs = result.ts ?? null

            if (!this._threadTs) {
                logger.debug('[SlackBridge] Failed to get thread_ts from header post')
                return
            }

            logger.debug(`[SlackBridge] Thread created: ${this._threadTs}`)

            // Post welcome message as the first thread reply
            await this.postWelcome()

            // Register with router to receive thread replies and Block Kit actions
            await this.router.register(
                this._threadTs,
                (text, userId, messageTs) => this.onSlackReply(text, userId, messageTs),
                (actionId, value, userId) => this.onSlackAction(actionId, value, userId),
            )
        } catch (err) {
            logger.debug('[SlackBridge] Failed to create thread: ' + String(err))
        }
    }

    /**
     * Handle an SDK message — filter and post to the Slack thread.
     */
    onSDKMessage = (message: SDKMessage): void => {
        // Track stats from result messages
        if (message.type === 'result') {
            const result = message as SDKResultMessage
            this.turnCount = result.num_turns ?? this.turnCount
            this.totalCost = result.total_cost_usd ?? this.totalCost
        }

        if (!this._threadTs || !shouldPostToSlack(message)) return

        // Clear processing indicator and react ✅ on first assistant response
        if (message.type === 'assistant' && this.lastUserMessageTs) {
            this.deleteProcessingIndicator()
            this.addReaction('white_check_mark', this.lastUserMessageTs)
            this.lastUserMessageTs = null
        }

        const formatted = formatSDKMessageForSlack(message)
        if (formatted.length > 0) {
            this.postToThread(formatted)
        }
    }

    /**
     * Close the bridge: update header and unregister from router.
     */
    async close(reason?: string): Promise<void> {
        this.status = reason ? 'error' : 'completed'
        await this.updateHeader()

        // Clean up permission bridge
        if (this.permissionHandler && this.permissionCallback) {
            this.permissionHandler.removeOnPermissionRequest(this.permissionCallback)
            this.permissionCallback = null
            this.permissionHandler = null
        }

        // Expire any remaining permission buttons
        for (const [, ts] of this.permissionMessageTs) {
            this.router.webClient.chat.update({
                token: this.config.botToken,
                channel: this.config.channelId,
                ts,
                text: 'Session ended',
                blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text: ':white_circle: Session ended' }] }],
            }).catch(() => {})
        }
        this.permissionMessageTs.clear()

        if (this._threadTs) {
            await this.router.unregister(this._threadTs)
        }

        logger.debug(`[SlackBridge] Closed (${this.status})${reason ? ': ' + reason : ''}`)
    }

    /**
     * Wire up Block Kit permission buttons for tool approvals and AskUserQuestion.
     * Must be called after the session's PermissionHandler is available.
     */
    setupPermissionBridge(handler: PermissionHandler): void {
        this.permissionHandler = handler
        this.permissionCallback = (toolCallId, toolName, input) => {
            this.postPermissionRequest(toolCallId, toolName, input)
        }
        handler.addOnPermissionRequest(this.permissionCallback)
        logger.debug('[SlackBridge] Permission bridge established')
    }

    /** Post a Block Kit message with Approve/Deny or option buttons */
    private postPermissionRequest(toolCallId: string, toolName: string, input: unknown): void {
        if (!this._threadTs) return

        const blocks = toolName === 'AskUserQuestion'
            ? this.buildAskBlocks(toolCallId, input)
            : this.buildPermissionBlocks(toolCallId, toolName, input)

        this.router.webClient.chat.postMessage({
            token: this.config.botToken,
            channel: this.config.channelId,
            thread_ts: this._threadTs,
            text: toolName === 'AskUserQuestion' ? 'Question from Claude' : 'Permission request',
            blocks,
        }).then((result) => {
            if (result.ts) {
                this.permissionMessageTs.set(toolCallId, result.ts)
            }
        }).catch((err) => {
            logger.debug(`[SlackBridge] Failed to post permission request: ${err}`)
        })
    }

    /** Build Block Kit blocks for a regular permission request (Approve/Deny) */
    private buildPermissionBlocks(toolCallId: string, toolName: string, input: unknown): any[] {
        let description: string
        const inputObj = input as Record<string, any>

        if (toolName === 'Bash' && inputObj?.command) {
            description = `:terminal: Claude wants to run a command:\n\`\`\`${inputObj.command}\`\`\``
        } else if (toolName === 'Edit' && inputObj?.file_path) {
            description = `:pencil2: Claude wants to edit \`${inputObj.file_path}\``
        } else if (toolName === 'Write' && inputObj?.file_path) {
            description = `:page_facing_up: Claude wants to write \`${inputObj.file_path}\``
        } else {
            description = `:lock: Claude wants to use \`${toolName}\``
        }

        return [
            {
                type: 'section',
                text: { type: 'mrkdwn', text: description },
            },
            {
                type: 'actions',
                elements: [
                    {
                        type: 'button',
                        text: { type: 'plain_text', text: 'Approve', emoji: true },
                        action_id: 'happy_approve',
                        value: JSON.stringify({ requestId: toolCallId }),
                        style: 'primary',
                    },
                    {
                        type: 'button',
                        text: { type: 'plain_text', text: 'Deny', emoji: true },
                        action_id: 'happy_deny',
                        value: JSON.stringify({ requestId: toolCallId }),
                        style: 'danger',
                    },
                ],
            },
        ]
    }

    /** Build Block Kit blocks for AskUserQuestion (option buttons) */
    private buildAskBlocks(toolCallId: string, input: unknown): any[] {
        const inputObj = input as { questions?: { question: string; header: string; options: { label: string; description?: string }[]; multiSelect?: boolean }[] }
        const question = inputObj?.questions?.[0]
        if (!question) {
            return this.buildPermissionBlocks(toolCallId, 'AskUserQuestion', input)
        }

        const blocks: any[] = [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `:question: *${question.header}*\n${question.question}`,
                },
            },
        ]

        const buttons = question.options.map((opt, i) => ({
            type: 'button' as const,
            text: { type: 'plain_text' as const, text: opt.label.substring(0, 75), emoji: true },
            action_id: `happy_ask_${i}`,
            value: JSON.stringify({
                requestId: toolCallId,
                header: question.header,
                label: opt.label,
            }),
        }))

        blocks.push({ type: 'actions', elements: buttons })

        // Show option descriptions as context
        const descriptions = question.options
            .filter((o) => o.description)
            .map((o) => `• *${o.label}*: ${o.description}`)
        if (descriptions.length > 0) {
            blocks.push({
                type: 'context',
                elements: [{ type: 'mrkdwn', text: descriptions.join('\n') }],
            })
        }

        return blocks
    }

    /** Handle a Block Kit action (button click) from Slack */
    private onSlackAction(actionId: string, value: string, userId: string): void {
        // Authorization check
        if (this.config.notifyUserId && userId !== this.config.notifyUserId) {
            logger.debug(`[SlackBridge] Ignored action from unauthorized user ${userId}`)
            return
        }

        if (!this.permissionHandler) {
            logger.debug('[SlackBridge] No permission handler, ignoring action')
            return
        }

        let payload: { requestId: string; header?: string; label?: string }
        try {
            payload = JSON.parse(value)
        } catch {
            logger.debug(`[SlackBridge] Failed to parse action value: ${value}`)
            return
        }

        const { requestId } = payload
        logger.debug(`[SlackBridge] Action ${actionId} for request ${requestId}`)

        if (actionId === 'happy_approve') {
            if (!this.permissionHandler.injectPermissionResponse(requestId, true)) return
            this.updatePermissionMessage(requestId, `Approved by <@${userId}>`)
        } else if (actionId === 'happy_deny') {
            if (!this.permissionHandler.injectPermissionResponse(requestId, false, 'Denied via Slack')) return
            this.updatePermissionMessage(requestId, `Denied by <@${userId}>`)
        } else if (actionId.startsWith('happy_ask_')) {
            // AskUserQuestion: approve + push answer text (guarded against double-click)
            const header = payload.header || 'Answer'
            const label = payload.label || 'Selected'

            if (!this.permissionHandler.injectPermissionResponse(requestId, true)) return
            this.updatePermissionMessage(requestId, `Answered: *${label}*`)

            // Push the formatted answer as a user message (same as mobile app)
            const answerText = `${header}: ${label}`
            const mode: EnhancedMode = { permissionMode: this.defaultPermissionMode }
            this.messageQueue.push(answerText, mode)
        }
    }

    /** Update a permission message to show result and remove buttons */
    private updatePermissionMessage(requestId: string, resultText: string): void {
        const messageTs = this.permissionMessageTs.get(requestId)
        if (!messageTs) return
        this.permissionMessageTs.delete(requestId)

        this.router.webClient.chat.update({
            token: this.config.botToken,
            channel: this.config.channelId,
            ts: messageTs,
            text: resultText,
            blocks: [
                {
                    type: 'context',
                    elements: [{ type: 'mrkdwn', text: resultText }],
                },
            ],
        }).catch((err) => {
            logger.debug(`[SlackBridge] Failed to update permission message: ${err}`)
        })
    }

    /** Post a welcome message as the first thread reply */
    private async postWelcome(): Promise<void> {
        if (!this._threadTs) return

        const mention = this.config.notifyUserId
            ? `<@${this.config.notifyUserId}> `
            : ''
        const lines = [
            `${mention}:zap: *Session started*`,
            '',
            'This thread is linked to your CLI session in real time.',
            'Reply here to send input to Claude.',
        ]

        try {
            await this.router.webClient.chat.postMessage({
                token: this.config.botToken,
                channel: this.config.channelId,
                thread_ts: this._threadTs,
                text: lines.join('\n'),
            })
        } catch (err) {
            logger.debug('[SlackBridge] Failed to post welcome: ' + String(err))
        }
    }

    /** Route a Slack thread reply into the session's message queue */
    private onSlackReply(text: string, userId: string, messageTs: string): void {
        // Only the session owner can send commands
        if (this.config.notifyUserId && userId !== this.config.notifyUserId) {
            logger.debug(`[SlackBridge] Ignored reply from unauthorized user ${userId}`)
            return
        }

        logger.debug(`[SlackBridge] Received Slack reply from ${userId}: ${text.substring(0, 80)}`)

        // React 👀 to acknowledge receipt
        this.addReaction('eyes', messageTs)
        this.lastUserMessageTs = messageTs

        // Post processing indicator
        this.postProcessingIndicator()

        const mode: EnhancedMode = {
            permissionMode: this.defaultPermissionMode,
        }
        this.messageQueue.push(text, mode)
    }

    /** Post one or more messages to the thread */
    private async postToThread(texts: string[]): Promise<void> {
        if (!this._threadTs) return

        for (const text of texts) {
            try {
                await this.router.webClient.chat.postMessage({
                    token: this.config.botToken,
                    channel: this.config.channelId,
                    thread_ts: this._threadTs,
                    text,
                })
            } catch (err) {
                logger.debug('[SlackBridge] Failed to post to thread: ' + String(err))
            }
        }
    }

    /** Add an emoji reaction to a message */
    private addReaction(name: string, timestamp: string): void {
        this.router.webClient.reactions.add({
            token: this.config.botToken,
            channel: this.config.channelId,
            name,
            timestamp,
        }).catch((err) => {
            logger.debug(`[SlackBridge] Failed to add :${name}: reaction: ${err}`)
        })
    }

    /** Post a processing indicator to the thread */
    private postProcessingIndicator(): void {
        if (!this._threadTs) return

        this.router.webClient.chat.postMessage({
            token: this.config.botToken,
            channel: this.config.channelId,
            thread_ts: this._threadTs,
            text: ':hourglass_flowing_sand: Processing…',
        }).then((result) => {
            this.processingTs = result.ts ?? null
        }).catch((err) => {
            logger.debug('[SlackBridge] Failed to post processing indicator: ' + String(err))
        })
    }

    /** Delete the processing indicator */
    private deleteProcessingIndicator(): void {
        if (!this.processingTs) return
        const ts = this.processingTs
        this.processingTs = null

        this.router.webClient.chat.delete({
            token: this.config.botToken,
            channel: this.config.channelId,
            ts,
        }).catch((err) => {
            logger.debug('[SlackBridge] Failed to delete processing indicator: ' + String(err))
        })
    }

    /** Update the header message with current status */
    private async updateHeader(): Promise<void> {
        if (!this.headerTs) return

        try {
            await this.router.webClient.chat.update({
                token: this.config.botToken,
                channel: this.config.channelId,
                ts: this.headerTs,
                text: this.formatHeader(),
            })
        } catch (err) {
            logger.debug('[SlackBridge] Failed to update header: ' + String(err))
        }
    }

    /** Format the header message text */
    private formatHeader(): string {
        const emoji = STATUS_EMOJI[this.status]
        const lines = [
            `${emoji} Session: ${this.sessionTitle}`,
            `Session ID: \`${this.sessionId}\``,
        ]

        if (this.turnCount > 0 || this.totalCost > 0) {
            lines.push(`Turns: ${this.turnCount} | Cost: $${this.totalCost.toFixed(4)}`)
        }

        return lines.join('\n')
    }
}
