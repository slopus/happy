import { Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'
import type { PartyMeta } from '../../core/types.js'
import { Badge } from '../components/badge.js'
import { InfiniteScroll } from '../components/infinite-scroll.js'
import { cn } from '../utils.js'

/** What the sidebar needs to show one party row — a subset of the registry meta plus a derived `closed` flag. */
export type PartyListItem = Pick<PartyMeta, 'id' | 'title' | 'lastMessageAt' | 'messagesCount'> & {
  closed?: boolean
}

const whenLabel = (lastMessageAt: number | null): string =>
  lastMessageAt === null ? '暂无消息' : new Date(lastMessageAt).toLocaleString()

/**
 * The left pane of the chat screen: a chronological list of parties. Purely presentational — the host wires the data,
 * the `onOpen` handler and, when its registry pages, `hasMore`/`onLoadMore` (rows are virtualized, so thousands of
 * parties stay cheap). The active party is highlighted. An optional `header` slot pins above the list (it doesn't
 * scroll) — the site drops its "create party" form there; the CLI-only viewer leaves it empty. While `loading` is set
 * and the list is still empty, a spinner replaces `emptyHint` so we never claim "no parties yet" mid-fetch.
 *
 * Row padding tracks the site header (`px-4 sm:px-6`) so the list lines up with the shell on either width.
 */
export const PartySidebar = ({
  parties,
  activeId,
  onOpen,
  hasMore = false,
  isLoadingMore = false,
  onLoadMore,
  className,
  header,
  loading = false,
  emptyHint = '暂无会诊。点击“新建会诊”开始。',
}: {
  parties: PartyListItem[]
  activeId?: string | null
  onOpen: (id: string) => void
  hasMore?: boolean
  isLoadingMore?: boolean
  onLoadMore?: () => void
  className?: string
  header?: ReactNode
  loading?: boolean
  emptyHint?: string
}) => (
  <aside className={cn('flex h-full min-h-0 flex-col border-r border-border', className)}>
    {header !== undefined && <div className="shrink-0 border-b border-border px-4 py-3 sm:px-6">{header}</div>}
    <InfiniteScroll
      data={parties}
      getItemKey={(party) => party.id}
      empty={
        loading ? (
          // Fill the scroll pane so the spinner centers in the sidebar, not at the top-left corner.
          <div className="flex h-full items-center justify-center p-6 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" aria-label="会诊加载中" />
          </div>
        ) : (
          <p className="px-4 py-4 text-sm text-muted-foreground sm:px-6">{emptyHint}</p>
        )
      }
      direction="down"
      virtualize
      estimateSize={64}
      canLoadMore={hasMore}
      isLoadingMore={isLoadingMore}
      {...(onLoadMore === undefined ? {} : { onLoadMore })}
      className="min-h-0 flex-1"
      renderItem={(party) => (
        <button
          type="button"
          onClick={() => onOpen(party.id)}
          className={cn(
            'flex w-full flex-col gap-0.5 border-b border-border px-4 py-3 text-left hover:bg-muted/40 sm:px-6',
            party.id === activeId && 'bg-muted/60 shadow-[inset_3px_0_0_var(--color-primary)]',
          )}
        >
          <span className="flex items-center gap-2">
            <span className="min-w-0 truncate font-accent text-sm font-semibold text-foreground">{party.title}</span>
            {party.closed && (
              <Badge variant="secondary" className="shrink-0">
                已关闭
              </Badge>
            )}
          </span>
          <span className="font-accent text-xs text-muted-foreground">
            {whenLabel(party.lastMessageAt)} · {party.messagesCount} 条消息
          </span>
        </button>
      )}
    />
  </aside>
)
