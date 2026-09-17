import { ListFilter, Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Message, Participant } from '../../core/types.js'
import { useMemo, useState } from 'react'
import { looksLikeDiff, summarizeDiff } from '../../core/diff.js'
import { Badge } from '../components/badge.js'
import { Button } from '../components/button.js'
import { InfiniteScroll } from '../components/infinite-scroll.js'
import { Menu } from '../components/menu.js'
import { cn } from '../utils.js'
import { PartyComposer } from './composer.js'
import { DiffCard, DiffModal } from './diff-modal.js'
import { MessageText, ParticipantDot } from './message.js'
import { PartySidebar, type PartyListItem } from './sidebar.js'
import { chatViewModes, isVisibleInView, type ChatViewMode } from './view-mode.js'

/** A message ready to render: the body is already decrypted (or `null` when it couldn't be). */
export type ChatMessage = Pick<Message, 'id' | 'kind' | 'from' | 'to' | 'ts'> & {
  /** Decrypted plaintext, or `null` when the key is wrong/missing. Empty for join/leave events. */
  text: string | null
}

/** Recipients multiselect: `selected` empty ⇒ everyone. The host owns the state; the chip row just toggles it. */
export interface RecipientsState {
  /** Addressable participants (active, excluding the current sender). */
  options: Pick<Participant, 'name' | 'color'>[]
  selected: string[]
  onToggle: (name: string) => void
  onEveryone: () => void
}

const timeLabel = (ts: number): string => new Date(ts).toLocaleTimeString()

/** A short label for the diff modal title bar: the file when there's one, else the file count. */
const diffTitle = (text: string): string => {
  const s = summarizeDiff(text)
  return s.firstFile ?? `${s.files} ${s.files === 1 ? 'file' : 'files'}`
}

export interface ChatProps {
  /** Left pane. */
  parties: PartyListItem[]
  activeId: string | null
  onOpenParty: (id: string) => void
  /** Party-list paging (scroll-driven): more registry pages exist / fetch the next one. */
  partiesHasMore?: boolean
  partiesLoadingMore?: boolean
  onLoadMoreParties?: () => void
  /** First party-list fetch still in flight — the sidebar shows a spinner instead of the "no parties yet" hint. */
  partiesLoading?: boolean
  /** Pinned above the party list (doesn't scroll) — the site puts its "create party" form here. */
  sidebarHeader?: ReactNode
  /** Actions for the open party's header, beside the title/participants — e.g. Invite / Delete. */
  headerActions?: ReactNode
  /** Current party (null ⇒ nothing opened yet). */
  title: string | null
  closed?: boolean
  participants: Participant[]
  messages: ChatMessage[]
  /**
   * The party's first page (messages + participants) is still in flight. Without it an opening party looks like an
   * empty one — "No messages yet" and "Nobody yet" are claims, and claiming them mid-fetch is simply a lie.
   */
  messagesLoading?: boolean
  hasOlder?: boolean
  loadingOlder?: boolean
  onLoadOlder?: () => void
  onSend: (text: string) => Promise<void>
  composerDisabled?: boolean
  composerHasContent?: boolean
  composerExtension?: ReactNode
  renderMessage?: (message: ChatMessage) => ReactNode
  onOpenParticipant?: (name: string) => void
  recipients: RecipientsState
  /**
   * The viewer's own participant name — drives listen/send addressing (not shown as a marker) and answers "is this for
   * me?" for the view filter in the header. Defaults to `host`.
   */
  currentName?: string
  sidebarClassName?: string
  /** Close the opened party (small screens show either the list or the conversation — this is the way back). */
  onBack?: () => void
}

