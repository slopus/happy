import axios from 'axios'
import { logger } from '@/ui/logger'
import { Expo, ExpoPushMessage } from 'expo-server-sdk'
import type { Metadata } from './types'

export interface PushToken {
    id: string
    token: string
    createdAt: number
    updatedAt: number
}

export type SessionNotificationKind = 'done' | 'permission' | 'question'

function getSessionTitle(metadata: Metadata | null | undefined): string {
    const summaryText = metadata?.summary?.text?.trim()
    if (summaryText) {
        return summaryText
    }

    const path = metadata?.path?.trim()
    if (!path) {
        return 'Session'
    }

    const segments = path.split(/[\\/]/).filter(Boolean)
    return segments[segments.length - 1] || 'Session'
}

function getSessionNotificationUrl(data: Record<string, any> | undefined): `/session/${string}` | null {
    const sessionId = data?.sessionId
    if (typeof sessionId !== 'string') {
        return null
    }

    const trimmedSessionId = sessionId.trim()
    if (!trimmedSessionId) {
        return null
    }

    return `/session/${encodeURIComponent(trimmedSessionId)}`
}

export function getSessionNotificationTitle(
    kind: SessionNotificationKind
): string {
    switch (kind) {
        case 'done':
            return "It's ready!"
        case 'permission':
            return 'Permission request'
        case 'question':
            return 'Clarification needed'
    }
}

export function getSessionNotificationBody(
    metadata: Metadata | null | undefined
): string {
    return getSessionTitle(metadata)
}

export function getSessionNotificationCopy(
    kind: SessionNotificationKind,
    metadata: Metadata | null | undefined
): { title: string; body: string } {
    return {
        title: getSessionNotificationTitle(kind),
        body: getSessionNotificationBody(metadata),
    }
}

export class PushNotificationClient {
    private readonly token: string
    private readonly baseUrl: string
    private readonly expo: Expo

    constructor(token: string, baseUrl: string = 'https://api.cluster-fluster.com') {
        this.token = token
        this.baseUrl = baseUrl
        this.expo = new Expo()
    }

    /**
     * Fetch all push tokens for the authenticated user
     */
    async fetchPushTokens(): Promise<PushToken[]> {
        try {
            const response = await axios.get<{ tokens: PushToken[] }>(
                `${this.baseUrl}/v1/push-tokens`,
                {
                    headers: {
                        'Authorization': `Bearer ${this.token}`,
                        'Content-Type': 'application/json'
                    }
                }
            )

            logger.debug(`Fetched ${response.data.tokens.length} push tokens`)
            
            // Log token information
            response.data.tokens.forEach((token, index) => {
                logger.debug(`[PUSH] Token ${index + 1}: id=${token.id}, created=${new Date(token.createdAt).toISOString()}, updated=${new Date(token.updatedAt).toISOString()}`)
            })
            
            return response.data.tokens
        } catch (error) {
            logger.debug('[PUSH] [ERROR] Failed to fetch push tokens:', error)
            throw new Error(`Failed to fetch push tokens: ${error instanceof Error ? error.message : 'Unknown error'}`)
        }
    }

