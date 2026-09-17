/**
 * `@name` mentions in (decrypted) message text. The charset mirrors participant-name rules, which is why `@` is
 * forbidden inside names. Mentions are a client-side concern by design: servers only ever see ciphertext.
 */

const MENTION_PATTERN = /@([\p{L}\p{N}][\p{L}\p{N}._-]*)/gu

/** Unique mentioned names, in order of first appearance. */
export const extractMentions = (text: string): string[] => {
  const seen = new Set<string>()
  for (const match of text.matchAll(MENTION_PATTERN)) {
    seen.add(match[1])
  }
  return [...seen]
}

/**
 * Whether a message concerns `name`: addressed directly or @-mentioned. Nothing else, not even the host: a caller
 * asking for "only what is addressed to me" gets exactly that, and a party where the owner talks to the room is a party
 * nobody should be watching through this filter in the first place.
 */
export const concernsParticipant = (msg: { to: '*' | string[]; text: string; from: string }, name: string): boolean => {
  if (msg.from === name) return false
  if (msg.to !== '*') return msg.to.includes(name)
  return extractMentions(msg.text).includes(name)
}
