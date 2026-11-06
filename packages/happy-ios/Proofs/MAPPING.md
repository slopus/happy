# Sync proofs: model to code

Machine-checked Lean 4 proofs about how the iOS app keeps what it shows in
step with the computer. `./check.sh` builds them (Lean 4.34, no Mathlib)
and fails on any `sorry`, `admit`, new `axiom`, or a theorem resting on an
axiom other than `propext`, `Classical.choice` and `Quot.sound`.

The model follows the decisions the code makes, not its Swift line by line:
the same comparisons in the same order. When the Swift below changes,
re-check its rows.

## What is proved

**New data is always merged.**

- An `agent.updated` is laid over the held copy only when it was made from
  the held version (`Versions.applied_only_on_its_base`); an older or
  already-held version changes nothing (`old_news_is_free`); the held
  version never goes back (`after_monotone`, `Chain.step_monotone`).
- A bootstrap read is merged with what is held, the newer of each agent
  (`merge_*`); however events and reads interleave, the copy is the newest
  of everything it has seen (`merge_all`).
- Home's refresh loop takes every read that lands. Once the loop has
  nothing left to do, home holds exactly what the computer has, however
  changes, applied events, reads, failures and exits interleaved
  (`Refresh.quiet_is_current`).
- A streamed word that starts within what the phone holds is merged, and
  the result is the computer's text through the end of the word
  (`Delta.grow_merges`); replays are free (`Delta.replay_is_free`).

**Nothing fresh is fetched again.**

- An `agent.updated` asks for a read exactly when the phone missed a
  version: holding version `j`, the event for `k` reads only when
  `j + 1 < k` (`Chain.reread_iff_missed`).
- An unbroken stream from a bootstrap's cursor, with reads interleaved
  anywhere, asks for no read at all (`Chain.in_order_never_rereads`).
- The loop reads only for news it couldn't apply or to retry a failed read
  (`Refresh.reads_le`, `no_staleness_no_reads`), and any amount of news
  while a read is on its way costs one more read (`reads_count_raises`).
- A conversation is read again for a word only when the word starts past
  what it holds (`Delta.grow_gives_up_iff_gap`), and only once for each
  message that breaks (see the limits below).
- Back on the stream with no stale news outstanding and no read on its way,
  home already holds what the computer has, so a reconnect that picks up
  where it left off reads nothing (`Refresh.resume_is_current`).

**What changed.** The loop used to drop a read whenever news arrived while
it was on its way. With news on every streamed word, home then never moved
until the agents stopped (`Refresh.dropped_never_moves`); taking each read
keeps it one read behind at most (`merged_keeps_up`, and
`merged_turn_is_the_loop` shows that turn is a run of the loop's steps).

## Map

| Model (`SyncProofs/…`) | Swift (`Sources/HappyCore/…`) |
| --- | --- |
| `Versions.decide` | `AgentUpdate.apply`'s `patch`: absent agent → `.unchanged`; no held version → `.reread`; `version <= held` → unchanged; `previousVersion == held` → applied; else `.reread` (AgentConnection/AgentUpdate.swift). `SyncEngine` runs the same decision on the agent `AgentIndex` finds (`apply(_:to:index:)`), which `AgentUpdateTests` holds to the walk on every update |
| `Versions.merge` | `AgentUpdate.keepingNewer`: the read's agents, each at the newer version |
| `Chain`, `Chain.previous` | the daemon's per-agent versions and each event's `previousVersion` |
| `Chain.Input`, `Chain.run`, `InOrder` | `SyncEngine.run`'s stream loop over `client.events(after: cursor)` with `reconcile` merges between |
| `Refresh.Step.change` | an event `scheduleReconcile` answers: any catalog prefix, or `AgentUpdate` → `.reread` (SyncEngine.run) |
| `Refresh.Step.applied` | `AgentUpdate` → `.applied`: `desktop` changed in place, then `agentsMoved` redraws the rows whose drawn fields moved |
| `Refresh.Step.begin` / `fail` / `exit` | `scheduleReconcile`'s loop: `while dirty { sleep; dirty = false; reconcile }`, its `catch` (dirty again, back off), and `refresh = nil`; a read cancelled by a disconnect is a `fail` (it never advances `covered`) |
| `Refresh.Step.gap` | a `hello` with `gap`, or from another `daemonId`, while resuming: home is read before anything is delivered |
| `resume_is_current`'s premise | `covered == signalled` with a verified `daemonId`: `run` resumes from `streamCursor` and skips the bootstrap read, the conversations' `.resync` and the authors' re-read |
| `Refresh` (the same loop) | `Store.schedulePlacesReload`, reading bots and tasks after an `agent.updated` the sidebar can't follow or a `bot.`/`task.` event; it used to restart its wait on each one and so never read while they kept coming |
| `Refresh.Step.finish` | `reconcile` taking the read: `self.desktop = keepingNewer(read, than: held)` |
| `Refresh.droppedTurn` | the removed `guard self.revision == revision else { return }` |
| `Delta.grow` | `Conversation.grow`, on one block's UTF-16 units (Agents/Conversation.swift); the stream applies it as `Conversation.growth` on `Transcript`'s held block, appending in place |

## Assumptions and limits

- Versions are compared as numbers. The daemon's are UUIDv7 strings of one
  length, whose string order is their time order.
- The daemon's history of an agent is a chain: each event's
  `previousVersion` is the version just before it, and versions only grow.
  The bootstrap read has every version before its cursor (the daemon's
  "the bootstrap cursor precedes its reads").
- `Refresh` abstracts home to one growing version and has one read in
  flight. Two can overlap across a reconnect; `reconcile` then keeps only
  a read begun after the last one taken (`adopted`), which is the newer
  one, so the merge is the same.
- Projects, workspaces, bots and tasks carry no version, so any event about
  them marks home stale and is read; that read is needed, not proven
  minimal per field. Structural agent changes (`workspaceId`,
  `parentAgentId`, `subtasks`) are read too.
- `Delta` says when a word can't be laid on what is held, not how often
  history is read for it. The daemon's history leaves out a message the
  agent is still writing, so a read can't mend it. `Conversation` reads
  once for each broken message (`behind`) and then waits for the
  message's next `message.updated`, which carries all of it. This bound
  is in the code and its tests, not in the proofs.
- Not modelled: the sidebar document (`Store`, which has its own versioned
  operations), intents laid over home (`IntentOverlay`), the feed, and
  timing (the 200 ms coalescing and 250 ms redraw).
