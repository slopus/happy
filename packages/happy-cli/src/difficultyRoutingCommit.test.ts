import { describe, expect, it, vi } from 'vitest'
import type { SessionEnvelope } from '@slopus/happy-wire'
import { DifficultyRoutingCommitter } from './difficultyRoutingCommit'
import {
  baseFloorDifficulty,
  recordPendingDecision,
  normalizeRoutingSessionState,
  type DifficultyRoutingSessionState,
  type RoutingPendingDecision,
} from './difficultyRoutingSessionState'

const NOW = 1_700_000_000_000

function pending(overrides: Partial<RoutingPendingDecision> = {}): RoutingPendingDecision {
  return {
    clientRequestId: 'req-1',
    candidateDifficulty: 'hard',
    selectedDifficulty: 'hard',
    selected: { model: 'claude-opus-5', effort: 'high' },
    base: { difficulty: 'hard', model: 'claude-opus-5', effort: 'high' },
    temporaryEscalation: false,
    hardTurns: 1,
    decisionReasons: ['classified-up'],
    classifierSource: 'p1-local',
    policyRevision: 7,
    policyVersion: 'org-shared-difficulty-routing.v1',
    createdAt: NOW,
    ...overrides,
  }
}

function makeCommitter(initial: unknown = undefined) {
  const persisted: DifficultyRoutingSessionState[] = []
  const emitted: SessionEnvelope[] = []
  const committer = new DifficultyRoutingCommitter(initial, {
    agent: 'claude',
    persist: (state) => persisted.push(state),
    emit: (envelope) => emitted.push(envelope),
    now: () => NOW,
  })
  return { committer, persisted, emitted }
}

function acceptedState(committer: DifficultyRoutingCommitter, entry = pending()) {
  return recordPendingDecision(committer.current(), entry)
}

function resultOf(envelope: SessionEnvelope): Record<string, unknown> {
  const ev = envelope.ev as { t: string; result: Record<string, unknown> }
  return ev.result
}

