/**
 * One-shot delivery into the persistent canvas document. The first mounted
 * editor handles a batch; tldraw synchronizes the document to other editors.
 * Delivered items are removed, so deleting a shape never triggers a replay.
 */
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

export interface TlLandingItem {
  /** Gallery item id; also used to dedupe shapes via shape.meta.galleryId. */
  galleryId: string
  attachment: ImageAttachmentRef
  /** Live conversation delivery; discard unfinished delivery when all canvases close. */
  fromConversation?: boolean
  /** Explicit history actions must not resume after the last canvas closes. */
  onlyWhileCanvasOpen?: boolean
  /**
   * Generation provenance copied onto the landed shape's meta: the canvas
   * digest then tells the model how each image was made, so "regenerate this"
   * or "vary this" reuses the original prompt and model instead of guessing.
   * All optional; shapes landed from older paths simply carry none.
   */
  prompt?: string
  provider?: string
  model?: string
}

type TlLandingConsumer = (items: readonly TlLandingItem[]) => Promise<boolean>
const pending = new Map<string, TlLandingItem>()
const consumers = new Set<TlLandingConsumer>()
const availabilityListeners = new Set<() => void>()
let delivering = false
let generation = 0

/** History actions must not silently queue into a canvas that is not open. */
export function hasTlLandingConsumer(): boolean { return consumers.size > 0 }
export function subscribeTlLandingAvailability(listener: () => void): () => void {
  availabilityListeners.add(listener)
  return () => { availabilityListeners.delete(listener) }
}
export function sendTlLandingToOpenCanvas(item: TlLandingItem): boolean {
  if (!hasTlLandingConsumer()) return false
  pushTlLandings([{ ...item, onlyWhileCanvasOpen: true }])
  return true
}

/** Invalidates async landings that started before the user cleared the canvas. */
export function getTlLandingGeneration(): number { return generation }

export function clearTlLandings(): void {
  generation += 1
  pending.clear()
}

/** Queue freshly generated images for the tldraw canvases. Safe to call anywhere. */
export function pushTlLandings(newItems: readonly TlLandingItem[]): void {
  for (const item of newItems) {
    if (!pending.has(item.galleryId)) pending.set(item.galleryId, item)
  }
  void deliver()
}

/** Conversation results are admitted only while a canvas is mounted. */
export function pushTlLandingsLive(items: readonly TlLandingItem[]): void {
  if (consumers.size > 0) pushTlLandings(items)
}

/** Register a ready editor. False means it unmounted before committing. */
export function registerTlLandingConsumer(consumer: TlLandingConsumer): () => void {
  const wasAvailable = hasTlLandingConsumer()
  consumers.add(consumer)
  if (!wasAvailable) for (const listener of availabilityListeners) listener()
  void deliver()
  let registered = true
  return () => {
    if (!registered) return
    registered = false
    consumers.delete(consumer)
    if (consumers.size === 0) {
      for (const [id, item] of pending) {
        if (item.fromConversation || item.onlyWhileCanvasOpen) pending.delete(id)
      }
      for (const listener of availabilityListeners) listener()
    }
  }
}

async function deliver(): Promise<void> {
  if (delivering) return
  delivering = true
  try {
    while (pending.size > 0) {
      const consumer = consumers.values().next().value
      if (consumer === undefined) break
      const batch = [...pending.values()]
      let completed = true
      try {
        completed = await consumer(batch)
      } catch (error) {
        // A failed batch must not become an infinite retry/replay loop.
        console.warn('[dsh-image-gen] canvas landing failed:', error)
      }
      if (completed) {
        for (const item of batch) {
          if (pending.get(item.galleryId) === item) pending.delete(item.galleryId)
        }
      }
    }
  } finally {
    delivering = false
  }
}
