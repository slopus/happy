/**
 * The broker's assignment ledger: which profile assignment a registration, a logical session and a
 * provider conversation belong to, and so whether a bind or a grant is still admitted.
 * See broker.ts for the rules; the ledger lives in the broker registry file.
 */
import { BrowserRuntimeError, type PrincipalId, type ProfileId } from './contracts'
import { sharedProfileId, type TenancyMode } from './tenancy'
import type { SessionOwner } from './sessionRegistration'

export interface SessionLineage { parentSessionIds?: string[]; conversationIds?: string[] }

export interface Registration {
    secretSha256: string
    owner?: SessionOwner
    /** Host boot id reported by the daemon at registration (the Runtime's own view may differ in a container). */
    bootId?: string
    agentSessionId?: string
    createdAtMs: number
    /**
     * Each profile's owner when the daemon registered (spawned) the session. A grant is issued only while
     * that is still the owner: after a reassignment the session gets nothing, until that owner is back.
     */
    principals?: Record<string, string>
    /** Each profile's assignment when the session was registered; grants only while it is current. */
    assignments?: Record<string, string>
    /** What the session continues (fork, recovery), as the daemon reported at registration. */
    lineage?: SessionLineage
    /** The session user Studio attested at spawn (a new chat), if any. */
    attestedPrincipalId?: string
    /** Shared machines: the user, profile and assignment the session belongs to, fixed at registration. */
    tuple?: SessionTuple
    grantIds: string[]
    /**
     * Revocation started: no grant is issued any more, and the registration (with
     * its grant ids) stays until every grant is revoked. A crash or a failed
     * revokeGrant leaves it for the daemon's retry or the next start-up.
     */
    revoking?: true
    /** Explicit logical-session termination, replayed after a crash. */
    endSession?: true
}

/**
 * Shared machines: whose session it is. `assignmentId` is null while the user's profile does not exist yet
 * (pending); the first grant after it is created confirms the session in its assignment. `sinceMs` is when a
 * pending session's user was attested: a profile removal after that retires it.
 */
export interface SessionTuple { principalId: string; profileId: string; assignmentId: string | null; sinceMs: number }

export interface RegistryFile {
    /** 1: dedicated (one canonical assignment key). 2: shared (a tuple per session). */
    schemaVersion: 1 | 2
    registrations: Record<string, Registration>
    orphanedSessions?: Record<string, number>
    /**
     * Logical session id → the assignments it was bound in (canonical key) or RETIRED. Never pruned: a session
     * of an earlier assignment cannot be bound again (sessions are few; ids are not secret).
     */
    sessionAssignments?: Record<string, string>
    /** Provider conversation id (e.g. `claude:<id>`) → the assignments it was continued in; never pruned. */
    conversationAssignments?: Record<string, string>
    /** Schema 2: logical session id → its tuple, or RETIRED. Never pruned. */
    sessionTuples?: Record<string, SessionTuple | typeof RETIRED>
    /** Schema 2: provider conversation id → the tuple it was continued in, or RETIRED. Never pruned. */
    conversationTuples?: Record<string, SessionTuple | typeof RETIRED>
    /** Schema 2: users whose profile a session asked for, until it exists (root abp-stack creates it). */
    profileRequests?: Record<string, ProfileRequest>
}

/** A user's profile requested (waiting for abp-stack), or refused until `retryAtMs` (or a newer registration). */
export type ProfileRequest =
    | { state: 'requested'; atMs: number }
    | { state: 'refused'; atMs: number; reason: ProfileRefusal; retryAtMs: number }

/** Why abp-stack did not create a profile: the machine is full, short of memory or busy, the user is blocked, or it failed. */
export const PROFILE_REFUSALS = ['capacity', 'memory', 'blocked', 'failed', 'busy'] as const
export type ProfileRefusal = (typeof PROFILE_REFUSALS)[number]
const REFUSAL_MESSAGES: Record<ProfileRefusal, string> = {
    capacity: 'this machine has no room for another browser profile (at most 8); ask the operator',
    memory: 'this machine does not have enough memory for another browser profile right now; ask the operator or try later',
    blocked: 'this user was removed from the machine\'s browser; ask the operator to add them again',
    failed: "the user's browser profile could not be created; ask the operator (abp-stack logs) or try again in a few minutes",
    busy: 'this machine is too busy to add a browser profile right now; try again in a few minutes',
}