describe('DifficultyRoutingCommitter', () => {
  it('previews the boundary model without committing a queued request', () => {
    const { committer, persisted, emitted } = makeCommitter()
    committer.recordPending(acceptedState(committer))
    committer.commitApplied(['req-1'], 'exec-1')
    committer.recordLocalPending(pending({
      clientRequestId: 'cheap', candidateDifficulty: 'trivial', selectedDifficulty: 'trivial',
      selected: { model: 'claude-haiku-4-5', effort: 'low' },
      base: { difficulty: 'trivial', model: 'claude-haiku-4-5', effort: 'low' },
    }))
    const before = structuredClone(committer.current())
    const persistCount = persisted.length
    const emitCount = emitted.length
    expect(committer.previewAppliedRoute(['cheap'])).toMatchObject({ model: 'claude-opus-5', effort: 'high' })
    expect(committer.current()).toEqual(before)
    expect(persisted).toHaveLength(persistCount)
    expect(emitted).toHaveLength(emitCount)
    committer.discardPending(['cheap'], 'cancelled')
    expect(committer.current().appliedRequestIds).toEqual(['req-1'])
  })

  it('emits each boundary correction reason once from the committed decision', () => {
    const { committer, emitted } = makeCommitter()
    committer.recordPending(acceptedState(committer))
    committer.commitApplied(['req-1'], 'exec-1')
    committer.recordLocalPending(pending({
      clientRequestId: 'cheap', candidateDifficulty: 'trivial', selectedDifficulty: 'trivial',
      selected: { model: 'claude-haiku-4-5', effort: 'low' },
      base: { difficulty: 'trivial', model: 'claude-haiku-4-5', effort: 'low' },
      decisionReasons: [],
    }))
    committer.commitApplied(['cheap'], 'exec-2')
    expect(resultOf(emitted[1]).decisionReasons).toEqual(['stale-queued-decision', 'sticky-floor-maintained'])
  })

  it('merges a delayed decision without overwriting a newer applied floor or revision', () => {
    const { committer } = makeCommitter()
    committer.recordPending(acceptedState(committer))
    const delayed = acceptedState(committer, pending({ clientRequestId: 'req-2' }))
    committer.commitApplied(['req-1'], 'exec-1')
    const revision = committer.current().revision
    committer.recordPending(delayed)
    expect(committer.current().base?.model).toBe('claude-opus-5')
    expect(committer.current().revision).toBeGreaterThan(revision)
    expect(Object.keys(committer.current().pending ?? {})).toEqual(['req-2'])
  })

  it('does not erase an unreadable future state on an explicit reset', () => {
    const { committer, persisted } = makeCommitter({ stateVersion: 99, revision: 4 })
    committer.startEpoch()
    expect(persisted).toHaveLength(0)
    expect(committer.current().foreignStateVersion).toBe(99)
  })

  it('shouldNotMoveTheFloorWhenARequestIsOnlyAccepted', () => {
    const { committer, emitted } = makeCommitter()
    committer.recordPending(acceptedState(committer))

    expect(baseFloorDifficulty(committer.current())).toBeUndefined()
    // Accepting is not applying — the committer emits nothing of its own here.
    expect(emitted).toHaveLength(0)
  })

  it('shouldCommitTheFloorAndEmitAnAppliedEventAtTheEngineBoundary', () => {
    const { committer, emitted } = makeCommitter()
    committer.recordPending(acceptedState(committer))

    committer.commitApplied(['req-1'], 'exec-1')

    expect(baseFloorDifficulty(committer.current())).toBe('hard')
    expect(emitted).toHaveLength(1)
    expect(resultOf(emitted[0])).toMatchObject({
      stage: 'applied',
      evidence: 'engine-applied',
      executionId: 'exec-1',
      clientRequestIds: ['req-1'],
      model: 'claude-opus-5',
    })
  })

  it('shouldNeverClaimProviderConfirmationItDidNotObserve', () => {
    const { committer, emitted } = makeCommitter()
    committer.recordPending(acceptedState(committer))
    committer.commitApplied(['req-1'], 'exec-1')

    expect(resultOf(emitted[0]).providerConfirmedModel).toBeUndefined()
  })

  it('shouldCommitOnceForABatchThatMergedSeveralRequests', () => {
    const { committer, emitted } = makeCommitter()
    let state = acceptedState(committer, pending({ clientRequestId: 'a' }))
    state = recordPendingDecision(state, pending({ clientRequestId: 'b' }))
    committer.recordPending(state)

    committer.commitApplied(['a', 'b'], 'exec-1')

    expect(committer.current().escalation?.hardTurns).toBe(1)
    expect(emitted).toHaveLength(1)
    expect(resultOf(emitted[0]).clientRequestIds).toEqual(['a', 'b'])
  })

  it('shouldEmitNothingAndChangeNothingForAReplayedExecutionId', () => {
    const { committer, emitted } = makeCommitter()
    committer.recordPending(acceptedState(committer))
    committer.commitApplied(['req-1'], 'exec-1')
    const afterFirst = committer.current()

    // The same execution reported twice, with the request queued again in between.
    committer.recordPending(recordPendingDecision(afterFirst, pending({ hardTurns: 9 })))
    committer.commitApplied(['req-1'], 'exec-1')

    expect(emitted).toHaveLength(1)
    expect(committer.current().escalation?.hardTurns).toBe(1)
  })

  it('shouldCountOnceWhenTheSameRequestIdAppearsTwiceInOneBatch', () => {
    // A double-send puts the same id in the queue twice, so the collected batch
    // carries it twice. Replacing the pending entry is not on its own enough —
    // the commit must not count the duplicate a second time.
    const { committer, emitted } = makeCommitter()
    committer.recordPending(acceptedState(committer))

    committer.commitApplied(['req-1', 'req-1'], 'exec-1')

    expect(committer.current().escalation?.hardTurns).toBe(1)
    expect(emitted).toHaveLength(1)
  })

  it('shouldEmitNothingForAnExecutionCarryingNoRequestIds', () => {
    const { committer, emitted } = makeCommitter()
    committer.recordPending(acceptedState(committer))

    committer.commitApplied(undefined, 'exec-1')
    committer.commitApplied([], 'exec-2')

    expect(emitted).toHaveLength(0)
    expect(baseFloorDifficulty(committer.current())).toBeUndefined()
  })

  it('shouldLeaveTheFloorUntouchedWhenAnAcceptedRequestIsCancelled', () => {
    const { committer, emitted } = makeCommitter()
    committer.recordPending(acceptedState(committer))

    committer.discardPending(['req-1'], 'cancelled')

    expect(committer.current().pending).toBeUndefined()
    expect(baseFloorDifficulty(committer.current())).toBeUndefined()
    expect(emitted).toHaveLength(0)
  })

  it('shouldNotApplyARequestThatWasCancelledBeforeTheEngineBoundary', () => {
    const { committer, emitted } = makeCommitter()
    committer.recordPending(acceptedState(committer))
    committer.discardPending(['req-1'], 'cancelled')

    committer.commitApplied(['req-1'], 'exec-1')

    expect(emitted).toHaveLength(0)
    expect(baseFloorDifficulty(committer.current())).toBeUndefined()
  })

  it('shouldKeepTheCommitWhenTheTurnFailsAfterTheEngineAppliedIt', () => {
    const { committer } = makeCommitter()
    committer.recordPending(acceptedState(committer))
    committer.commitApplied(['req-1'], 'exec-1')

    // A post-apply failure is reported as a discard of the same request. The
    // model really was configured, so the floor must survive it.
    committer.discardPending(['req-1'], 'failed')

    expect(baseFloorDifficulty(committer.current())).toBe('hard')
  })

  it('shouldClearTheFloorOnlyForAnExplicitContextReset', () => {
    const { committer } = makeCommitter()
    committer.recordPending(acceptedState(committer))
    committer.commitApplied(['req-1'], 'exec-1')

    committer.startEpoch()

    expect(baseFloorDifficulty(committer.current())).toBeUndefined()
  })

  it('shouldRefuseToPersistOverARecordWrittenByANewerVersion', () => {
    const { committer, persisted } = makeCommitter({ stateVersion: 99, revision: 4 })
    committer.recordPending(recordPendingDecision(committer.current(), pending()))

    expect(persisted).toHaveLength(0)
  })

  it('shouldPersistEveryDurableTransitionForAReadableRecord', () => {
    const { committer, persisted } = makeCommitter()
    committer.recordPending(acceptedState(committer))
    committer.commitApplied(['req-1'], 'exec-1')

    expect(persisted).toHaveLength(2)
    expect(persisted[1].revision).toBeGreaterThan(persisted[0].revision)
  })

  it('shouldStartFromAMigratedLegacyRecordWithoutTreatingItAsApplied', () => {
    const { committer } = makeCommitter({ difficulty: 'hard', hardTurns: 2, updatedAt: NOW })
    expect(baseFloorDifficulty(committer.current())).toBe('hard')
    // Migrated history: a selection with no observed apply behind it.
    expect(committer.current().base?.provenance).toBe('legacy-selection')
  })
})

