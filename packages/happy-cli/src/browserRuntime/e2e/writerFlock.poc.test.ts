/**
 * D9 writer lock on real containers: a second Runtime container on the same
 * state volume must exit at once (flock -n, status 75) while the first keeps
 * serving; once the first dies the kernel drops the lock and a new container
 * can take over.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RequestId } from '../contracts'
import { PROFILE_A, startPocStack, type PocStack } from './pocStack'

const runDir = (run: string) => join(resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts/browser-poc/.abp'), run)
const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const logs = (container: string) => spawnSync('docker', ['logs', container], { encoding: 'utf8' }).stderr

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
        const value = probe()
        if (value !== undefined) return value
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
        await new Promise((r) => setTimeout(r, 250))
    }
}

describe('Runtime writer flock on overlapping containers', () => {
    let stack: PocStack
    beforeAll(async () => { stack = await startPocStack() }, 300_000)
    afterAll(() => stack?.down({ purge: true }))

    /** Same image, bundle, keys, env and state volume as the harness Runtime; no published ports. */
    const startSecondRuntime = (suffix: string): string => {
        const first = stack.env.containers.runtime
        const image = docker(['inspect', '-f', '{{.Config.Image}}', first])
        const env = JSON.parse(readFileSync(join(runDir(stack.run), 'runtime-env.json'), 'utf8')) as Record<string, string>
        const name = `abp-${stack.run}-runtime-${suffix}`
        docker(['run', '-d', '--name', name, '--label', `ai.saycode.abp-run=${stack.run}`, '--network', `abp-${stack.run}-a`,
            '--read-only', '--tmpfs', '/tmp:rw,size=64m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '-v', `abp-${stack.run}-state:/var/lib/abp`, '-v', `${resolve(runDir(stack.run), '../runtime.mjs')}:/app/runtime.mjs:ro`,
            '-v', `${join(runDir(stack.run), 'keys.json')}:/app/keys.json:ro`,
            ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]), image])
        // Profile B's browser sits on its own network, like the harness Runtime's second attachment.
        spawnSync('docker', ['network', 'connect', `abp-${stack.run}-b`, name])
        return name
    }

    it('reports the flock as held by the running Runtime', () => {
        expect(logs(stack.env.containers.runtime)).toMatch(/listening .*flock=true/)
    })

    it('makes a second Runtime on the same state volume exit immediately while the first keeps serving', async () => {
        const second = startSecondRuntime('dup')
        const exit = await waitFor(() => {
            const [status, code] = docker(['inspect', '-f', '{{.State.Status}} {{.State.ExitCode}}', second]).split(' ')
            return status === 'exited' ? Number(code) : undefined
        }, 15_000, 'the second Runtime to exit')
        expect(exit).toBe(75)
        expect(logs(second)).not.toMatch(/listening/)
        const { token } = stack.mintAgent()
        const space = await stack.client(token).createSpace({ profileId: PROFILE_A, requestId: randomUUID() as RequestId })
        expect(space.taskSpaceId).toBeTruthy()
        docker(['rm', '-f', second])
    }, 60_000)

    it('lets a new Runtime take over once the lock holder is killed', async () => {
        docker(['kill', stack.env.containers.runtime])
        const replacement = startSecondRuntime('next')
        const listening = await waitFor(() => /listening .*flock=true/.test(logs(replacement)) ? true : undefined, 90_000, 'the replacement Runtime to listen')
        expect(listening).toBe(true)
        expect(docker(['inspect', '-f', '{{.State.Status}}', replacement])).toBe('running')
        docker(['rm', '-f', replacement])
    }, 120_000)
})
