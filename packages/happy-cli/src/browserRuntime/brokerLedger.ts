/**
 * The broker's assignment ledger: which profile assignment a registration, a logical session and a
 * provider conversation belong to, and so whether a bind or a grant is still admitted.
 * See broker.ts for the rules; the ledger lives in the broker registry file.
 */
import { BrowserRuntimeError, type PrincipalId, type ProfileId } from './contracts'
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

export interface RegistryFile {
    schemaVersion: 1
    registrations: Record<string, Registration>
    orphanedSessions?: Record<string, number>
    /**
     * Logical session id → the assignments it was bound in (canonical key) or RETIRED. Never pruned: a session
     * of an earlier assignment cannot be bound again (sessions are few; ids are not secret).
     */
    sessionAssignments?: Record<string, string>
    /** Provider conversation id (e.g. `claude:<id>`) → the assignments it was continued in; never pruned. */
    conversationAssignments?: Record<string, string>
}

export interface AssignmentLedger {
    /** A logical session of an earlier assignment (or retired): its attention is not delivered. */
    isRetired(agentSessionId: string): boolean
    /**
     * Start-up: records the sessions and conversations of every registration, and marks the registrations
     * of another assignment for revocation (their sessions end). Returns how many were marked.
     */
    retireStale(registrations: Iterable<Registration>): number
    /** The assignment fields a new registration records; throws when its lineage cannot be admitted. */
    register(lineage: SessionLineage | undefined): Partial<Registration>
    /** Records a bind of the registration to the logical session; throws when it is not admitted. */
    bind(registration: Registration, agentSessionId: string): void
    /** The owner, profile and assignment a grant for the registration is issued in; throws when it is not admitted. */
    grant(registration: Registration, profileId: string): { principalId: PrincipalId; profileId: ProfileId; assignmentId?: string }
}

export interface LedgerOptions {
    profiles: ReadonlyMap<ProfileId, PrincipalId>
    assignments?: ReadonlyMap<ProfileId, string>
    sessionHistory?(agentSessionId: string): Iterable<string | undefined>
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
        register: (lineage) => {
            if (lineageOfEarlierAssignment(lineage))
                throw new BrowserRuntimeError('SCOPE_DENIED', 'the conversation cannot be shown to belong to the current assignment of the profile; start a new chat')
            return { principals: Object.fromEntries(options.profiles), ...(currentAssignments ? { assignments: currentAssignments } : {}) }
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
            const principalId = options.profiles.get(profileId as ProfileId)
            if (!principalId) throw new BrowserRuntimeError('SCOPE_DENIED', 'profile is not allowed')
            // Registrations from before owners were recorded have no owner to compare: refused (a new spawn registers again).
            if (registration.principals?.[profileId] !== principalId) throw new BrowserRuntimeError('SCOPE_DENIED', 'the session was started for another owner of this profile')
            const assignmentId = currentAssignments?.[profileId]
            if (currentAssignments && (!assignmentId || registration.assignments?.[profileId] !== assignmentId))
                throw new BrowserRuntimeError('SCOPE_DENIED', 'the session was started in an earlier assignment of this profile')
            return { principalId, profileId: profileId as ProfileId, ...(assignmentId ? { assignmentId } : {}) }
        },
    }
}
