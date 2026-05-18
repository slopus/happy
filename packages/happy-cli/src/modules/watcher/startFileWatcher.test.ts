import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { startFileWatcher } from './startFileWatcher'
import { mkdir, writeFile, appendFile, rm } from 'node:fs/promises'
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

  it('gives up exactly once when the file never appears', async () => {
    const missing = join(testDir, 'never.jsonl')
    let changes = 0
    let gaveUp = 0

    stop = startFileWatcher(missing, () => { changes++ }, {
      missingFileTimeoutMs: 100,
      onGaveUp: () => { gaveUp++ },
    })

    // First retry backoff is ~1s, so give-up lands a little after that.
    await sleep(2500)

    expect(gaveUp).toBe(1)
    expect(changes).toBe(0)
  })

  it('recovers when the file appears within the grace window', async () => {
    const file = join(testDir, 'late.jsonl')
    let changes = 0
    let gaveUp = 0

    stop = startFileWatcher(file, () => { changes++ }, {
      missingFileTimeoutMs: 10_000,
      onGaveUp: () => { gaveUp++ },
    })

    // Create the transcript after the watcher has already failed once.
    await sleep(300)
    await writeFile(file, 'line-1\n')
    await sleep(1500)
    await appendFile(file, 'line-2\n')
    await appendFile(file, 'line-3\n')
    await sleep(800)

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

    await sleep(2000)

    expect(gaveUp).toBe(0)
    expect(changes).toBe(0)
  })
})
