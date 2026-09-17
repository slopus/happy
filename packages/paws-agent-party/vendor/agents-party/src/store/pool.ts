import fs from 'node:fs'
import { ensureDataDir, partyFilePath } from '../core/dirs.js'
import { openPartyStore } from './store.js'
import type { PartyStore } from './store.js'

/**
 * A pool of open party stores keyed by party id — one SQLite handle per party for the process lifetime. Used by the
 * standalone server and the local client. The SITE does not use this pool: its file paths need an async ownerId lookup
 * (`/data/<userId>/<partyId>.sqlite`), so it implements `ctx.store` itself — that context method is the real seam, this
 * pool is just the single-dir convenience.
 */

export interface StorePool {
  get(partyId: string): Promise<PartyStore>
  /** Closes the handle and deletes the party's files (the sqlite plus its -wal/-shm siblings). */
  remove(partyId: string): Promise<void>
  closeAll(): Promise<void>
}

export const createStorePool = (
  dir?: string,
  filePath: (partyId: string) => string = (id) => partyFilePath(id, dir),
): StorePool => {
  ensureDataDir(dir)
  const open = new Map<string, Promise<PartyStore>>()

  const get = (partyId: string): Promise<PartyStore> => {
    let store = open.get(partyId)
    if (store === undefined) {
      store = openPartyStore(filePath(partyId))
      open.set(partyId, store)
      // Never cache a failure — a transient open error must not brick the party until restart.
      store.catch(() => open.delete(partyId))
    }
    return store
  }

  return {
    get,
    remove: async (partyId) => {
      const store = open.get(partyId)
      if (store !== undefined) {
        open.delete(partyId)
        await (await store).close()
      }
      const path = filePath(partyId)
      for (const file of [path, `${path}-wal`, `${path}-shm`]) {
        fs.rmSync(file, { force: true })
      }
    },
    closeAll: async () => {
      const stores = [...open.values()]
      open.clear()
      for (const store of stores) await (await store).close()
    },
  }
}
