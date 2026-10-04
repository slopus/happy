import { readDaemonControlPort } from './browserClient'

export function registerBrowserLocalSetupRpc(manager: {
    registerHandler(method: string, handler: (params: unknown) => Promise<unknown>): void
}) {
    for (const action of ['begin', 'status', 'revoke'] as const) {
        manager.registerHandler(`browser-local-setup:${action}`, async params => {
            const control = await readDaemonControlPort()
            if (!control) throw new Error('BROWSER_SETUP_OFFLINE')
            const response = await fetch(`http://127.0.0.1:${control.port}/browser/local-setup/${action}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${control.controlSecret}` },
                body: JSON.stringify(params), signal: AbortSignal.timeout(10000),
            })
            if (!response.ok) throw new Error(response.status === 404 ? 'BROWSER_SETUP_UPGRADE_REQUIRED' : 'BROWSER_SETUP_UNAVAILABLE')
            return response.json()
        })
    }
}
