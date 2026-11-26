/**
 * Bounded in-memory attachment image cache for client views.
 *
 * Enforces dual constraints (max items + max bytes) with LRU eviction.
 * The background fetch lifecycle is decoupled from individual consumer signals,
 * preventing a canceled thumbnail from aborting the shared blob request.
 */
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { IMAGE_ROUTE, imageUrlFor } from '../shared.js'

interface CacheEntry {
  promise: Promise<Blob>
  bytes: number
}

export const MAX_CACHE_COUNT = 30
export const MAX_CACHE_BYTES = 128 * 1024 * 1024 // 128 MB

let currentCacheBytes = 0
const cache = new Map<string, CacheEntry>()

/**
 * Fetch or reuse an image Blob by attachment ID.
 * Refreshes LRU recency on hit and enforces count/byte limits on arrival.
 */
export function fetchAttachmentBlob(attachment: ImageAttachmentRef): Promise<Blob> {
  const key = String(attachment.attachmentId)
  const existing = cache.get(key)
  if (existing !== undefined) {
    // Refresh LRU recency
    cache.delete(key)
    cache.set(key, existing)
    return existing.promise
  }

  const entry: CacheEntry = {
    promise: Promise.resolve().then(async () => {
      try {
        // Content-addressed attachments are served with an immutable cache
        // header, so repeated previews/downloads stay in the browser cache.
        let response = await fetch(imageUrlFor(attachment), {
          credentials: 'same-origin',
          cache: 'force-cache',
        })
        if (response.status === 405) {
          // Host builds that only expose the POST form.
          response = await fetch(IMAGE_ROUTE, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ attachment }),
          })
        }
        if (!response.ok) throw new Error(`Image unavailable (${response.status})`)
        const blob = await response.blob()
        if (cache.get(key) === entry) {
          entry.bytes = blob.size
          currentCacheBytes += blob.size
          enforceLimits()
        }
        return blob
      } catch (err) {
        // Failed requests must never stay in cache
        if (cache.get(key) === entry) {
          cache.delete(key)
        }
        throw err
      }
    }),
    bytes: 0,
  }

  cache.set(key, entry)
  enforceLimits()
  return entry.promise
}

/** Check if an attachment Blob is already cached in memory. */
export function getCachedAttachmentBlob(attachmentId: string | ImageAttachmentRef['attachmentId']): Promise<Blob> | undefined {
  return cache.get(String(attachmentId))?.promise
}

/** Evict one item from memory cache (e.g. when deleted from gallery). */
export function evictAttachmentCache(attachmentId: string | ImageAttachmentRef['attachmentId']): void {
  const key = String(attachmentId)
  const entry = cache.get(key)
  if (entry !== undefined) {
    currentCacheBytes = Math.max(0, currentCacheBytes - entry.bytes)
    cache.delete(key)
  }
}

/** Clear all in-memory image caches. */
export function clearAttachmentCache(): void {
  cache.clear()
  currentCacheBytes = 0
}

/** Get current cache size metrics (useful for assertions and health monitoring). */
export function getCacheMetrics(): { count: number; bytes: number } {
  return { count: cache.size, bytes: currentCacheBytes }
}

function enforceLimits(): void {
  while (cache.size > MAX_CACHE_COUNT || currentCacheBytes > MAX_CACHE_BYTES) {
    const oldestKey = cache.keys().next().value
    if (oldestKey === undefined) break
    const oldest = cache.get(oldestKey)
    if (oldest !== undefined) {
      currentCacheBytes = Math.max(0, currentCacheBytes - oldest.bytes)
    }
    cache.delete(oldestKey)
  }
}
