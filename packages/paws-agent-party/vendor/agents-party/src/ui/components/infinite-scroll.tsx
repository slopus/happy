import { useVirtualizer } from '@tanstack/react-virtual'
import * as React from 'react'
import { cn } from '../utils.js'

/**
 * Scroll-driven paging for the two lists the chat screen has — no "load more" buttons.
 *
 * `direction: 'down'` pages forward as the user approaches the bottom (the party list). With `virtualize` only the
 * visible rows are in the DOM (@tanstack/react-virtual, an optional peer — only this component imports it).
 *
 * `direction: 'up'` is a reverse chat: virtualized with `anchorTo: 'end'` so prepended history keeps the viewport
 * pinned, and `followOnAppend` sticks to new messages when the user was already at the bottom. Older pages load as the
 * user scrolls toward the top.
 *
 * The virtualizer lives in the same component that renders the scroll element (TanStack's canonical pattern) — a child
 * that mounts `useVirtualizer` after the parent ref is set leaves `scrollRect` stuck at `{0,0}`.
 *
 * The component owns the scroll container; pass `scrollRef` to drive it from outside if needed.
 */

export interface InfiniteScrollProps<T> {
  data: T[]
  renderItem: (item: T, index: number) => React.ReactNode
  getItemKey: (item: T, index: number) => React.Key
  empty?: React.ReactNode
  direction?: 'down' | 'up'
  /** Virtualize rows — for flat lists that can grow into the thousands. Always on for `direction: 'up'`. */
  virtualize?: boolean
  /** Estimated row height for the virtualizer (px). */
  estimateSize?: number
  canLoadMore?: boolean
  isLoadingMore?: boolean
  onLoadMore?: () => unknown
  /** The scroll container (it scrolls; style it with height/flex classes). */
  className?: string
  /** The inner list wrapper (padding / non-virtual layout). */
  listClassName?: string
  /** Access to the scroll container element. */
  scrollRef?: React.RefObject<HTMLDivElement | null>
  onScroll?: React.UIEventHandler<HTMLDivElement>
  /**
   * When this value changes, a chat list (`direction: 'up'`) jumps to the latest message — use the opened party id so
   * switching parties lands at the bottom.
   */
  stickKey?: React.Key
}

interface LoadState {
  canLoadMore: boolean
  isLoadingMore: boolean
  onLoadMore?: (() => unknown) | undefined
}

const subscribeToMount = () => () => {}
const getClientSnapshot = () => true
const getServerSnapshot = () => false

const itemKeyToVirtual = (key: React.Key): string | number => (typeof key === 'number' ? key : String(key))

