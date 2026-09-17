import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { HOST_COLOR, pickParticipantColor } from '../core/colors.js'
import { PartyError } from '../core/errors.js'
import { HOST_NAME, validateParticipantName } from '../core/names.js'
import { isVisibleTo } from '../core/types.js'
import type { Message, NewMessage, Participant } from '../core/types.js'
import { openSqlite } from './sqlite-driver.js'

/**
 * The party store — one SQLite file per party, two tables: `messages` (ciphertext bodies, plaintext metadata) and
 * `participants` (join/leave history). Used directly by the local protocol and by every server behind the HTTP API. The
 * store knows nothing about keys: it moves ciphertext.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  fromName TEXT NOT NULL,
  toNames TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  replyTo TEXT
);
CREATE TABLE IF NOT EXISTS participants (
  name TEXT PRIMARY KEY,
  joinedAt INTEGER NOT NULL,
  leftAt INTEGER,
  desc TEXT,
  color TEXT NOT NULL
);
`

export interface ReadOptions {
  /** Whose view — only messages this participant may see. Omit for the owner's view: everything (it's their data). */
  for?: string
  /** Cursor of the last seen message; omit for the full history. */
  since?: string
  /** Exclusive upper cursor bound — "older than this" for infinite scroll. */
  before?: string
  /** At most this many messages, counted from the NEWEST matching (result stays ascending) — "the latest 50". */
  limit?: number
}

export interface PartyStore {
  /** Appends a message row. Senders must be active participants (join/leave events enforce themselves). */
  append(msg: NewMessage): Promise<Message>
  read(opts?: ReadOptions): Promise<Message[]>
  join(name: string, opts?: { desc?: string; owner?: boolean }): Promise<Participant>
  leave(name: string): Promise<void>
  participants(): Promise<Participant[]>
  /** Absolute economics values for the registry: message count, file size, last activity. */
  stats(): Promise<{ messagesCount: number; sizeBytes: number; lastMessageAt: number | null }>
  close(): Promise<void>
}

const rowToMessage = (row: Record<string, unknown>): Message => ({
  cursor: String(row.seq),
  id: String(row.id),
  ts: Number(row.ts),
  from: String(row.fromName),
  to: row.toNames === '*' ? '*' : (JSON.parse(String(row.toNames)) as string[]),
  kind: row.kind as Message['kind'],
  text: String(row.text),
  ...(row.replyTo == null ? {} : { replyTo: String(row.replyTo) }),
})

