/**
 * Shared browser image and DOM helpers for client views.
 * Completely decoupled from gallery-view and studio-view to prevent circular dependencies.
 */

/** Convert a Blob to a data URL. Used for tldraw image assets, which need a
 *  self-contained src; the session canvas keeps them in memory only (no
 *  persistenceKey, nothing touches disk). */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('blobToDataUrl failed'))
    reader.readAsDataURL(blob)
  })
}

/** Copy an image Blob to the OS clipboard, converting to PNG if required by the browser. */
export async function copyImageBlob(blob: Blob): Promise<boolean> {
  try {
    if (blob.type === 'image/png') {
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': blob }),
      ])
      return true
    }

    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(blob)
      try {
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        const ctx = canvas.getContext('2d')
        if (!ctx) return false
        ctx.drawImage(bitmap, 0, 0)
        const pngBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
        if (!pngBlob) return false
        await navigator.clipboard.write([
          new ClipboardItem({ 'image/png': pngBlob }),
        ])
        return true
      } finally {
        bitmap.close()
      }
    }

    const img = new Image()
    const url = URL.createObjectURL(blob)
    try {
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('Image decode failed'))
        img.src = url
      })
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) return false
      ctx.drawImage(img, 0, 0)
      const pngBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (!pngBlob) return false
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': pngBlob }),
      ])
      return true
    } finally {
      URL.revokeObjectURL(url)
    }
  } catch {
    return false
  }
}

/** Safely trigger a browser file download by mounting an anchor element into the DOM. */
export function downloadBlobUrl(url: string, filename: string): void {
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  try {
    link.click()
  } finally {
    document.body.removeChild(link)
  }
}

/** Human-readable relative time formatter supporting zh and en. */
export function formatRelativeTime(timestamp: number, lang: 'zh' | 'en'): string {
  const diff = Math.max(0, Date.now() - timestamp)
  if (lang === 'zh') {
    if (diff < 60_000) return '刚刚'
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
    if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
    const d = new Date(timestamp)
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
  }
  if (diff < 60_000) return 'Just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`
  const d = new Date(timestamp)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

export interface ZipFileInput {
  name: string
  data: Uint8Array
}

const CRC_TABLE = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
  }
  CRC_TABLE[i] = c
}

function crc32(buf: Uint8Array): number {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i] ?? 0
    const entry = CRC_TABLE[(crc ^ byte) & 0xFF] ?? 0
    crc = entry ^ (crc >>> 8)
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

/**
 * Create a standard zero-compression (Store mode 0) PKZip Blob from an array of files.
 * Zero external dependencies, pure browser ArrayBuffer/Blob, fast and universally compatible with OS extractors.
 */
export function createZipBlob(files: ZipFileInput[]): Blob {
  const parts: unknown[] = []
  const centralRecords: Uint8Array[] = []
  let offset = 0
  const encoder = new TextEncoder()

  for (const file of files) {
    const nameBytes = encoder.encode(file.name)
    const data = file.data
    const crc = crc32(data)
    const size = data.length

    // Local file header (30 bytes)
    const localHeader = new Uint8Array(30)
    const lv = new DataView(localHeader.buffer)
    lv.setUint32(0, 0x04034b50, true) // signature
    lv.setUint16(4, 20, true)         // version needed: 2.0
    lv.setUint16(6, 0, true)          // flags
    lv.setUint16(8, 0, true)          // compression: 0 (Store)
    lv.setUint16(10, 0, true)         // time
    lv.setUint16(12, 0, true)         // date
    lv.setUint32(14, crc, true)       // crc32
    lv.setUint32(18, size, true)      // compressed size
    lv.setUint32(22, size, true)      // uncompressed size
    lv.setUint16(26, nameBytes.length, true) // filename length
    lv.setUint16(28, 0, true)         // extra field length

    parts.push(localHeader, nameBytes, data)

    // Central directory header (46 bytes)
    const cdRecord = new Uint8Array(46)
    const cv = new DataView(cdRecord.buffer)
    cv.setUint32(0, 0x02014b50, true) // signature
    cv.setUint16(4, 20, true)         // version made by: 2.0
    cv.setUint16(6, 20, true)         // version needed: 2.0
    cv.setUint16(8, 0, true)          // flags
    cv.setUint16(10, 0, true)         // compression: 0 (Store)
    cv.setUint16(12, 0, true)         // time
    cv.setUint16(14, 0, true)         // date
    cv.setUint32(16, crc, true)       // crc32
    cv.setUint32(20, size, true)      // compressed size
    cv.setUint32(24, size, true)      // uncompressed size
    cv.setUint16(28, nameBytes.length, true) // filename length
    cv.setUint16(30, 0, true)         // extra field length
    cv.setUint16(32, 0, true)         // comment length
    cv.setUint16(34, 0, true)         // disk number start
    cv.setUint16(36, 0, true)         // internal file attributes
    cv.setUint32(38, 0, true)         // external file attributes
    cv.setUint32(42, offset, true)    // relative offset of local header

    centralRecords.push(cdRecord, nameBytes)
    offset += localHeader.length + nameBytes.length + data.length
  }

  const cdOffset = offset
  let cdSize = 0
  for (const part of centralRecords) {
    cdSize += part.byteLength
  }

  // End of central directory record (22 bytes)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(4, 0, true)            // disk number
  ev.setUint16(6, 0, true)            // disk where CD starts
  ev.setUint16(8, files.length, true) // total entries on disk
  ev.setUint16(10, files.length, true)// total entries
  ev.setUint32(12, cdSize, true)      // size of CD
  ev.setUint32(16, cdOffset, true)    // offset of CD
  ev.setUint16(20, 0, true)           // comment length

  return new Blob([...parts, ...centralRecords, eocd] as unknown as BlobPart[], { type: 'application/zip' })
}

/**
 * Downscale an image for the gallery grid.
 * Returns the source blob when the browser lacks the needed canvas APIs, so
 * callers can always render something without extra capability branches.
 */
export async function createImageThumbnail(source: Blob, width: number): Promise<Blob> {
  if (typeof createImageBitmap !== 'function') return source
  try {
    const bitmap = await createImageBitmap(source, { resizeWidth: width, resizeQuality: 'high' })
    try {
      const canvas: HTMLCanvasElement | OffscreenCanvas =
        typeof OffscreenCanvas === 'function'
          ? new OffscreenCanvas(bitmap.width, bitmap.height)
          : Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height })
      const context = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
      if (!context) return source
      context.drawImage(bitmap, 0, 0)
      if (typeof OffscreenCanvas === 'function' && canvas instanceof OffscreenCanvas) {
        return await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 })
      }
      return await new Promise<Blob>((resolve, reject) => {
        ;(canvas as HTMLCanvasElement).toBlob((blob: Blob | null) => (blob ? resolve(blob) : reject(new Error('thumbnail encode failed'))), 'image/webp', 0.82)
      })
    } finally {
      bitmap.close?.()
    }
  } catch {
    return source
  }
}
