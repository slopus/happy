import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { startFileWatcher } from './startFileWatcher'
import { mkdir, writeFile, appendFile, rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('startFileWatcher', () => {
  let testDir: string
  let stop: (() => void) | null = null

  beforeEach(async () => {
    testDir = join(tmpdir(), `fw-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(testDir, { recursive: true })
  })

  afterEach(async () => {
    if (stop) {
      stop()
      stop = null
    }
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true, force: true })
    }
  })

  // Regression test. Claude Code creates the transcript lazily: it does not
  // exist until the user submits their first prompt. The previous
  // implementation bounded total absence by time and gave up, which
  // blacklisted the session permanently — its content never synced again.
  it('does not give up while the file has simply not been created yet', async () => {
    const missing = join(testDir, 'never.jsonl')
    let changes = 0
    let gaveUp = 0

    stop = startFileWatcher(missing, () => { changes++ }, {
      missingFileTimeoutMs: 100,
      onGaveUp: () => { gaveUp++ },
    })

    // Far past missingFileTimeoutMs: that timeout only bounds a parent
    // directory that cannot be watched at all.
    await sleep(1200)

    expect(gaveUp).toBe(0)
    expect(changes).toBe(0)
  })

  // The real-world case: the user types their first prompt 90 seconds in.
  // A short timeout here proves waiting for creation is independent of it.
  it('attaches to a file created long after the timeout would have fired', async () => {
    const file = join(testDir, 'late.jsonl')
    let changes = 0
    let gaveUp = 0

    stop = startFileWatcher(file, () => { changes++ }, {
      missingFileTimeoutMs: 100,
      onGaveUp: () => { gaveUp++ },
    })

    await sleep(900)
    expect(gaveUp).toBe(0)

    await writeFile(file, 'line-1\n')
    await sleep(400)
    await appendFile(file, 'line-2\n')
    await sleep(400)

    expect(gaveUp).toBe(0)
    expect(changes).toBeGreaterThan(0)
  })

  it('does not give up when the file exists from the start', async () => {
    const file = join(testDir, 'present.jsonl')
    await writeFile(file, 'init\n')

    let changes = 0
    let gaveUp = 0
    stop = startFileWatcher(file, () => { changes++ }, {
      missingFileTimeoutMs: 200,
      onGaveUp: () => { gaveUp++ },
    })

    await sleep(300)
    await appendFile(file, 'more\n')
    await sleep(400)

    expect(gaveUp).toBe(0)
    expect(changes).toBeGreaterThan(0)
  })

  it('re-arms when the file is deleted and later recreated', async () => {
    const file = join(testDir, 'recreated.jsonl')
    await writeFile(file, 'init\n')

    let changes = 0
    let gaveUp = 0
    stop = startFileWatcher(file, () => { changes++ }, {
      missingFileTimeoutMs: 100,
      onGaveUp: () => { gaveUp++ },
    })

    await sleep(200)
    await unlink(file)
    await sleep(600)

    await writeFile(file, 'reborn\n')
    await sleep(300)
    await appendFile(file, 'again\n')
    await sleep(400)

    expect(gaveUp).toBe(0)
    expect(changes).toBeGreaterThan(0)
  })

  // The only remaining give-up path: the parent directory itself stays
  // unwatchable (missing, or permissions deny it). This is what the original
  // timeout was actually there to guard.
  it('gives up exactly once when the parent directory stays unwatchable', async () => {
    const missing = join(testDir, 'no-such-dir', 'ghost.jsonl')
    let changes = 0
    let gaveUp = 0

    stop = startFileWatcher(missing, () => { changes++ }, {
      missingFileTimeoutMs: 100,
      onGaveUp: () => { gaveUp++ },
    })

    await sleep(2500)

    expect(gaveUp).toBe(1)
    expect(changes).toBe(0)
  })

  it('stops on dispose without giving up', async () => {
    const missing = join(testDir, 'aborted.jsonl')
    let changes = 0
    let gaveUp = 0

    const dispose = startFileWatcher(missing, () => { changes++ }, {
      missingFileTimeoutMs: 10_000,
      onGaveUp: () => { gaveUp++ },
    })

    await sleep(150)
    dispose()
    // Calling dispose twice must be safe.
    dispose()
    stop = null

    await sleep(600)

    // Creating the file after dispose must not fire the callback either.
    await writeFile(missing, 'after-dispose\n')
    await sleep(300)

    expect(gaveUp).toBe(0)
    expect(changes).toBe(0)
  })
})
