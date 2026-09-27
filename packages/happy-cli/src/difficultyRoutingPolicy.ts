// Provenance snapshot from Desktop `src/domain/taskRouter.ts` and
// `src/domain/operationModels.ts`, read 2026-09-17 for
// specs/org-shared-difficulty-routing. Keep this pure until a released shared
// package can replace the snapshot; do not import Desktop runtime paths.
// Shared-only quality v2 removes bare CJK explanation trivial shortcuts;
// Desktop OFF behavior is intentionally unchanged.
// 2026-09-23: Desktop 이 hard/trivial 목적지를 GPT-6 세대와 Opus 5.5 로 옮겨 같이 따라간다.
// 2026-09-27: Desktop #1060(2026-09-24)을 따라 routine 도 claude-opus-5-5/low ·
// gpt-6-sol/low 로 옮긴다. routine 과 hard 가 모델을 공유하므로 모델만으로 등급을
// 되읽는 곳은 hard 로 치우친다 (Desktop taskRouter.ts `difficultyForModel` 과 같다).
// 2026-09-27: claude escalated 도 Desktop(2026-09-24 사용자 지시)을 따라 fable-5-1 의
// effort 를 high → medium 으로 내린다. 옛 fable-5-1/high 는 escalated 로 계속 인식한다.
// 세 모델 모두 최신 CLI 에서만 실행된다 (Claude Code 2.1.280+, Codex 0.157.0+).

export type RoutableAgent = 'claude' | 'codex'
export type Difficulty = 'trivial' | 'routine' | 'hard' | 'escalated'
export type ClassifiableDifficulty = Exclude<Difficulty, 'escalated'>

export type RouteDecision = {
  model: string
  effort: string
}

export type SendModelOptionsResult = {
  model?: string
  effort?: string | null
  difficulty?: Difficulty
  rawDifficulty?: Difficulty
  source?: 'p1' | 'p2'
}

export const USER_REQUEST_MODELS: Record<RoutableAgent, Record<Difficulty, RouteDecision>> = {
  claude: {
    trivial: { model: 'claude-haiku-4-5', effort: 'low' },
    routine: { model: 'claude-opus-5-5', effort: 'low' },
    hard: { model: 'claude-opus-5-5', effort: 'high' },
    escalated: { model: 'claude-fable-5-1', effort: 'medium' },
  },
  codex: {
    trivial: { model: 'gpt-6-luna', effort: 'low' },
    routine: { model: 'gpt-6-sol', effort: 'low' },
    hard: { model: 'gpt-6-sol', effort: 'high' },
    escalated: { model: 'gpt-6-astra', effort: 'medium' },
  },
}

/**
 * Every (agent, model, effort) pair this build recognises as a routing tier,
 * across generations — not just the one generation `USER_REQUEST_MODELS` routes
 * to today.
 *
 * Two different jobs must not be confused:
 *
 * - `USER_REQUEST_MODELS` decides what a NEW decision routes to. It is
 *   unchanged here; nothing in this table remaps an existing pair.
 * - this table decides what an EXISTING pair MEANS, whether it arrived from a
 *   stored floor written by an older build or from a client running a newer
 *   catalog than ours.
 *
 * Without it, a pair from the other generation reads as "unknown model", and an
 * unknown model has no tier — so the floor is dropped and the conversation
 * silently restarts cheap. That is the exact failure this feature exists to
 * prevent, and it shows up precisely when the two repos are mid-rollout.
 *
 * Recognising a pair is never the same as rewriting it: a floor stored as
 * `claude-opus-5/high` keeps running `claude-opus-5/high` (R3 exact retention).
 * This only says that pair means `hard`.
 *
 * Sourced 2026-09-23 from the Desktop worktree
 * `src/domain/operationModels.ts` (USER_REQUEST_MODELS), which is the
 * definitive table for the generation this CLI does not yet route to.
 */