describe('recordPending receipt filtering (R7)', () => {
  it('shouldNotResurrectARequestAppliedSeveralExecutionsAgo', () => {
    // `lastApplied` only remembers the newest execution. Filtering against it
    // alone lets an older applied request back into pending, where it lingers
    // forever: the commit refuses it (it is in the receipts), and nothing else
    // ever clears it.
    const { committer } = makeCommitter()
    committer.recordPending(acceptedState(committer))
    committer.commitApplied(['req-1'], 'exec-1')
    committer.recordPending(recordPendingDecision(committer.current(), pending({ clientRequestId: 'other' })))
    committer.commitApplied(['other'], 'exec-2')

    // req-1 is now an old receipt, no longer named by `lastApplied`.
    committer.recordPending(recordPendingDecision(committer.current(), pending()))

    expect(committer.current().pending?.['req-1']).toBeUndefined()
  })

  it('shouldStillAcceptAGenuinelyNewRequest', () => {
    const { committer } = makeCommitter()
    committer.recordPending(acceptedState(committer))
    committer.commitApplied(['req-1'], 'exec-1')

    committer.recordPending(recordPendingDecision(committer.current(), pending({ clientRequestId: 'fresh' })))

    expect(committer.current().pending?.['fresh']).toBeDefined()
  })

  it('shouldApplyTheSameFilterToALocallyRoutedTurn', () => {
    const { committer } = makeCommitter()
    committer.recordPending(acceptedState(committer))
    committer.commitApplied(['req-1'], 'exec-1')
    committer.recordPending(recordPendingDecision(committer.current(), pending({ clientRequestId: 'other' })))
    committer.commitApplied(['other'], 'exec-2')

    committer.recordLocalPending(pending({ kind: 'local-auto-bootstrap' }))

    expect(committer.current().pending?.['req-1']).toBeUndefined()
  })
})

