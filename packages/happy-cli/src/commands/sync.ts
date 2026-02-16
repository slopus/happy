/**
 * Sync command handler for `happy sync`
 *
 * Called from Claude Code's Stop hook on every turn end.
 * Reads new JSONL messages from the Claude session transcript
 * and sends them to happy-server via HTTP POST.
 *
 * SPEED is critical: this runs on every Claude Code turn end.
 * - Reads stdin synchronously (fd 0)
 * - Skips sessions not attached to happy
 * - Reconstructs ApiSessionClient directly from stored state (no network round trip)
 * - Only sends delta (new lines since last sync)
 */

import { readFileSync, existsSync } from 'node:fs'
import { readCredentials } from '@/persistence'
import { ApiSessionClient } from '@/api/apiSession'
import { RawJSONLinesSchema, type RawJSONLines } from '@/claude/types'
import { logger } from '@/ui/logger'
import { readSyncState, writeSyncState } from '@/commands/syncState'
import type { Session } from '@/api/types'

export async function handleSyncCommand(_args: string[]): Promise<void> {
  try {
    // Step 1: Read stdin (hook provides JSON)
    // Claude Code hooks pipe JSON via stdin. Read synchronously for speed.
    let stdinData: string
    try {
      stdinData = readFileSync(0, 'utf-8') // fd 0 = stdin
    } catch {
      process.exit(0)
    }

    if (!stdinData || !stdinData.trim()) {
      process.exit(0)
    }

    // Step 2: Parse hook input
    let hookInput: { session_id: string; transcript_path: string }
    try {
      hookInput = JSON.parse(stdinData)
    } catch {
      process.exit(0)
    }

    const claudeSessionId: string = hookInput.session_id
    const transcriptPath: string = hookInput.transcript_path

    if (!claudeSessionId || !transcriptPath) {
      process.exit(0)
    }

    // Step 3: Check if session is attached
    const syncState = readSyncState(claudeSessionId)
    if (!syncState) {
      // Session not attached to happy, nothing to do
      process.exit(0)
    }

    // Step 4: Read new JSONL lines
    if (!existsSync(transcriptPath)) {
      process.exit(0)
    }
    const content = readFileSync(transcriptPath, 'utf-8')
    const allLines = content.split('\n').filter(l => l.trim())

    if (allLines.length <= syncState.lastSyncedLine) {
      // No new lines
      process.exit(0)
    }

    const newLines = allLines.slice(syncState.lastSyncedLine)

    // Step 5: Parse new messages
    const newMessages: RawJSONLines[] = []
    for (const line of newLines) {
      try {
        const parsed = JSON.parse(line)
        const result = RawJSONLinesSchema.safeParse(parsed)
        if (result.success && (result.data.type === 'user' || result.data.type === 'assistant')) {
          newMessages.push(result.data)
        }
      } catch {
        // Skip unparseable lines
      }
    }

    if (newMessages.length === 0) {
      // Update line count but no messages to send
      syncState.lastSyncedLine = allLines.length
      writeSyncState(claudeSessionId, syncState)
      process.exit(0)
    }

    // Step 6: Reconstruct Session and create ApiSessionClient
    // Construct directly from stored state to avoid network round trip
    const credentials = await readCredentials()
    if (!credentials) {
      process.exit(0) // Don't break Claude Code hooks even if credentials are missing
    }

    const session: Session = {
      id: syncState.happySessionId,
      seq: 0,
      metadata: { path: syncState.metadataPath } as any, // Only path is used by constructor
      metadataVersion: 0,
      agentState: null,
      agentStateVersion: 0,
      encryptionKey: new Uint8Array(Buffer.from(syncState.encryptionKey, 'base64')),
      encryptionVariant: syncState.encryptionVariant,
    }

    const sessionClient = new ApiSessionClient(credentials.token, session)

    // Step 7: Send new messages
    // Do NOT call sessionClient.onUserMessage() -- no Socket.IO needed for one-shot sync.
    // Messages are sent via HTTP POST through the outbox.
    for (const msg of newMessages) {
      sessionClient.sendClaudeSessionMessage(msg)
    }
    sessionClient.closeClaudeSessionTurn('completed')
    await sessionClient.flush()

    // Step 8: Update sync state and close
    syncState.lastSyncedLine = allLines.length
    writeSyncState(claudeSessionId, syncState)
    await sessionClient.close()
  } catch (error) {
    logger.debug('[sync] Error during sync:', error instanceof Error ? error.message : String(error))
    process.exit(0) // Never break Claude Code's flow
  }
}
