import tweetnacl from 'tweetnacl'
import { createEnvelope, type SessionEnvelope } from '@slopus/happy-wire'
import { configuration } from '@/configuration'
import { logger } from '@/ui/logger'
import { decodeBase64, encodeBase64, getRandomBytes } from '@/api/encryption'
import {
  DIFFICULTY_ROUTING_POLICY_VERSION,
  pickDifficultyRoutingPrompt,
} from './difficultyRouting'
import {
  KNOWN_ROUTE_TIERS,
  USER_REQUEST_MODELS,
  classifyDifficultyHeuristic,
  isKnownRoutePair,
  isSupportedRoutedModelEffort,
  tierForKnownRoutePair,
  resolveEscalation,
  routeSendModelOptionsWithDifficulty,
  shouldReusePreviousDifficultyForContinuation,
  type ClassifiableDifficulty,
  type Difficulty,
  type RoutableAgent,
  type SendModelOptionsResult,
} from './difficultyRoutingPolicy'
import {
  baseFloorDifficulty,
  canPersistRoutingState,
  effectiveEscalation,
  isFloorUnknown,
  normalizeRoutingSessionState,
  recordPendingDecision,
  type DifficultyRoutingSessionState,
  type RoutingDecisionReason,
  type RoutingDecisionKind,
  type RoutingHardTurnsIntent,
  type RoutingPendingDecision,
  type RoutingProvenance,
  type RoutingRouteSnapshot,
} from './difficultyRoutingSessionState'

/** The pre-v2 record. Still accepted as input, never written back. */
export type DifficultyRoutingState = {
  difficulty?: Difficulty
  hardTurns?: number
  updatedAt?: number
}

export type DifficultyRoutingRuntimeInput = {
  agent: RoutableAgent
  sourceMachineId: string
  sessionId: string
  contentText: string
  meta: Record<string, unknown> | undefined
  current: { model?: string; effort?: string | null }
  /**
   * Whatever the session metadata holds — a v2 record, a pre-v2 record, or
   * something unreadable. Normalised here rather than at every call site, so a
   * caller cannot accidentally hand routing a record it never validated.
   */
  state?: unknown
}

/**
 * Routing declined, and the caller must NOT fall back to whatever cheap
 * candidate it already staged for this turn.
 *
 * The distinction matters because the runners set `messageModel` from the
 * client's `meta` *before* asking routing. Returning a plain `null` there means
 * "no opinion", and the turn then runs on the client's candidate — which, when
 * the reason for declining is an unreadable or unusable floor, is exactly the
 * silent downgrade this feature exists to prevent. `keep-current` tells the
 * caller to run the session's existing setting instead.
 */
export type DifficultyRoutingProtect = {
  protect: 'keep-current'
  reason: 'floor-unknown' | 'stored-base-pair-unsupported'
}

export function isRoutingProtect(
  outcome: DifficultyRoutingRuntimeOutcome,
): outcome is DifficultyRoutingProtect {
  return outcome !== null && 'protect' in outcome
}

export type DifficultyRoutingRuntimeOutcome =
  | DifficultyRoutingRuntimeDecision
  | DifficultyRoutingProtect
  | null

export type DifficultyRoutingRuntimeDecision = {
  /**
   * The manual selection this conversation was on immediately before returning
   * to Auto, when there was one. Deliberately NOT on the session event: the
   * result schema lives in `@slopus/happy-wire` and adding a field there needs
   * that package rebuilt and shipped. The transition itself is already
   * observable on the wire through the `manual-return-to-auto` decision reason;
   * this carries the model/effort for local consumers and logs until the wire
   * field is agreed. See the handover note.
   */
  previousApplied?: { model: string; effort: string | null; difficulty: Difficulty; kind: RoutingDecisionKind }
  route: SendModelOptionsResult
  /**
   * The session state with this turn's decision recorded as **pending**. The
   * floor and the counters are untouched; they move only when the runner reaches
   * its engine-applied boundary and calls `commitAppliedRouting`.
   */
  state: DifficultyRoutingSessionState
  pending: RoutingPendingDecision
  event: SessionEnvelope
}

type GrantOk = {
  ok: true
  grant: {
    policyRevision: number
    expiresAt: number
    sourceMachineId: string
    hostMachineId: string
    hostProcessKeyId: string
    hostProcessPublicKey: string
    maxInputChars: 8000
    modelMaxInputTokens: 512
    relayDeadlineAt: number
    timingVersion: 2
    issuedAt: number
    ttlMs: number
    relayTtlMs: number
  }
  signedGrant: string
  aiModelPolicy: DifficultyRoutingAiModelPolicy
}

type DifficultyRoutingAiModelPolicy = {
  source: 'unrestricted' | 'organization' | 'member'
  allowedSelectionKeys: string[] | null
  defaultSelectionKey: string | null
}

type RelayResponse = {
  version: 1
  requestId: string
  policyRevision: number
  status: 'ok' | 'busy' | 'not-ready' | 'expired' | 'revoked' | 'unsupported' | 'error'
  difficulty?: ClassifiableDifficulty | null
  classifierRevision?: string
}

const RUNTIME_ROUTING_DEADLINE_MS = 3_000

/**
 * Process-relative and never adjusted, unlike `Date.now()`. Every budget, deadline and
 * elapsed measurement in this turn rides on it, so a wall-clock adjustment mid-turn can
 * neither buy nor destroy budget. Logged timestamps and persisted sticky state keep using
 * the wall clock — those are meant to be comparable across processes.
 */
function monotonicNow(): number {
  return performance.now()
}
let circuitBreakerUntil = 0
let consecutiveFailures = 0

/**
 * Every exit of `resolveDifficultyRouting` reports why, because a failure here
 * is invisible by design: the turn silently keeps the client's model. Without
 * this the only field evidence was the byte size of an encrypted relay
 * response, which cannot distinguish "classified but discarded" from
 * "never classified".
 *
 * Never pass the prompt, the intent or the turn authorization — the contract
 * keeps routing text out of logs (`difficultyRoutingRuntime.test.ts` pins it).
 */
function logRoutingOutcome(
  outcome: string,
  detail: Record<string, string | number | boolean | null | undefined> = {},
): void {
  logger.debug(`[difficultyRouting] ${outcome}`, detail)
}

/**
 * A decision builder returns null when the routed model/effort is unusable or
 * the org AI policy disallows it. That discard is the one outcome that looks
 * identical to "routing never ran" from outside, so name it explicitly.
 */
