/**
 * Telegram Mini App Integration
 *
 * Detects if running inside Telegram and provides access to Telegram WebApp SDK.
 * Ported from HAPI web/src/hooks/useTelegram.ts
 */

/**
 * Detects if the current environment is Telegram Mini App
 * by checking URL hash/query parameters that Telegram passes.
 * This works BEFORE the SDK is loaded.
 */
export function isTelegramEnvironment(): boolean {
    if (typeof window === 'undefined') return false

    // Telegram passes launch params via window.location.hash
    // Format: #tgWebAppVersion=...&tgWebAppData=...&tgWebAppPlatform=...
    const hash = window.location.hash.slice(1)
    const hashParams = new URLSearchParams(hash)

    // Primary detection: check hash parameters
    if (hashParams.has('tgWebAppVersion') || hashParams.has('tgWebAppData')) {
        return true
    }

    // Fallback: check query parameters (alternative flow)
    const search = window.location.search
    if (search.includes('tgWebApp') || search.includes('initData')) {
        return true
    }

    return false
}

export type TelegramWebAppThemeParams = {
    bg_color?: string
    text_color?: string
    hint_color?: string
    link_color?: string
    button_color?: string
    button_text_color?: string
    secondary_bg_color?: string
}

export type TelegramWebAppUser = {
    id: number
    username?: string
    first_name: string
    last_name?: string
}

export type TelegramWebAppInitDataUnsafe = {
    start_param?: string
    user?: TelegramWebAppUser
}

export type TelegramWebApp = {
    initData: string
    initDataUnsafe?: TelegramWebAppInitDataUnsafe
    themeParams: TelegramWebAppThemeParams
    colorScheme?: 'light' | 'dark'
    ready: () => void
    expand: () => void
    close?: () => void
    onEvent?: (eventType: string, callback: () => void) => void
    offEvent?: (eventType: string, callback: () => void) => void
    BackButton?: {
        show: () => void
        hide: () => void
        onClick: (callback: () => void) => void
        offClick: (callback: () => void) => void
    }
    MainButton?: {
        text: string
        color: string
        textColor: string
        isVisible: boolean
        isActive: boolean
        show: () => void
        hide: () => void
        enable: () => void
        disable: () => void
        setText: (text: string) => void
        onClick: (callback: () => void) => void
        offClick: (callback: () => void) => void
    }
    HapticFeedback?: {
        impactOccurred: (style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft') => void
        notificationOccurred: (type: 'error' | 'success' | 'warning') => void
        selectionChanged: () => void
    }
    SettingsButton?: {
        isVisible: boolean
        show: () => void
        hide: () => void
        onClick: (callback: () => void) => void
        offClick: (callback: () => void) => void
    }
}

declare global {
    interface Window {
        Telegram?: {
            WebApp?: TelegramWebApp
        }
    }
}

export function getTelegramWebApp(): TelegramWebApp | null {
    return window.Telegram?.WebApp ?? null
}

/**
 * Checks if running inside a real Telegram Mini App.
 * Requires SDK to be loaded. Returns true only if initData is present.
 */
export function isTelegramApp(): boolean {
    const tg = getTelegramWebApp()
    return tg !== null && Boolean(tg.initData)
}

/**
 * Dynamically loads the Telegram Web App SDK with timeout.
 * Only call this if isTelegramEnvironment() returns true.
 */
export function loadTelegramSdk(timeoutMs = 3000): Promise<void> {
    return new Promise((resolve) => {
        if (window.Telegram?.WebApp) {
            resolve()
            return
        }

        let settled = false
        const settle = () => {
            if (!settled) {
                settled = true
                resolve()
            }
        }

        // Timeout - don't block app indefinitely
        setTimeout(settle, timeoutMs)

        const script = document.createElement('script')
        script.src = 'https://telegram.org/js/telegram-web-app.js'
        script.async = true
        script.onload = settle
        script.onerror = settle
        document.head.appendChild(script)
    })
}

/**
 * Extract Telegram initData from environment
 */
export function getTelegramInitData(): string | null {
    const tg = getTelegramWebApp()
    if (tg?.initData) {
        return tg.initData
    }

    // Fallback: check URL parameters (for testing or alternative flows)
    if (typeof window === 'undefined') return null

    const query = new URLSearchParams(window.location.search)
    const tgWebAppData = query.get('tgWebAppData')
    if (tgWebAppData) {
        return tgWebAppData
    }

    const initData = query.get('initData')
    return initData || null
}
