import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

export const BROWSER_NATIVE_HOST_NAME = 'ai.saycode.happy_browser'
const BROWSER_NATIVE_HOST_FILE = `${BROWSER_NATIVE_HOST_NAME}.json`

export async function prepareBrowserNativeMessaging({ readToken, registerHost, onRegistrationError }: {
    readToken: () => Promise<string>
    registerHost: () => Promise<string | null>
    onRegistrationError: (error: unknown) => void
}): Promise<{ token: string; manifestPath: string | null }> {
    // Finish legacy-token migration before Chrome can discover and launch the
    // helper. Otherwise the helper can create a new machine-wide token first.
    const token = await readToken()
    try {
        return { token, manifestPath: await registerHost() }
    } catch (error) {
        onRegistrationError(error)
        return { token, manifestPath: null }
    }
}

export function resolveBrowserNativeHostManifestPath({ platform, homeDir }: {
    platform: NodeJS.Platform
    homeDir: string
}): string | null {
    if (platform === 'darwin') {
        return join(
            homeDir,
            'Library',
            'Application Support',
            'Google',
            'Chrome',
            'NativeMessagingHosts',
            BROWSER_NATIVE_HOST_FILE,
        )
    }
    if (platform === 'linux') {
        return join(
            homeDir,
            '.config',
            'google-chrome',
            'NativeMessagingHosts',
            BROWSER_NATIVE_HOST_FILE,
        )
    }
    return null
}

/** The same extension published on the Chrome Web Store; users install it there instead of loading the bundle unpacked. */
export const CHROME_WEB_STORE_EXTENSION_ID = 'oonefemjapkafdiibkllemkjdlmmblbc'

export function buildBrowserNativeHostManifest({ extensionId, helperPath }: {
    extensionId: string
    helperPath: string
}) {
    if (!isAbsolute(helperPath)) {
        throw new Error('Native Messaging helper path must be absolute')
    }
    return {
        name: BROWSER_NATIVE_HOST_NAME,
        description: 'Provides local Happy Browser Bridge pairing settings',
        path: helperPath,
        type: 'stdio' as const,
        allowed_origins: [...new Set([extensionId, CHROME_WEB_STORE_EXTENSION_ID])].map(id => `chrome-extension://${id}/`),
    }
}

export async function registerBrowserNativeHost({ platform, homeDir, extensionId, helperPath }: {
    platform: NodeJS.Platform
    homeDir: string
    extensionId: string
    helperPath: string
}): Promise<string | null> {
    const manifestPath = resolveBrowserNativeHostManifestPath({ platform, homeDir })
    if (!manifestPath) return null

    const manifest = buildBrowserNativeHostManifest({ extensionId, helperPath })
    await mkdir(dirname(manifestPath), { recursive: true })
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    return manifestPath
}
