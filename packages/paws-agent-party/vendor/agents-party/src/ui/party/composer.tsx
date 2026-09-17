import { Send } from 'lucide-react'
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../components/button.js'
import { Textarea } from '../components/textarea.js'
import { cn } from '../utils.js'
import { ParticipantDot } from './message.js'

const MAX_HEIGHT_PX = 144 // ~6 lines, then the textarea scrolls inside

/** How many names the `@` picker offers at once — enough for a party, short enough to stay a glance. */
const MENTION_LIMIT = 8

/** The `@word` being typed right before the caret. Mirrors the mention charset in core/mentions.ts. */
const MENTION_TOKEN = /(?:^|\s)@([\p{L}\p{N}._-]*)$/u

/** Where the `@` sits and what has been typed after it, or null when the caret is not inside a mention. */
const mentionAtCaret = (value: string, caret: number): { start: number; query: string } | null => {
  const match = MENTION_TOKEN.exec(value.slice(0, caret))
  if (match === null) {
    return null
  }
  const query = match[1]
  return { start: caret - query.length - 1, query }
}

/**
 * The chat input pinned to the bottom of the conversation: auto-grows while typing, Enter sends, Shift+Enter breaks the
 * line. Purely presentational — it hands the trimmed text to `onSend` and never touches the network itself. An optional
 * `toolbar` (e.g. the recipients row) renders in the section's top padding.
 *
 * The whole section reads as one field: it has a top divider and inner padding but no frame around the textarea, and a
 * click anywhere inside it (except the send button and a toolbar chip) focuses the textarea. Send is an icon button
 * with a generous hit area.
 *
 * Typing `@` opens the mention picker over the field (`mentions` = the addressable participants): ↑/↓ walk it, Enter or
 * Tab inserts, Escape dismisses it for that `@`. Mentions are plain text — they address a message the way a chat does,
 * and change nothing about routing (that is the `to:` row).
 */
