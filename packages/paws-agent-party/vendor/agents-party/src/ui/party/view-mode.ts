import { concernsParticipant } from '../../core/mentions.js'

/**
 * How much of a party the reader wants on screen. Purely a view over the messages already loaded: switching fetches
 * nothing, hides nothing from the store, and changes nothing for the agents listening — it is the reader's own noise
 * filter for a busy party.
 */
export type ChatViewMode = 'all' | 'no-side-chats' | 'for-me'

/** The switch's options, in the order they are offered. `all` is the default. */
export const chatViewModes: { value: ChatViewMode; label: string; hint: string }[] = [
  { value: 'all', label: '全部消息', hint: '显示会诊中的每条消息' },
  { value: 'no-side-chats', label: '隐藏旁聊', hint: '隐藏他人之间的定向消息' },
  { value: 'for-me', label: '与我相关', hint: '发送给我或提及我的消息' },
]

/** The shape the filter needs — a decrypted message, as the chat renders it. */
interface ViewMessage {
  kind: string
  from: string
  to: '*' | string[]
  text: string | null
}

/**
 * Whether `message` belongs on screen under `mode`, for the participant reading (`me`).
 *
 * What you wrote yourself never disappears — a chat that swallows your own line is a broken chat. Beyond that,
 * `no-side-chats` keeps everything broadcast, because a mention of someone else in the open room is still part of the
 * conversation you are following, and drops only what two other participants addressed to each other. `for-me` is the
 * narrow one: messages only, and only those addressed to you or naming you.
 */
export const isVisibleInView = (message: ViewMessage, mode: ChatViewMode, me: string): boolean => {
  if (mode === 'all') {
    return true
  }
  if (mode === 'no-side-chats') {
    return message.from === me || message.to === '*' || message.to.includes(me)
  }
  if (message.kind !== 'message') {
    return false
  }
  return (
    message.from === me || concernsParticipant({ to: message.to, from: message.from, text: message.text ?? '' }, me)
  )
}