export const KNOWN_ROUTE_TIERS: ReadonlyArray<{
  agent: RoutableAgent
  model: string
  effort: string
  tier: Difficulty
}> = [
  // --- claude, generation shipped by this CLI ---
  { agent: 'claude', model: 'claude-haiku-4-5', effort: 'low', tier: 'trivial' },
  { agent: 'claude', model: 'claude-sonnet-5', effort: 'high', tier: 'routine' },
  { agent: 'claude', model: 'claude-opus-5', effort: 'high', tier: 'hard' },
  { agent: 'claude', model: 'claude-fable-5-1', effort: 'high', tier: 'escalated' },
  // --- claude, generation shipped by Desktop. routine and hard share the model;
  //     only effort tells them apart. ---
  { agent: 'claude', model: 'claude-opus-5-5', effort: 'low', tier: 'routine' },
  { agent: 'claude', model: 'claude-opus-5-5', effort: 'high', tier: 'hard' },
  { agent: 'claude', model: 'claude-fable-5-1', effort: 'medium', tier: 'escalated' },
  // --- codex, generation shipped by this CLI ---
  { agent: 'codex', model: 'gpt-5.6-luna', effort: 'low', tier: 'trivial' },
  { agent: 'codex', model: 'gpt-5.6-terra', effort: 'high', tier: 'routine' },
  { agent: 'codex', model: 'gpt-5.6-sol', effort: 'high', tier: 'hard' },
  { agent: 'codex', model: 'gpt-6-astra', effort: 'medium', tier: 'escalated' },
  // --- codex, generation shipped by Desktop. routine and hard share gpt-6-sol;
  //     only effort tells them apart. ---
  { agent: 'codex', model: 'gpt-6-luna', effort: 'low', tier: 'trivial' },
  { agent: 'codex', model: 'gpt-6-sol', effort: 'low', tier: 'routine' },
  { agent: 'codex', model: 'gpt-6-sol', effort: 'high', tier: 'hard' },
]

/**
 * The tier a known pair means, or null when this build has never heard of it.
 *
 * Null is deliberately not "assume the cheapest": an unrecognised pair carries
 * no comparable tier, and guessing one would fabricate a floor.
 */
export function tierForKnownRoutePair(
  agent: RoutableAgent,
  model: string | undefined,
  effort: string | null | undefined,
): Difficulty | null {
  if (!model || effort === null || effort === undefined) return null
  return KNOWN_ROUTE_TIERS.find((entry) => (
    entry.agent === agent && entry.model === model && entry.effort === effort
  ))?.tier ?? null
}

/** Whether this build recognises the pair at all, in either generation. */
export function isKnownRoutePair(
  agent: RoutableAgent,
  route: Pick<SendModelOptionsResult, 'model' | 'effort'>,
): boolean {
  return tierForKnownRoutePair(agent, route.model, route.effort) !== null
}

const DIFFICULTY_ORDER: readonly Difficulty[] = ['trivial', 'routine', 'hard', 'escalated']
/** Exported so the engine boundary can re-check the same threshold the
 *  classifier used, against the counter as it stands at execution time. */
export const HARD_TURNS_BEFORE_ESCALATION = 3
const STICKY_IDLE_RESET_MS = 60 * 60 * 1000

export function isRoutableAgent(agent: string | undefined): agent is RoutableAgent {
  return agent === 'claude' || agent === 'codex'
}

export function routeModelEffort(agent: RoutableAgent, difficulty: Difficulty): RouteDecision {
  return USER_REQUEST_MODELS[agent][difficulty]
}

export function isSupportedRoutedModelEffort(
  agent: RoutableAgent,
  route: Pick<SendModelOptionsResult, 'model' | 'effort'>,
): boolean {
  return Object.values(USER_REQUEST_MODELS[agent]).some((model) => (
    model.model === route.model && model.effort === route.effort
  ))
}

