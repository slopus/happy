import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialStagingParents, stageUserCredentials, unstageUserCredentials, sweepOrphanUserHomeDirs } from './stageUserCredentials'

describe('stageUserCredentials', () => {
  it('writes an access.key file containing the user token and secret', async () => {
    const { homeDir } = await stageUserCredentials('user-token-abc', 'base64secret==')
    try {
      const accessKey = await fs.readFile(join(homeDir, 'access.key'), 'utf-8')
      expect(JSON.parse(accessKey)).toEqual({
        token: 'user-token-abc',
        secret: 'base64secret==',
      })
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true })
    }
  })

  it('copies the daemon state file so the child can still reach the daemon', async () => {
    // Regression: HAPPY_HOME_DIR relocates daemon.state.json too, so a staged
    // home without it made the child's startup webhook fail with "No daemon
    // running, no state file found" → "Session webhook timeout for PID ...".
    const scratch = mkdtempSync(join(tmpdir(), 'daemon-state-'))
    const daemonStateFile = join(scratch, 'daemon.state.json')
    const state = JSON.stringify({ pid: 4242, httpPort: 43937 })
    await fs.writeFile(daemonStateFile, state)

    const { homeDir } = await stageUserCredentials('t', 's', daemonStateFile)
    try {
      const staged = await fs.readFile(join(homeDir, 'daemon.state.json'), 'utf-8')
      expect(JSON.parse(staged)).toEqual({ pid: 4242, httpPort: 43937 })
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true })
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it('still stages credentials when the daemon state file is missing', async () => {
    // Best-effort copy: an unreadable daemon state must not fail the spawn.
    const { homeDir } = await stageUserCredentials('t', 's', join(tmpdir(), 'does-not-exist-daemon.state.json'))
    try {
      const accessKey = await fs.readFile(join(homeDir, 'access.key'), 'utf-8')
      expect(JSON.parse(accessKey).token).toBe('t')
      await expect(fs.stat(join(homeDir, 'daemon.state.json'))).rejects.toThrow()
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true })
    }
  })

  it('creates a logs subdirectory so the child CLI can write logs', async () => {
    const { homeDir } = await stageUserCredentials('t', 's')
    try {
      const stat = await fs.stat(join(homeDir, 'logs'))
      expect(stat.isDirectory()).toBe(true)
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true })
    }
  })

  it('returns a unique tmp directory for each call', async () => {
    const a = await stageUserCredentials('t', 's')
    const b = await stageUserCredentials('t', 's')
    try {
      expect(a.homeDir).not.toBe(b.homeDir)
    } finally {
      await fs.rm(a.homeDir, { recursive: true, force: true })
      await fs.rm(b.homeDir, { recursive: true, force: true })
    }
  })

  it('writes access.key with mode 0600 so only the owner can read', async () => {
    const { homeDir } = await stageUserCredentials('t', 's')
    try {
      const stat = await fs.stat(join(homeDir, 'access.key'))
      // Check that group/other have no read access
      const modeStr = (stat.mode & 0o777).toString(8)
      expect(modeStr).toBe('600')
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true })
    }
  })
})

describe('unstageUserCredentials', () => {
  it('removes a previously staged directory', async () => {
    const { homeDir } = await stageUserCredentials('t', 's')
    await fs.access(homeDir)

    await unstageUserCredentials(homeDir)

    await expect(fs.access(homeDir)).rejects.toThrow()
  })

  it('is idempotent — removing a non-existent directory does not throw', async () => {
    const { homeDir } = await stageUserCredentials('t', 's')
    await unstageUserCredentials(homeDir)
    await expect(unstageUserCredentials(homeDir)).resolves.toBeUndefined()
  })

  it('refuses to delete paths outside the happy-session tmp prefix', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'not-happy-session-'))
    try {
      await expect(unstageUserCredentials(outsideDir)).rejects.toThrow(/refusing/i)
      await fs.access(outsideDir)
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true })
    }
  })

  it('refuses to delete an obviously dangerous path', async () => {
    await expect(unstageUserCredentials('/')).rejects.toThrow(/refusing/i)
    await expect(unstageUserCredentials('/home/aiden')).rejects.toThrow(/refusing/i)
  })
})

describe('sweepOrphanUserHomeDirs', () => {
  let scratchTmp: string
  let liveDir: string
  let orphanDir: string
  let unrelatedDir: string

  beforeEach(() => {
    scratchTmp = mkdtempSync(join(tmpdir(), 'sweep-parent-'))
    liveDir = mkdtempSync(join(scratchTmp, 'happy-session-'))
    orphanDir = mkdtempSync(join(scratchTmp, 'happy-session-'))
    unrelatedDir = mkdtempSync(join(scratchTmp, 'not-ours-'))
  })

  afterEach(() => {
    rmSync(scratchTmp, { recursive: true, force: true })
  })

  it('removes happy-session-* directories that no live session claims', async () => {
    const removed = await sweepOrphanUserHomeDirs([liveDir], scratchTmp)
    expect(removed).toEqual([orphanDir])
    await fs.access(liveDir)
    await expect(fs.access(orphanDir)).rejects.toThrow()
    await fs.access(unrelatedDir)
  })

  it('leaves directories whose prefix does not match alone', async () => {
    await sweepOrphanUserHomeDirs([], scratchTmp)
    await fs.access(unrelatedDir)
  })

  it('returns empty when parent dir does not exist', async () => {
    const missing = join(tmpdir(), 'definitely-not-there-' + Date.now())
    const removed = await sweepOrphanUserHomeDirs([], missing)
    expect(removed).toEqual([])
  })
})

describe('staging parent change (a machine that became mandatory)', () => {
  let oldParent: string
  let newParent: string

  beforeEach(() => {
    oldParent = mkdtempSync(join(tmpdir(), 'old-staging-'))
    newParent = mkdtempSync(join(tmpdir(), 'new-staging-'))
  })

  afterEach(() => {
    rmSync(oldParent, { recursive: true, force: true })
    rmSync(newParent, { recursive: true, force: true })
  })

  it('keeps the OS tmp dir as a trusted parent next to the current one, once each', () => {
    expect(credentialStagingParents('/home/agent/.happy-staging')).toEqual(['/home/agent/.happy-staging', tmpdir()])
    expect(credentialStagingParents(tmpdir())).toEqual([tmpdir()])
  })

  it('unstages a directory staged under an earlier parent', async () => {
    const staged = mkdtempSync(join(oldParent, 'happy-session-'))
    await unstageUserCredentials(staged, [newParent, oldParent])
    await expect(fs.access(staged)).rejects.toThrow()
  })

  it('still refuses a directory under neither parent', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'elsewhere-'))
    const staged = mkdtempSync(join(elsewhere, 'happy-session-'))
    await expect(unstageUserCredentials(staged, [newParent, oldParent])).rejects.toThrow(/refusing/)
    rmSync(elsewhere, { recursive: true, force: true })
  })

  it('sweeps orphans under every trusted parent, keeping live ones', async () => {
    const orphanOld = mkdtempSync(join(oldParent, 'happy-session-'))
    const orphanNew = mkdtempSync(join(newParent, 'happy-session-'))
    const live = mkdtempSync(join(oldParent, 'happy-session-'))
    const removed = await sweepOrphanUserHomeDirs([live], [newParent, oldParent])
    expect(removed.sort()).toEqual([orphanNew, orphanOld].sort())
    await fs.access(live)
  })
})
