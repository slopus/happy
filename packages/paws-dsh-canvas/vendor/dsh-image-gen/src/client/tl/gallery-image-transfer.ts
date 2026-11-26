import type { GalleryItem } from '../gallery-store.js'
import type { TlLandingItem } from './tl-canvas-bridge.js'
import { CANVAS_MAX_PROMPT_CHARS } from '../../shared.js'

export const GALLERY_IMAGE_MIME = 'application/x-dsh-image-gen-gallery-image'
const EXTENSIONS = new Map([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp'], ['image/gif', 'gif']])
type DragStart = { dataTransfer: DataTransfer | null; preventDefault(): void }

export function galleryLanding(item: GalleryItem): TlLandingItem {
  return { galleryId: item.id, attachment: item.attachment, prompt: item.prompt.slice(0, CANVAS_MAX_PROMPT_CHARS), provider: item.provider, model: item.model }
}

/** Internal drops resolve the attachment after landing; loaded blobs also support file drag-out. */
export function startGalleryImageDrag(event: DragStart, item: GalleryItem, blob: Blob | null | undefined): boolean {
  const transfer = event.dataTransfer
  const mediaType = blob?.type || item.attachment.mediaType
  const extension = EXTENSIONS.get(mediaType)
  if (!transfer || !extension) { event.preventDefault(); return false }
  try {
    // Remove the browser's URL-only payload (and any native file) before adding ours.
    transfer.items.clear()
    transfer.effectAllowed = 'copy'
    let supported = false
    if (blob?.size) {
      try {
        const name = item.id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100) || 'image'
        const file = new File([blob], `${name}.${extension}`, { type: mediaType })
        supported = transfer.items.add(file) !== null
      } catch { /* The internal reference can still work when files are rejected. */ }
    }
    // Starting an internal drag must not wait for hover-prefetched originals.
    // Keep these independent: a host may accept only files or only custom MIME.
    try {
      transfer.setData(GALLERY_IMAGE_MIME, JSON.stringify(galleryLanding(item)))
      supported = true
    } catch { /* File fallback when an original is already available. */ }
    if (supported) return true
  } catch { /* An unavailable transfer store cannot start a drag. */ }
  event.preventDefault()
  return false
}

export function readGalleryImageDrop(transfer: Pick<DataTransfer, 'getData'>): TlLandingItem | undefined {
  try {
    const raw = transfer.getData(GALLERY_IMAGE_MIME)
    if (!raw || raw.length > 64_000) return undefined
    const value: unknown = JSON.parse(raw)
    if (!record(value) || !text(value.galleryId) || !record(value.attachment)) return undefined
    const a = value.attachment
    if (!text(a.attachmentId) || typeof a.mediaType !== 'string' || !EXTENSIONS.has(a.mediaType)
      || !dimension(a.bytes) || !dimension(a.width) || !dimension(a.height)
      || (a.name !== undefined && (typeof a.name !== 'string' || a.name.length > 1024))) return undefined
    if (typeof value.prompt !== 'string' || value.prompt.length > CANVAS_MAX_PROMPT_CHARS
      || typeof value.provider !== 'string' || !text(value.provider)
      || typeof value.model !== 'string' || value.model.length > 1024) return undefined
    return {
      galleryId: value.galleryId,
      attachment: {
        attachmentId: a.attachmentId as GalleryItem['attachment']['attachmentId'], mediaType: a.mediaType as GalleryItem['attachment']['mediaType'],
        bytes: a.bytes, width: a.width, height: a.height,
        ...(typeof a.name === 'string' ? { name: a.name } : {}),
      },
      prompt: value.prompt, provider: value.provider, model: value.model,
    }
  } catch { return undefined }
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 1024 }
function dimension(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
