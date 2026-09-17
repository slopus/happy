/**
 * v2 core model. A party is one shared channel; participants are unique names inside it; every message body is
 * ciphertext (encrypted with the party's own key — see core/crypto.ts), metadata stays plaintext so servers can route
 * and count without ever reading content.
 */

export type MessageKind = 'message' | 'join' | 'leave'

/**
 * Who a message is for: `'*'` = everyone, or specific participant names. `'*'` can never collide with a name — the name
 * rules forbid it (`all` is reserved too, for clarity).
 */
export type Recipients = '*' | string[]

export interface Message {
  /** Stringified monotonic sequence inside the party — pass it back as `since` to read only newer messages. */
  cursor: string
  /** Globally unique message id (UUID). */
  id: string
  /** Epoch milliseconds. */
  ts: number
  from: string
  to: Recipients
  kind: MessageKind
  /** Ciphertext (base64url(iv ‖ ct)) for kind 'message'; empty for join/leave events. */
  text: string
  /** Id of the message this one replies to. */
  replyTo?: string
}

export interface NewMessage {
  from: string
  to: Recipients
  kind: MessageKind
  text: string
  replyTo?: string
}

export interface Participant {
  name: string
  /** Epoch milliseconds of the (latest) join. */
  joinedAt: number
  /** Set when the participant left; absent while active. */
  leftAt?: number
  /** Free-form role in the party ("reviews the diffs"), set at join. */
  desc?: string
  /** Stable display color assigned at join (core/colors.ts) — `black` is the host's, always. */
  color: string
}

/**
 * Extensible per-party settings, stored as JSON in the registry. First knob: who may join — `open` = anyone who knows
 * the party id (content is protected by the encryption key anyway); future: `members` = only listed participants.
 */
export interface PartySettings {
  joinPolicy: 'open'
}

export const defaultSettings = (): PartySettings => ({ joinPolicy: 'open' })

/**
 * One row of the registry — party metadata, never message content. Field names are camelCase everywhere (SQLite here,
 * Prisma/Postgres on the site) so both sides speak one dictionary.
 */
export interface PartyMeta {
  id: string
  title: string
  createdAt: number
  lastMessageAt: number | null
  messagesCount: number
  sizeBytes: number
  /** Plaintext party key — populated locally and on self-hosted servers (your own disk). */
  key: string | null
  /** Party key sealed with the owner's public key — the only form a zero-knowledge server (our site) stores. */
  keyWrapped: string | null
  settings: PartySettings
}

/**
 * Visibility rule: broadcasts are for everyone, addressed messages are for their recipients — and the sender always
 * sees their own messages. The owner (web UI) reads without a viewer name and sees everything: it's their data.
 */
export const isVisibleTo = (msg: Pick<Message, 'from' | 'to'>, name: string): boolean => {
  if (msg.from === name) return true
  if (msg.to === '*') return true
  return msg.to.includes(name)
}
