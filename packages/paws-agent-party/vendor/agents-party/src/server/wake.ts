/**
 * In-process wake hub — pending `/listen` long-polls park here instead of polling the store. A write through the API
 * calls `wake(partyId)` and reaches every listener in this process instantly; the timeout in `wait` is the safety net
 * for writes the process cannot see (local-protocol clients writing the files directly next to a standalone server,
 * multi-instance deployments) — see `PartyApiContext.listenFallbackMs`.
 */

export interface WakeHub {
  /** Resolves every pending `wait` for the party. */
  wake(partyId: string): void
  /** Resolves on the next wake for the party, or after `timeoutMs` — whichever comes first. */
  wait(partyId: string, timeoutMs: number): Promise<void>
  /** Resolves every pending `wait` (server shutdown). */
  wakeAll(): void
}

export const createWakeHub = (): WakeHub => {
  const waiters = new Map<string, Set<() => void>>()

  const remove = (partyId: string, waiter: () => void): void => {
    const set = waiters.get(partyId)
    if (set === undefined) return
    set.delete(waiter)
    if (set.size === 0) waiters.delete(partyId)
  }

  return {
    wake: (partyId) => {
      const set = waiters.get(partyId)
      if (set === undefined) return
      waiters.delete(partyId)
      for (const waiter of set) waiter()
    },
    wait: (partyId, timeoutMs) =>
      new Promise((resolve) => {
        const waiter = (): void => {
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(() => {
          remove(partyId, waiter)
          resolve()
        }, timeoutMs)
        const set = waiters.get(partyId) ?? new Set<() => void>()
        waiters.set(partyId, set)
        set.add(waiter)
      }),
    wakeAll: () => {
      const all = [...waiters.values()]
      waiters.clear()
      for (const set of all) for (const waiter of set) waiter()
    },
  }
}
