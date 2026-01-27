import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSessionScanner } from './sessionScanner'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { getProjectPath } from './path'
import { logger } from '@/ui/logger'

async function waitFor(predicate: () => boolean, timeoutMs: number = 2000, intervalMs: number = 25): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  throw new Error('Timed out waiting for condition')
}

describe('sessionScanner onMessage errors', () => {
  let testDir: string
  let projectDir: string
  let scanner: Awaited<ReturnType<typeof createSessionScanner>> | null = null
  let originalClaudeConfigDir: string | undefined
  let claudeConfigDir: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `scanner-test-${Date.now()}`)
    await mkdir(testDir, { recursive: true })

    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    claudeConfigDir = join(testDir, 'claude-config')
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir

    projectDir = getProjectPath(testDir)
    await mkdir(projectDir, { recursive: true })
  })

  afterEach(async () => {
    if (scanner) {
      await scanner.cleanup()
      scanner = null
    }

    if (originalClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    }

    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true, force: true })
    }
  })

  it('logs and continues when onMessage callback throws', async () => {
    const debugSpy = vi.spyOn(logger, 'debug')

    let didThrow = false
    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      transcriptMissingWarningMs: 0,
      onMessage: () => {
        didThrow = true
        throw new Error('boom')
      },
    })

    const sessionId = '93a9705e-bc6a-406d-8dce-8acc014dedbd'
    const sessionFile = join(projectDir, `${sessionId}.jsonl`)
    await writeFile(sessionFile, JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'hi' } }) + '\n')
    scanner.onNewSession(sessionId)

    await waitFor(() => didThrow)
    await waitFor(() => debugSpy.mock.calls.some((c) => String(c[0]).includes('[SESSION_SCANNER] onMessage callback threw')))
  })
})