function logDecision(
  classifierSource: string,
  decision: DifficultyRoutingRuntimeOutcome,
  clientRequestId: string,
  remoteStatus?: string,
): DifficultyRoutingRuntimeOutcome {
  if (decision && isRoutingProtect(decision)) return decision
  if (!decision) {
    logRoutingOutcome('decision-discarded', { classifierSource, clientRequestId, remoteStatus })
    return null
  }
  logRoutingOutcome('queued', {
    classifierSource,
    clientRequestId,
    remoteStatus,
    model: decision.route.model,
    effort: decision.route.effort,
    difficulty: decision.route.difficulty,
  })
  return decision
}

export async function resolveDifficultyRouting(
  input: DifficultyRoutingRuntimeInput,
): Promise<DifficultyRoutingRuntimeOutcome> {
  const intent = input.meta?.difficultyRoutingIntent
  if (hasManualModelOverride(input.meta)) {
    logRoutingOutcome('skipped', { reason: 'manual-model-override', sessionId: input.sessionId })
    return null
  }
  const clientRequestId = typeof intent === 'object' && intent !== null
    ? (intent as Record<string, unknown>).clientRequestId
    : undefined
  if (typeof clientRequestId !== 'string' || !clientRequestId) {
    logRoutingOutcome('skipped', { reason: 'missing-client-request-id', sessionId: input.sessionId })
    return null
  }
  const prompt = pickDifficultyRoutingPrompt({
    intent,
    contentText: input.contentText,
    metaPrompt: input.meta?.difficultyRoutingPrompt,
  })
  if (prompt === null) {
    logRoutingOutcome('skipped', { reason: 'prompt-not-routable', sessionId: input.sessionId, clientRequestId })
    return null
  }
  const authorization = typeof input.meta?.difficultyRoutingAuthorization === 'string'
    ? input.meta.difficultyRoutingAuthorization
    : ''
  if (!authorization) {
    logRoutingOutcome('skipped', { reason: 'missing-authorization', sessionId: input.sessionId, clientRequestId })
    return null
  }
  // Taken once, before the grant request, and never extended.
  const m0 = monotonicNow()
  const deadline = m0 + RUNTIME_ROUTING_DEADLINE_MS
  let grant: GrantRequestResult
  try {
    grant = await requestGrant(input, clientRequestId, deadline)
  } catch (error) {
    noteRemoteFailure()
    logRoutingOutcome('grant-request-failed', {
      clientRequestId,
      errorName: error instanceof Error ? error.name : typeof error,
    })
    return null
  }
  if (!grant.ok) {
    if ((grant.reason === 'host-unavailable' || grant.reason === 'unsupported') && grant.aiModelPolicy) {
      const p1 = classifyDifficultyHeuristic(prompt)
      noteRemoteFailure()
      // `failed` travels with this outcome too: a timing-contract rejection now degrades here
      // instead of being skipped, and naming which conditions failed is the only local signal
      // that tells a version mismatch apart from a server that is answering wrongly.
      logRoutingOutcome('grant-rejected-falling-back', {
        clientRequestId,
        reason: grant.reason,
        failureStage: grant.failureStage,
        failed: grant.failed?.join(','),
      })
      return logDecision('fallback-p1', buildLocalDecision(input, prompt, clientRequestId, p1.difficulty, null, undefined, 'fallback-p1', grant.aiModelPolicy), clientRequestId, grant.reason)
    }
    logRoutingOutcome('skipped', {
      reason: grant.reason ?? 'grant-rejected',
      failureStage: grant.failureStage,
      httpStatus: grant.httpStatus,
      failed: grant.failed?.join(','),
      expiresInMs: grant.expiresInMs,
      relayDeadlineInMs: grant.relayDeadlineInMs,
      clientRequestId,
    })
    return null
  }

  // The server issued this grant BEFORE we saw it, so the round trip is charged against its
  // life rather than restarting it. `routeDeadline` can only ever shrink the turn deadline.
  const m1 = monotonicNow()
  const elapsedMs = m1 - m0
  const grantLeftMs = Math.max(0, grant.value.grant.ttlMs - elapsedMs)
  const relayLeftMs = Math.max(0, grant.value.grant.relayTtlMs - elapsedMs)
  const routeDeadline = Math.min(deadline, m1 + grantLeftMs, m1 + relayLeftMs)
  if (grantLeftMs <= 0 || relayLeftMs <= 0 || monotonicNow() >= routeDeadline) {
    logRoutingOutcome('skipped', { reason: 'budget-spent', clientRequestId, elapsedMs: Math.round(elapsedMs) })
    return null
  }

  const p1 = classifyDifficultyHeuristic(prompt)
  if (p1.confident || shouldReusePreviousDifficultyForContinuation(prompt, freshPreviousDifficulty(input.state, input.agent)) || circuitBreakerUntil > monotonicNow()) {
    return logDecision('p1-local', buildLocalDecision(input, prompt, clientRequestId, p1.difficulty, grant.value.grant.policyRevision, undefined, 'p1-local', grant.value.aiModelPolicy), clientRequestId)
  }

  try {
    const sealedText = sealText(prompt, grant.value.grant.hostProcessPublicKey)
    // Sealing and serialization cost time too, so the budget is read here and not earlier.
    // Under fake timers nothing elapses between the check above and this one, so no test
    // distinguishes deleting this guard — it exists for the real elapsed time of sealing.
    // It must never become `Math.max(1, …)`: reviving a spent budget sends a dead request.
    const remainingMs = Math.floor(routeDeadline - monotonicNow())
    if (remainingMs <= 0) {
      logRoutingOutcome('skipped', { reason: 'budget-spent-before-relay', clientRequestId })
      return null
    }
    const relay = await requestRelay({
      requestId: clientRequestId,
      signedGrant: grant.value.signedGrant,
      policyRevision: grant.value.grant.policyRevision,
      sourceMachineId: grant.value.grant.sourceMachineId,
      hostMachineId: grant.value.grant.hostMachineId,
      hostProcessKeyId: grant.value.grant.hostProcessKeyId,
      remainingMs: Math.min(remainingMs, grant.value.grant.relayTtlMs),
      sealedText,
    }, routeDeadline)
    // The answer arrived, but an answer past the deadline is not an answer. A fetch mock or a
    // transport that ignores abort can still resolve late; this is what stops it being applied.
    // Discarding the stale answer is not a reason to discard the turn's routing too: the
    // local decision costs no network and no budget, and the wall time is already spent
    // whichever way this goes. Returning null here made a slow server strictly worse than a
    // failed one, because the branch directly below already degrades to exactly this.
    if (monotonicNow() >= routeDeadline) {
      noteRemoteFailure()
      logRoutingOutcome('relay-result-late', { clientRequestId })
      return logDecision(
        'fallback-p1',
        buildLocalDecision(input, prompt, clientRequestId, p1.difficulty, grant.value.grant.policyRevision, undefined, 'fallback-p1', grant.value.aiModelPolicy),
        clientRequestId,
        'relay-result-late',
      )
    }
    if (relay.status !== 'ok' || !relay.difficulty) {
      noteRemoteFailure()
      return logDecision('fallback-p1', buildLocalDecision(input, prompt, clientRequestId, p1.difficulty, grant.value.grant.policyRevision, relay.status, 'fallback-p1', grant.value.aiModelPolicy), clientRequestId, relay.status)
    }
    consecutiveFailures = 0

    return logDecision('p2-org-shared', buildRemoteDecision(input, prompt, clientRequestId, relay.difficulty, grant.value.grant.policyRevision, relay, grant.value.aiModelPolicy), clientRequestId, relay.status)
  } catch (error) {
    const p1 = classifyDifficultyHeuristic(prompt)
    noteRemoteFailure()
    logRoutingOutcome('relay-request-failed', {
      clientRequestId,
      errorName: error instanceof Error ? error.name : typeof error,
    })
    return logDecision('fallback-p1', buildLocalDecision(input, prompt, clientRequestId, p1.difficulty, null, undefined, 'fallback-p1', grant.value.aiModelPolicy), clientRequestId)
  }
}

