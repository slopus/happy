import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Where agents-party keeps its data on a machine (CLI, local web, self-hosted server alike): <dir>/registry.sqlite —
 * the registry: one row of metadata per party (see core/types.ts PartyMeta) <dir>/parties/<id>.sqlite — one file per
 * party: messages + participants
 *
 * `<dir>` is `~/.agents-party`, overridable via AGENTS_PARTY_DIR (tests, self-hosted volumes).
 */

export const dataDir = (): string => process.env.AGENTS_PARTY_DIR ?? path.join(os.homedir(), '.agents-party')

export const registryPath = (dir = dataDir()): string => path.join(dir, 'registry.sqlite')

export const partiesDir = (dir = dataDir()): string => path.join(dir, 'parties')

export const partyFilePath = (partyId: string, dir = dataDir()): string =>
  path.join(partiesDir(dir), `${partyId}.sqlite`)

export const ensureDataDir = (dir = dataDir()): string => {
  fs.mkdirSync(partiesDir(dir), { recursive: true })
  return dir
}
