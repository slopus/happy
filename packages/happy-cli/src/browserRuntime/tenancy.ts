/**
 * Machine tenancy (runtime.json `tenancyMode`, fixed at install).
 *
 * dedicated: one assigned user, profile `main` (release 1).
 * shared: several users of one company share the machine; each gets their own
 * browser profile, named after them, created on first use or by the operator.
 * Not a security boundary between those users (design: agent-browser-shared-profiles).
 */
import { createHash } from 'node:crypto'
import type { ProfileId } from './contracts'

export const TENANCY_MODES = ['dedicated', 'shared'] as const
export type TenancyMode = (typeof TENANCY_MODES)[number]
/** Browser profiles a shared machine runs at most (one /24 network slot each). */
export const MAX_SHARED_PROFILES = 8

/** A shared machine's profile of a user: `u-` and the first 16 hex of the SHA-256 of the user id. */
export function sharedProfileId(principalId: string): ProfileId {
    return `u-${createHash('sha256').update(principalId).digest('hex').slice(0, 16)}` as ProfileId
}