function buildRemoteDecision(
  input: DifficultyRoutingRuntimeInput,
  prompt: string,
  clientRequestId: string,
  difficulty: ClassifiableDifficulty,
  policyRevision: number,
  relay: RelayResponse,
  aiModelPolicy: DifficultyRoutingAiModelPolicy,
): DifficultyRoutingRuntimeOutcome {
  return buildDecision({
    input,
    prompt,
    clientRequestId,
    difficulty,
    policyRevision,
    classifierSource: 'p2-org-shared',
    source: 'p2',
    remoteStatus: relay.status,
    classifierRevision: relay.classifierRevision,
    aiModelPolicy,
  })
}

function buildLocalDecision(
  input: DifficultyRoutingRuntimeInput,
  prompt: string,
  clientRequestId: string,
  difficulty: ClassifiableDifficulty,
  policyRevision: number | null = null,
  remoteStatus?: RelayResponse['status'],
  classifierSource: 'p1-local' | 'fallback-p1' = 'fallback-p1',
  aiModelPolicy?: DifficultyRoutingAiModelPolicy,
): DifficultyRoutingRuntimeOutcome {
  return buildDecision({
    input,
    prompt,
    clientRequestId,
    difficulty,
    policyRevision,
    classifierSource,
    source: 'p1',
    remoteStatus,
    aiModelPolicy,
  })
}

/**
 * The one place a turn's routing is decided, so the floor, the temporary
 * escalation and the policy substitution cannot drift apart between the local
 * and the shared path.
 *
 * Four things are kept separate on purpose, because collapsing any pair of them
 * is what made the old state lie:
 *
 * - **candidate** — what the classifier said about this input alone.
 * - **selected** — what this turn will run on, escalation included.
 * - **base** — the floor this turn would commit if the engine applies it. Never
 *   the escalated tier, and never a tier the policy refused to run.
 * - **pending** — all of the above, held until the engine-applied boundary.
 */
function buildDecision(args: {
  input: DifficultyRoutingRuntimeInput
  prompt: string
  clientRequestId: string
  difficulty: ClassifiableDifficulty
  policyRevision: number | null
  classifierSource: 'p1-local' | 'p2-org-shared' | 'fallback-p1'
  source: 'p1' | 'p2'
  remoteStatus?: RelayResponse['status']
  classifierRevision?: string
  aiModelPolicy?: DifficultyRoutingAiModelPolicy
}): DifficultyRoutingRuntimeOutcome {
  const { input, prompt, clientRequestId } = args
  const now = Date.now()
  const state = normalizeRoutingSessionState(input.state, input.agent)

  // An unreadable record is not an empty one. Re-classifying here would let a
  // version skew silently restart an expensive conversation at the cheapest
  // tier, so the turn keeps whatever the engine is already configured with and
  // routing reports nothing. Persisting would also destroy the newer writer's
  // fields, which `canPersistRoutingState` refuses independently.
  if (isFloorUnknown(state) || !canPersistRoutingState(state)) {
    logRoutingOutcome('skipped', {
      reason: 'floor-unknown',
      clientRequestId,
      foreignStateVersion: state.foreignStateVersion,
    })
    return { protect: 'keep-current', reason: 'floor-unknown' }
  }

  const previousDifficulty = baseFloorDifficulty(state)
  const { hardTurns: priorHardTurns, ageMs } = effectiveEscalation(state, now)

  let baseRoute = routeSendModelOptionsWithDifficulty(
    input.agent,
    prompt,
    {},
    args.difficulty,
    previousDifficulty,
    args.source,
  )
  if (state.base && baseRoute.difficulty === state.base.difficulty) {
    // Recognised across generations, so a floor established by a newer client
    // is retained exactly rather than being treated as unusable.
    if (!isKnownRoutePair(input.agent, state.base)) {
      logRoutingOutcome('decision-discarded', { reason: 'stored-base-pair-unsupported', clientRequestId })
      return { protect: 'keep-current', reason: 'stored-base-pair-unsupported' }
    }
    baseRoute = { ...baseRoute, model: state.base.model, effort: state.base.effort }
  }
  const escalated = resolveEscalation(input.agent, prompt, baseRoute, {
    hardTurns: priorHardTurns,
    ageMs,
  })
  if (!escalated.routed.model || !escalated.routed.effort) return null
  // Known in either generation: after retention this route may legitimately
  // carry a pair from the catalog a newer client routes to.
  if (!isKnownRoutePair(input.agent, escalated.routed)) return null

  const allowed = resolveRouteAllowedByAiPolicy(input.agent, escalated.routed, input.current, args.aiModelPolicy)
  if (!allowed?.route.model || !allowed.route.effort) return null
  const routed = allowed.route
  const selectedModel = allowed.route.model

  // The floor this turn would commit. The temporary escalation is dropped here —
  // it is a one-turn override, not a new floor — and a policy substitution is
  // taken at face value, because a floor the org forbids can never be run.
  const baseTier: Difficulty = allowed.substituted
    ? (catalogRouteForModel(input.agent, routed.model)?.tier ?? escalated.stickyDifficulty ?? args.difficulty)
    : (escalated.stickyDifficulty ?? args.difficulty)
  const base: RoutingRouteSnapshot = {
    difficulty: baseTier,
    model: allowed.substituted ? selectedModel : baseRoute.model!,
    effort: allowed.substituted ? routed.effort ?? null : baseRoute.effort ?? null,
  }

  const temporaryEscalation = !allowed.substituted && escalated.routed.difficulty === 'escalated'
  const decisionReasons = resolveDecisionReasons({
    state,
    previousDifficulty,
    candidate: args.difficulty,
    selected: routed.difficulty ?? args.difficulty,
    temporaryEscalation,
    substituted: allowed.substituted,
    classifierSource: args.classifierSource,
    continuationReuse: shouldReusePreviousDifficultyForContinuation(prompt, previousDifficulty),
  })

  const pending: RoutingPendingDecision = {
    clientRequestId,
    candidateDifficulty: args.difficulty,
    selectedDifficulty: routed.difficulty ?? args.difficulty,
    selected: { model: selectedModel, effort: routed.effort ?? null },
    base,
    temporaryEscalation,
    hardTurns: escalated.hardTurns,
    // The absolute above describes the counter as it looked when this request
    // was accepted. Concurrency makes that wrong by the time it applies, so the
    // intent is what the commit resolves against the counter that exists then.
    hardTurnsIntent: resolveHardTurnsIntent(escalated.hardTurns, priorHardTurns),
    decisionReasons,
    classifierSource: args.classifierSource,
    policyRevision: args.policyRevision,
    policyVersion: DIFFICULTY_ROUTING_POLICY_VERSION,
    createdAt: now,
    // Kept so the engine boundary can re-validate a raise against the policy
    // that was actually in force for this request, without a fresh grant.
    ...(args.aiModelPolicy
      ? {
        policySnapshot: {
          allowedSelectionKeys: args.aiModelPolicy.allowedSelectionKeys,
          defaultSelectionKey: args.aiModelPolicy.defaultSelectionKey,
        },
      }
      : {}),
  }

  const nextState = recordPendingDecision(state, pending)
  return {
    route: routed,
    state: nextState,
    pending,
    ...(state.lastAppliedRoute
      ? {
        previousApplied: {
          model: state.lastAppliedRoute.model,
          effort: state.lastAppliedRoute.effort,
          difficulty: state.lastAppliedRoute.difficulty,
          kind: state.lastAppliedRoute.kind,
        },
      }
      : {}),
    event: createDifficultyRoutingEvent({
      clientRequestId,
      policyRevision: args.policyRevision,
      route: routed,
      classifierSource: args.classifierSource,
      remoteStatus: args.remoteStatus,
      classifierRevision: args.classifierRevision,
      pending,
      revision: nextState.revision,
      evidence: state.base?.provenance ?? 'unknown',
      ...(state.lastAppliedRoute
        ? {
          previousApplied: {
            model: state.lastAppliedRoute.model,
            effort: state.lastAppliedRoute.effort,
            difficulty: state.lastAppliedRoute.difficulty,
            kind: state.lastAppliedRoute.kind,
          },
        }
        : {}),
    }),
  }
}