describe('boundary escalation through the committer (R4)', () => {
  it('shouldRaiseAWaitingTurnAndKeepTheFloorWhereItWas', () => {
    const { committer, emitted } = makeCommitter()
    const hard = (id: string) => pending({
      clientRequestId: id,
      candidateDifficulty: 'hard',
      hardTurnsIntent: 'increment',
    })
    for (const id of ['a', 'b']) {
      committer.recordPending(recordPendingDecision(committer.current(), hard(id)))
      committer.commitApplied([id], `x-${id}`)
    }
    committer.recordPending(recordPendingDecision(committer.current(), hard('waited')))

    // The committer must use its own clock here, or the streak reads as expired
    // and the escalation it just earned is skipped.
    const revised = committer.commitApplied(['waited'], 'exec-e')

    expect(revised).toEqual({ model: 'claude-fable-5-1', effort: 'medium' })
    expect(committer.current().base).toMatchObject({ difficulty: 'hard', model: 'claude-opus-5' })
    expect(resultOf(emitted.at(-1)!)).toMatchObject({ model: 'claude-fable-5-1', difficulty: 'escalated' })
  })
})

describe('applied event accuracy at the boundary (R4, R8)', () => {
  const hard = (id: string, overrides: Partial<RoutingPendingDecision> = {}) => pending({
    clientRequestId: id,
    candidateDifficulty: 'hard',
    hardTurnsIntent: 'increment',
    ...overrides,
  })

  function committerWithStreak(n: number) {
    const made = makeCommitter()
    for (let i = 0; i < n; i += 1) {
      made.committer.recordPending(recordPendingDecision(made.committer.current(), hard(`seed-${i}`)))
      made.committer.commitApplied([`seed-${i}`], `x-${i}`)
    }
    return made
  }

  it('shouldNotLetABoundaryEscalationOverwriteTheEventsBaseRoute', () => {
    // The event builder rewrites baseRoute from `revised`. For a temporary
    // escalation that would publish Fable as the floor, and a client reading
    // baseRoute would then treat the override as permanent.
    const { committer, emitted } = committerWithStreak(2)
    committer.recordPending(recordPendingDecision(committer.current(), hard('waited')))

    committer.commitApplied(['waited'], 'exec-e')

    expect(resultOf(emitted.at(-1)!)).toMatchObject({
      model: 'claude-fable-5-1',
      difficulty: 'escalated',
      temporaryEscalation: true,
      baseRoute: { difficulty: 'hard', model: 'claude-opus-5', effort: 'high' },
    })
  })

  it('shouldCarryThePreviousActualRouteOnTheAppliedEventItself', () => {
    // The queued event's snapshot is taken at accept time and can be stale by
    // the boundary. The applied event is the one that says what ran, so it must
    // carry the route it actually followed.
    const { committer, emitted } = makeCommitter()
    committer.recordPending(acceptedState(committer))
    committer.commitApplied(['req-1'], 'exec-1')
    expect(resultOf(emitted.at(-1)!).previousApplied).toBeUndefined()

    committer.recordPending(recordPendingDecision(committer.current(), pending({
      clientRequestId: 'second',
      selected: { model: 'claude-sonnet-5', effort: 'high' },
    })))
    committer.commitApplied(['second'], 'exec-2')

    expect(resultOf(emitted.at(-1)!).previousApplied).toMatchObject({
      model: 'claude-opus-5',
      difficulty: 'hard',
      kind: 'auto',
    })
  })

  it('shouldReturnToTheBaseOnTheTurnAfterABoundaryEscalation', () => {
    const { committer, emitted } = committerWithStreak(2)
    committer.recordPending(recordPendingDecision(committer.current(), hard('waited')))
    committer.commitApplied(['waited'], 'exec-e')
    expect(committer.current().lastEscalatedExecutionId).toBe('exec-e');

    // A resolved follow-up: the streak ends and the conversation returns to the
    // floor the escalation never touched.
    committer.recordPending(recordPendingDecision(committer.current(), pending({
      clientRequestId: 'after',
      hardTurnsIntent: 'reset',
    })));
    const revised = committer.commitApplied(['after'], 'exec-after')

    expect(revised).toBeNull()
    expect(committer.current().base).toMatchObject({ difficulty: 'hard', model: 'claude-opus-5' })
    expect(committer.current().escalation?.hardTurns).toBe(0)
    expect(committer.current().lastEscalatedExecutionId).toBeUndefined()
    expect(resultOf(emitted.at(-1)!)).toMatchObject({
      model: 'claude-opus-5',
      temporaryEscalation: false,
      previousApplied: { model: 'claude-fable-5-1', difficulty: 'escalated' },
    })
  })

  it('shouldReEscalateOnALaterTurnWhenTheStreakEarnsItAgain', () => {
    const { committer } = committerWithStreak(2)
    committer.recordPending(recordPendingDecision(committer.current(), hard('waited')))
    committer.commitApplied(['waited'], 'exec-e')

    // Streak keeps climbing: escalation is allowed to recur (R4).
    committer.recordPending(recordPendingDecision(committer.current(), hard('again')))
    const revised = committer.commitApplied(['again'], 'exec-again')

    expect(revised).toEqual({ model: 'claude-fable-5-1', effort: 'medium' })
    expect(committer.current().base).toMatchObject({ difficulty: 'hard', model: 'claude-opus-5' })
  })

  it('shouldCorrectAQueuedTurnWhoseFloorModelChangedAtTheSameTier', () => {
    // Equal tier, different exact pair: running the queued model would revert
    // the floor to a model the conversation has moved off.
    const { committer } = makeCommitter()
    committer.recordPending(recordPendingDecision(committer.current(), pending({
      clientRequestId: 'newgen',
      selected: { model: 'claude-opus-5-5', effort: 'high' },
      base: { difficulty: 'hard', model: 'claude-opus-5-5', effort: 'high' },
    })))
    committer.commitApplied(['newgen'], 'exec-1')
    expect(committer.current().base?.model).toBe('claude-opus-5-5')

    // Queued back when the floor was still the older pair.
    committer.recordPending(recordPendingDecision(committer.current(), pending({ clientRequestId: 'oldgen' })))
    const revised = committer.commitApplied(['oldgen'], 'exec-2')

    expect(revised).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
  })
})