export interface AssignmentLedger {
    /** A logical session of an earlier assignment (or retired): its attention is not delivered. */
    isRetired(agentSessionId: string): boolean
    /**
     * Start-up: records the sessions and conversations of every registration, and marks the registrations
     * of another assignment for revocation (their sessions end). Returns how many were marked.
     */
    retireStale(registrations: Iterable<Registration>): number
    /** The assignment fields a new registration records; throws when its lineage or attested user cannot be admitted. */
    register(lineage: SessionLineage | undefined, attested?: AttestedUser): Partial<Registration>
    /** Records a bind of the registration to the logical session; throws when it is not admitted. */
    bind(registration: Registration, agentSessionId: string): void
    /** The owner, profile and assignment a grant for the registration is issued in; throws when it is not admitted. */
    grant(registration: Registration, profileId: string | undefined): { principalId: PrincipalId; profileId: ProfileId; assignmentId?: string }
}

/** A verified session-user attestation. */
export interface AttestedUser { principalId: PrincipalId; issuedAtMs: number }

export interface LedgerOptions {
    profiles: ReadonlyMap<ProfileId, PrincipalId>
    assignments?: ReadonlyMap<ProfileId, string>
    sessionHistory?(agentSessionId: string): Iterable<string | undefined>
    /** Shared machines: users whose profile was removed, and when (MAX_SAFE_INTEGER: blocked for good). */
    profileTombstones?: ReadonlyMap<PrincipalId, number>
    now?: () => number
}

/**
 * A registry written under the other tenancy mode (the machine was reinstalled): its registrations carry no
 * usable owner, so each is revoked (its session ends) and every session and conversation it knew is retired.
 * Returns how many registrations were marked, or undefined when the registry already fits the mode.
 */
export function adoptRegistry(registry: RegistryFile, mode: TenancyMode): number | undefined {
    const schemaVersion = mode === 'shared' ? 2 : 1
    if (registry.schemaVersion === schemaVersion) return undefined
    const sessions = new Set([...Object.keys(registry.sessionAssignments ?? {}), ...Object.keys(registry.sessionTuples ?? {})])
    const conversations = new Set([...Object.keys(registry.conversationAssignments ?? {}), ...Object.keys(registry.conversationTuples ?? {})])
    let marked = 0
    for (const registration of Object.values(registry.registrations)) {
        for (const conversation of registration.lineage?.conversationIds ?? []) conversations.add(conversation)
        if (registration.agentSessionId) sessions.add(registration.agentSessionId)
        if (registration.revoking) continue
        registration.revoking = true
        if (registration.agentSessionId) registration.endSession = true
        marked++
    }
    const retired = (ids: Set<string>) => Object.fromEntries([...ids].map((id) => [id, RETIRED] as const))
    delete registry.sessionAssignments; delete registry.conversationAssignments; delete registry.sessionTuples; delete registry.conversationTuples
    if (mode === 'shared') Object.assign(registry, { schemaVersion, sessionTuples: retired(sessions), conversationTuples: retired(conversations) })
    else Object.assign(registry, { schemaVersion, sessionAssignments: retired(sessions), conversationAssignments: retired(conversations) })
    return marked
}

/** Ledger value of a session from before assignments were recorded (or whose registration had none). */
const RETIRED = 'retired'
/** Canonical ledger key of a profile → assignment map. */
const assignmentKey = (assignments: Readonly<Record<string, string>>): string =>
    JSON.stringify(Object.entries(assignments).sort(([left], [right]) => left.localeCompare(right)))