export const openPartyStore = async (filePath: string): Promise<PartyStore> => {
  const db = await openSqlite(filePath, SCHEMA)

  const insert = (msg: NewMessage): Message => {
    const id = randomUUID()
    const ts = Date.now()
    const result = db.run(
      'INSERT INTO messages (id, ts, fromName, toNames, kind, text, replyTo) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, ts, msg.from, msg.to === '*' ? '*' : JSON.stringify(msg.to), msg.kind, msg.text, msg.replyTo ?? null],
    )
    return { ...msg, id, ts, cursor: String(result.lastInsertRowid) }
  }

  const isActive = (name: string): boolean =>
    db.all('SELECT 1 FROM participants WHERE name = ? AND leftAt IS NULL', [name]).length > 0

  return {
    // Methods are async so validation throws surface as rejections, never as synchronous escapes.
    append: async (msg: NewMessage) => {
      if (msg.kind !== 'message') {
        throw new PartyError('BAD_REQUEST', 'join/leave events are emitted by join() and leave().')
      }
      if (!isActive(msg.from)) {
        throw new PartyError('NOT_A_PARTICIPANT', `"${msg.from}" is not at this party — join first.`)
      }
      return insert(msg)
    },

    read: async (opts: ReadOptions = {}) => {
      const parseCursor = (value: string): number => {
        const seq = Number(value)
        if (!Number.isFinite(seq)) throw new PartyError('BAD_REQUEST', `Invalid cursor: ${value}`)
        return seq
      }
      const sinceSeq = opts.since === undefined ? 0 : parseCursor(opts.since)
      const beforeSeq = opts.before === undefined ? Number.MAX_SAFE_INTEGER : parseCursor(opts.before)
      const viewer = opts.for

      // No limit: one ascending scan. With a limit: walk from the newest matching row backwards in batches, so
      // visibility filtering can't starve the page ("the latest 50 I may see"), then flip back to ascending.
      if (opts.limit === undefined) {
        const rows = db.all('SELECT * FROM messages WHERE seq > ? AND seq < ? ORDER BY seq ASC', [sinceSeq, beforeSeq])
        const messages = rows.map(rowToMessage)
        return viewer === undefined ? messages : messages.filter((msg) => isVisibleTo(msg, viewer))
      }

      const page: Message[] = []
      let upper = beforeSeq
      while (page.length < opts.limit) {
        const batch = db
          .all('SELECT * FROM messages WHERE seq > ? AND seq < ? ORDER BY seq DESC LIMIT 200', [sinceSeq, upper])
          .map(rowToMessage)
        if (batch.length === 0) break
        for (const msg of batch) {
          if (viewer === undefined || isVisibleTo(msg, viewer)) page.push(msg)
          if (page.length === opts.limit) break
        }
        upper = Number(batch.at(-1)?.cursor)
      }
      return page.reverse()
    },

    join: async (name: string, opts: { desc?: string; owner?: boolean } = {}) => {
      validateParticipantName(name, { owner: opts.owner })
      const now = Date.now()
      // Color is assigned once, on the FIRST join: the host is always black, everyone else takes the next palette
      // color in join order. A rejoin keeps the original color (the upsert never touches it).
      const others = Number(
        (db.all('SELECT COUNT(*) AS count FROM participants WHERE color != ?', [HOST_COLOR])[0] as { count: unknown })
          .count,
      )
      const color = name.toLowerCase() === HOST_NAME ? HOST_COLOR : pickParticipantColor(others)
      const result = db.run(
        `INSERT INTO participants (name, joinedAt, leftAt, desc, color) VALUES (?, ?, NULL, ?, ?)
         ON CONFLICT(name) DO UPDATE SET joinedAt = excluded.joinedAt, leftAt = NULL, desc = excluded.desc
         WHERE participants.leftAt IS NOT NULL`,
        [name, now, opts.desc ?? null, color],
      )
      if (result.changes === 0) {
        // The owner's name is verified by the caller (owner: true only comes with owner credentials), so an active
        // row under it IS this same person — rejoin is idempotent: return the row, no duplicate join event. Other
        // names can't prove identity yet, so an active holder means the name is genuinely taken.
        if (opts.owner === true && name.toLowerCase() === HOST_NAME) {
          const row = db.all('SELECT * FROM participants WHERE name = ?', [name])[0] as Record<string, unknown>
          return {
            name,
            joinedAt: Number(row.joinedAt),
            color: String(row.color),
            ...(row.desc == null ? {} : { desc: String(row.desc) }),
          }
        }
        throw new PartyError('NAME_TAKEN', `The name "${name}" is already taken at this party — pick another one.`)
      }
      insert({ from: name, to: '*', kind: 'join', text: '' })
      const stored = db.all('SELECT color FROM participants WHERE name = ?', [name])[0] as { color: string }
      return {
        name,
        joinedAt: now,
        color: stored.color,
        ...(opts.desc === undefined ? {} : { desc: opts.desc }),
      }
    },

    leave: async (name: string) => {
      if (!isActive(name)) return // leaving twice is fine
      insert({ from: name, to: '*', kind: 'leave', text: '' })
      db.run('UPDATE participants SET leftAt = ? WHERE name = ?', [Date.now(), name])
    },

    participants: async () =>
      db.all('SELECT * FROM participants ORDER BY joinedAt ASC').map((row) => ({
        name: String(row.name),
        joinedAt: Number(row.joinedAt),
        color: String(row.color),
        ...(row.leftAt == null ? {} : { leftAt: Number(row.leftAt) }),
        ...(row.desc == null ? {} : { desc: String(row.desc) }),
      })),

    stats: async () => {
      const row = db.all('SELECT COUNT(*) AS count, MAX(ts) AS last FROM messages')[0] as Record<string, unknown>
      let sizeBytes = 0
      try {
        sizeBytes = fs.statSync(filePath).size
      } catch {
        // file gone mid-flight — stats are best-effort
      }
      return {
        messagesCount: Number(row.count),
        sizeBytes,
        lastMessageAt: row.last == null ? null : Number(row.last),
      }
    },

    close: async () => {
      db.close()
    },
  }
}
