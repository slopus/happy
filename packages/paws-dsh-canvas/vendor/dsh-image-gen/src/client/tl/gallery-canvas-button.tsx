import { useSyncExternalStore, type FC } from 'react'
import { Frame } from 'lucide-react'
import type { GalleryItem } from '../gallery-store.js'
import { galleryLanding } from './gallery-image-transfer.js'
import { hasTlLandingConsumer, sendTlLandingToOpenCanvas, subscribeTlLandingAvailability } from './tl-canvas-bridge.js'

/** An explicit alternative to native dragging, including a visible unavailable state. */
export const GalleryCanvasButton: FC<{
  item: GalleryItem
  lang: 'zh' | 'en'
  disabled?: boolean
  className?: string
  onToast(message: string): void
}> = ({ item, lang, disabled, className, onToast }) => {
  const available = useSyncExternalStore(subscribeTlLandingAvailability, hasTlLandingConsumer, () => false)
  const open = lang === 'en' ? 'Open the infinite canvas first' : '请先打开无限画布'
  const title = !available ? open : disabled
    ? lang === 'en' ? 'Wait for the image to load' : '请等待图片加载完成'
    : lang === 'en' ? 'Send to canvas' : '发送到画布'
  return <button type="button" className={className} title={title} aria-label={title} disabled={!available || disabled}
    onClick={event => {
      event.stopPropagation()
      const sent = sendTlLandingToOpenCanvas(galleryLanding(item))
      onToast(sent ? lang === 'en' ? 'Sent to canvas' : '已发送到画布' : open)
    }}><Frame size={14} /></button>
}
