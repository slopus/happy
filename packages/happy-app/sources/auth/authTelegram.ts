/**
 * Telegram Authentication
 *
 * Validates Telegram initData with Happy server and obtains auth credentials.
 */

import { AuthCredentials } from './tokenStorage'

export interface TelegramAuthResponse {
    token: string
    secret: string
    user: {
        id: string
        email?: string
        telegramUserId?: number
        telegramUsername?: string
    }
}

export interface TelegramAuthError {
    error: string
    code?: string
}

/**
 * Authenticate with Happy server using Telegram initData
 *
 * @param initData - The initData string from Telegram WebApp
 * @param serverUrl - Happy server base URL
 * @returns Auth credentials (token + secret) on success
 * @throws Error if authentication fails
 */
export async function authWithTelegram(
    initData: string,
    serverUrl: string
): Promise<AuthCredentials> {
    const response = await fetch(`${serverUrl}/v1/auth/telegram`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ initData }),
    })

    if (!response.ok) {
        const errorData: TelegramAuthError = await response.json()
        throw new Error(errorData.error || 'Telegram authentication failed')
    }

    const data: TelegramAuthResponse = await response.json()

    return {
        token: data.token,
        secret: data.secret,
    }
}

/**
 * Bind existing Happy account to Telegram account
 *
 * @param initData - Telegram initData
 * @param existingToken - Existing Happy access token
 * @param serverUrl - Happy server base URL
 * @returns Updated credentials
 */
export async function bindTelegramAccount(
    initData: string,
    existingToken: string,
    serverUrl: string
): Promise<AuthCredentials> {
    const response = await fetch(`${serverUrl}/v1/auth/telegram/bind`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${existingToken}`,
        },
        body: JSON.stringify({ initData }),
    })

    if (!response.ok) {
        const errorData: TelegramAuthError = await response.json()
        throw new Error(errorData.error || 'Failed to bind Telegram account')
    }

    const data: TelegramAuthResponse = await response.json()

    return {
        token: data.token,
        secret: data.secret,
    }
}
