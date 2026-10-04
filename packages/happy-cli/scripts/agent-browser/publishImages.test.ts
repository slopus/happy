/** Saydo specs/agent-browser-one-click-install I5: the release publishes the images and the digests a machine pulls them by. */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
    it.skipIf(process.platform === 'win32')('runs the publisher through inherited build output and writes the image manifest', () => {
        const root = mkdtempSync(join(tmpdir(), 'abp-publisher-test-'))
        try {
            // The release runs on Linux. Replace Docker entirely: this test never pushes images.
            writeFileSync(join(root, 'docker'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.ABP_TEST_DOCKER_LOG, JSON.stringify(args) + '\\n');
const digest = c => 'sha256:' + c.repeat(64);
if (args[1] === 'build') {
    fs.writeFileSync(args[args.indexOf('--metadata-file') + 1], JSON.stringify({ 'containerimage.digest': digest('c') }));
    console.log('fake build output');
} else if (args[1] === 'imagetools') {
    const ref = args.at(-1);
    console.log(JSON.stringify(ref.endsWith(digest('c')) ? {
        manifests: ['amd64', 'arm64'].map((architecture, i) => ({ digest: digest(String(i + 1)), platform: { os: 'linux', architecture } }))
    } : { config: { digest: digest(ref.endsWith(digest('1')) ? 'a' : 'b') } }));
} else { process.exit(1); }
`, { mode: 0o700 })
            const output = join(root, 'abp-images.json')
            const log = join(root, 'docker.jsonl')
            const result = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'publish-images.mjs'),
                '--repo', 'fixture', '--version', '1.1.10-aplus.289', '--out', output], {
                encoding: 'utf8', timeout: 15_000,
                env: { ...process.env, PATH: `${root}:${process.env.PATH}`, TMPDIR: root, ABP_TEST_DOCKER_LOG: log },
            })
            expect(result.stderr).toBe('')
            expect(result.status).toBe(0)
            const image = (role: string) => ({ ref: `docker.io/fixture/abp-${role}@${digest('c')}`, ids: { amd64: digest('a'), arm64: digest('b') } })
            expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({ schemaVersion: 1, version: '1.1.10-aplus.289', runtime: image('runtime'), browser: image('browser') })
            const builds = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]).filter(args => args[1] === 'build')
            expect(builds).toHaveLength(2)
            for (const [i, role] of ['runtime', 'browser'].entries()) {
                expect(builds[i]).toContain('--push')
                expect(builds[i][builds[i].indexOf('--platform') + 1]).toBe('linux/amd64,linux/arm64')
                expect(builds[i][builds[i].indexOf('-t') + 1]).toBe(`docker.io/fixture/abp-${role}:1.1.10-aplus.289`)
            }
        } finally { rmSync(root, { recursive: true, force: true }) }
    }, 20_000)

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
    it('runs a command that streams its output to the log', () => {
        expect(sh(process.execPath, ['-e', 'process.stdout.write("built")'], { stdio: 'inherit' })).toBe('')
    })

    it('returns the trimmed output of a captured command and fails on a non-zero exit', () => {
        expect(sh(process.execPath, ['-e', 'process.stdout.write(" sha256:abc \\n")'])).toBe('sha256:abc')
        expect(() => sh(process.execPath, ['-e', 'process.exit(3)'])).toThrow(/failed \(3\)/)
    })
})