/** Dedicated machines: every profile's assignment is compared together, under one canonical key. */
export function dedicatedLedger(registry: RegistryFile, options: LedgerOptions): AssignmentLedger {
    const ledger = registry.sessionAssignments ??= {}
    const conversations = registry.conversationAssignments ??= {}
    const currentAssignments = options.assignments && Object.fromEntries(options.assignments)
    const currentKey = currentAssignments && assignmentKey(currentAssignments)
    const registrationKey = (registration: Registration): string => (registration.assignments ? assignmentKey(registration.assignments) : RETIRED)
    const isRetired = (agentSessionId: string): boolean => currentKey !== undefined && agentSessionId in ledger && ledger[agentSessionId] !== currentKey
    const currentValues = new Set(Object.values(currentAssignments ?? {}))
    /** A logical session of another assignment: the ledger says so, or its retained tasks and spaces were made in one (or before assignments). */
    const sessionOfEarlierAssignment = (agentSessionId: string): boolean => isRetired(agentSessionId)
        || [...options.sessionHistory?.(agentSessionId) ?? []].some((assignment) => !assignment || !currentValues.has(assignment))
    /**
     * Whether a continued conversation (resume, fork, recovery) cannot be shown to belong to the current assignment.
     * Refused: any parent session or conversation known from another assignment (ledger or retained records), and
     * any lineage the ledgers cannot vouch for — an unknown parent (from before the ledger, or a lost state volume)
     * or an unknown conversation — unless a parent bound in the current assignment proves it current (then a
     * conversation first seen here is that parent's and gets recorded). A fresh chat has no lineage and is allowed.
     */
    const lineageOfEarlierAssignment = (lineage: SessionLineage | undefined): boolean => {
        if (currentKey === undefined) return false
        const parents = lineage?.parentSessionIds ?? []
        const conversationIds = lineage?.conversationIds ?? []
        if (parents.some(sessionOfEarlierAssignment)
            || conversationIds.some((conversation) => conversation in conversations && conversations[conversation] !== currentKey)) return true
        const knownCurrentParent = parents.length > 0 && parents.every((parent) => ledger[parent] === currentKey)
        if (knownCurrentParent) return false
        return parents.length > 0 || conversationIds.some((conversation) => conversations[conversation] !== currentKey)
    }
    return {
        isRetired,
        retireStale: (registrations) => {
            if (currentKey === undefined) return 0
            let stale = 0
            for (const registration of registrations) {
                const key = registrationKey(registration)
                if (registration.agentSessionId && !(registration.agentSessionId in ledger)) ledger[registration.agentSessionId] = key
                for (const conversation of registration.lineage?.conversationIds ?? []) conversations[conversation] ??= key
                if (key === currentKey || registration.revoking) continue
                registration.revoking = true
                if (registration.agentSessionId) registration.endSession = true
                stale++
            }
            return stale
        },
        register: (lineage, attested) => {
            if (lineageOfEarlierAssignment(lineage))
                throw new BrowserRuntimeError('SCOPE_DENIED', 'the conversation cannot be shown to belong to the current assignment of the profile; start a new chat')
            return { principals: Object.fromEntries(options.profiles), ...(currentAssignments ? { assignments: currentAssignments } : {}),
                ...(attested ? { attestedPrincipalId: attested.principalId } : {}) }
        },
        bind: (registration, agentSessionId) => {
            if (currentKey === undefined) return
            // A logical session belongs to the assignment it was first bound in (a resumed chat of an earlier
            // assignment is refused, also when that owner is back): the ledger, and its retained records.
            if (sessionOfEarlierAssignment(agentSessionId) || lineageOfEarlierAssignment(registration.lineage))
                throw new BrowserRuntimeError('SCOPE_DENIED', 'the session was started in an earlier assignment of the profile; start a new chat')
            if (registrationKey(registration) !== currentKey) throw new BrowserRuntimeError('SCOPE_DENIED', 'the registration belongs to an earlier assignment of the profile')
            ledger[agentSessionId] = currentKey
            for (const conversation of registration.lineage?.conversationIds ?? []) conversations[conversation] ??= currentKey
        },
        grant: (registration, profileId) => {
            const principalId = profileId === undefined ? undefined : options.profiles.get(profileId as ProfileId)
            if (profileId === undefined || !principalId) throw new BrowserRuntimeError('SCOPE_DENIED', 'profile is not allowed')
            // Registrations from before owners were recorded have no owner to compare: refused (a new spawn registers again).
            if (registration.principals?.[profileId] !== principalId) throw new BrowserRuntimeError('SCOPE_DENIED', 'the session was started for another owner of this profile')
            // Studio says another user started it: Studio treats the machine as shared, this install as dedicated.
            if (registration.attestedPrincipalId !== undefined && registration.attestedPrincipalId !== principalId)
                throw new BrowserRuntimeError('SCOPE_DENIED', "the session was started by a user who does not own this machine's browser profile")
            const assignmentId = currentAssignments?.[profileId]
            if (currentAssignments && (!assignmentId || registration.assignments?.[profileId] !== assignmentId))
                throw new BrowserRuntimeError('SCOPE_DENIED', 'the session was started in an earlier assignment of this profile')
            return { principalId, profileId: profileId as ProfileId, ...(assignmentId ? { assignmentId } : {}) }
        },
    }
}

