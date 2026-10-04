export const BROWSER_NATIVE_HOST_NAME = 'ai.saycode.happy_browser'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

export async function attemptNativePairing(chromeApi) {
    const stored = await chromeApi.storage.local.get(['token', 'viewerKey', 'pairingId'])
    const storedToken = stored.token
    const storedViewerKey = stored.viewerKey
    const viewerScoped = typeof stored.viewerKey === 'string'
        && /^bv1_[A-Za-z0-9_-]{32}$/.test(stored.viewerKey)
    if (hasToken(stored) && (!viewerScoped || stored.pairingId)) {
        return { status: 'already-configured' }
    }

    let response
    try {
        response = await chromeApi.runtime.sendNativeMessage(
            BROWSER_NATIVE_HOST_NAME,
            { type: 'pair' },
        )
    } catch {
        return { status: 'unavailable' }
    }

    if (!isValidPairingResponse(response)) {
        return { status: 'invalid-response' }
    }
    const current = await chromeApi.storage.local.get(['token', 'viewerKey'])
    if (current.token !== storedToken || current.viewerKey !== storedViewerKey) {
        return { status: 'already-configured' }
    }

    await chromeApi.storage.local.set({
        token: response.config.token,
        port: response.config.port,
        host: response.config.host,
        ...(response.config.viewerKey ? { viewerKey: response.config.viewerKey } : {}),
    })
    return { status: 'paired' }
}

// A Desktop setup link carries a one-time operation id, never credentials.
export async function attemptSetupPairing(chromeApi, operationId) {
    if (!/^[A-Za-z0-9_-]{32}$/.test(operationId)) return { status: 'invalid-response' }
    let response
    try {
        response = await chromeApi.runtime.sendNativeMessage(BROWSER_NATIVE_HOST_NAME, { type: 'setup-pair', operationId })
    } catch {
        try { response = await exchangeSetupOverLoopback(operationId) }
        catch { return { status: 'unavailable' } }
    }
    const config = response?.config
    if (!isValidPairingResponse(response) || !LOOPBACK_HOSTS.has(config.host)
        || !/^bv1_[A-Za-z0-9_-]{32}$/.test(config.viewerKey ?? '')
        || config.pairingId !== operationId || typeof config.profile !== 'string' || !config.profile.trim()) {
        return { status: 'invalid-response' }
    }
    await chromeApi.storage.local.set({ token: config.token, port: config.port, host: config.host,
        viewerKey: config.viewerKey, pairingId: config.pairingId, profile: config.profile })
    return { status: 'paired' }
}

function exchangeSetupOverLoopback(operationId) {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:41777/setup-pair?operationId=${operationId}`)
        const timer = setTimeout(() => { socket.close(); reject(new Error('setup timeout')) }, 5000)
        socket.onmessage = event => {
            clearTimeout(timer)
            try { resolve(JSON.parse(event.data)) } catch { reject(new Error('invalid setup')) }
            socket.close()
        }
        socket.onerror = socket.onclose = () => { clearTimeout(timer); reject(new Error('setup unavailable')) }
    })
}

function hasToken(stored) {
    return typeof stored.token === 'string' && Boolean(stored.token.trim())
}

function isValidPairingResponse(response) {
    const config = response?.config
    return response?.ok === true
        && typeof config?.token === 'string'
        && config.token.length > 0
        && Number.isInteger(config?.port)
        && config.port > 0
        && config.port <= 65535
        && (
            LOOPBACK_HOSTS.has(config?.host)
            || (
                config?.host === 'host.docker.internal'
                && typeof config?.viewerKey === 'string'
                && /^bv1_[A-Za-z0-9_-]{32}$/.test(config.viewerKey)
            )
        )
}
