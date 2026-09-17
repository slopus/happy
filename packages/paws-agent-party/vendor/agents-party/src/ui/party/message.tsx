import { cn } from '../utils.js'

/**
 * Maps a stored participant color name (core/colors.ts: `black` for the host, then `blue`, `green`, … in join order)
 * onto this theme's swatch. Each palette color is a light/dark pair (`bg-*-500 dark:bg-*-400`) so it stays vivid on
 * either background; `black` (the host) uses the theme's ink token — `bg-card-foreground` reads near-black on light and
 * near-white on dark, so no ring hack is needed. Unknown names fall back to the muted foreground.
 */
const dotClassByColor: Record<string, string> = {
  black: 'bg-card-foreground',
  blue: 'bg-blue-500 dark:bg-blue-400',
  green: 'bg-green-500 dark:bg-green-400',
  orange: 'bg-orange-500 dark:bg-orange-400',
  violet: 'bg-violet-500 dark:bg-violet-400',
  pink: 'bg-pink-500 dark:bg-pink-400',
  teal: 'bg-teal-500 dark:bg-teal-400',
  red: 'bg-red-500 dark:bg-red-400',
  amber: 'bg-amber-500 dark:bg-amber-400',
}

export const participantDotClass = (color: string | undefined): string =>
  (color && dotClassByColor[color]) || 'bg-muted-foreground'

/** A small round swatch in the participant's server-assigned color. */
export const ParticipantDot = ({ color, className }: { color: string | undefined; className?: string }) => (
  <span className={cn('size-2 shrink-0 rounded-full', participantDotClass(color), className)} />
)

/**
 * Renders one message body. Decryption happens upstream (in the browser): `text` is already the plaintext, or `null`
 * when it could not be decrypted with the available key. Diff bodies are detected by the caller (core `looksLikeDiff`)
 * and rendered as a card + modal instead — this component only handles plain text.
 */
export const MessageText = ({
  text,
}: {
  /** The decrypted plaintext, or `null` when the message can't be decrypted. */
  text: string | null
}) => {
  if (text === null) {
    return <p className="text-sm text-muted-foreground italic">无法用此 Party 密钥解密消息</p>
  }
  return <p className="text-sm whitespace-pre-wrap text-foreground">{text}</p>
}
