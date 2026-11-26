import { memo, useCallback, useId, useRef, useState, type FC } from 'react'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  DefaultToolbar,
  Tldraw,
  createShapeId,
  type Editor,
  type TLAssetId,
  type TLCreateShapePartial,
  type TLImageAsset,
  type TLImageShape,
} from 'tldraw'
import { blobToDataUrl } from '../browser-image-utils.js'
import { clearAttachmentCache, fetchAttachmentBlob } from '../image-cache.js'
import { CANVAS_MAX_PROMPT_CHARS } from '../../shared.js'
import { applyBrandTheme, syncTldrawThemeWithHost } from './tl-brand-theme.js'
import { startCanvasSync, type CanvasSyncStatus } from './canvas-sync.js'
import { clearTlLandings, getTlLandingGeneration, registerTlLandingConsumer, type TlLandingItem } from './tl-canvas-bridge.js'
import { GALLERY_IMAGE_MIME, readGalleryImageDrop } from './gallery-image-transfer.js'

/**
 * Infinite canvas surface for the Studio workbench, backed by tldraw.
 *
 * Both surfaces share one locally persisted document. The landing queue is
 * consumed once; tldraw owns subsequent edits, deletion, undo and persistence.
 */

const MAX_DISPLAY_SIDE = 380
const GRID_GAP = 40
const GRID_COLS = 3

const mountedCanvases = new Set<() => void>()
const mountedEditors = new Set<Editor>()

/** Reset canvas-owned data only. Gallery records and host attachments are untouched. */
export function clearStudioTlCanvases(): boolean {
  if (mountedCanvases.size === 0) return false
  clearTlLandings()
  for (const clear of mountedCanvases) clear()
  clearAttachmentCache()
  return true
}

/**
 * Cancel in-editor selection on every mounted canvas, keeping shapes and sync
 * untouched. Selection is interaction state tied to the surface: leaving the
 * studio page cancels it so a stale selection can neither resurface on return
 * nor linger in the host mirror.
 */
export function deselectStudioTlCanvases(): boolean {
  if (mountedEditors.size === 0) return false
  for (const editor of mountedEditors) editor.run(() => editor.selectNone())
  return true
}

/**
 * Dock the stock toolbar vertically along the left edge (Figma-style) instead
 * of tldraw's signature bottom-center pill. It is still the same
 * DefaultToolbar with the same tools and overflow handling — only the
 * orientation changes, which is what makes the whole composition read as our
 * own surface rather than stock tldraw. TL_THEME_CSS offsets it from the
 * screen edge like the other floating cards.
 */
const StudioToolbar = () => <DefaultToolbar orientation="vertical" />

function tlAssetIdFor(galleryId: string): TLAssetId {
  return `asset:ig-${galleryId.replace(/[^A-Za-z0-9_-]/g, '_')}` as TLAssetId
}

function displaySizeOf(attachment: ImageAttachmentRef): { w: number; h: number } {
  const width = attachment.width > 0 ? attachment.width : 512
  const height = attachment.height > 0 ? attachment.height : 512
  const scale = MAX_DISPLAY_SIDE / Math.max(width, height)
  return { w: Math.round(width * scale), h: Math.round(height * scale) }
}

/** Dedupe across the whole document, including images moved to other pages. */
function landedIdsOf(editor: Editor): Set<string> {
  const landedIds = new Set<string>()
  for (const shape of editor.store.allRecords()) {
    if (shape.typeName !== 'shape' || shape.type !== 'image') continue
    const galleryId = (shape.meta as { galleryId?: unknown } | undefined)?.galleryId
    if (typeof galleryId === 'string') landedIds.add(galleryId)
  }
  return landedIds
}

/** Truncate the prompt copied onto a shape: the canvas digest stays compact. */
function metaPromptOf(prompt: string | undefined): string | undefined {
  if (typeof prompt !== 'string') return undefined
  const collapsed = prompt.replace(/\s+/g, ' ').trim()
  return collapsed.length === 0 ? undefined : collapsed.slice(0, CANVAS_MAX_PROMPT_CHARS)
}