/**
 * A turn the *client's* auto-router decided and this CLI merely applied.
 *
 * Recorded so that switching from local to shared routing does not start from
 * an empty floor (R2/AC3) — without it the first shared turn of a hard
 * conversation restarts at the cheapest tier.
 *
 * The evidence is `engine-applied`, the same as any other executed turn: this
 * process applies these settings and observes it. Which classifier picked the
 * tier is recorded in `kind`, and it does not weaken an observed execution —
 * marking it weaker made consumers ignore a floor the CLI really established.
 *
 * Returns null rather than guessing whenever the model is outside the routing
 * catalog or the pair is one the catalog does not offer — inventing a tier
 * there would fabricate a floor out of an unknown model.
 */
export function buildLocalAutoBootstrapDecision(args: {
  agent: RoutableAgent
  clientRequestId: string
  model: string | undefined
  effort: string | null | undefined
  now: number
}): RoutingPendingDecision | null {
  // Recognised in either generation. The pair is then kept EXACTLY as the
  // client sent it (R3) — recognising `gpt-6-luna/low` as `trivial` must never
  // rewrite it to this build's own `gpt-5.6-luna/low`.
  const tier = tierForKnownRoutePair(args.agent, args.model, args.effort ?? null)
  if (!tier || !args.model) return null
  // An escalated tier is a one-turn override, never a floor.
  if (tier === 'escalated') return null
  return {
    clientRequestId: args.clientRequestId,
    kind: 'local-auto-bootstrap',
    baseProvenance: 'engine-applied',
    candidateDifficulty: tier,
    selectedDifficulty: tier,
    selected: { model: args.model, effort: args.effort ?? null },
    base: { difficulty: tier, model: args.model, effort: args.effort ?? null },
    temporaryEscalation: false,
    hardTurns: 0,
    decisionReasons: ['legacy-bootstrap'],
    classifierSource: 'manual-legacy',
    policyRevision: null,
    policyVersion: DIFFICULTY_ROUTING_POLICY_VERSION,
    createdAt: args.now,
  }
}

/**
 * Aligns a decision with the settings the engine is actually being given.
 *
 * The runners rewrite a routed model before it reaches the SDK — Z.AI
 * substitutions, a cleared model becoming the backend default, an effort the
 * SDK will not accept. Recording the pre-rewrite pair would make the floor a
 * statement about a model that never ran, and the next turn would then "retain"
 * something the provider never saw.
 *
 * Returns null when the applied pair has no tier in any known generation: there
 * is no honest floor to record for it, and guessing one would be a fabrication.
 * The turn still runs; only the floor declines to move.
 */
export function reconcileDecisionWithAppliedSettings(
  decision: RoutingPendingDecision,
  applied: { model: string | undefined; effort: string | null | undefined },
  agent: RoutableAgent,
): RoutingPendingDecision | null {
  const model = applied.model
  const effort = applied.effort ?? null
  if (model === decision.selected.model && effort === decision.selected.effort) return decision
  const tier = tierForKnownRoutePair(agent, model, effort)
  if (!tier || !model) return null
  return {
    ...decision,
    selected: { model, effort },
    selectedDifficulty: decision.temporaryEscalation ? decision.selectedDifficulty : tier,
    base: decision.temporaryEscalation
      ? decision.base
      : { difficulty: tier, model, effort },
  }
}

/**
 * A manually pinned turn. Recorded only so the next Auto turn can name the
 * return and show what the conversation was actually on (R5/AC5); it never
 * feeds the floor or the escalation counters.
 */
export function buildManualAppliedDecision(args: {
  clientRequestId: string
  model: string
  effort: string | null
  now: number
}): RoutingPendingDecision {
  return {
    clientRequestId: args.clientRequestId,
    kind: 'manual',
    candidateDifficulty: 'routine',
    selectedDifficulty: 'routine',
    selected: { model: args.model, effort: args.effort },
    base: { difficulty: 'routine', model: args.model, effort: args.effort },
    temporaryEscalation: false,
    hardTurns: 0,
    decisionReasons: [],
    classifierSource: 'manual-legacy',
    policyRevision: null,
    policyVersion: DIFFICULTY_ROUTING_POLICY_VERSION,
    createdAt: args.now,
  }
}