function tierRank(difficulty: Difficulty): number {
  return DIFFICULTY_ORDER.indexOf(difficulty)
}

function maxDifficulty(a: Difficulty, b: Difficulty): Difficulty {
  return tierRank(a) >= tierRank(b) ? a : b
}

const HARD_SIGNALS: readonly RegExp[] = [
  /architect|아키텍처|설계/,
  /\brefactor|리팩터|리팩토링/,
  /performance|성능|최적화|optimi[sz]e/,
  /debug|디버그|root cause|원인\s*(분석|파악)|왜\s*안|why\s+(is|does|isn't|won't)|race condition|deadlock|concurren|동시성|memory leak|메모리\s*누수/,
  /migrat|마이그레이션/,
  /security|보안|취약|vulnerab/,
  /scalab|확장성|distributed|분산\s*처리/,
  /전반적|전체\s*구조|cross[- ]?cutting/,
  /\breview\b|code\s*review|\baudit\b|리뷰|검토|점검|レビュー|コードレビュー|監査|审查|審查|审阅|審閱|评审|評審/,
  /버그|\bbug\b|고장|안\s*(돼|되|됨|됩니)|not\s+work|does\s?n['o]?t\s+work|is\s?n['o]?t\s+work|\bbroken\b|깨졌|깨져|터졌|터져|crash|크래시|먹통|멈춰|멈췄|\bhang\b|freeze|무한\s*루프|infinite\s*loop|flaky|재현|バグ|故障|崩溃|崩潰|死循环|死循環/,
  /분석|analy[sz]|조사(해|하| |$)|investigat|진단|diagnos|파악(해|하| )|알아내|알아봐|figure\s+out|왜\s+이(런|렇게)|分析|調査|诊断|診斷/,
  /계획\s*(을|세|짜|수립)|\bplan\b|전략|strateg|접근\s*(법|방식)|approach|설계\s*(결정|방향)|trade[- ]?off|트레이드오프|戦略|策略|设计方案|設計方案/,
  /設計|アーキテクチャ|リファクタ|パフォーマンス|最適化|デバッグ|原因|なぜ動か|移行|セキュリティ|脆弱|スケーラ|分散|並行|並列|メモリリーク/,
  /架构|架構|设计|重构|重構|性能|优化|優化|调试|調試|为什么|為什麼|迁移|遷移|安全|漏洞|可扩展|可擴展|分布式|分佈式|并发|並發|内存泄漏|記憶體洩漏/,
]

const TRIVIAL_SIGNALS: readonly RegExp[] = [
  /typo|오타|오탈자|띄어쓰기/,
  /rename|이름\s*(변경|바꿔|바꾸)|리네임/,
  /\bcomment\b|주석/,
  /format|포맷|prettier|정렬|import\s*(정리|정렬)/,
  /one[- ]?liner|한\s*줄/,
  /뭐야|무엇인가|무슨\s*뜻|의미가\s*뭐|what\s+is\b|what\s+does\b|설명만/,
  /タイポ|誤字|脱字|変数名|リネーム|名前を変更|コメント|フォーマット|整形|一行|とは何|何ですか/,
  /错别字|錯別字|拼写|拼寫|重命名|改名|注释|註釋|格式化|一行|是什么|是什麼|什么是|什麼是/,
]

const CONTINUATION_SIGNALS: readonly RegExp[] = [
  /계속|이어서|마저\s*(해|진행)|그대로\s*(진행|해)/,
  /\bcontinue\b|keep\s+going|carry\s+on|\bgo\s+on\b|\bproceed\b|as\s+before|same\s+as\s+before/,
  /続けて|続きを|そのまま(進めて|お願い)?/,
  /继续|繼續|接着做|接著做|照原样|照原樣/,
]