export const InfiniteScroll = <T,>({
  data,
  renderItem,
  getItemKey,
  empty = null,
  direction = 'down',
  virtualize = false,
  estimateSize = 60,
  canLoadMore = false,
  isLoadingMore = false,
  onLoadMore,
  className,
  listClassName,
  scrollRef,
  onScroll,
  stickKey,
}: InfiniteScrollProps<T>) => {
  // State (not a ref alone) so the virtualizer re-runs once the scroll element is actually in the DOM.
  const [scrollEl, setScrollEl] = React.useState<HTMLDivElement | null>(null)
  const hasMounted = React.useSyncExternalStore(subscribeToMount, getClientSnapshot, getServerSnapshot)

  const setContainer = React.useCallback(
    (node: HTMLDivElement | null) => {
      setScrollEl(node)
      if (scrollRef) scrollRef.current = node
    },
    [scrollRef],
  )

  const isChat = direction === 'up'
  const useVirt = hasMounted && (virtualize || isChat) && data.length > 0

  const getItemKeyStable = React.useCallback(
    (index: number) => itemKeyToVirtual(getItemKey(data[index]!, index)),
    [data, getItemKey],
  )

  const virtualizer = useVirtualizer({
    // React 19 may notify during commit when the Party list changes.
    useFlushSync: false,
    count: useVirt ? data.length : 0,
    getScrollElement: () => scrollEl,
    estimateSize: () => estimateSize,
    getItemKey: getItemKeyStable,
    overscan: 10,
    enabled: useVirt && scrollEl !== null,
    ...(isChat
      ? {
          anchorTo: 'end' as const,
          followOnAppend: true as const,
          scrollEndThreshold: 80,
        }
      : {}),
  })

  const virtualItems = virtualizer.getVirtualItems()

  // Latest load state for observer/effect callbacks (they close over a stable ref).
  const loadStateRef = React.useRef<LoadState>({ canLoadMore, isLoadingMore, onLoadMore })
  React.useEffect(() => {
    loadStateRef.current = { canLoadMore, isLoadingMore, onLoadMore }
  })

  // ── direction 'down' + virtual: fetch next page when the last visible row approaches the end ──
  const lastVirtualIndex = virtualItems.at(-1)?.index
  React.useEffect(() => {
    if (!useVirt || isChat) return
    const state = loadStateRef.current
    if (!state.canLoadMore || state.isLoadingMore || state.onLoadMore === undefined || data.length === 0) return
    if (lastVirtualIndex !== undefined && lastVirtualIndex >= data.length - 1) void state.onLoadMore()
  }, [useVirt, isChat, data.length, lastVirtualIndex])

  // ── direction 'up': jump to latest when opening a party (or first paint with messages) ──
  const didStickRef = React.useRef<React.Key | null>(null)
  React.useLayoutEffect(() => {
    if (!useVirt || !isChat || data.length === 0) return
    const key = stickKey ?? '__default__'
    if (didStickRef.current === key) return
    didStickRef.current = key
    if (typeof virtualizer.scrollToEnd === 'function') virtualizer.scrollToEnd()
  }, [useVirt, isChat, stickKey, data.length, virtualizer])

  // ── non-virtual sentinel (direction 'down' without virtualize) ──
  const sentinelRef = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    if (useVirt) return
    const el = scrollEl
    const sentinel = sentinelRef.current
    if (el === null || sentinel === null) return
    const observer = new IntersectionObserver(
      (entries) => {
        const state = loadStateRef.current
        if (!entries.some((entry) => entry.isIntersecting)) return
        if (!state.canLoadMore || state.isLoadingMore || state.onLoadMore === undefined) return
        void state.onLoadMore()
      },
      { root: el, rootMargin: '200px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [useVirt, scrollEl, direction])

  const handleScroll: React.UIEventHandler<HTMLDivElement> = (event) => {
    onScroll?.(event)
    if (!useVirt || !isChat) return
    const state = loadStateRef.current
    if (!state.canLoadMore || state.isLoadingMore || state.onLoadMore === undefined) return
    // Near the top → load older history. anchorTo:'end' keeps the visible message pinned after the prepend.
    if (event.currentTarget.scrollTop < 120) void state.onLoadMore()
  }

  const sentinel = <div ref={sentinelRef} aria-hidden className="h-px shrink-0" />

  let body: React.ReactNode
  if (data.length === 0) {
    body = empty
  } else if (useVirt) {
    body = (
      <div
        className={listClassName}
        style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}
      >
        {virtualItems.map((virtualItem) => (
          <div
            key={virtualItem.key}
            ref={virtualizer.measureElement}
            data-index={virtualItem.index}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualItem.start}px)`,
            }}
          >
            {renderItem(data[virtualItem.index]!, virtualItem.index)}
          </div>
        ))}
      </div>
    )
  } else {
    body = (
      <div className={listClassName}>
        {direction === 'up' && sentinel}
        {data.map((item, index) => (
          <React.Fragment key={getItemKey(item, index)}>{renderItem(item, index)}</React.Fragment>
        ))}
        {direction === 'down' && sentinel}
      </div>
    )
  }

  return (
    <div ref={setContainer} className={cn('min-h-0 overflow-y-auto', className)} onScroll={handleScroll}>
      {body}
    </div>
  )
}
