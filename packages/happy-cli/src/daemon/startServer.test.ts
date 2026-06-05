import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { startServerProcess, StartServerError } from './startServer'

// Tiny Node script used by most tests. Writes $OUT (if set) and sleeps.
// Kept on disk as a file (no -e) so tokenizeCommand does not have to
// handle quoted inline JavaScript.
function writeSleepScript(dir: string, ms: number): string {
  const script = `
const fs = require('fs')
const out = process.env.OUT
if (out) fs.writeFileSync(out, process.env.TEST_VAR || '')
setTimeout(() => process.exit(0), ${ms})
`
  const p = path.join(dir, 'sleep.js')
  writeFileSync(p, script)
  return p
}

// Kill a spawned pid. Used to clean up after the `process stays alive`
// checks so we don't leak 2-second sleepers into parallel test runs.
function kill(pid: number) {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}

async function waitForFile(filePath: string, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(filePath)) {
    if (Date.now() >= deadline) return false
    await sleep(25)
  }
  return true
}

describe('startServerProcess', () => {
  const dirs: string[] = []
  afterEach(() => {
    while (dirs.length) {
      const d = dirs.pop()
      if (d) rmSync(d, { recursive: true, force: true })
    }
  })

  function mkdir(): string {
    const d = mkdtempSync(path.join(tmpdir(), 'start-server-'))
    dirs.push(d)
    return d
  }

  it('spawns a node process and returns its pid', async () => {
    const dir = mkdir()
    const script = writeSleepScript(dir, 2000)
    const { pid } = await startServerProcess({
      command: `node ${script}`,
      cwd: dir,
    })
    expect(Number.isInteger(pid)).toBe(true)
    // pid must be a live process at the moment we claim success. Sending
    // signal 0 performs the liveness check without delivering a signal.
    expect(() => process.kill(pid, 0)).not.toThrow()
    kill(pid)
  })

  it('injects req.env into the child process environment', async () => {
    const dir = mkdir()
    const script = writeSleepScript(dir, 2000)
    const outPath = path.join(dir, 'out.txt')
    const { pid } = await startServerProcess({
      command: `node ${script}`,
      cwd: dir,
      env: { OUT: outPath, TEST_VAR: 'elastic_id=seen' },
    })
    expect(await waitForFile(outPath)).toBe(true)
    expect(readFileSync(outPath, 'utf-8')).toBe('elastic_id=seen')
    kill(pid)
  })

  it('rejects with CWD_NOT_FOUND when the working directory is missing', async () => {
    await expect(
      startServerProcess({
        command: 'node server.js',
        cwd: '/definitely/not/a/real/path/xyz-123',
      }),
    ).rejects.toBeInstanceOf(StartServerError)

    await expect(
      startServerProcess({
        command: 'node server.js',
        cwd: '/definitely/not/a/real/path/xyz-123',
      }),
    ).rejects.toMatchObject({ code: 'CWD_NOT_FOUND' })
  })

  it('rejects with INVALID_COMMAND on shell metacharacters', async () => {
    const dir = mkdir()
    await expect(
      startServerProcess({
        command: 'node server.js && echo hi',
        cwd: dir,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_COMMAND' })
  })

  it('rejects with EXEC_NOT_FOUND when the executable is not on PATH', async () => {
    const dir = mkdir()
    await expect(
      startServerProcess(
        {
          command: 'nonexistent-binary-xyz-123 arg',
          cwd: dir,
        },
        // A small delay gives Node's ChildProcess 'error' event time to fire
        // for ENOENT, which otherwise races with the immediate resolve path.
        { fastFailDelayMs: 50 },
      ),
    ).rejects.toMatchObject({ code: 'EXEC_NOT_FOUND' })
  })

  it('calls onSpawn with the live ChildProcess for tracking', async () => {
    const dir = mkdir()
    const script = writeSleepScript(dir, 2000)
    let tracked: number | null = null
    const { pid } = await startServerProcess(
      {
        command: `node ${script}`,
        cwd: dir,
      },
      {
        onSpawn: (child) => { tracked = child.pid ?? null },
      },
    )
    expect(tracked).toBe(pid)
    kill(pid)
  })
})
