import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startPocStack, type PocStack } from './pocStack'

/** Runs a one-line Python HTTP probe inside a container, returning the status or the error class. */
function probe(container: string, url: string, host?: string): string {
    const script = [
        'import sys, urllib.request',
        `req = urllib.request.Request(${JSON.stringify(url)}${host ? `, headers={"Host": ${JSON.stringify(host)}}` : ''})`,
        'try:',
        '    print(urllib.request.urlopen(req, timeout=3).status)',
        'except urllib.error.HTTPError as e:',
        '    print(e.code)',
        'except Exception as e:',
        '    print(type(e).__name__)',
    ].join('\n')
    return execFileSync('docker', ['exec', container, 'python3', '-c', script], { encoding: 'utf8' }).trim()
}

/** Same probe from a node-only container (fixture/runtime), with an explicit Host header. */
function nodeProbe(container: string, hostname: string, hostHeader: string): string {
    const script = `require('http').get({ host: ${JSON.stringify(hostname)}, port: 9223, path: '/json/version', headers: { Host: ${JSON.stringify(hostHeader)} }, timeout: 3000 }, (r) => { console.log(r.statusCode); r.resume() }).on('error', (e) => console.log(e.code))`
    return execFileSync('docker', ['exec', container, 'node', '-e', script], { encoding: 'utf8' }).trim()
}

describe('PoC container isolation', () => {
    let stack: PocStack
    beforeAll(async () => { stack = await startPocStack() }, 300_000)
    afterAll(() => stack?.down({ purge: true }))

    it('a browser cannot reach the other profile\'s CDP endpoint, and CDP refuses unexpected Host headers', () => {
        const { browserA, browserB, fixture } = stack.env.containers as Record<string, string>
        // Separate networks: browser-b does not even resolve browser-a.
        expect(probe(browserB, 'http://browser-a:9223/json/version')).toBe('URLError')
        expect(probe(browserA, 'http://browser-b:9223/json/version')).toBe('URLError')
        // The fixture shares browser-a's network, but a forged Host is refused by the proxy.
        expect(nodeProbe(fixture, 'browser-a', 'localhost:9222')).toBe('403')
        expect(nodeProbe(fixture, 'browser-a', 'browser-a:9223')).toBe('200')
    })
})
