# Chat list: acceptance criteria

The goal, in one sentence: opening and reading any real session is fast and
nothing on screen ever moves except by the reader's own scroll.

State of the world these criteria apply to: the single inverted FlashList
(`ChatList.tsx`), group rows collapsed by construction, syntax highlighting
off by default. The Legend List experiment is deleted; its lessons live in
`chat-list-scrolling.md`.

## A. Interaction invariants (manual on device, or maestro)

- **A1 — expand up, anchored.** Tapping a collapsed "Worked Ns" ribbon expands
  the group upward. Every pixel at and below the tapped ribbon stays exactly
  where it was. The trailing "Hide" row lands on the pixels the ribbon vacated.
- **A2 — collapse from either side.** Both the top ribbon and the bottom Hide
  row collapse the group. After collapsing from the bottom row, the ribbon is
  back under the reader's thumb (round trip verified at SSIM ≥ 0.999).
- **A3 — no self-moving content.** A group that pages in from history, or a
  turn that completes, appears **collapsed on its first painted frame**. At no
  point does the visible content shift without the reader scrolling. This is
  structural: expansion state is derived default-closed, so there is no
  transient expanded commit to observe.
- **A4 — reading is respected.** A group stays expanded until the reader
  closes it, sends a new message, or leaves the app. Streaming turns render
  flat (ungrouped) and never fold up mid-read.
- **A5 — keyboard.** Opening the keyboard translates the view once. No
  double-move, no flash of content under the keyboard, no stuck offset.

## B. Performance budgets (enforced by `pnpm --filter happy-app perf:e2e`)

Measured on the iOS simulator, dev-client build, against the account's **10
most recent real sessions** — no fixtures, no synthetic data. The harness
deep-links `happy://session/<id>`, reads `[perf]` lines from Metro, and fails
the run when any budget is broken.

- **B1 — no long JS blocks.** The **worst** ChatList commit for a session ≤
  **300 ms** (dev build; observed baseline ≤ 22 ms).
- **B2 — steady-state quiet.** In the final 3 s of the settle window, a
  session that received no messages gets ≤ **2** ChatList commits. Streaming
  sessions are exempt — one commit per arriving batch is the list working.
- **B3 — time to list.** `ChatList mounted` ≤ **2500 ms** after that
  session's `session-open` mark, including never-opened sessions that fetch
  their first 100 messages (observed baseline ≤ 600 ms).
- **B4 — store writes stay cheap.** No `applyMessages` batch > **50 ms**
  while a session is open. Catches the background-prefetch re-sort stalls.

Budgets are per-session absolutes, not averages: one pathological session is
exactly the case that matters. Baselines recorded in the harness report
(`.context/perf-report-*.json`); tighten budgets there, never loosen them to
make a run pass.

## C. Code shape (reviewed, not scripted)

- **C1** — no new libraries; `@legendapp/list` pinned back to the HEAD version
  (dev-demo only). One chat list implementation, not two.
- **C2** — expansion state is one `useState`; no effect reconciles it against
  the data. New-message reset happens during render, not in an effect.
- **C3** — syntax highlighting stays off by default until it is both correct
  and off the first-commit path (`buildDiff DEFAULTS.syntax === false`).
