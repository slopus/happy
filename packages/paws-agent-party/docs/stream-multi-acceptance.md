# Streaming and multi-person debate acceptance

Date: 2026-09-18. Scope: AgentParty companion, not the main Paws chat renderer.
This records pre-merge verification; it is not a production deployment claim.

## Contract

- Mention at least two distinct room members with automatic debate enabled.
- Speakers run sequentially in first-mention order. Every participant speaking
  once counts as one round; the maximum is ten rounds (three people = thirty turns).
- SDK public text appears incrementally in one reply card. Durable terminal text
  is authoritative. Thinking, child-agent and unrelated-session text stay excluded.
- Stop/failure preserves partial text and prevents subsequent debate turns.
  Stopping observation does not guarantee termination of already accepted remote work.
- Existing per-member unread-context cursor and Codex session reuse are preserved.

## Real Paws/Codex acceptance

The built normal server used the real Paws SDK with an authorized Linux Docker
executor (CLI 1.3.11), three Codex profiles, `gpt-5.6-luna` / `low`, and two rounds.
No mock-model option was used. All six turns completed in participant order.

Five of six turns had multiple SSE text updates **before** a public final-message
ID / terminal turn. Examples of observed cumulative lengths: 40 → 53 → 58 → 85 →
99 → 111, and 8 → 18 → 48 → 58 → 115. The first turn had one observed text snapshot,
so this report does not claim progressive chunks were observed for every turn.
The acceptance script exited successfully and stopped only the three workers
whose durable local message IDs matched this test. No account credentials were
written to this report or printed in test output.

## Browser functional acceptance (Ego, test SDK)

The actual built SPA and HTTP/SSE server were exercised with the explicit
“测试替身，非真实 Agent” fixture. This isolates UI behavior; it is not the real-model
acceptance above.

- Created a three-member room with hostname `fixture-mac-mini.local`, debate on,
  and two rounds. Submitted mentions in non-default order: 质疑者 → 产品经理 → 技术负责人.
- Observed six final Agent cards in exactly that order repeated twice. A DOM
  mutation observer recorded the first card changing from `public` to
  `public-agent-3e` to final text while it displayed “正在回复”; no duplicate final card.
- At completion, the timeline followed the bottom: scrollTop 87, scrollHeight 918,
  clientHeight 831.
- Started another debate and stopped during the first partial `public` output.
  The partial card remained with “已停止：Debate stopped”. No next participant was
  dispatched; reload retained the stopped state and seven total Agent cards.
- Started a subsequent two-round debate, moved the timeline to the top and
  dispatched a scroll event. At completion, all six additional replies existed
  (thirteen total Agent cards), scrollTop remained zero, and the previous stopped
  partial card was still present. The test space was then closed.

Screenshots were asked about but not confirmed, so none were captured. These are
DOM functional observations, not a screenshot-based visual review. No video was
recorded for this change.

## Automated validation and review

- Package Vitest: 26 files / 128 tests passed; TypeScript `--noEmit` passed.
- Package production build passed.
- Tests cover three people × ten rounds = thirty sequential turns; two-person
  compatibility; disabled debate; deduplicated mentions; stop/failure; SDK session
  and root-turn isolation; SSE authentication; partial replies; durable overwrite;
  delayed history/snapshot ordering; room switching; and SSE parsing/reconnection.
- Independent code review found and then verified fixes for final-card duplication
  when history arrives first and history-poll starvation with slow responses.
- An older finance test assumed ordering inside `Promise.all`. Its assertion now
  checks each phase's exact participants and the moderator boundaries without
  assuming concurrent send order.

## Boundaries

- This run did not test production reverse-proxy streaming. Verify after merged-main deployment.
- Live delivery requires upstream SDK text events; otherwise durable public text
  is displayed when available, without simulated typing.
- Existing 100-message history fetching is unchanged; this is not a pagination redesign.
- Terminal lifecycle changes persist partial text, but an abrupt crash can lose
  newer in-memory chunks that have not reached a lifecycle persistence boundary.