/**
 * Non-content reasons for the transition. These are what the UI shows instead of
 * an invented saving percentage, so each one has to be distinguishable: "kept
 * because the conversation is hard" and "kept because the org forbids the
 * cheaper model" look identical on screen otherwise.
 */
function resolveDecisionReasons(args: {
  state: DifficultyRoutingSessionState
  previousDifficulty: Difficulty | undefined
  candidate: Difficulty
  selected: Difficulty
  temporaryEscalation: boolean
  substituted: boolean
  classifierSource: string
  continuationReuse: boolean
}): RoutingDecisionReason[] {
  const reasons: RoutingDecisionReason[] = []
  // A new context really did start here; the previous floor no longer applies.
  if (args.state.epochStartedAt !== undefined && args.state.base === undefined) {
    reasons.push('context-reset')
  }
  // R5/AC5: the transition away from a manual pin must be observable.
  if (args.state.lastManual) reasons.push('manual-return-to-auto')
  if (args.continuationReuse) reasons.push('continuation-reuse')
  if (args.temporaryEscalation) reasons.push('temporary-escalation')
  else if (args.state.lastEscalatedExecutionId) reasons.push('temporary-escalation-return')
  if (args.substituted) reasons.push('policy-fallback')
  if (args.previousDifficulty !== undefined && tierRank(args.selected) > tierRank(args.candidate)) {
    reasons.push('sticky-floor-maintained')
  }
  if (args.previousDifficulty === undefined || tierRank(args.candidate) > tierRank(args.previousDifficulty)) {
    reasons.push('classified-up')
  }
  if (args.state.base?.provenance === 'legacy-selection') reasons.push('legacy-bootstrap')
  if (args.classifierSource === 'fallback-p1') reasons.push('classifier-fallback')
  return reasons
}

/**
 * Turns the classifier's freshly computed counter into the change it represents.
 * Zero is a reset rather than a decrement: it is how a resolution signal and a
 * non-hard turn both arrive, and both genuinely end the streak.
 */
function resolveHardTurnsIntent(next: number, prior: number): RoutingHardTurnsIntent {
  if (next === 0) return 'reset'
  if (next > prior) return 'increment'
  if (next < prior) return 'decrement'
  return 'none'
}

const TIER_ORDER: readonly Difficulty[] = ['trivial', 'routine', 'hard', 'escalated']
function tierRank(difficulty: Difficulty): number {
  return TIER_ORDER.indexOf(difficulty)
}

/**
 * Which tier, and which exact pair, a model means when only the model is known.
 * A substituted model whose tier is unknown has no comparable floor — efforts
 * are per-model labels, not a numeric scale, so guessing one would be inventing
 * a comparison the catalog denies.
 *
 * routine and hard share one model (effort low/high), so a model-only lookup is
 * ambiguous; it resolves to the highest tier, as Desktop's `difficultyForModel`
 * does — keeping a floor too high for a turn is cheaper than losing it. A model
 * the current catalog no longer routes to (claude-sonnet-5, an org's only
 * allowed model) keeps the pair it ran as in its own generation.
 */
function catalogRouteForModel(
  agent: RoutableAgent,
  model: string | undefined,
): { tier: Difficulty; pair: { model: string; effort: string } } | null {
  if (!model) return null
  let match: { tier: Difficulty; pair: { model: string; effort: string } } | null = null
  for (const tier of TIER_ORDER) {
    const route = USER_REQUEST_MODELS[agent][tier]
    if (route.model === model) match = { tier, pair: route }
  }
  if (match) return match
  for (const entry of KNOWN_ROUTE_TIERS) {
    if (entry.agent !== agent || entry.model !== model) continue
    if (!match || tierRank(entry.tier) > tierRank(match.tier)) {
      match = { tier: entry.tier, pair: { model: entry.model, effort: entry.effort } }
    }
  }
  return match
}

/**
 * A rejected grant used to collapse to `{ ok: false }` with no reason on four
 * different paths, so the field log could not tell a broken response from a
 * failed check. Name the stage; keep whatever reason the server did send.
 */
type GrantRequestResult =
  | { ok: true; value: GrantOk }
  | {
    ok: false
    failureStage: 'parse' | 'http' | 'response' | 'validation'
    reason?: string
    httpStatus?: number
    failed?: GrantFailureCode[]
    expiresInMs?: number
    relayDeadlineInMs?: number
    aiModelPolicy?: DifficultyRoutingAiModelPolicy
  }

async function requestGrant(
  input: DifficultyRoutingRuntimeInput,
  clientRequestId: string,
  deadline: number,
): Promise<GrantRequestResult> {
  const response = await fetch(`${resolveAplusApiOrigin()}/api/me/difficulty-routing/grant`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Happy-Client': `cli-coding-session/${configuration.currentCliVersion}`,
      'X-Aplus-Machine-Id': input.sourceMachineId,
    },
    body: JSON.stringify({
      version: 1,
      clientRequestId,
      authorization: input.meta?.difficultyRoutingAuthorization,
      sourceMachineId: input.sourceMachineId,
      sessionId: input.sessionId,
      policyVersion: DIFFICULTY_ROUTING_POLICY_VERSION,
      intent: input.meta?.difficultyRoutingIntent,
      maxRelayTtlMs: RUNTIME_ROUTING_DEADLINE_MS,
      timingVersion: 2,
    }),
    // Floored: the monotonic clock is fractional and AbortSignal.timeout rejects non-integers.
    signal: AbortSignal.timeout(Math.max(1, Math.floor(deadline - monotonicNow()))),
  })
  const body = await response.json().catch(() => null) as unknown
  if (!body || typeof body !== 'object') return { ok: false, failureStage: 'parse' }
  const record = body as Record<string, unknown>
  const reason = typeof record.reason === 'string' ? record.reason : undefined
  if (!response.ok) {
    return {
      ok: false,
      failureStage: 'http',
      httpStatus: response.status,
      reason,
      aiModelPolicy: parseAiModelPolicy(record.aiModelPolicy),
    }
  }
  if (record.ok !== true) {
    return { ok: false, failureStage: 'response', reason, aiModelPolicy: parseAiModelPolicy(record.aiModelPolicy) }
  }
  const validation = validateGrant(record, { clientRequestId, sourceMachineId: input.sourceMachineId })
  if (!validation.ok) {
    return {
      ok: false,
      failureStage: 'validation',
      failed: validation.failed,
      expiresInMs: validation.expiresInMs,
      relayDeadlineInMs: validation.relayDeadlineInMs,
      // A rejection confined to the timing contract says this server has not shipped v2 — it
      // does not say the response was garbage. The CLI is published to npm and upgraded
      // independently of the aplus API, so a client can legitimately run ahead of the
      // deployment; dropping the policy snapshot there turned routing off for every such user
      // with nothing but a debug line. Carry it, and let the caller degrade to the local
      // decision the way it already does for an unsupported host.
      reason: isTimingContractMismatch(validation.failed) ? 'unsupported' : undefined,
      aiModelPolicy: parseAiModelPolicy(record.aiModelPolicy),
    }
  }
  return { ok: true, value: validation.value }
}

