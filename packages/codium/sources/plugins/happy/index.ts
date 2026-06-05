import { happyClient } from '@/happy/client'
import type {
    AuthState,
    Capability,
    Plugin,
    PluginContext,
} from '../types'
import type { HappyStateSnapshot } from '@/shared/happy-protocol'

function mapAuth(state: HappyStateSnapshot): AuthState {
    switch (state.status) {
        case 'authenticated':
            return { status: 'connected', account: state.accountId }
        case 'authenticating':
        case 'starting':
            return { status: 'connecting' }
        case 'error':
            return { status: 'error', message: state.error ?? 'Happy authentication failed' }
        case 'unconfigured':
            return { status: 'unconfigured' }
    }
}

class HappyPlugin implements Plugin {
    id = 'happy'
    name = 'Happy'
    description = 'Encrypted Happy account connection for future sync and remote session support.'
    vendor = 'Happy'
    category = 'integrations' as const
    accent = '#2563eb'

    private auth: AuthState = { status: 'connecting' }
    private capabilities: Capability[] = []
    private unsubscribe: (() => void) | null = null

    async activate(ctx: PluginContext) {
        happyClient.start()
        this.auth = mapAuth(happyClient.getSnapshot())
        this.unsubscribe = happyClient.subscribe(() => {
            this.auth = mapAuth(happyClient.getSnapshot())
            ctx.onAuthChanged()
        })
    }

    async connect(_credential: string, ctx: PluginContext): Promise<AuthState> {
        this.auth = { status: 'connecting' }
        ctx.onAuthChanged()
        const next = await happyClient.startLinkDevice()
        this.auth = mapAuth(next)
        ctx.onAuthChanged()
        return this.auth
    }

    async disconnect(ctx: PluginContext) {
        await happyClient.logout()
        this.auth = mapAuth(happyClient.getSnapshot())
        ctx.onAuthChanged()
    }

    getAuthState(): AuthState { return this.auth }
    getCapabilities(): readonly Capability[] { return this.capabilities }

    dispose(): void {
        this.unsubscribe?.()
        this.unsubscribe = null
    }
}

export const happyPlugin: Plugin = new HappyPlugin()
