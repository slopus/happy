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
  - Home's dock (the new-session pickers) gets the sessions without their
    heartbeat, cursors, thinking or agent state. It keeps `active` and
    `lastMeaningfulMessageAt`, which order its places, so a new message
    reaches it and a heartbeat does not.
  - A stopped session's "last seen" in the chat is a token written at the
    presence clock (`HomeSnapshot.presenceNow`), so it changes only when the
    shown text does. Home's stamps and headings never use that clock: it
    stands still while nothing is disconnected.
- Every main-thread apply runs inside `ApplyPerf.measure`. That gives each
  apply an `os_signpost` interval. In debug builds it also asserts the main
  queue, counts per site and per main-queue turn (`ApplyMetrics`), and logs
  blocks over `ApplyBudget.block`.
- Each apply starts at least one 60 Hz frame (16.67 ms) after the previous
  one in the same pipeline finished. A refused apply counts too. This is
  coarse wall-clock coalescing, not the display's frame clock. Whether
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
- The chat's rows (`ChatRows`, in an `ApplyPipeline`) are derived off the
  main thread: the rendered window, work groups, one input per row, a plan
  per row, the footer, the list's geometry and the changeset.
  - The main thread hands over only what it decides (`ChatRowsView`: the
    width, the layout, what the reader opened or picked, pages and group
    toggles as running tallies), and only when it changed.
  - `RowPlanner` measures a row once per (id, input, width). It also reuses
    the plans the list applied, so a pass that never reached the screen
    costs nothing later.
  - `ChatListView.apply` takes the changeset as is: deletes, inserts, moves,
    and a new plan only for the changed rows that are on screen.
  - An update planned for another width or layout is refused and planned
    again.
  - Marking the chat read on open is a store write, done off the main thread.

## Known gaps

- Day headings, archive toggles, and machine and section headers still
  measure their label on the main thread. Each is measured once per value
  and width, when shown.
- The banner header is also measured on the main thread, once per banner
  content and width.
- Home's and the sidebar's stamps and day headings are written at the time
  of the derivation. Nothing re-derives them when the clock alone moves; they
  catch up with the next store change.
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
| Streaming 50 tokens into a 2000-message chat (46-row window) | window, grouping and row inputs built on the main thread per update; 1 row measured; every visible cell handed its plan | 0 main-thread derivation; 1 row measured and 1 reconfigure per token; 0 for an unchanged snapshot |
| A page of older history | — | only the added rows measured, inserted after the oldest |
| 300-odd inputs in 340 ms, 2 ms per apply | — | at most 22 applies, each starting at least 16.67 ms after the last one ended (wall clock) |
