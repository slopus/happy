/**
 * Socket Mode event router singleton
 *
 * Maintains a single Bolt App Socket Mode connection shared across all
 * SlackBridge instances. Message events are routed to the correct bridge
 * by thread_ts, eliminating stale-connection issues from V1.
 */

import { App, LogLevel } from '@slack/bolt'
import type { WebClient } from '@slack/web-api'
import type { SlackConfig } from '@/slack/types'
import { logger } from '@/ui/logger'

/** Handler invoked when a thread reply is received */
export type SlackThreadHandler = (text: string, userId: string, messageTs: string) => void

/** Handler invoked when a Block Kit action (button click) is received */
export type SlackActionHandler = (actionId: string, value: string, userId: string) => void

/**
 * Singleton router that keeps one Socket Mode connection alive and
 * dispatches incoming message events to per-thread handlers.
 */
export class SlackEventRouter {
    private static instance: SlackEventRouter | null = null

    private app: App
    private config: SlackConfig
    private bridges = new Map<string, SlackThreadHandler>()
    private actionBridges = new Map<string, SlackActionHandler>()
    private botUserId: string | null = null
    private started = false

    private constructor(config: SlackConfig) {
        this.config = config

        const boltLogger = {
            debug: (...msgs: unknown[]) => {
                const joined = msgs.map(String).join(' ')
                logger.debug('[Bolt] ' + joined)

                // Detect stale Socket Mode connections from the hello message
                const numMatch = joined.match(/"num_connections"\s*:\s*(\d+)/)
                if (numMatch) {
                    const n = parseInt(numMatch[1], 10)
                    if (n > 1) {
                        logger.debug(
                            `[SlackEventRouter] WARNING: Slack reports ${n} Socket Mode connections. ` +
                            `Stale connections from previous runs may cause missed events.`
                        )
                    }
                }
            },
            info: (...msgs: unknown[]) => logger.debug('[Bolt] ' + msgs.map(String).join(' ')),
            warn: (...msgs: unknown[]) => logger.debug('[Bolt:WARN] ' + msgs.map(String).join(' ')),
            error: (...msgs: unknown[]) => logger.debug('[Bolt:ERROR] ' + msgs.map(String).join(' ')),
            getLevel: () => LogLevel.DEBUG,
            setLevel: () => {},
            setName: () => {},
        }

        this.app = new App({
            token: config.botToken,
            appToken: config.appToken,
            socketMode: true,
            logLevel: LogLevel.DEBUG,
            logger: boltLogger,
        })

        this.app.error(async (error) => {
            logger.debug('[SlackEventRouter] Unhandled Bolt error: ' + String(error))
        })

        // Route message events by thread_ts
        this.app.event('message', async ({ event }) => {
            const ev = event as any
            const threadTs = ev.thread_ts as string | undefined
            if (!threadTs) return // Ignore top-level messages

            // Ignore subtypes we don't care about
            const subtype = ev.subtype as string | undefined
            if (subtype === 'message_changed' || subtype === 'message_deleted' || subtype === 'bot_message') {
                return
            }

            // Ignore our own messages
            const userId = ev.user as string | undefined
            if (!userId || userId === this.botUserId) return

            // Only listen in the configured channel
            if (ev.channel !== this.config.channelId) return

            const text = ((ev.text as string) || '').trim()
            if (!text) return

            const messageTs = ev.ts as string
            const handler = this.bridges.get(threadTs)
            if (handler) {
                logger.debug(`[SlackEventRouter] Routing message to thread ${threadTs}`)
                handler(text, userId, messageTs)
            }
        })

        // Route Block Kit action events (button clicks) by thread_ts
        this.app.action(/^happy_/, async ({ body, ack }) => {
            await ack()
            const payload = body as any
            const action = payload.actions?.[0]
            if (!action) return

            const threadTs = payload.message?.thread_ts as string | undefined
            if (!threadTs) return

            const userId = payload.user?.id as string | undefined
            if (!userId) return

            const handler = this.actionBridges.get(threadTs)
            if (handler) {
                logger.debug(`[SlackEventRouter] Routing action ${action.action_id} to thread ${threadTs}`)
                handler(action.action_id, action.value || '', userId)
            }
        })
    }

    /**
     * Get or create the singleton instance.
     * Does NOT start Socket Mode — that happens on first register().
     */
    static getInstance(config: SlackConfig): SlackEventRouter {
        if (!SlackEventRouter.instance) {
            SlackEventRouter.instance = new SlackEventRouter(config)
        }
        return SlackEventRouter.instance
    }

    /** Expose the Bolt WebClient for posting messages */
    get webClient(): WebClient {
        return this.app.client
    }

    /**
     * Register a handler for a specific thread_ts.
     * Optionally register an action handler for Block Kit button clicks.
     * Starts Socket Mode on the first registration.
     */
    async register(threadTs: string, handler: SlackThreadHandler, actionHandler?: SlackActionHandler): Promise<void> {
        this.bridges.set(threadTs, handler)
        if (actionHandler) {
            this.actionBridges.set(threadTs, actionHandler)
        }
        logger.debug(`[SlackEventRouter] Registered handler for thread ${threadTs} (total: ${this.bridges.size})`)

        if (!this.started) {
            // Resolve bot user ID before starting
            const authResult = await this.app.client.auth.test({ token: this.config.botToken })
            this.botUserId = (authResult.user_id as string) ?? null
            logger.debug(`[SlackEventRouter] Bot user ID: ${this.botUserId}`)

            await this.app.start()
            this.started = true
            logger.debug('[SlackEventRouter] Socket Mode connection started')
        }
    }

    /**
     * Unregister a thread handler.
     * When the last handler is removed, stops Socket Mode and destroys the singleton.
     */
    async unregister(threadTs: string): Promise<void> {
        this.bridges.delete(threadTs)
        this.actionBridges.delete(threadTs)
        logger.debug(`[SlackEventRouter] Unregistered handler for thread ${threadTs} (remaining: ${this.bridges.size})`)

        if (this.bridges.size === 0 && this.started) {
            try {
                await this.app.stop()
            } catch {
                // App may already be stopped
            }
            this.started = false
            SlackEventRouter.instance = null
            logger.debug('[SlackEventRouter] Socket Mode connection stopped, singleton cleared')
        }
    }
}