async function requestRelay(input: {
  requestId: string
  signedGrant: string
  policyRevision: number
  sourceMachineId: string
  hostMachineId: string
  hostProcessKeyId: string
  remainingMs: number
  sealedText: ReturnType<typeof sealText>
}, deadline: number): Promise<RelayResponse> {
  const response = await fetch(`${resolveAplusApiOrigin()}/api/me/difficulty-routing/classify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Happy-Client': `cli-coding-session/${configuration.currentCliVersion}`,
      'X-Aplus-Machine-Id': input.sourceMachineId,
    },
    body: JSON.stringify({
      version: 1,
      requestId: input.requestId,
      signedGrant: input.signedGrant,
      policyRevision: input.policyRevision,
      sourceMachineId: input.sourceMachineId,
      hostMachineId: input.hostMachineId,
      hostProcessKeyId: input.hostProcessKeyId,
      timingVersion: 2,
      remainingMs: input.remainingMs,
      sealedText: input.sealedText,
    }),
    // Floored: the monotonic clock is fractional and AbortSignal.timeout rejects non-integers.
    signal: AbortSignal.timeout(Math.max(1, Math.floor(deadline - monotonicNow()))),
  })
  if (!response.ok) return {
    version: 1,
    requestId: input.requestId,
    policyRevision: input.policyRevision,
    status: 'error',
  }
  const body = await response.json().catch(() => null) as { ok?: unknown; result?: unknown } | null
  const result = body?.ok === true && isRelayResponse(body.result, input.requestId, input.policyRevision)
    ? body.result
    : null
  return result ?? {
    version: 1,
    requestId: input.requestId,
    policyRevision: input.policyRevision,
    status: 'error',
  }
}

/**
 * Every condition is evaluated, not short-circuited: a single reported cause
 * sends the next investigation at the wrong field when several are wrong at
 * once. Returns the narrowed grant on success so callers keep type safety
 * without a cast.
 *
 * `now` is captured once by the caller and shared with the log, because
 * reading the clock twice makes the reported remainder disagree with the
 * decision that used it.
 */
type GrantFailureCode =
  | 'ok' | 'signedGrant' | 'grant' | 'version' | 'grantId' | 'policyRevision'
  | 'expiresAt' | 'sourceMachineId' | 'hostMachineId' | 'hostProcessKeyId' | 'hostProcessPublicKey'
  | 'maxInputChars' | 'modelMaxInputTokens' | 'relayDeadlineAt'
  | 'aiModelPolicy' | 'clientRequestId'
  // Timing v2: every one of these compares server values with each other. None of them
  // reads this machine's clock — that comparison is the defect this contract retires.
  | 'timingVersion' | 'requestId' | 'issuedAt' | 'ttlMs' | 'relayTtlMs'
  | 'ttlMs-mismatch' | 'relayTtlMs-mismatch'

type GrantValidation =
  | { ok: true; value: GrantOk }
  | { ok: false; failed: GrantFailureCode[]; expiresInMs?: number; relayDeadlineInMs?: number }

/**
 * The timing v2 fields plus the two checks derived from them. A server that predates the
 * contract fails all of these and nothing else, because the derived comparisons cannot hold
 * when the durations they read are absent.
 */
const TIMING_CONTRACT_FAILURES = new Set<GrantFailureCode>([
  'timingVersion', 'requestId', 'issuedAt', 'ttlMs', 'relayTtlMs',
  'ttlMs-mismatch', 'relayTtlMs-mismatch',
])

/** True only when every reported cause is about the timing contract — one wrong field
 * elsewhere means a broken grant, which carries no authority and gets no degradation. */
function isTimingContractMismatch(failed: GrantFailureCode[]): boolean {
  return failed.length > 0 && failed.every((code) => TIMING_CONTRACT_FAILURES.has(code))
}

/**
 * Validates a negotiated timing v2 grant. Deliberately takes no clock: the previous version
 * checked `expiresAt <= now + 60_000` against this machine's wall clock and rejected correctly
 * issued grants whenever the server sat a couple of milliseconds ahead.
 */
function validateGrant(
  value: Record<string, unknown>,
  expected: { clientRequestId: string; sourceMachineId: string },
): GrantValidation {
  const failed: GrantFailureCode[] = []
  const add = (code: GrantFailureCode, pass: boolean) => { if (!pass) failed.push(code) }

  add('ok', value.ok === true)
  add('signedGrant', typeof value.signedGrant === 'string'
    && value.signedGrant.length > 0 && value.signedGrant.length <= 8192)
  add('aiModelPolicy', isAiModelPolicy(value.aiModelPolicy))
  add('clientRequestId', typeof expected.clientRequestId === 'string' && expected.clientRequestId.length > 0)

  const grant = value.grant
  const record = typeof grant === 'object' && grant !== null && !Array.isArray(grant)
    ? grant as Record<string, unknown>
    : null
  if (record === null) {
    failed.push('grant')
    return { ok: false, failed }
  }

  add('version', record.version === 1)
  add('grantId', typeof record.grantId === 'string' && record.grantId.length > 0 && record.grantId.length <= 200)
  add('policyRevision', typeof record.policyRevision === 'number'
    && Number.isSafeInteger(record.policyRevision) && record.policyRevision >= 0)

  const expiresAt = typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt)
    ? record.expiresAt
    : null
  if (expiresAt === null) failed.push('expiresAt')

  add('sourceMachineId', typeof record.sourceMachineId === 'string'
    && record.sourceMachineId === expected.sourceMachineId)
  add('hostMachineId', typeof record.hostMachineId === 'string'
    && record.hostMachineId.length > 0 && record.hostMachineId.length <= 200)
  add('hostProcessKeyId', typeof record.hostProcessKeyId === 'string'
    && record.hostProcessKeyId.length > 0 && record.hostProcessKeyId.length <= 200)
  const publicKey = typeof record.hostProcessPublicKey === 'string'
    ? decodeBase64OrNull(record.hostProcessPublicKey)
    : null
  add('hostProcessPublicKey', publicKey?.length === tweetnacl.box.publicKeyLength)
  add('maxInputChars', record.maxInputChars === 8000)
  add('modelMaxInputTokens', record.modelMaxInputTokens === 512)

  const relayDeadlineAt = typeof record.relayDeadlineAt === 'number' && Number.isFinite(record.relayDeadlineAt)
    ? record.relayDeadlineAt
    : null
  if (relayDeadlineAt === null) failed.push('relayDeadlineAt')

  // A legacy answer to a v2 request is not a negotiated grant. Treating it as one would put
  // this client straight back to comparing a foreign instant against its own clock.
  add('timingVersion', record.timingVersion === 2)
  add('requestId', record.requestId === expected.clientRequestId)
  const issuedAt = nonNegativeSafeInteger(record.issuedAt)
  const ttlMs = positiveSafeInteger(record.ttlMs)
  const relayTtlMs = positiveSafeInteger(record.relayTtlMs)
  add('issuedAt', issuedAt !== null)
  add('ttlMs', ttlMs !== null && ttlMs <= 60_000)
  add('relayTtlMs', relayTtlMs !== null && relayTtlMs <= RUNTIME_ROUTING_DEADLINE_MS && (ttlMs === null || relayTtlMs <= ttlMs))
  // The only arithmetic left: server values against server values.
  add('ttlMs-mismatch', issuedAt !== null && ttlMs !== null && expiresAt !== null && expiresAt - issuedAt === ttlMs)
  add('relayTtlMs-mismatch', issuedAt !== null && relayTtlMs !== null && relayDeadlineAt !== null
    && relayDeadlineAt - issuedAt === relayTtlMs)

  if (failed.length > 0) return { ok: false, failed }
  return { ok: true, value: value as unknown as GrantOk }
}

function nonNegativeSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function positiveSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function parseAiModelPolicy(value: unknown): DifficultyRoutingAiModelPolicy | undefined {
  return isAiModelPolicy(value) ? value : undefined
}

function isAiModelPolicy(value: unknown): value is DifficultyRoutingAiModelPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.source !== 'unrestricted' && record.source !== 'organization' && record.source !== 'member') return false
  if (record.source === 'unrestricted') {
    return record.allowedSelectionKeys === null && record.defaultSelectionKey === null
  }
  if (!Array.isArray(record.allowedSelectionKeys)
    || record.allowedSelectionKeys.length === 0
    || record.allowedSelectionKeys.length > 256
    || record.allowedSelectionKeys.some((key) => typeof key !== 'string' || key.length === 0 || key.length > 256)) {
    return false
  }
  return record.defaultSelectionKey === null
    || (typeof record.defaultSelectionKey === 'string'
      && record.defaultSelectionKey.length > 0
      && record.defaultSelectionKey.length <= 256
      && record.allowedSelectionKeys.includes(record.defaultSelectionKey))
}

/**
 * Applies the org policy and reports whether a substitution happened, because
 * the caller must not record a refused tier as the conversation's floor.
 *
 * Every substitution is re-validated as a *pair*. Carrying the previous effort
 * across a model change is how an unrunnable combination used to be produced:
 * effort labels belong to a model, they are not a scale shared between models.
 * A substituted model that the catalog does not list has no valid effort to
 * pair with, so the decision fails rather than guessing one.
 */
function resolveRouteAllowedByAiPolicy(
  agent: RoutableAgent,
  route: SendModelOptionsResult,
  current: { model?: string; effort?: string | null },
  policy: DifficultyRoutingAiModelPolicy | undefined,
): { route: SendModelOptionsResult; substituted: boolean } | null {
  if (!policy || policy.allowedSelectionKeys === null) return { route, substituted: false }
  if (route.model && isModelAllowedByAiPolicy(policy, agent, route.model)) return { route, substituted: false }

  const substitute = current.model && isModelAllowedByAiPolicy(policy, agent, current.model)
    ? current.model
    : defaultModelForAgent(policy, agent)
  if (!substitute) return null

  const known = catalogRouteForModel(agent, substitute)
  if (!known) {
    // Allowed by policy but absent from the routing catalog: no effort in this
    // catalog is known to be valid for it. Fail rather than pair it blindly.
    logRoutingOutcome('decision-discarded', { reason: 'substituted-model-not-in-catalog' })
    return null
  }
  const { tier, pair } = known
  return {
    route: { ...route, model: pair.model, effort: pair.effort, difficulty: tier },
    substituted: true,
  }
}

function isModelAllowedByAiPolicy(
  policy: DifficultyRoutingAiModelPolicy,
  agent: RoutableAgent,
  model: string,
): boolean {
  if (policy.allowedSelectionKeys === null) return true
  return policy.allowedSelectionKeys.includes(`${agent}:${model}`)
}

function defaultModelForAgent(policy: DifficultyRoutingAiModelPolicy, agent: RoutableAgent): string | null {
  if (!policy.defaultSelectionKey) return null
  const prefix = `${agent}:`
  return policy.defaultSelectionKey.startsWith(prefix)
    ? policy.defaultSelectionKey.slice(prefix.length)
    : null
}

function hasManualModelOverride(meta: Record<string, unknown> | undefined): boolean {
  if (!meta) return false
  const hasModel = Object.prototype.hasOwnProperty.call(meta, 'model')
  const hasEffort = Object.prototype.hasOwnProperty.call(meta, 'effort')
  if (!hasModel && !hasEffort) return false
  return meta.modelSource !== 'auto'
}

function decodeBase64OrNull(value: string): Uint8Array | null {
  try {
    return decodeBase64(value)
  } catch {
    return null
  }
}

/**
 * The floor for a continuation check. Read straight from the base route: there
 * is deliberately no idle TTL here any more. Only the failure counters age, and
 * `effectiveEscalation` owns that.
 */
function freshPreviousDifficulty(state: unknown, agent: RoutableAgent): Difficulty | undefined {
  return baseFloorDifficulty(normalizeRoutingSessionState(state, agent))
}

export function resolveAplusApiOrigin(): string {
  const configured = process.env.HAPPY_APLUS_MCP_CONFIG_URL
  if (configured) {
    try {
      const parsed = new URL(configured)
      return parsed.origin
    } catch {
      // Fall through to the UI origin.
    }
  }
  return configuration.webappUrl
}

function isRelayResponse(value: unknown, requestId: string, policyRevision: number): value is RelayResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.version !== 1 || record.requestId !== requestId || record.policyRevision !== policyRevision) return false
  if (!['ok', 'busy', 'not-ready', 'expired', 'revoked', 'unsupported', 'error'].includes(String(record.status))) return false
  if (record.status === 'ok') {
    if (record.difficulty !== 'trivial' && record.difficulty !== 'routine' && record.difficulty !== 'hard') return false
    if (typeof record.classifierRevision !== 'string' || record.classifierRevision.length === 0) return false
  }
  return true
}

function noteRemoteFailure(): void {
  consecutiveFailures += 1
  if (consecutiveFailures >= 3) {
    circuitBreakerUntil = monotonicNow() + 30_000
    consecutiveFailures = 0
  }
}

function sealText(text: string, hostProcessPublicKey: string): {
  alg: 'x25519-xsalsa20-poly1305'
  nonce: string
  ephemeralPublicKey: string
  ciphertext: string
} {
  const ephemeral = tweetnacl.box.keyPair()
  const nonce = getRandomBytes(tweetnacl.box.nonceLength)
  const ciphertext = tweetnacl.box(
    new TextEncoder().encode(text),
    nonce,
    decodeBase64(hostProcessPublicKey),
    ephemeral.secretKey,
  )
  return {
    alg: 'x25519-xsalsa20-poly1305',
    nonce: encodeBase64(nonce),
    ephemeralPublicKey: encodeBase64(ephemeral.publicKey),
    ciphertext: encodeBase64(ciphertext),
  }
}

/**
 * Strictly additive over the v1 result: every field a v1 reader knows keeps its
 * v1 meaning, so an older client reads this exactly as it always did.
 *
 * `stage` is the field that matters most to a new reader. This event is emitted
 * when the request is **queued** — accepted for execution. It is not a claim
 * that the engine applied the setting, that a provider ran the model, or that a
 * cache was hit. A reader must not present `queued` as any of those.
 */
function createDifficultyRoutingEvent(input: {
  clientRequestId: string
  policyRevision: number | null
  route: SendModelOptionsResult
  classifierSource: 'p2-org-shared' | 'p1-local' | 'fallback-p1'
  remoteStatus?: RelayResponse['status']
  classifierRevision?: string
  pending?: RoutingPendingDecision
  revision?: number
  evidence?: RoutingProvenance
  previousApplied?: { model: string; effort: string | null; difficulty: Difficulty; kind: RoutingDecisionKind }
}): SessionEnvelope {
  return createEnvelope('session', {
    t: 'difficulty-routing',
    result: {
      version: 1,
      clientRequestId: input.clientRequestId,
      mode: 'auto',
      policyVersion: DIFFICULTY_ROUTING_POLICY_VERSION,
      policyRevision: input.policyRevision,
      model: input.route.model ?? '',
      effort: input.route.effort ?? null,
      difficulty: input.route.difficulty ?? 'routine',
      classifierSource: input.classifierSource,
      ...(input.remoteStatus ? { remoteStatus: input.remoteStatus } : {}),
      ...(input.classifierRevision ? { classifierRevision: input.classifierRevision } : {}),
      // --- additive, v2 readers only ---
      stage: 'queued' as const,
      ...(input.revision !== undefined ? { revision: input.revision } : {}),
      ...(input.evidence ? { evidence: input.evidence } : {}),
      ...(input.pending ? {
        clientRequestIds: [input.pending.clientRequestId],
        candidateDifficulty: input.pending.candidateDifficulty,
        baseRoute: {
          difficulty: input.pending.base.difficulty,
          model: input.pending.base.model,
          effort: input.pending.base.effort,
        },
        temporaryEscalation: input.pending.temporaryEscalation,
        decisionReasons: input.pending.decisionReasons,
      } : {}),
      ...(input.previousApplied ? { previousApplied: input.previousApplied } : {}),
    },
  })
}

/**
 * Announces that auto-routing declined and the turn is running on the session's
 * existing setting instead.
 *
 * Without this the user sees an ordinary accepted turn and no indication that
 * the model may not be the one auto-routing would have chosen — the failure is
 * invisible except in a debug log nobody has open. `stage: 'unknown'` and
 * `evidence: 'unknown'` say exactly that: a routing state exists that this build
 * could not use, so no claim is made about the floor.
 *
 * The floor is not changed and no provider call is made on account of this.
 */
export function createDifficultyRoutingUnknownEvent(input: {
  clientRequestId: string
  reason: DifficultyRoutingProtect['reason']
  model: string | undefined
  effort: string | null | undefined
}): SessionEnvelope {
  return createEnvelope('session', {
    t: 'difficulty-routing',
    result: {
      version: 1,
      clientRequestId: input.clientRequestId,
      mode: 'auto',
      policyVersion: DIFFICULTY_ROUTING_POLICY_VERSION,
      policyRevision: null,
      // What the turn is actually running on, which is the session's current
      // setting rather than anything routing chose.
      model: input.model ?? '',
      effort: input.effort ?? null,
      difficulty: 'routine',
      classifierSource: 'manual-legacy',
      stage: 'unknown' as const,
      evidence: 'unknown' as const,
      decisionReasons: [input.reason],
      clientRequestIds: [input.clientRequestId],
    },
  })
}

/**
 * The `applied` counterpart, emitted by a runner at its engine-applied boundary.
 * Carries every client request the execution merged, so a reader can attribute
 * a batch without assuming one user message equals one execution.
 */
export function createDifficultyRoutingAppliedEvent(input: {
  applied: RoutingPendingDecision
  clientRequestIds: readonly string[]
  executionId: string
  revision: number
  /** The evidence of the committed route, independent of classifier location. */
  evidence?: RoutingProvenance
  /** The route the PREVIOUS execution ran on, captured before this one lands. */
  previousApplied?: { model: string; effort: string | null; difficulty: Difficulty; kind: RoutingDecisionKind }
}): SessionEnvelope {
  return createEnvelope('session', {
    t: 'difficulty-routing',
    result: {
      version: 1,
      clientRequestId: input.applied.clientRequestId,
      mode: 'auto',
      policyVersion: DIFFICULTY_ROUTING_POLICY_VERSION,
      policyRevision: input.applied.policyRevision,
      // What actually reached the engine, which is the revision when the
      // boundary raised a stale decision.
      model: input.applied.selected.model,
      effort: input.applied.selected.effort,
      difficulty: input.applied.selectedDifficulty,
      classifierSource: input.applied.classifierSource as 'p1-local' | 'p2-org-shared' | 'fallback-p1',
      stage: 'applied' as const,
      revision: input.revision,
      evidence: input.evidence ?? 'engine-applied',
      executionId: input.executionId,
      clientRequestIds: [...input.clientRequestIds],
      candidateDifficulty: input.applied.candidateDifficulty,
      // The state transition already resolved floor versus temporary override.
      baseRoute: { ...input.applied.base },
      temporaryEscalation: input.applied.temporaryEscalation,
      decisionReasons: [...input.applied.decisionReasons],
      ...(input.previousApplied ? { previousApplied: input.previousApplied } : {}),
    },
  })
}
