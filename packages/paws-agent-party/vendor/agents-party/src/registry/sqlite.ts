import { defaultSettings } from '../core/types.js'
import type { PartyMeta, PartySettings } from '../core/types.js'
import { openSqlite } from '../store/sqlite-driver.js'
import type { Registry, RegistryEntry, PartyStats } from './registry.js'

/** The package's registry: one SQLite file (`<dir>/registry.sqlite`) for the machine or the self-hosted server. */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS parties (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  lastMessageAt INTEGER,
  messagesCount INTEGER NOT NULL DEFAULT 0,
  sizeBytes INTEGER NOT NULL DEFAULT 0,
  key TEXT,
  keyWrapped TEXT,
  settings TEXT NOT NULL DEFAULT '{}',
  ownerId TEXT
);
`

const rowToEntry = (row: Record<string, unknown>): RegistryEntry => ({
  id: String(row.id),
  title: String(row.title),
  createdAt: Number(row.createdAt),
  lastMessageAt: row.lastMessageAt == null ? null : Number(row.lastMessageAt),
  messagesCount: Number(row.messagesCount),
  sizeBytes: Number(row.sizeBytes),
  key: row.key == null ? null : String(row.key),
  keyWrapped: row.keyWrapped == null ? null : String(row.keyWrapped),
  settings: { ...defaultSettings(), ...(JSON.parse(String(row.settings)) as Partial<PartySettings>) },
  ownerId: row.ownerId == null ? null : String(row.ownerId),
})

export const createSqliteRegistry = async (path: string): Promise<Registry> => {
  const db = await openSqlite(path, SCHEMA)
  return {
    create: (meta: PartyMeta, ownerId: string | null = null) => {
      db.run(
        `INSERT INTO parties (id, title, createdAt, lastMessageAt, messagesCount, sizeBytes, key, keyWrapped, settings, ownerId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          meta.id,
          meta.title,
          meta.createdAt,
          meta.lastMessageAt,
          meta.messagesCount,
          meta.sizeBytes,
          meta.key,
          meta.keyWrapped,
          JSON.stringify(meta.settings),
          ownerId,
        ],
      )
      return Promise.resolve()
    },
    get: (id: string) => {
      const rows = db.all('SELECT * FROM parties WHERE id = ?', [id])
      return Promise.resolve(rows.length === 0 ? null : rowToEntry(rows[0] as Record<string, unknown>))
    },
    list: (ownerId: string | null = null, opts: { limit?: number; offset?: number } = {}) => {
      // LIMIT -1 is SQLite's "no limit" — needed because OFFSET only parses after a LIMIT.
      const page = ' LIMIT ? OFFSET ?'
      const pageParams: (string | number)[] = [opts.limit ?? -1, opts.offset ?? 0]
      const rows =
        ownerId === null
          ? db.all(`SELECT * FROM parties ORDER BY COALESCE(lastMessageAt, createdAt) DESC${page}`, pageParams)
          : db.all(`SELECT * FROM parties WHERE ownerId = ? ORDER BY COALESCE(lastMessageAt, createdAt) DESC${page}`, [
              ownerId,
              ...pageParams,
            ])
      return Promise.resolve(rows.map(rowToEntry))
    },
    touch: (id: string, stats: PartyStats) => {
      db.run('UPDATE parties SET lastMessageAt = ?, messagesCount = ?, sizeBytes = ? WHERE id = ?', [
        stats.lastMessageAt,
        stats.messagesCount,
        stats.sizeBytes,
        id,
      ])
      return Promise.resolve()
    },
    rename: (id: string, title: string) => {
      db.run('UPDATE parties SET title = ? WHERE id = ?', [title, id])
      return Promise.resolve()
    },
    updateSettings: (id: string, settings: PartySettings) => {
      db.run('UPDATE parties SET settings = ? WHERE id = ?', [JSON.stringify(settings), id])
      return Promise.resolve()
    },
    remove: (id: string) => {
      db.run('DELETE FROM parties WHERE id = ?', [id])
      return Promise.resolve()
    },
    close: () => {
      db.close()
      return Promise.resolve()
    },
  }
}
