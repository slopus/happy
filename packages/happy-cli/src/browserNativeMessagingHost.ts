import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_BROWSER_BRIDGE_PORT, resolveBrowserBridgeHost } from './daemon/browserBridgeConfig'
import { runBrowserNativeMessagingHost } from './daemon/browserNativeMessagingHost'
import { readOrCreateBrowserBridgeToken, resolveBrowserBridgeTokenFile } from './daemon/browserBridgeToken'
import { readFile } from 'node:fs/promises'

const userHome = homedir()
const happyHomeDir = process.env.HAPPY_HOME_DIR?.replace(/^~/, userHome) ?? join(userHome, '.happy')
const bridgeToken = resolveBrowserBridgeTokenFile({ homeDir: userHome, happyHomeDir })

void runBrowserNativeMessagingHost({
    input: process.stdin,
    write: (chunk) => { process.stdout.write(chunk) },
    writeError: (message) => { process.stderr.write(message) },
    readToken: () => readOrCreateBrowserBridgeToken(bridgeToken.tokenFile, {
        migrateFrom: bridgeToken.migrateFrom,
    }),
    port: DEFAULT_BROWSER_BRIDGE_PORT,
    host: resolveBrowserBridgeHost(process.env),
    consumeSetup: async operationId => {
        // Chrome does not inherit the daemon's HAPPY_HOME_DIR. Probe only the
        // documented personal/Standalone homes; each endpoint authenticates
        // with that home's own control secret and accepts its own nonce only.
        for (const home of new Set([happyHomeDir, join(userHome, '.happy_local'), join(userHome, '.happy_local_dev')])) {
            try {
                const state = JSON.parse(await readFile(join(home, 'daemon.state.json'), 'utf8'))
                if (!Number.isInteger(state.httpPort) || state.httpPort < 1 || state.httpPort > 65535 || typeof state.controlSecret !== 'string') continue
                const response = await fetch(`http://127.0.0.1:${state.httpPort}/browser/local-setup/consume`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.controlSecret}` },
                    body: JSON.stringify({ operationId }), signal: AbortSignal.timeout(2000),
                })
                if (response.ok) return await response.json()
            } catch { /* try the other explicitly known local runtime */ }
        }
        throw new Error('SETUP_UNAVAILABLE')
    },
})
