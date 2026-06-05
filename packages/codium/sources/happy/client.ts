import { useSyncExternalStore } from 'react'
import type {
    HappyAuthenticatedClientStatus,
    HappyStateSnapshot,
} from '@/shared/happy-protocol'

const initialState: HappyStateSnapshot = {
    status: 'starting',
    serverUrl: '',
    webappUrl: '',
    clientReady: false,
    updatedAt: Date.now(),
}

let snapshot = initialState
let unsubscribeIpc: (() => void) | null = null
let initialized = false
const listeners = new Set<() => void>()

function emit(next: HappyStateSnapshot): void {
    snapshot = next
    for (const listener of listeners) listener()
}

function setError(message: string): void {
    emit({
        ...snapshot,
        status: 'error',
        error: message,
        updatedAt: Date.now(),
    })
}

function ensureStarted(): void {
    if (initialized) return
    initialized = true
    try {
        unsubscribeIpc = window.happy.onState(emit)
        void window.happy.getState().then(emit).catch((err) => {
            setError(err instanceof Error ? err.message : String(err))
        })
    } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
    }
}

export const happyClient = {
    start(): void {
        ensureStarted()
    },
    getSnapshot(): HappyStateSnapshot {
        return snapshot
    },
    subscribe(listener: () => void): () => void {
        ensureStarted()
        listeners.add(listener)
        return () => {
            listeners.delete(listener)
            if (listeners.size === 0 && unsubscribeIpc) {
                unsubscribeIpc()
                unsubscribeIpc = null
                initialized = false
            }
        }
    },
    async createAccount(): Promise<HappyStateSnapshot> {
        ensureStarted()
        const next = await window.happy.createAccount()
        emit(next)
        return next
    },
    async startLinkDevice(): Promise<HappyStateSnapshot> {
        ensureStarted()
        const next = await window.happy.startLinkDevice()
        emit(next)
        return next
    },
    async restoreSecret(secretKey: string): Promise<HappyStateSnapshot> {
        ensureStarted()
        const next = await window.happy.restoreSecret(secretKey)
        emit(next)
        return next
    },
    async cancelAuth(): Promise<HappyStateSnapshot> {
        ensureStarted()
        const next = await window.happy.cancelAuth()
        emit(next)
        return next
    },
    async logout(): Promise<HappyStateSnapshot> {
        ensureStarted()
        const next = await window.happy.logout()
        emit(next)
        return next
    },
    async clientStatus(): Promise<HappyAuthenticatedClientStatus> {
        ensureStarted()
        return window.happy.clientStatus()
    },
}

export function useHappyState(): HappyStateSnapshot {
    return useSyncExternalStore(
        happyClient.subscribe,
        happyClient.getSnapshot,
        happyClient.getSnapshot,
    )
}