export const PartyComposer = ({
  onSend,
  disabled,
  placeholder = '输入消息…',
  hasContent = false,
  toolbar,
  mentions,
}: {
  onSend: (text: string) => Promise<void>
  disabled?: boolean
  hasContent?: boolean
  placeholder?: string
  toolbar?: ReactNode
  /** Names the `@` picker offers, in party order. Omit to turn the picker off. */
  mentions?: { name: string; color: string }[]
}) => {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const canSend = !disabled

  // The open `@` token, the highlighted row in the picker, the caret to restore after an insert, and the `@` position
  // Escape dismissed (so the picker stays shut while that same mention is still being typed).
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null)
  const [active, setActive] = useState(0)
  const caretRef = useRef<number | null>(null)
  const dismissedRef = useRef<number | null>(null)

  const matches = useMemo(() => {
    if (mention === null || mentions === undefined) {
      return []
    }
    const query = mention.query.toLowerCase()
    const starts = mentions.filter((option) => option.name.toLowerCase().startsWith(query))
    const rest = mentions.filter(
      (option) => !option.name.toLowerCase().startsWith(query) && option.name.toLowerCase().includes(query),
    )
    return [...starts, ...rest].slice(0, MENTION_LIMIT)
  }, [mention, mentions])

  // Keyed on the value, not fired from the handlers: measuring right after a `setText` would still read the previous
  // content (React has not committed it yet), which is how a send used to leave the field stuck at its grown height.
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (el === null) {
      return
    }
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`
  }, [text])

  /** Recompute the open mention from wherever the caret is now (typing, clicking, arrowing). */
  const syncMention = () => {
    const el = textareaRef.current
    if (el === null || mentions === undefined) {
      return
    }
    const found = mentionAtCaret(el.value, el.selectionStart)
    if (found === null) {
      dismissedRef.current = null
      setMention(null)
      return
    }
    if (dismissedRef.current === found.start) {
      return
    }
    dismissedRef.current = null
    setMention((prev) => (prev?.start === found.start && prev.query === found.query ? prev : found))
    setActive(0)
  }

  const insertMention = (name: string) => {
    const el = textareaRef.current
    if (el === null || mention === null) {
      return
    }
    const caret = el.selectionStart
    const next = `${text.slice(0, mention.start)}@${name} ${text.slice(caret)}`
    caretRef.current = mention.start + name.length + 2
    setMention(null)
    setText(next)
  }

  // Restoring the caret has to wait for the value React just set, otherwise the browser puts it back at the end.
  useEffect(() => {
    const el = textareaRef.current
    if (el === null || caretRef.current === null) {
      return
    }
    el.focus()
    el.setSelectionRange(caretRef.current, caretRef.current)
    caretRef.current = null
  }, [text])

  const send = async () => {
    const trimmed = text.trim()
    if ((!trimmed && !hasContent) || !canSend || sending) {
      return
    }
    setSending(true)
    setError('')
    try {
      await onSend(trimmed)
      setText('')
      setMention(null)
    } catch (error) {
      setError(error instanceof Error ? error.message : '发送失败，请重试。')
    } finally {
      setSending(false)
      textareaRef.current?.focus()
    }
  }

  const picking = mention !== null && matches.length > 0

  return (
    <div
      className="relative cursor-text border-t border-border bg-background px-4 py-2 sm:px-6"
      onMouseDown={(event) => {
        // Clicking the padding (anywhere but the textarea itself, the send button or a toolbar chip) focuses the field,
        // so the whole section behaves like one input.
        const target = event.target as HTMLElement
        if (target === textareaRef.current || target.closest('button, input, label, select, a') !== null) {
          return
        }
        event.preventDefault()
        textareaRef.current?.focus()
      }}
    >
      {picking && (
        <div
          role="listbox"
          aria-label="participants"
          className="absolute bottom-full left-4 z-30 mb-1 w-56 overflow-hidden rounded-md border border-border bg-card py-1 shadow-lg sm:left-6"
        >
          {matches.map((option, index) => (
            <button
              key={option.name}
              type="button"
              role="option"
              aria-selected={index === active}
              // mousedown, not click: the textarea must not lose focus before the insert lands.
              onMouseDown={(event) => {
                event.preventDefault()
                insertMention(option.name)
              }}
              onMouseEnter={() => setActive(index)}
              className={cn(
                'flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left font-accent text-xs',
                index === active ? 'bg-muted text-foreground' : 'text-muted-foreground',
              )}
            >
              <ParticipantDot color={option.color} />
              <span className="min-w-0 truncate">{option.name}</span>
            </button>
          ))}
        </div>
      )}
      {toolbar !== undefined && (
        // `px-1` matches the textarea's horizontal padding so "to:" lines up with the placeholder.
        <div className="mb-1.5 flex flex-wrap items-center gap-2 px-1 font-accent text-xs text-muted-foreground">
          {toolbar}
        </div>
      )}
      <div className="flex items-end gap-1">
        <Textarea
          ref={textareaRef}
          value={text}
          aria-label="消息"
          rows={1}
          disabled={!canSend}
          placeholder={placeholder}
          className="max-h-36 min-h-9 flex-1 resize-none overflow-y-auto border-0 bg-transparent px-1 py-1.5 shadow-none focus-visible:border-transparent dark:bg-transparent"
          onChange={(event) => {
            setText(event.target.value)
            syncMention()
          }}
          onSelect={syncMention}
          onBlur={() => setMention(null)}
          onKeyDown={(event) => {
            if (picking) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                const step = event.key === 'ArrowDown' ? 1 : -1
                setActive((prev) => (prev + step + matches.length) % matches.length)
                return
              }
              if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault()
                insertMention(matches[active]?.name ?? matches[0]!.name)
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                dismissedRef.current = mention.start
                setMention(null)
                return
              }
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
        />
        <Button
          variant="ghost"
          size="icon-default"
          icon={Send}
          aria-label="发送消息"
          onClick={() => void send()}
          disabled={!canSend || (!text.trim() && !hasContent) || sending}
        />
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
