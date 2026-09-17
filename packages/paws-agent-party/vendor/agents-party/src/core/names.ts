import { PartyError } from './errors.js'

/**
 * Participant name rules. Names are addressing targets, so the charset must stay unambiguous: no `*` (the "everyone"
 * selector), no `,` (list separator), no `@` (mentions), no whitespace. `all` is reserved for clarity next to `*`;
 * `admin` is reserved so no agent can pose as an authority. `host` is the OWNER's name — the human this party belongs
 * to: servers only accept it on owner-authenticated requests, so seeing `host` in a party is trustworthy by
 * construction. Agents are guests and pick any other name.
 */

export const HOST_NAME = 'host'

const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,31}$/u

const RESERVED = new Set(['all', 'admin'])

// Scripts with Latin look-alikes. A name mixing them can impersonate another participant to the human eye —
// Latin "h" + Cyrillic "о" + Latin "st" renders exactly like the owner's reserved "host" — so one script per name.
const CONFUSABLE_SCRIPTS = [/\p{Script=Latin}/u, /\p{Script=Cyrillic}/u, /\p{Script=Greek}/u]

/**
 * The charset/length rule alone — no reservations. For places that check a name they are not claiming: a message may be
 * ADDRESSED to `host` (or to someone who never joined), it just can't be SENT under a name that isn't yours.
 */
export const isParticipantNameShaped = (name: string): boolean => NAME_PATTERN.test(name)

export const validateParticipantName = (name: string, opts: { owner?: boolean } = {}): void => {
  if (RESERVED.has(name.toLowerCase())) {
    throw new PartyError('INVALID_NAME', `The name "${name}" is reserved — pick another one.`)
  }
  if (name.toLowerCase() === HOST_NAME && opts.owner !== true) {
    throw new PartyError('INVALID_NAME', `The name "${HOST_NAME}" is reserved for the party host — its human owner.`)
  }
  if (!NAME_PATTERN.test(name)) {
    throw new PartyError(
      'INVALID_NAME',
      `Invalid participant name "${name}" — use 1-32 letters, digits, dots, dashes or underscores (no spaces, *, @ or commas).`,
    )
  }
  if (CONFUSABLE_SCRIPTS.filter((script) => script.test(name)).length > 1) {
    throw new PartyError('INVALID_NAME', `Invalid participant name "${name}" — don't mix alphabets in one name.`)
  }
}
