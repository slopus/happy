import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { PROFILE_COPY } from './lib/profileCopy.mjs'

describe('legacy copy manifest', () => {
    it('copies and verifies files, directories and symlinks without following links; resume replaces only partial destination', () => {
        const root = mkdtempSync(join(tmpdir(), 'abp-copy-'))
        try {
            const source = join(root, 'source'), target = join(root, 'target'), external = join(root, 'outside')
            mkdirSync(source); mkdirSync(target); mkdirSync(external)
            writeFileSync(join(external, 'keep'), 'outside')
            mkdirSync(join(source, 'Default'))
            writeFileSync(join(source, 'Default', 'Cookies'), 'synthetic cookie bytes')
            symlinkSync(external, join(source, 'SingletonSocket'))
            // Host test cannot chown to production UID. All copy/hash/link logic runs unchanged.
            const script = PROFILE_COPY.replaceAll("'/from'", JSON.stringify(source)).replaceAll("'/to'", JSON.stringify(target))
                .replace(/os\.chown\([^\n]+/g, 'None').replace('os.sync()', 'None')
            const run = (...args: string[]) => spawnSync('python3', ['-c', script, ...args], { encoding: 'utf8' })
            const copied = run()
            expect(copied.status, copied.stderr).toBe(0)
            expect(JSON.parse(copied.stdout).verified).toBe(true)
            expect(readFileSync(join(target, 'Default', 'Cookies'), 'utf8')).toBe('synthetic cookie bytes')
            expect(run().status).not.toBe(0)
            writeFileSync(join(target, 'partial'), 'incomplete')
            const resumed = run('--resume')
            expect(resumed.status, resumed.stderr).toBe(0)
            expect(JSON.parse(resumed.stdout).sha256).toBe(JSON.parse(copied.stdout).sha256)
            expect(readFileSync(join(external, 'keep'), 'utf8')).toBe('outside')
        } finally { rmSync(root, { recursive: true, force: true }) }
    })
})