    /**
     * Send push notification via Expo Push API with retry
     * @param messages - Array of push messages to send
     */
    async sendPushNotifications(messages: ExpoPushMessage[]): Promise<void> {
        logger.debug(`Sending ${messages.length} push notifications`)

        // Filter out invalid push tokens
        const validMessages = messages.filter(message => {
            if (Array.isArray(message.to)) {
                return message.to.every(token => Expo.isExpoPushToken(token))
            }
            return Expo.isExpoPushToken(message.to)
        })

        if (validMessages.length === 0) {
            logger.debug('No valid Expo push tokens found')
            return
        }

        // Create chunks to respect Expo's rate limits
        const chunks = this.expo.chunkPushNotifications(validMessages)

        for (const chunk of chunks) {
            // Retry with exponential backoff for 5 minutes
            const startTime = Date.now()
            const timeout = 300000 // 5 minutes
            let attempt = 0
            
            while (true) {
                try {
                    const ticketChunk = await this.expo.sendPushNotificationsAsync(chunk)
                    
                    // Log any errors but don't throw
                    const errors = ticketChunk.filter(ticket => ticket.status === 'error')
                    if (errors.length > 0) {
                        const errorDetails = errors.map(e => ({ message: e.message, details: e.details }))
                        logger.debug('[PUSH] Some notifications failed:', errorDetails)
                    }
                    
                    // If all notifications failed, throw to trigger retry
                    if (errors.length === ticketChunk.length) {
                        throw new Error('All push notifications in chunk failed')
                    }
                    
                    // Success - break out of retry loop
                    break
                } catch (error) {
                    const elapsed = Date.now() - startTime
                    if (elapsed >= timeout) {
                        logger.debug('[PUSH] Timeout reached after 5 minutes, giving up on chunk')
                        break
                    }
                    
                    // Calculate exponential backoff delay
                    attempt++
                    const delay = Math.min(1000 * Math.pow(2, attempt), 30000) // Max 30 seconds between retries
                    const remainingTime = timeout - elapsed
                    const waitTime = Math.min(delay, remainingTime)
                    
                    if (waitTime > 0) {
                        logger.debug(`[PUSH] Retrying in ${waitTime}ms (attempt ${attempt})`)
                        await new Promise(resolve => setTimeout(resolve, waitTime))
                    }
                }
            }
        }

        logger.debug(`Push notifications sent successfully`)
    }

    /**
     * Send a push notification to all registered devices for the user
     * @param title - Notification title
     * @param body - Notification body
     * @param data - Additional data to send with the notification
     */
    sendToAllDevices(title: string, body?: string, data?: Record<string, any>): void {
        logger.debug(`[PUSH] sendToAllDevices called with title: "${title}", body: "${body ?? ''}"`);
        
        // Execute async operations without awaiting
        (async () => {
            try {
                // Fetch all push tokens
                logger.debug('[PUSH] Fetching push tokens...')
                const tokens = await this.fetchPushTokens()
                logger.debug(`[PUSH] Fetched ${tokens.length} push tokens`)
                
                // Log token details for debugging
                tokens.forEach((token, index) => {
                    logger.debug(`[PUSH] Using token ${index + 1}: id=${token.id}`)
                })

                if (tokens.length === 0) {
                    logger.debug('No push tokens found for user')
                    return
                }

                // Create messages for all tokens
                const messages: ExpoPushMessage[] = tokens.map((token, index) => {
                    logger.debug(`[PUSH] Creating message ${index + 1} for token`)
                    return {
                        to: token.token,
                        title,
                        body: body && body.length > 0 ? body : undefined,
                        data,
                        // TODO: For brutalist session artwork, attach rich media via a public HTTPS image URL.
                        // Bundled app asset paths / require(...) / local file paths will not work in push payloads.
                        // iOS also needs a Notification Service Extension to render richContent.image reliably.
                        sound: 'default',
                        priority: 'high'
                    }
                })

                // Send notifications
                logger.debug(`[PUSH] Sending ${messages.length} push notifications...`)
                await this.sendPushNotifications(messages)
                logger.debug('[PUSH] Push notifications sent successfully')
            } catch (error) {
                logger.debug('[PUSH] Error sending to all devices:', error)
            }
        })()
    }

    sendSessionNotification(params: {
        kind: SessionNotificationKind
        metadata: Metadata | null | undefined
        data?: Record<string, any>
    }): void {
        const { title, body } = getSessionNotificationCopy(params.kind, params.metadata)
        const sessionTitle = getSessionNotificationBody(params.metadata)
        const url = getSessionNotificationUrl(params.data)
        this.sendToAllDevices(title, body, {
            ...params.data,
            kind: params.kind,
            sessionTitle,
            ...(url ? { url } : {}),
        })
    }
}