export async function landTlItems(editor: Editor, items: readonly TlLandingItem[], isActive: () => boolean, onUnreadable?: () => void): Promise<boolean> {
  // Explicit saves may request an image that is already in the document.
  const landedIds = landedIdsOf(editor)
  const pending = items.filter(item => !landedIds.has(item.galleryId))
  if (pending.length === 0) return true

  const assets: TLImageAsset[] = []
  const landed: Array<{ galleryId: string; assetId: TLAssetId; w: number; h: number; attachmentId: string; name: string; fromConversation: boolean; prompt?: string; provider?: string; model?: string }> = []
  for (const item of pending) {
    if (!isActive()) return false
    const assetId = tlAssetIdFor(item.galleryId)
    if (editor.getAsset(assetId) === undefined) {
      try {
        const blob = await fetchAttachmentBlob(item.attachment)
        const src = await blobToDataUrl(blob)
        assets.push({
          id: assetId,
          typeName: 'asset',
          type: 'image',
          meta: {},
          props: {
            name: item.attachment.name ?? item.galleryId,
            src,
            w: item.attachment.width > 0 ? item.attachment.width : 512,
            h: item.attachment.height > 0 ? item.attachment.height : 512,
            mimeType: blob.type || item.attachment.mediaType,
            isAnimated: item.attachment.mediaType === 'image/gif',
            fileSize: item.attachment.bytes,
          },
        })
      } catch (error) {
        console.warn('[dsh-image-gen] canvas landing skipped (attachment unreadable):', item.galleryId, error)
        if (isActive()) onUnreadable?.()
        continue
      }
    }
    const size = displaySizeOf(item.attachment)
    const prompt = metaPromptOf(item.prompt)
    landed.push({
      galleryId: item.galleryId,
      assetId,
      attachmentId: String(item.attachment.attachmentId),
      name: item.attachment.name ?? item.galleryId,
      fromConversation: item.fromConversation === true,
      w: size.w,
      h: size.h,
      ...(prompt !== undefined ? { prompt } : {}),
      ...(typeof item.provider === 'string' && item.provider.length > 0 ? { provider: item.provider } : {}),
      ...(typeof item.model === 'string' && item.model.length > 0 ? { model: item.model } : {}),
    })
  }
  if (!isActive()) return false
  // A second surface/tab may have synchronized this image during the fetch.
  const nowLanded = landedIdsOf(editor)
  const ready = landed.filter(item => !nowLanded.has(item.galleryId))
  if (ready.length === 0) return true
  if (assets.length > 0) editor.createAssets(assets)

  // Layout: rows of up to GRID_COLS images. The block prefers the viewport
  // center; when that spot is already occupied it drops below all existing
  // content, so consecutive batches never stack on top of each other.
  const rows: Array<typeof ready> = []
  for (let index = 0; index < ready.length; index += GRID_COLS) rows.push(ready.slice(index, index + GRID_COLS))
  const rowSizes = rows.map(row => ({
    width: row.reduce((sum, cell) => sum + cell.w, 0) + GRID_GAP * (row.length - 1),
    height: Math.max(...row.map(cell => cell.h)),
  }))
  const blockWidth = Math.max(...rowSizes.map(size => size.width))
  const blockHeight = rowSizes.reduce((sum, size) => sum + size.height, 0) + GRID_GAP * (rows.length - 1)
  const viewport = editor.getViewportPageBounds()
  const originX = viewport.center.x - blockWidth / 2
  let originY = viewport.center.y - blockHeight / 2

  const existing = editor.getCurrentPageShapes()
  if (existing.length > 0) {
    // Cushion the candidate by half a gap so landed batches keep breathing room.
    const cushion = GRID_GAP / 2
    const candidateX = originX - cushion
    const candidateY = originY - cushion
    const candidateW = blockWidth + cushion * 2
    const candidateH = blockHeight + cushion * 2
    let occupied = false
    let contentBottom = Number.NEGATIVE_INFINITY
    for (const shape of existing) {
      const bounds = editor.getShapePageBounds(shape.id)
      if (bounds === undefined) continue
      if (bounds.maxY > contentBottom) contentBottom = bounds.maxY
      if (!occupied
        && candidateX < bounds.maxX && candidateX + candidateW > bounds.minX
        && candidateY < bounds.maxY && candidateY + candidateH > bounds.minY) {
        occupied = true
      }
    }
    if (occupied) originY = contentBottom + GRID_GAP
  }
  let cursorY = originY
  const shapes: TLCreateShapePartial<TLImageShape>[] = []
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex]!
    const rowSize = rowSizes[rowIndex]!
    let cursorX = originX + (blockWidth - rowSize.width) / 2
    for (const cell of row) {
      shapes.push({
        id: createShapeId(`ig-${cell.galleryId}`),
        type: 'image',
        x: Math.round(cursorX),
        y: Math.round(cursorY),
        props: { assetId: cell.assetId, w: cell.w, h: cell.h },
        // Generation provenance rides on meta: canvas-sync surfaces it in the
        // model-facing digest so "regenerate this" reuses the original params.
        meta: {
          galleryId: cell.galleryId,
          attachmentId: cell.attachmentId,
          name: cell.name,
          fromConversation: cell.fromConversation,
          ...(cell.prompt !== undefined ? { prompt: cell.prompt } : {}),
          ...(cell.provider !== undefined ? { provider: cell.provider } : {}),
          ...(cell.model !== undefined ? { model: cell.model } : {}),
        },
      })
      cursorX += cell.w + GRID_GAP
    }
    cursorY += rowSize.height + GRID_GAP
  }
  editor.createShapes(shapes)

  // When the batch landed outside the visible viewport (e.g. below older
  // content), bring it into view: pan if it fits at the current zoom,
  // otherwise zoom out just enough to frame it.
  const visible = originX >= viewport.minX && originY >= viewport.minY
    && originX + blockWidth <= viewport.maxX && originY + blockHeight <= viewport.maxY
  if (!visible) {
    if (blockWidth <= viewport.w && blockHeight <= viewport.h) {
      editor.centerOnPoint({ x: originX + blockWidth / 2, y: originY + blockHeight / 2 }, { animation: { duration: 240 } })
    } else {
      editor.zoomToBounds({ x: originX, y: originY, w: blockWidth, h: blockHeight }, { animation: { duration: 240 }, inset: GRID_GAP })
    }
  }
  return true
}

