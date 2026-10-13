# Apply performance

How home and the chat get from a store change to the screen (AGENTS.md
rule 8), and what the Linux benchmarks measure.

## The path

- `Core/Changes/ApplyPipeline` derives off the main thread. Each derivation
  takes the newest input together with the state the screen applied last.
  - When nothing rendered changed, it returns nil and the main thread hears
    nothing.
  - The diff is always against what was applied, never against a result that
    was dropped.
  - Inputs that arrive during a derivation merge into one. A result that is
    about to apply while a newer input waits is dropped, but never twice in a
    row.
  - A refused apply (wrong width, an account switch) keeps the old state.
  - `cancel()` and releasing the observation drop the result in flight.
- `RowChangeset` holds deletes, inserts and moves (from the id diff) and
  reconfigures (same id, different value).
- Home (`HomeDerivation`), the iPad sidebar (`TabletSidebarDerivation`) and
  the chat's session (`ChatSessionState`) are derived from
  `AccountSession.homeFeed`.
  - The rows carry only rendered values. A row's raw `lastActivityAt` is
    cleared because the row draws `timestamp`.
  - The chat's record clears cursors, versions, ciphertexts, `updatedAt`,
    `activeAt` while online, `thinkingAt` and `unread`.
- Every main-thread apply runs inside `ApplyPerf.measure`. That gives each
  apply an `os_signpost` interval. In debug builds it also asserts the main
  queue, counts per site and per main-queue turn (`ApplyMetrics`), and logs
  blocks over `ApplyBudget.block`.
- Applies are at least one 60 Hz frame (16.67 ms) apart per pipeline. This
  is coarse wall-clock coalescing, not the display's frame clock. Whether
  it really means one apply per displayed frame has not been checked on a
  device.
- The session list applies the changeset to a plain `UITableView`: exact
  row deletes, inserts, moves and reconfigures. It never takes a fresh
  diffable snapshot and never reloads after the first load. Flat and grouped
  rows never share an id, so switching layouts is a delete plus an insert,
  and a reconfigured row always keeps its cell class.
- Session, project-card, worktree and chat rows are one fixed height at any
  width (`HomeRowHeights`, checked by `HomeRowHeightTests`), so they are
  never measured.

## Known gaps

- Day headings, archive toggles, and machine and section headers still
  measure their label on the main thread. Each is measured once per value
  and width, when shown.
- The banner header is also measured on the main thread, once per banner
  content and width.
- `HomeSnapshot.presenceNow` is not consumed yet. A stopped session's "last
  seen" text does not tick between store changes.
- None of the UIKit behaviour is verified: no simulator run, no device
  timings.

## Before and after

`Tests/HappyCoreTests/ApplyPerf*.swift` use fixed sessions, a fixed clock and
the en_US_POSIX locale. Counts are exact. Times are debug medians on the
shared Linux build machine, against generous ceilings, and they do not
measure UIKit. "Before" is a model of the b1247fce screens:
`HomeState` per delivery on the main thread, then the old row comparison.

| Scenario | Before | After |
| --- | --- | --- |
| 150 invisible changes (heartbeat, cursors, versions) | 150 main-thread derivations, 0 applies | 0 reach the main thread |
| One session's title changes | 1 main derivation, 1 snapshot apply, 1 reconfigure | 1 apply: reconfigure [20] |
| Same-minute activity reorders a row | 1 move + 1 reconfigure | 1 move, 0 reconfigures |
| 500 sessions in 5 pages during one derivation | 5 derivations, 5 applies | 2 derivations (1 superseded), 1 apply of 500 inserts |
| Real store and HomeFeed: 10 sessions × 15 heartbeats + cursor bumps, then 1 title | 150 home values | home 2 applies, chat 2 applies (first value + the title) |
| `HomeState` for 1000 sessions | 14.7–31 ms on the main thread | 0 ms on main; 16–27 ms in the background |
| Unrendered setting changes (`reviewPromptAnswered`, `lastUsedAgent`, …) | chat session applied | 0 chat applies |
| Flat ⇄ grouped layout switch | `reloadData` | delete + insert, 0 reconfigures |
| 302 inputs in 340 ms | — | 22 applies, every gap at least 16.69 ms (wall clock) |
