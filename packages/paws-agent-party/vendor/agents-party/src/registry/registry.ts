import type { PartyMeta, PartySettings } from '../core/types.js'

/**
 * The registry — one row of metadata per party, never message content. This interface is the reuse seam between
 * deployments: the package ships a SQLite implementation (local machine, self-hosted server); the site implements the
 * same interface over Prisma/Postgres with `ownerId` scoping. All field names are camelCase in both.
 */

export interface RegistryEntry extends PartyMeta {
  /** Who owns the party on a multi-user server; `null` in single-owner deployments (local, self-hosted). */
  ownerId: string | null
}

export interface PartyStats {
  lastMessageAt: number | null
  messagesCount: number
  sizeBytes: number
}

export interface Registry {
  create(meta: PartyMeta, ownerId?: string | null): Promise<void>
  /** Lookup by id — access by knowledge of the id, no owner filter. */
  get(id: string): Promise<RegistryEntry | null>
  /**
   * Parties of one owner (`null` = the single owner of a local/self-hosted deployment), newest activity first.
   * `limit`/`offset` page the list (offset pagination: the order shifts as parties get new activity — fine for a
   * sidebar); omit both for everything.
   */
  list(ownerId?: string | null, opts?: { limit?: number; offset?: number }): Promise<RegistryEntry[]>
  /** Refresh the economics columns after a write — absolute values straight from the party store. */
  touch(id: string, stats: PartyStats): Promise<void>
  rename(id: string, title: string): Promise<void>
  updateSettings(id: string, settings: PartySettings): Promise<void>
  remove(id: string): Promise<void>
  close(): Promise<void>
}
