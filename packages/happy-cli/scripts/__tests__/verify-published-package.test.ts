import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const script = join(__dirname, '..', 'verify-published-package.sh')
const directories: string[] = []

afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function verify(version = '1.1.10-aplus.274', options: { unavailable?: boolean; guardFails?: boolean; wrongVersion?: boolean; tarballUnavailable?: boolean } = {}) {
    const directory = mkdtempSync(join(tmpdir(), 'happy-registry-test-'))
    directories.push(directory)
    const calls = join(directory, 'calls')
    const state = join(directory, 'state')
    for (const command of ['npm', 'curl', 'sleep', 'node']) {
        const program = command === 'npm'
            ? `if [ "$1" = view ]; then
  if [ "${options.unavailable ? 'yes' : 'no'}" = yes ] || [ ! -f '${state}' ]; then touch '${state}'; exit 1; fi
  echo 'https://registry.npmjs.org/@buzzni/happy-cli/-/happy-cli-1.1.10-aplus.274.tgz'
elif [ "$1" = pack ]; then
  echo '[{"name":"@buzzni/happy-cli","version":"${options.wrongVersion ? '1.1.10-aplus.273' : '1.1.10-aplus.274'}","filename":"happy.tgz"}]'
else exit 99; fi`
            : command === 'curl'
                ? `exit ${options.tarballUnavailable ? 1 : 0}`
                : command === 'node'
                    ? `if [ "$1" = -e ]; then exec '${process.execPath}' "$@"; fi
exit ${options.guardFails ? 1 : 0}`
                    : 'exit 0'
        const commandPath = join(directory, command)
        writeFileSync(commandPath, `#!/bin/sh\nprintf '%s\\n' '${command} '"$*" >> '${calls}'\n${program}\n`)
        chmodSync(commandPath, 0o755)
    }
    const result = spawnSync('bash', [script, version], {
        encoding: 'utf8', timeout: 15_000,
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
    })
    return { ...result, calls: readFileSync(calls, { encoding: 'utf8', flag: 'a+' }) }
}

describe('published package verification without publication', () => {
    it('waits for propagation then guards the exact release with a fresh install', () => {
        const result = verify()
        expect(result.status, result.stderr).toBe(0)
        expect(result.calls).toContain('npm view @buzzni/happy-cli@1.1.10-aplus.274 dist.tarball')
        expect(result.calls).toContain('sleep 30')
        expect(result.calls).toContain('npm pack @buzzni/happy-cli@1.1.10-aplus.274 --ignore-scripts')
        expect(result.calls).toMatch(/node .*guard-publish-artifact.cjs .*happy.tgz --install-smoke/)
        expect(result.calls).not.toMatch(/npm (publish|dist-tag|deprecate)/)
    })

    it.each(['latest', '1.1.10-aplus.274;echo unsafe', '', '../274'])('rejects non-release input %j before npm runs', (version) => {
        const result = verify(version)
        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain('Expected an exact A+ CLI release version')
        expect(result.calls).not.toContain('npm ')
    })

    it.each([{ unavailable: true }, { tarballUnavailable: true }])('fails after bounded propagation retries without installing %j', (options) => {
        const result = verify('1.1.10-aplus.274', options)
        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain('Published package is not available')
        expect(result.calls.match(/npm view/g)).toHaveLength(60)
        expect(result.calls).not.toContain('npm pack')
        expect(result.calls).not.toContain('guard-publish-artifact')
    })

    it('rejects a packed package with the wrong version before guarding it', () => {
        const result = verify('1.1.10-aplus.274', { wrongVersion: true })
        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain('Packed release does not match')
        expect(result.calls).not.toContain('guard-publish-artifact')
    })

    it('propagates artifact guard and fresh-install failures', () => {
        const result = verify('1.1.10-aplus.274', { guardFails: true })
        expect(result.calls).toContain('--install-smoke')
        expect(result.status).not.toBe(0)
    })
})