const FRUSTRATION_SIGNALS: readonly RegExp[] = [
  /(아직도?|여전히|계속|또)\s*(안\s*(돼|되|됨|됩니)|못\s|오류|에러|버그|문제|실패|그대로)/,
  /still\s+(not|is\s*n'?t|does\s*n'?t|won'?t|broken|fail|crash|hang|the\s+same)/,
  /same\s+(error|issue|problem|failure|bug)/,
  /(did|does|do)\s*n[o']?t\s+(fix|help)|not\s+fixed|no\s+(change|difference|luck)/,
  /(broken|fail(s|ed|ing)?|error|crash(es|ed|ing)?)\s+again/,
  /(まだ|相変わらず|やはり)(動かな|直らな|直ってな|できな|エラー|失敗|ダメ|だめ|遅)/,
  /(还是|還是|仍然|依然)\s*(不行|不好使|不对|不對|报错|報錯|出错|出錯|失败|失敗|有问题|有問題|一样|一樣|没变|沒變)/,
]

const RESOLUTION_SIGNALS: readonly RegExp[] = [
  /해결\s*(됐|됬|되었|했)/,
  /(잘|정상적으로|정상|제대로|모두|다)\s*(\S{1,8}\s+)?(됐|됬|되었|된다|됩니다|동작(해|한다|했|합니다)|작동(해|한다|했|합니다)|성공했|통과했|끝났)/,
  /고쳐졌|고쳤어|해결\s*완료/,
  /(정상|잘|제대로)[^.!?\n]{0,10}확인(했|됐|완료|됨)/,
  /\b(it|that|this)\s+works\b|\bworks\s+now\b|\bworking\s+now\b|\ball\s+good\b|\bresolved\b|\bfixed\s+now\b|\bnow\s+fixed\b/,
  /直った|直りました|動いた|動きました|解決した|解決しました|うまくいった|成功した/,
  /解决了|解決了|修好了|修复了|修復了|正常了|成功了|可以了/,
]

const CONTINUATION_MAX_LEN = 24
const RESOLUTION_NEGATIONS = /안\s*(돼|되|됐|됨)|못\s|실패|\bnot\b|\bfail/
const INTERROGATIVE_TAIL = /([?？]|나요|까요|는지|은지|을까|ㄹ까|인가|은가|ㄴ가|건가|맞나|맞지|맞아)[.!]?\s*$/
const EMBEDDED_QUESTION = /(는|은)지/

function matchesAny(text: string, signals: readonly RegExp[]): boolean {
  return signals.some((re) => re.test(text))
}

export function classifyDifficultyHeuristic(prompt: string): { difficulty: ClassifiableDifficulty; confident: boolean } {
  const text = (prompt ?? '').toLowerCase()
  if (!text.trim()) return { difficulty: 'routine', confident: false }
  if (matchesAny(text, HARD_SIGNALS)) return { difficulty: 'hard', confident: true }
  if (matchesAny(text, TRIVIAL_SIGNALS)) return { difficulty: 'trivial', confident: true }
  return { difficulty: 'routine', confident: false }
}

function isContinuationRequest(prompt: string): boolean {
  const text = (prompt ?? '').trim()
  return Boolean(text) && text.length <= CONTINUATION_MAX_LEN && matchesAny(text, CONTINUATION_SIGNALS)
}

export function shouldReusePreviousDifficultyForContinuation(prompt: string, previousDifficulty: Difficulty | undefined): boolean {
  return previousDifficulty !== undefined && isContinuationRequest(prompt)
}

function toSentences(text: string): string[] {
  return text.match(/[^.!?？。！\n]+[.!?？。！]*/g) ?? []
}

function isResolutionSignal(prompt: string): boolean {
  const text = (prompt ?? '').trim().toLowerCase()
  return Boolean(text) && toSentences(text).some((sentence) => {
    const s = sentence.trim()
    if (INTERROGATIVE_TAIL.test(s) || EMBEDDED_QUESTION.test(s) || RESOLUTION_NEGATIONS.test(s)) return false
    return matchesAny(s, RESOLUTION_SIGNALS)
  })
}

function isFrustrationSignal(prompt: string): boolean {
  const text = (prompt ?? '').trim().toLowerCase()
  return Boolean(text) && matchesAny(text, FRUSTRATION_SIGNALS)
}

function stickyExpired(ageMs: number | undefined): boolean {
  return ageMs !== undefined && ageMs > STICKY_IDLE_RESET_MS
}

function resolveStickyEntry(
  agent: string | undefined,
  prompt: string,
  current: { model?: string; effort?: string | null },
  previousDifficulty: Difficulty | undefined,
): SendModelOptionsResult | RoutableAgent {
  if (current.model) return current
  if (!isRoutableAgent(agent)) return current
  if (previousDifficulty && isContinuationRequest(prompt)) {
    return { difficulty: previousDifficulty, rawDifficulty: previousDifficulty, ...routeModelEffort(agent, previousDifficulty) }
  }
  return agent
}

function composeSticky(
  agent: RoutableAgent,
  previousDifficulty: Difficulty | undefined,
  rawDifficulty: Difficulty,
  source?: 'p1' | 'p2',
): SendModelOptionsResult {
  const difficulty = previousDifficulty ? maxDifficulty(previousDifficulty, rawDifficulty) : rawDifficulty
  return { difficulty, rawDifficulty, source, ...routeModelEffort(agent, difficulty) }
}

function nextHardTurns(
  previous: { hardTurns?: number; ageMs?: number } | undefined,
  routed: Pick<SendModelOptionsResult, 'difficulty' | 'rawDifficulty' | 'source'>,
): number {
  if (routed.difficulty !== 'hard') return 0
  const prior = !previous || stickyExpired(previous.ageMs) ? 0 : previous.hardTurns ?? 0
  if (routed.source === undefined) return prior
  return routed.rawDifficulty === 'hard' ? prior + 1 : Math.max(0, prior - 1)
}

function shouldEscalate(
  prompt: string,
  currentDifficulty: Difficulty | undefined,
  hardTurns: number,
  priorHardTurns: number,
  rawDifficulty: Difficulty | undefined = 'hard',
): boolean {
  if (currentDifficulty !== 'hard') return false
  if (rawDifficulty === 'hard' && hardTurns >= HARD_TURNS_BEFORE_ESCALATION) return true
  return priorHardTurns >= 1 && isFrustrationSignal(prompt)
}

export function routeSendModelOptionsWithDifficulty(
  agent: string | undefined,
  prompt: string,
  current: { model?: string; effort?: string | null },
  rawDifficulty: ClassifiableDifficulty,
  previousDifficulty?: Difficulty,
  source: 'p1' | 'p2' = 'p2',
): SendModelOptionsResult {
  const entry = resolveStickyEntry(agent, prompt, current, previousDifficulty)
  if (typeof entry !== 'string') return entry
  return composeSticky(entry, previousDifficulty, rawDifficulty, source)
}

export function resolveEscalation(
  agent: string | undefined,
  prompt: string,
  routed: SendModelOptionsResult,
  previous: { hardTurns?: number; ageMs?: number } | undefined,
): { routed: SendModelOptionsResult; hardTurns: number; stickyDifficulty?: Difficulty } {
  const resolved = isResolutionSignal(prompt)
  const hardTurns = resolved ? 0 : nextHardTurns(previous, routed)
  const priorHardTurns = resolved || !previous || stickyExpired(previous.ageMs) ? 0 : previous.hardTurns ?? 0
  if (!isRoutableAgent(agent) || !shouldEscalate(prompt, routed.difficulty, hardTurns, priorHardTurns, routed.rawDifficulty)) {
    return { routed, hardTurns, stickyDifficulty: routed.difficulty }
  }
  return {
    routed: { ...routed, difficulty: 'escalated', ...routeModelEffort(agent, 'escalated') },
    hardTurns,
    stickyDifficulty: 'hard',
  }
}
