import type { Editor, TLShape } from 'tldraw'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { CANVAS_ASSET_ROUTE } from '../../shared.js'

/** Bound raster dimensions before exporting; large multi-image PNGs get a
 * JPEG preview instead of being silently discarded. Originals are separate. */
export async function exportSelectionPreview(editor: Editor, shapes: TLShape[], maxBytes: number, signal: AbortSignal): Promise<string> {
  const bounds = editor.getSelectionPageBounds()
  const scale = Math.min(1, 2048 / Math.max(1, (bounds?.w ?? 2048) + 32, (bounds?.h ?? 2048) + 32))
  const attempts = [
    { format: 'png' as const, scale, quality: 1 },
    { format: 'jpeg' as const, scale, quality: 0.85 },
    { format: 'jpeg' as const, scale: scale * 0.75, quality: 0.7 },
    { format: 'jpeg' as const, scale: scale * 0.5, quality: 0.6 },
    { format: 'jpeg' as const, scale: scale * 0.25, quality: 0.5 },
  ]
  // Stay below both the host limit and a modest browser/network budget.
  const maxChars = Math.floor(Math.min(maxBytes, 4_000_000) / 3) * 4
  for (const attempt of attempts) {
    signal.throwIfAborted()
    const { url } = await editor.toImageDataUrl(shapes, { background: true, padding: 16, pixelRatio: 1, ...attempt })
    signal.throwIfAborted()
    if (url.length - url.indexOf(',') - 1 <= maxChars) return url
  }
  throw new Error('preview-too-large')
}

export async function readCanvasImageLimit(signal: AbortSignal): Promise<number> {
  const response = await fetch(CANVAS_ASSET_ROUTE, { credentials: 'same-origin', signal })
  if (!response.ok) throw new Error(`host-unavailable (${response.status})`)
  const value = await response.json() as { maxImageBytes?: unknown }
  if (typeof value.maxImageBytes !== 'number' || !Number.isSafeInteger(value.maxImageBytes) || value.maxImageBytes <= 0) throw new Error('host-unavailable')
  return value.maxImageBytes
}

export interface CanvasOriginalCacheEntry { src: string | null; attachment: ImageAttachmentRef }

/** Use tldraw's resolver for IndexedDB-backed imports, not just asset.props.src.
 * Upload each original once per mount/source, with individual byte limits. */
export async function syncCanvasOriginal(editor: Editor, shape: TLShape, maxBytes: number, signal: AbortSignal, cache: Map<string, CanvasOriginalCacheEntry>): Promise<ImageAttachmentRef> {
  if (shape.type !== 'image' || shape.props.assetId === null) throw new Error('original-unavailable')
  const asset = editor.getAsset(shape.props.assetId)
  if (asset?.type !== 'image') throw new Error('original-unavailable')
  const cached = cache.get(asset.id)
  if (cached?.src === asset.props.src) return cached.attachment
  const url = await editor.resolveAssetUrl(asset.id, { shouldResolveToOriginal: true })
  signal.throwIfAborted()
  if (url === null) throw new Error('original-unavailable')
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error('original-unavailable')
  const blob = await response.blob()
  if (blob.size > maxBytes) throw new Error('original-too-large')
  const mediaType = blob.type || asset.props.mimeType || ''
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType)) throw new Error('original-format-unsupported')
  const uploaded = await fetch(CANVAS_ASSET_ROUTE, {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': mediaType }, body: blob, signal,
  })
  if (!uploaded.ok) throw new Error(uploaded.status === 413 ? 'original-too-large' : `original-upload-failed (${uploaded.status})`)
  const result = await uploaded.json() as { attachment?: ImageAttachmentRef }
  const ref = result.attachment
  if (!ref || typeof ref.attachmentId !== 'string' || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(ref.mediaType)
    || !Number.isSafeInteger(ref.bytes) || ref.bytes <= 0 || !Number.isInteger(ref.width) || ref.width <= 0 || !Number.isInteger(ref.height) || ref.height <= 0) throw new Error('original-upload-failed')
  cache.set(asset.id, { src: asset.props.src, attachment: ref })
  return ref
}