const TL_COMPONENTS = { Toolbar: StudioToolbar }

export const StudioTlCanvas: FC<{ lang?: 'zh' | 'en'; licenseKey?: string | undefined }> = memo(function StudioTlCanvas({ lang = 'zh', licenseKey }) {
  // tldraw 5.3.0 reads licenseKey once when LicenseProvider mounts; it has no
  // runtime update path. StudioView gates mounting until the config read
  // settles, so capture that one value here: a later config refresh must not
  // remount the editor and race its ~350ms IndexedDB persistence throttle.
  const [initialLicenseKey] = useState(licenseKey)
  // Separate camera/selection state for editors sharing the document.
  const sessionId = useId()
  const [syncStatus, setSyncStatus] = useState<CanvasSyncStatus>({ phase: 'idle', count: 0 })
  const [landingError, setLandingError] = useState(false)
  const retrySync = useRef<() => void>(() => {})
  const editorRef = useRef<Editor | null>(null)
  const onMount = useCallback((editor: Editor) => {
          let active = true
          editorRef.current = editor
          // tldraw restores instance state (including the selection) from the
          // persisted snapshot; every mount starts as fresh interaction state.
          editor.run(() => editor.selectNone())
          mountedEditors.add(editor)
          // Re-tint canvas-rendered colors (selection, marquee, "blue"
          // palette) to the plugin brand; UI chrome comes from TL_THEME_CSS.
          applyBrandTheme(editor)
          // Follow the DSH host's light/dark theme, now and on later flips.
          const stopThemeSync = syncTldrawThemeWithHost(editor)
          // Dot-grid backdrop: tldraw's built-in zoom-aware grid, re-tinted to
          // the workbench blue-grey. Gives the empty canvas spatial rhythm and
          // alignment reference without the graph-paper feel of line grids.
          editor.updateInstanceState({ isGridMode: true })
          // One console line proves the editor booted inside the webview;
          // useful when the host page swallows render errors.
          console.info(`[dsh-image-gen] tldraw mounted (instance ${editor.id})`)
          // tldraw calls onMount after the local document has loaded.
          const stopLanding = registerTlLandingConsumer(items => {
            const generation = getTlLandingGeneration()
            setLandingError(false)
            return landTlItems(editor, items, () => active && generation === getTlLandingGeneration(), () => setLandingError(true))
          })
          // Mirror this canvas into the host so the conversation agent can
          // see it (canvas_state / view_canvas / edit_image canvas_selection).
          let stopSync = startCanvasSync(editor, setSyncStatus)
          retrySync.current = () => stopSync.retry()
          const clear = (): void => {
            setLandingError(false)
            // Stop outstanding screenshots as well as the old host selection.
            stopSync()
            editor.complete()
            editor.run(() => {
              editor.selectNone()
              const pages = editor.getPages()
              for (const page of pages) {
                editor.deleteShapes([...editor.getPageShapeIds(page.id)])
              }
              for (const page of pages.slice(1)) editor.deletePage(page.id)
              editor.deleteAssets(editor.getAssets())
              editor.setCamera({ x: 0, y: 0, z: 1 })
            }, { history: 'ignore', ignoreShapeLock: true })
            editor.clearHistory()
            stopSync = startCanvasSync(editor, setSyncStatus)
          }
          mountedCanvases.add(clear)
          return () => {
            active = false
            if (editorRef.current === editor) editorRef.current = null
            mountedEditors.delete(editor)
            mountedCanvases.delete(clear)
            stopLanding()
            stopThemeSync()
            stopSync()
            retrySync.current = () => {}
          }
  }, [])
  const statusText = lang === 'en'
    ? syncStatus.phase === 'ready' ? `Selection ready · ${syncStatus.count} shapes`
      : syncStatus.phase === 'preparing' ? `Preparing selection · ${syncStatus.count} shapes…`
        : 'Selection sync failed'
    : syncStatus.phase === 'ready' ? `选区已就绪 · ${syncStatus.count} 个元素`
      : syncStatus.phase === 'preparing' ? `正在准备选区 · ${syncStatus.count} 个元素…`
        : '选区同步失败'

  return (
    <div className="dsh-ig-tl-canvas" onDragOverCapture={event => {
      // Drag-over runs in protected mode: inspect types, not getData().
      // A cold internal drag has no Files payload for tldraw's handler.
      if (!editorRef.current || !event.dataTransfer.types.includes(GALLERY_IMAGE_MIME)) return
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = 'copy'
    }} onDropCapture={event => {
      const item = readGalleryImageDrop(event.dataTransfer)
      const editor = editorRef.current
      if (!item || !editor) return
      event.preventDefault()
      event.stopPropagation()
      setLandingError(false)
      const generation = getTlLandingGeneration()
      void landTlItems(editor, [item], () => editorRef.current === editor && generation === getTlLandingGeneration(), () => setLandingError(true))
        .catch(error => {
          if (editorRef.current === editor) setLandingError(true)
          console.warn('[dsh-image-gen] history image drop failed:', error)
        })
    }}>
      <Tldraw
        key={initialLicenseKey ?? ''}
        persistenceKey="dsh-image-gen-workbench-v1"
        sessionId={sessionId}
        components={TL_COMPONENTS}
        onMount={onMount}
        {...(initialLicenseKey === undefined || initialLicenseKey.length === 0 ? {} : { licenseKey: initialLicenseKey })}
      />
      {(landingError || syncStatus.phase !== 'idle') && (
        <div className="dsh-ig-canvas-sync-status" data-phase={landingError ? 'error' : syncStatus.phase} role="status" aria-live="polite">
          <span>{landingError
            ? lang === 'en' ? 'Could not read the original image. Reload it and try again.' : '无法读取原图，请重新加载图片后重试。'
            : <>{statusText}{syncStatus.phase === 'error' ? `：${canvasSyncError(syncStatus.error, lang)}` : ''}</>}</span>
          {!landingError && syncStatus.phase === 'error' && <button type="button" onClick={() => retrySync.current()}>{lang === 'en' ? 'Retry' : '重试'}</button>}
        </div>
      )}
    </div>
  )
})

function canvasSyncError(error: string | undefined, lang: 'zh' | 'en'): string {
  const en = lang === 'en'
  if (error?.includes('too-many-selected')) return en ? 'Select at most 16 shapes to edit with originals.' : '使用原图编辑时，请一次选择不超过 16 个元素。'
  if (error?.includes('too-large')) return en ? 'An image exceeds the size limit. Reduce its size and retry.' : '图片超出大小限制，请缩小后重试。'
  if (error?.includes('unsupported')) return en ? 'Use PNG, JPEG, WebP or GIF images.' : '请使用 PNG、JPEG、WebP 或 GIF 图片。'
  if (error?.includes('host-unavailable')) return en ? 'Restart DSH to load the updated plugin, then retry.' : '请重启 DSH 加载新版插件后重试。'
  return en ? 'Check the connection or re-import an unavailable image, then retry.' : '请检查连接；若原图已失效，请重新导入后重试。'
}
