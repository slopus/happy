/** Saydo specs/agent-browser-one-click-install I5: the release publishes the images and the digests a machine pulls them by. */
import { describe, expect, it } from 'vitest'
import { configDigests, imagesManifest, sh } from './publish-images.mjs'

const digest = (c: string) => `sha256:${c.repeat(64)}`
const index = JSON.stringify({
    schemaVersion: 2,
    manifests: [
        { digest: digest('1'), platform: { os: 'linux', architecture: 'amd64' } },
        { digest: digest('2'), platform: { os: 'linux', architecture: 'arm64' } },
        // buildx attestation manifests carry no runnable platform.
        { digest: digest('3'), platform: { os: 'unknown', architecture: 'unknown' } },
    ],
})
const platformManifest: Record<string, string> = {
    [digest('1')]: JSON.stringify({ config: { digest: digest('a') } }),
    [digest('2')]: JSON.stringify({ config: { digest: digest('b') } }),
}

describe('release image publisher', () => {
    it('reads the image id (config digest) of each architecture from the pushed multi-arch index', () => {
        const fetched: string[] = []
        const ids = configDigests(index, (manifestDigest: string) => { fetched.push(manifestDigest); return platformManifest[manifestDigest] })
        expect(ids).toEqual({ amd64: digest('a'), arm64: digest('b') })
        expect(fetched).toEqual([digest('1'), digest('2')])
    })

    it('refuses an index that misses an architecture', () => {
        const amd64Only = JSON.stringify({ schemaVersion: 2, manifests: [{ digest: digest('1'), platform: { os: 'linux', architecture: 'amd64' } }] })
        expect(() => configDigests(amd64Only, (d: string) => platformManifest[d])).toThrow(/no arm64 image/)
    })

    it('writes abp-images.json with digest-pinned references and both architectures', () => {
        const runtime = { ref: `docker.io/namsangboy/abp-runtime@${digest('c')}`, ids: { amd64: digest('d'), arm64: digest('e') } }
        const browser = { ref: `docker.io/namsangboy/abp-browser@${digest('f')}`, ids: { amd64: digest('a'), arm64: digest('b') } }
        expect(imagesManifest({ version: '1.1.10-aplus.287', runtime, browser })).toEqual({ schemaVersion: 1, version: '1.1.10-aplus.287', runtime, browser })
        expect(() => imagesManifest({ version: 'v', runtime: { ...runtime, ref: 'docker.io/namsangboy/abp-runtime:1.0' }, browser })).toThrow(/runtime reference must be pinned by digest/)
        expect(() => imagesManifest({ version: 'v', runtime, browser: { ...browser, ids: { amd64: digest('a') } } })).toThrow(/browser image id for arm64/)
    })
})

describe('publisher commands', () => {
    // The 1.1.10-aplus.288 release stopped here: a command whose output goes straight to the log has no stdout to trim.
    it('runs a command that streams its output to the log', () => {
        expect(sh(process.execPath, ['-e', 'process.stdout.write("built")'], { stdio: 'inherit' })).toBe('')
    })

    it('returns the trimmed output of a captured command and fails on a non-zero exit', () => {
        expect(sh(process.execPath, ['-e', 'process.stdout.write(" sha256:abc \\n")'])).toBe('sha256:abc')
        expect(() => sh(process.execPath, ['-e', 'process.exit(3)'])).toThrow(/failed \(3\)/)
    })
})

