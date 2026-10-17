/**
 * Telegram Integration Hook for Happy App
 *
 * Manages Telegram Mini App environment detection, SDK loading, and authentication.
 * Integrates with Happy's existing auth system.
 */

import { useEffect, useState, useCallback } from 'react'
import {
    isTelegramEnvironment,
    loadTelegramSdk,
    getTelegramWebApp,
    getTelegramInitData,
    type TelegramWebApp,
} from './useTelegram'
import { authWithTelegram } from '@/auth/authTelegram'
import { useAuth } from '@/auth/AuthContext'

export interface UseTelegramResult {
    /** Whether running inside Telegram Mini App */
    isTelegram: boolean
    /** Telegram WebApp SDK instance (null if not in Telegram) */
    telegram: TelegramWebApp | null
    /** Whether SDK is still loading */
    isLoading: boolean
    /** Error during SDK load or auth */
    error: string | null
    /** Authenticate with Telegram (if not already authenticated) */
    authenticateWithTelegram: () => Promise<void>
}

export function useHappyTelegram(serverUrl: string): UseTelegramResult {
    const [isTelegram, setIsTelegram] = useState(false)
    const [telegram, setTelegram] = useState<TelegramWebApp | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const { login, isAuthenticated } = useAuth()

    // Detect Telegram environment and load SDK
    useEffect(() => {
        const initTelegram = async () => {
            try {
                setIsLoading(true)
                setError(null)

                // Check if in Telegram environment
                const isInTelegram = isTelegramEnvironment()
                setIsTelegram(isInTelegram)

                if (!isInTelegram) {
                    setIsLoading(false)
                    return
                }

                // Load Telegram SDK
                await loadTelegramSdk(3000)

                // Get SDK instance
                const tg = getTelegramWebApp()
                if (!tg) {
                    throw new Error('Telegram WebApp SDK failed to load')
                }

                setTelegram(tg)

                // Notify Telegram that app is ready
                tg.ready()

                // Expand to full screen
                tg.expand()

                // Set theme based on Telegram's color scheme
                if (tg.colorScheme) {
                    // You can use this to sync with your app's theme
                    // e.g., dispatch theme change action
                }

                setIsLoading(false)
            } catch (err) {
                console.error('[Telegram] Init error:', err)
                setError(err instanceof Error ? err.message : 'Failed to initialize Telegram')
                setIsLoading(false)
            }
        }

        initTelegram()
    }, [])

    // Auto-authenticate with Telegram if not already authenticated
    const authenticateWithTelegram = useCallback(async () => {
        if (!isTelegram) {
            throw new Error('Not running in Telegram environment')
        }

        if (isAuthenticated) {
            console.log('[Telegram] Already authenticated, skipping')
            return
        }

        try {
            setError(null)

            // Get Telegram initData
            const initData = getTelegramInitData()
            if (!initData) {
                throw new Error('No Telegram initData available')
            }

            // Authenticate with Happy server
            const credentials = await authWithTelegram(initData, serverUrl)

            // Login to Happy
            await login(credentials.token, credentials.secret)

            console.log('[Telegram] Authentication successful')
        } catch (err) {
            console.error('[Telegram] Auth error:', err)
            const errorMessage = err instanceof Error ? err.message : 'Telegram authentication failed'
            setError(errorMessage)
            throw err
        }
    }, [isTelegram, isAuthenticated, serverUrl, login])

    return {
        isTelegram,
        telegram,
        isLoading,
        error,
        authenticateWithTelegram,
    }
}

/**
 * Hook to apply Telegram theme colors to your app
 */
export function useTelegramTheme() {
    const [themeColors, setThemeColors] = useState<Record<string, string>>({})

    useEffect(() => {
        const tg = getTelegramWebApp()
        if (!tg) return

        const colors: Record<string, string> = {}

        if (tg.themeParams.bg_color) {
            colors.background = tg.themeParams.bg_color
        }
        if (tg.themeParams.text_color) {
            colors.text = tg.themeParams.text_color
        }
        if (tg.themeParams.button_color) {
            colors.button = tg.themeParams.button_color
        }
        if (tg.themeParams.button_text_color) {
            colors.buttonText = tg.themeParams.button_text_color
        }

        setThemeColors(colors)
    }, [])

    return themeColors
}
