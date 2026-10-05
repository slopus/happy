import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
    buildBrowserNativeHostManifest,
    prepareBrowserNativeMessaging,
    registerBrowserNativeHost,
    resolveBrowserNativeHostManifestPath,
} from './browserNativeHostRegistration'

const EXTENSION_ID = 'emaponnolfbhnoaabgiebjmbdlmoifke'
const HOST_FILE = 'ai.saycode.happy_browser.json'
const tempDirs: string[] = []

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('browser native host registration', () => {
    it('prepares or migrates the bridge token before exposing the native host manifest', async () => {
        const events: string[] = []

        const result = await prepareBrowserNativeMessaging({
            readToken: async () => {
                events.push('token')
                return 'migrated-token'
            },
            registerHost: async () => {
                events.push('manifest')
                return '/tmp/native-host.json'
            },
            onRegistrationError: () => {},
        })

        expect(events).toEqual(['token', 'manifest'])
        expect(result).toEqual({
            token: 'migrated-token',
            manifestPath: '/tmp/native-host.json',
        })
    })

    it('keeps the prepared token available when native host registration fails', async () => {
        const errors: unknown[] = []

        const result = await prepareBrowserNativeMessaging({
            readToken: async () => 'existing-token',
            registerHost: async () => { throw new Error('read-only directory') },
            onRegistrationError: (error) => { errors.push(error) },
        })

        expect(result).toEqual({ token: 'existing-token', manifestPath: null })
        expect(errors).toHaveLength(1)
    })

    it('resolves the macOS user-level Google Chrome manifest path', () => {
        expect(resolveBrowserNativeHostManifestPath({
            platform: 'darwin',
            homeDir: '/Users/happy',
        })).toBe(`/Users/happy/Library/Application Support/Google/Chrome/NativeMessagingHosts/${HOST_FILE}`)
    })

    it('resolves the Linux user-level Google Chrome manifest path', () => {
        expect(resolveBrowserNativeHostManifestPath({
            platform: 'linux' as const,
            homeDir: '/home/happy',
        })).toBe(`/home/happy/.config/google-chrome/NativeMessagingHosts/${HOST_FILE}`)
    })

    it('does not register a Chrome host on unsupported platforms', () => {
        expect(resolveBrowserNativeHostManifestPath({
            platform: 'win32',
            homeDir: 'C:\\Users\\happy',
        })).toBeNull()
    })

    it('allows only the bundled Happy extension and its Chrome Web Store listing', () => {
        expect(buildBrowserNativeHostManifest({
            extensionId: EXTENSION_ID,
            helperPath: '/opt/happy/bin/happy-browser-native-host.mjs',
        })).toEqual({
            name: 'ai.saycode.happy_browser',
            description: 'Provides local Happy Browser Bridge pairing settings',
            path: '/opt/happy/bin/happy-browser-native-host.mjs',
            type: 'stdio',
            allowed_origins: [`chrome-extension://${EXTENSION_ID}/`, 'chrome-extension://oonefemjapkafdiibkllemkjdlmmblbc/'],
        })
    })

    it('rejects a relative helper path', () => {
        expect(() => buildBrowserNativeHostManifest({
            extensionId: EXTENSION_ID,
            helperPath: 'bin/happy-browser-native-host.mjs',
        })).toThrow('absolute')
    })

    it('writes the same user-level manifest when registration runs repeatedly', async () => {
        const homeDir = await mkdtemp(join(tmpdir(), 'happy-native-host-'))
        tempDirs.push(homeDir)
        const input = {
            platform: 'linux' as const,
            homeDir,
            extensionId: EXTENSION_ID,
            helperPath: '/opt/happy/bin/happy-browser-native-host.mjs',
        }

        const first = await registerBrowserNativeHost(input)
        const firstContents = await readFile(first!, 'utf8')
        const second = await registerBrowserNativeHost(input)

        expect(second).toBe(first)
        expect(await readFile(second!, 'utf8')).toBe(firstContents)
        expect(JSON.parse(firstContents).allowed_origins).toEqual([
            `chrome-extension://${EXTENSION_ID}/`,
            'chrome-extension://oonefemjapkafdiibkllemkjdlmmblbc/',
        ])
    })
})