/**
 * Shared machines: each session belongs to one user's profile and assignment (its tuple), so reassigning or
 * removing one user's profile retires only that user's sessions. A new chat gets its tuple from Studio's
 * attestation; a resume, fork or recovery inherits its parents' tuple from the ledger (whoever sent the
 * message: the browser belongs to whoever started the chat) and may not mix users.
 */
export function sharedLedger(registry: RegistryFile, options: LedgerOptions): AssignmentLedger {
    const ledger = registry.sessionTuples ??= {}
    const conversations = registry.conversationTuples ??= {}
    const requests = registry.profileRequests ??= {}
    const now = options.now ?? Date.now
    // A request is done once its user's profile exists.
    for (const principalId of Object.keys(requests)) if (options.profiles.get(sharedProfileId(principalId)) === principalId) delete requests[principalId]
    const currentValues = new Set(options.assignments?.values() ?? [])
    const retired = (tuple: SessionTuple | typeof RETIRED): boolean => {
        if (tuple === RETIRED) return true
        if (tuple.assignmentId !== null) return options.assignments?.get(tuple.profileId as ProfileId) !== tuple.assignmentId
        const removedAtMs = options.profileTombstones?.get(tuple.principalId as PrincipalId)
        return removedAtMs !== undefined && removedAtMs >= tuple.sinceMs
    }
    const isRetired = (agentSessionId: string): boolean => agentSessionId in ledger && retired(ledger[agentSessionId])
    const sessionOfEarlierAssignment = (agentSessionId: string): boolean => isRetired(agentSessionId)
        || [...options.sessionHistory?.(agentSessionId) ?? []].some((assignment) => !assignment || !currentValues.has(assignment))
    const refuse = (message: string): never => { throw new BrowserRuntimeError('SCOPE_DENIED', message) }
    /** The tuple a continued conversation inherits, undefined for a fresh chat; throws when the ledger cannot vouch for it. */
    const inherited = (lineage: SessionLineage | undefined): SessionTuple | undefined => {
        const parents = lineage?.parentSessionIds ?? []
        const conversationIds = lineage?.conversationIds ?? []
        if (parents.length === 0 && conversationIds.length === 0) return undefined
        if (parents.some(sessionOfEarlierAssignment) || conversationIds.some((id) => id in conversations && retired(conversations[id])))
            refuse('the conversation belongs to an earlier assignment of its browser profile; start a new chat')
        // Without a known parent every conversation must be known; with one, a new conversation is that parent's.
        const vouchers = parents.length > 0 ? parents.map((parent) => ledger[parent]) : conversationIds.map((id) => conversations[id])
        const known = [...vouchers, ...conversationIds.map((id) => conversations[id]).filter(Boolean)]
        if (vouchers.some((tuple) => tuple === undefined)) refuse('the conversation cannot be shown to belong to a user of this machine; start a new chat')
        const tuples = known as SessionTuple[]
        if (new Set(tuples.map((tuple) => tuple.principalId)).size > 1) refuse('the conversation continues sessions of different users')
        return { ...tuples[0] }
    }
    const confirm = (registration: Registration, tuple: SessionTuple): void => {
        if (registration.agentSessionId) ledger[registration.agentSessionId] = { ...tuple }
        for (const id of registration.lineage?.conversationIds ?? []) {
            const known = conversations[id]
            if (known === undefined || (known !== RETIRED && known.assignmentId === null && known.principalId === tuple.principalId)) conversations[id] = { ...tuple }
        }
    }
    return {
        isRetired,
        retireStale: (registrations) => {
            let stale = 0
            for (const registration of registrations) {
                const tuple = registration.tuple
                if (!tuple) continue
                if (registration.agentSessionId && !(registration.agentSessionId in ledger)) ledger[registration.agentSessionId] = { ...tuple }
                for (const id of registration.lineage?.conversationIds ?? []) conversations[id] ??= { ...tuple }
                if (registration.revoking || !retired(tuple)) continue
                registration.revoking = true
                if (registration.agentSessionId) registration.endSession = true
                stale++
            }
            return stale
        },
        register: (lineage, attested) => {
            const parent = inherited(lineage)
            if (parent && attested && attested.principalId !== parent.principalId) refuse('the conversation belongs to another user of this machine')
            let tuple = parent
            if (!tuple && attested) {
                const profileId = sharedProfileId(attested.principalId)
                const exists = options.profiles.get(profileId) === attested.principalId
                tuple = { principalId: attested.principalId, profileId, assignmentId: exists ? options.assignments?.get(profileId) ?? null : null, sinceMs: attested.issuedAtMs }
            }
            if (tuple && retired(tuple)) refuse("the user's browser profile on this machine was removed; ask the operator to add it again")
            return { ...(tuple ? { tuple } : {}), ...(attested ? { attestedPrincipalId: attested.principalId } : {}) }
        },
        bind: (registration, agentSessionId) => {
            if (sessionOfEarlierAssignment(agentSessionId)) refuse('the session was started in an earlier assignment of its browser profile; start a new chat')
            const tuple = registration.tuple
            if (!tuple) return
            if (retired(tuple)) refuse('the registration belongs to an earlier assignment of its browser profile')
            const known = ledger[agentSessionId]
            if (known !== undefined && known !== RETIRED && known.principalId !== tuple.principalId) refuse('the session belongs to another user of this machine')
            if (known === undefined || known === RETIRED || known.assignmentId === null || tuple.assignmentId !== null) ledger[agentSessionId] = { ...tuple }
            for (const id of registration.lineage?.conversationIds ?? []) conversations[id] ??= { ...tuple }
        },
        grant: (registration) => {
            const tuple = registration.tuple
            if (!tuple) return refuse('the session has no attested user; start a new chat from Studio to use the browser on a shared machine')
            if (retired(tuple)) refuse('the session was started in an earlier assignment of its browser profile')
            const profileId = tuple.profileId as ProfileId
            const principalId = options.profiles.get(profileId)
            if (principalId === undefined) {
                // Created on first use: requested for abp-stack (the broker persists it), unless refused lately.
                const request = requests[tuple.principalId]
                if (request?.state === 'refused' && now() < request.retryAtMs && registration.createdAtMs <= request.atMs)
                    throw new BrowserRuntimeError('PROFILE_UNAVAILABLE', REFUSAL_MESSAGES[request.reason])
                if (request?.state !== 'requested') requests[tuple.principalId] = { state: 'requested', atMs: now() }
                throw new BrowserRuntimeError('PROFILE_PROVISIONING', "the user's browser profile is being created; retry shortly", true)
            }
            if (principalId !== tuple.principalId) refuse('the browser profile belongs to another user')
            const assignmentId = options.assignments?.get(profileId)
            if (!assignmentId) return refuse('the browser profile has no assignment')
            if (tuple.assignmentId === null) {
                tuple.assignmentId = assignmentId
                confirm(registration, tuple)
            } else if (tuple.assignmentId !== assignmentId) refuse('the session was started in an earlier assignment of its browser profile')
            return { principalId: principalId as PrincipalId, profileId, assignmentId }
        },
    }
}