describe('committer opaque request ids', () => {
  it('accepts and commits a literal __proto__ id without changing the map prototype', () => {
    const { committer } = makeCommitter()
    committer.recordPending(acceptedState(committer, pending({ clientRequestId: '__proto__' })))
    expect(Object.keys(committer.current().pending ?? {})).toEqual(['__proto__'])
    committer.commitApplied(['__proto__'], 'exec')
    expect(committer.current().appliedRequestIds).toEqual(['__proto__'])
  })
  it.each(['constructor', 'toString', '__proto__'])('ignores unaccepted %s at preview and commit', (id) => {
    const { committer } = makeCommitter()
    committer.recordPending(acceptedState(committer))
    const before = structuredClone(committer.current())
    expect(committer.previewAppliedRoute([id])).toBeNull()
    expect(committer.commitApplied([id], 'exec')).toBeNull()
    expect(committer.current()).toEqual(before)
  })
})

describe('runtime normalization before durable apply', () => {
  it('records the normalized known pair before persisting or emitting', () => {
    const { committer, persisted, emitted } = makeCommitter()
    committer.recordPending(acceptedState(committer))
    const route = committer.commitApplied(['req-1'], 'normalized', () => ({ model: 'claude-haiku-4-5', effort: 'low' }))
    expect(route).toEqual({ model: 'claude-haiku-4-5', effort: 'low' })
    expect(persisted.at(-1)?.base).toMatchObject({ model: 'claude-haiku-4-5', effort: 'low', difficulty: 'trivial' })
    expect(resultOf(emitted[0])).toMatchObject({ model: 'claude-haiku-4-5', baseRoute: { model: 'claude-haiku-4-5' } })
  })
  it('keeps the chosen batch winner when normalization lowers its tier', () => {
    const { committer, emitted } = makeCommitter()
    committer.recordLocalPending(pending({ clientRequestId: 'hard' }))
    committer.recordLocalPending(pending({
      clientRequestId: 'routine', selectedDifficulty: 'routine',
      selected: { model: 'claude-sonnet-5', effort: 'high' },
      base: { difficulty: 'routine', model: 'claude-sonnet-5', effort: 'high' },
    }))
    committer.commitApplied(['hard', 'routine'], 'batch', () => ({ model: 'claude-haiku-4-5', effort: 'low' }))
    expect(resultOf(emitted[0])).toMatchObject({ clientRequestId: 'hard', model: 'claude-haiku-4-5' })
    expect(committer.current().appliedRequestIds).toEqual(['hard', 'routine'])
  })
  it('runs an unknown runtime pair without recording a fabricated floor', () => {
    const { committer, emitted } = makeCommitter()
    committer.recordPending(acceptedState(committer))
    expect(committer.commitApplied(['req-1'], 'zai', () => ({ model: 'glm-5', effort: 'high' }))).toEqual({ model: 'glm-5', effort: 'high' })
    expect(committer.current().base).toBeUndefined()
    expect(committer.current().lastApplied).toBeUndefined()
    expect(committer.current().pending).toBeUndefined()
    expect(emitted).toHaveLength(0)
  })
})
