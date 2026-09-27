import { describe, expect, it } from 'vitest'
import {
  USER_REQUEST_MODELS,
  classifyDifficultyHeuristic,
  resolveEscalation,
  routeSendModelOptionsWithDifficulty,
  tierForKnownRoutePair,
} from './difficultyRoutingPolicy'

describe('difficulty routing policy parity snapshot', () => {
  it('matches Desktop USER_REQUEST_MODELS for routed user requests', () => {
    expect(USER_REQUEST_MODELS).toEqual({
      claude: {
        trivial: { model: 'claude-haiku-4-5', effort: 'low' },
        routine: { model: 'claude-opus-5-5', effort: 'low' },
        hard: { model: 'claude-opus-5-5', effort: 'high' },
        escalated: { model: 'claude-fable-5-1', effort: 'high' },
      },
      codex: {
        trivial: { model: 'gpt-6-luna', effort: 'low' },
        routine: { model: 'gpt-6-sol', effort: 'low' },
        hard: { model: 'gpt-6-sol', effort: 'high' },
        escalated: { model: 'gpt-6-astra', effort: 'medium' },
      },
    })
  })

  it('tells routine and hard apart by effort now that they share a model', () => {
    expect(tierForKnownRoutePair('claude', 'claude-opus-5-5', 'low')).toBe('routine')
    expect(tierForKnownRoutePair('claude', 'claude-opus-5-5', 'high')).toBe('hard')
    expect(tierForKnownRoutePair('codex', 'gpt-6-sol', 'low')).toBe('routine')
    expect(tierForKnownRoutePair('codex', 'gpt-6-sol', 'high')).toBe('hard')
  })

  it('still reads the retired routine pairs as routine', () => {
    expect(tierForKnownRoutePair('claude', 'claude-sonnet-5', 'high')).toBe('routine')
    expect(tierForKnownRoutePair('codex', 'gpt-5.6-terra', 'high')).toBe('routine')
  })

  it('keeps the sticky floor instead of downgrading easier follow-ups', () => {
    expect(routeSendModelOptionsWithDifficulty(
      'claude',
      'rename this variable',
      {},
      'trivial',
      'hard',
    )).toMatchObject({
      difficulty: 'hard',
      rawDifficulty: 'trivial',
      model: 'claude-opus-5-5',
      effort: 'high',
    })
  })

  it('reuses previous difficulty for short continuation turns', () => {
    const routed = routeSendModelOptionsWithDifficulty(
      'codex',
      'continue',
      {},
      'routine',
      'hard',
    )
    expect(routed).toMatchObject({
      difficulty: 'hard',
      rawDifficulty: 'hard',
      model: 'gpt-6-sol',
      effort: 'high',
    })
    expect(routed).not.toHaveProperty('source')
  })

  it('escalates stuck hard sessions but persists hard as the sticky floor', () => {
    const routed = routeSendModelOptionsWithDifficulty('claude', 'debug this deadlock', {}, 'hard', 'hard')
    expect(resolveEscalation('claude', 'debug this deadlock', routed, { hardTurns: 2 })).toEqual({
      routed: {
        ...routed,
        difficulty: 'escalated',
        model: 'claude-fable-5-1',
        effort: 'high',
      },
      hardTurns: 3,
      stickyDifficulty: 'hard',
    })
  })

  it('resolution reports reset the hard-turn counter without lowering the route', () => {
    const routed = routeSendModelOptionsWithDifficulty('codex', 'all good, it works now', {}, 'routine', 'hard')
    expect(resolveEscalation('codex', 'all good, it works now', routed, { hardTurns: 2 })).toMatchObject({
      hardTurns: 0,
      stickyDifficulty: 'hard',
      routed: {
        difficulty: 'hard',
        model: 'gpt-6-sol',
        effort: 'high',
      },
    })
  })
})

describe('shared routing explanation requests', () => {
  it.each([
    '切断した後も接続数が増え続けています。何が起きているか説明してください。',
    '同一订单偶尔扣款两次，请解释相关事件的先后关系。',
    '同一訂單偶爾扣款兩次，請解釋相關事件的先後關係。',
  ])('does not bypass P2 merely because the request asks for an explanation', (prompt) => {
    expect(classifyDifficultyHeuristic(prompt)).toEqual({ difficulty: 'routine', confident: false })
  })
  it.each(['この変数名をリネームしてください', '请修正这个错别字', '请修正這個錯別字', 'HTTPとは何ですか'])('retains clear mechanical/factual shortcuts', (prompt) => {
    expect(classifyDifficultyHeuristic(prompt)).toEqual({ difficulty: 'trivial', confident: true })
  })
})