/** The two-pane party screen: party list on the left, the opened conversation on the right. */
export const Chat = ({
  parties,
  activeId,
  onOpenParty,
  partiesHasMore,
  partiesLoadingMore,
  onLoadMoreParties,
  partiesLoading,
  sidebarHeader,
  headerActions,
  title,
  closed,
  participants,
  messages,
  messagesLoading = false,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  onSend,
  composerDisabled,
  composerHasContent,
  composerExtension,
  renderMessage,
  onOpenParticipant,
  recipients,
  currentName = 'host',
  sidebarClassName,
  onBack,
}: ChatProps) => {
  // One pane at a time on small screens: the list until a party is opened, then the conversation (with a back
  // button); side by side from `md` up.
  const sidebarClasses =
    sidebarClassName ?? cn('w-72 md:flex lg:w-80', title === null ? 'flex w-full md:w-72' : 'hidden')
  const colorOf = useMemo(() => {
    const map = new Map(participants.map((p) => [p.name, p.color]))
    return (name: string): string | undefined => map.get(name)
  }, [participants])

  // A diff message opens in a modal on click; null when nothing is open.
  const [openDiff, setOpenDiff] = useState<{ text: string; title: string } | null>(null)

  // The reader's own noise filter. Local state on purpose: it hides nothing from anyone else and fetches nothing, so
  // switching is instant on messages already on screen.
  const [viewMode, setViewMode] = useState<ChatViewMode>('all')
  const visible = useMemo(
    () =>
      viewMode === 'all' ? messages : messages.filter((message) => isVisibleInView(message, viewMode, currentName)),
    [messages, viewMode, currentName],
  )
  const hidden = messages.length - visible.length

  // Clicking a name addresses it — in the header, and on any message. Only names the composer can actually address:
  // active participants other than you, which is exactly what the recipients row offers.
  const addressable = useMemo(() => new Set(recipients.options.map((option) => option.name)), [recipients.options])
  const canAddress = (name: string): boolean => closed !== true && addressable.has(name)
  const addressTitle = (name: string): string =>
    onOpenParticipant ? `查看 ${name} 执行详情` : recipients.selected.includes(name) ? `取消发送给 ${name}` : `发送给 ${name}`
  const activateParticipant = (name: string) => onOpenParticipant ? onOpenParticipant(name) : recipients.onToggle(name)

  const recipientsRow = (
    <>
      <span>发送给：</span>
      <button
        type="button"
        onClick={recipients.onEveryone}
        className={cn(
          'rounded-full border border-border px-2.5 py-0.5 transition-colors select-none hover:bg-muted/60',
          recipients.selected.length === 0 && 'border-primary bg-primary text-primary-foreground hover:bg-primary',
        )}
      >
        默认主持人
      </button>
      {recipients.options.map((option) => {
        const on = recipients.selected.includes(option.name)
        return (
          <button
            key={option.name}
            type="button"
            onClick={() => recipients.onToggle(option.name)}
            className={cn(
              'flex items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 transition-colors select-none hover:bg-muted/60',
              on && 'border-primary bg-primary text-primary-foreground hover:bg-primary',
            )}
          >
            <ParticipantDot color={option.color} />
            {option.name}
          </button>
        )
      })}
    </>
  )

  return (
    <div className="flex h-full min-h-0 flex-1">
      <PartySidebar
        parties={parties}
        activeId={activeId}
        onOpen={onOpenParty}
        hasMore={partiesHasMore ?? false}
        isLoadingMore={partiesLoadingMore ?? false}
        loading={partiesLoading ?? false}
        header={sidebarHeader}
        {...(onLoadMoreParties === undefined ? {} : { onLoadMore: onLoadMoreParties })}
        className={sidebarClasses}
      />

      {title === null ? (
        <div className="hidden flex-1 items-center justify-center p-6 md:flex">
          {/* One paragraph, not two flex items: as direct children of the flex box the sentence and the command were
              laid out side by side, each wrapping in its own column. */}
          <p className="max-w-md text-center text-sm text-pretty text-muted-foreground">
            从左侧选择会诊，或点击“新建会诊”开始单 Agent 连接检查或完整会诊。
          </p>
        </div>
      ) : (
        // `@container` so the header breaks on the width of THIS pane, not the viewport: the sidebar eats 288px of it
        // in the cabinet and none of it on the guest page, and a viewport breakpoint would fire at two different
        // moments for the same layout.
        <div className="@container flex h-full min-w-0 flex-1 flex-col">
          {/* Same horizontal padding + min-height as the party-list header (`px-4 py-3 sm:px-6` + h-9 control).
              Two steps, both measured on THIS pane, not the viewport: under 40rem the actions drop below the
              participants (a phone has no room for both), and from 55rem — about a 1200px window once the sidebar
              takes its 320px — the action buttons grow their labels. In between they are icons, which is what makes
              one row enough. */}
          {/* `relative z-20` lifts the WHOLE header above the message list. Without it the participant tooltip below
              relies on out-ranking the virtualiser's absolutely positioned rows inside one stacking context, and lost:
              the box painted under the messages, so their text ran straight through it. */}
          <div className="relative z-20 flex min-h-[3.75rem] flex-col gap-2 border-b border-border px-4 py-3 @min-[40rem]:flex-row @min-[40rem]:flex-wrap @min-[40rem]:items-center @min-[40rem]:gap-x-3 sm:px-6">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
              {onBack !== undefined && (
                // `self-start` + the title's own line height (h-7 = text-lg's 1.75rem): the arrow sits on the FIRST
                // line of the title. Centred, it drifts down the moment the title wraps or a participant follows it.
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 self-start md:hidden"
                  onClick={onBack}
                  aria-label="返回会诊列表"
                >
                  ←
                </Button>
              )}
              <h1 className="min-w-0 font-title text-lg font-semibold break-words text-accent-foreground">{title}</h1>
              {closed && <Badge variant="secondary">已关闭</Badge>}
              {/* Optical nudge: serif title + mono xs sit on different visual centers despite items-center. */}
              {participants.length === 0 ? (
                // Same rule as the message list: while the party is still loading nobody has been counted yet, so
                // saying the room is empty would be a guess dressed as a fact.
                <span className="translate-y-px font-accent text-xs text-muted-foreground">
                  {messagesLoading ? '加载中…' : '暂无参与者'}
                </span>
              ) : (
                participants.map((participant) => {
                  const addressable = canAddress(participant.name)
                  const selected = recipients.selected.includes(participant.name)
                  const desc = participant.desc !== undefined && participant.desc !== '' ? participant.desc : null
                  const chip = (
                    <>
                      <ParticipantDot color={participant.color} />
                      {/* A name is an identifier, so it never wraps: "party-repo" split over two lines at the hyphen
                          reads as two different participants. */}
                      <span
                        className={cn(
                          'font-semibold whitespace-nowrap text-foreground',
                          participant.leftAt !== undefined && 'text-muted-foreground line-through',
                        )}
                      >
                        {participant.name}
                      </span>
                    </>
                  )
                  const chipClasses =
                    '-mx-1 flex items-center gap-1.5 rounded-full px-1 py-0.5 font-accent text-xs transition-colors'
                  return (
                    // The role a participant plays is a sentence per person: inline it ate the header, so it lives in
                    // a tooltip on HOVER only. Not on focus or tap: a tooltip opened by a click has to be dismissed by
                    // another click somewhere harmless, and two of them can end up open at once.
                    // Optical nudge (translate-y-px): serif title + mono xs sit on different visual centers.
                    // `z-30` is not decoration: `translate-y-px` makes this span a stacking context, so the tooltip's
                    // own z-index only ever competes INSIDE it. Without a z-index here the whole chip sits among the
                    // positioned auto-z elements and loses to whatever comes later in the header — the action buttons
                    // painted straight over the tooltip.
                    <span key={participant.name} className="group relative z-30 translate-y-px">
                      {addressable ? (
                        <button
                          type="button"
                          onClick={() => activateParticipant(participant.name)}
                          aria-pressed={onOpenParticipant ? undefined : selected}
                          aria-label={addressTitle(participant.name)}
                          className={cn(chipClasses, 'cursor-pointer hover:bg-muted/60', selected && 'bg-muted')}
                        >
                          {chip}
                        </button>
                      ) : (
                        <span className={chipClasses}>{chip}</span>
                      )}
                      {(desc !== null || addressable) && (
                        <span className="pointer-events-none absolute top-full left-0 z-50 mt-1 hidden w-max max-w-64 rounded-md border border-border bg-card px-2 py-1 font-accent text-xs text-muted-foreground shadow-lg group-hover:block">
                          {desc}
                          {addressable && (
                            <span className={cn('block text-muted-foreground/70', desc !== null && 'mt-0.5')}>
                              {onOpenParticipant ? '点击查看执行详情' : selected ? '取消收件人' : '选择收件人'}
                            </span>
                          )}
                        </span>
                      )}
                    </span>
                  )
                })
              )}
            </div>
            {/* gap-1 matches the site header theme↔burger icon pair */}
            <div className="flex shrink-0 items-center gap-1">
              <Menu
                options={chatViewModes}
                value={viewMode}
                onSelect={setViewMode}
                icon={ListFilter}
                ariaLabel="筛选消息"
                triggerClassName={cn(viewMode !== 'all' && 'text-primary')}
                // Stacked, the actions start at the LEFT edge of the pane, and a right-aligned panel would hang off
                // the screen; in a row they sit at the right, where it must hang the other way.
                panelClassName="left-0 @min-[40rem]:right-0 @min-[40rem]:left-auto"
                label={
                  // Same pane breakpoint as the action buttons: icon only until the row has room for words.
                  <span className="hidden @min-[55rem]:inline">
                    {chatViewModes.find((mode) => mode.value === viewMode)?.label}
                    {viewMode !== 'all' && hidden > 0 && ` · 已隐藏 ${hidden} 条`}
                  </span>
                }
              />
              {headerActions}
            </div>
          </div>

          {/* Messages: virtualized reverse chat — stickKey jumps to latest on party open; prepends stay anchored. */}
          <InfiniteScroll
            data={visible}
            getItemKey={(message) => message.id}
            direction="up"
            estimateSize={88}
            stickKey={activeId ?? undefined}
            canLoadMore={hasOlder ?? false}
            isLoadingMore={loadingOlder ?? false}
            {...(onLoadOlder === undefined ? {} : { onLoadMore: onLoadOlder })}
            empty={
              messagesLoading ? (
                // Fill the pane so the spinner centers in the conversation, and never say "no messages" mid-fetch.
                <div className="flex h-full items-center justify-center p-6 text-muted-foreground">
                  <Loader2 className="size-5 animate-spin" aria-label="消息加载中" />
                </div>
              ) : (
                <p className="px-4 py-4 text-sm text-muted-foreground sm:px-6">
                  {hidden > 0 ? `此筛选无消息，已隐藏 ${hidden} 条。` : '暂无消息。'}
                </p>
              )
            }
            className="min-h-0 flex-1 px-4 pt-4 sm:px-6"
            renderItem={(message) =>
              message.kind === 'message' ? (
                <div className="flex flex-col gap-0.5 pb-3">
                  <div className="flex items-center gap-2 font-accent text-xs text-muted-foreground">
                    <ParticipantDot color={colorOf(message.from)} />
                    {canAddress(message.from) ? (
                      <button
                        type="button"
                        onClick={() => activateParticipant(message.from)}
                        aria-label={addressTitle(message.from)}
                        aria-pressed={onOpenParticipant ? undefined : recipients.selected.includes(message.from)}
                        title={addressTitle(message.from)}
                        className="cursor-pointer font-semibold text-foreground hover:underline"
                      >
                        {message.from}
                      </button>
                    ) : (
                      <span className="font-semibold text-foreground">{message.from}</span>
                    )}
                    {message.to !== '*' && <span>→ {message.to.join(', ')}</span>}
                    <span>{timeLabel(message.ts)}</span>
                  </div>
                  <div className="max-w-3xl pl-4">
                    {renderMessage ? renderMessage(message) : message.text !== null && looksLikeDiff(message.text) ? (
                      <DiffCard
                        text={message.text}
                        onOpen={() =>
                          setOpenDiff({
                            text: message.text as string,
                            title: `${message.from} · ${diffTitle(message.text as string)}`,
                          })
                        }
                      />
                    ) : (
                      <MessageText text={message.text} />
                    )}
                  </div>
                </div>
              ) : (
                <p className="pb-3 font-accent text-xs text-muted-foreground italic">
                  {message.from} {message.kind === 'join' ? '加入' : '离开'} · {timeLabel(message.ts)}
                </p>
              )
            }
          />

          {/* Input pinned to the bottom — placeholder defaults to "Message…" in PartyComposer. */}
          {!closed && (
            <PartyComposer
              key={activeId}
              onSend={onSend}
              disabled={composerDisabled}
              hasContent={composerHasContent}
              toolbar={<>{recipientsRow}{composerExtension}</>}
              mentions={recipients.options}
            />
          )}
        </div>
      )}

      {openDiff !== null && <DiffModal text={openDiff.text} title={openDiff.title} onClose={() => setOpenDiff(null)} />}
    </div>
  )
}
