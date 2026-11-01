# Offline first

The app opens on the last state it saw, with no network, and every action
a person takes shows at once, is kept on the phone, and goes to the
server or computer when it can. This covers both account kinds: a paired
computer ("agent", `SyncEngine` over Tailcat) and a Happy account
("legacy", `LegacySyncEngine` over the relay server).

## Rules

1. **Read from disk first.** Every screen draws from what is kept on the
   phone; the network only brings diffs. No screen waits for a request to
   draw something it has drawn before.
2. **Every action is optimistic and durable.** It is applied locally in
   the same step that writes it to the account's outbox, before anything
   is sent. Killing the app at any point after the tap keeps the action.
3. **Sent in the background, in order, with backoff.** Delivery runs off
   the main thread once the account is reachable, retries transient
   failures at 1, 2, 4 … 30 seconds, and is idempotent: each action has a
   client ID sent as the server's `mutationId` where the route takes one,
   and every other route it uses sets a state (read, archived, a name), so
   sending it twice has one effect.
4. **Pending wins.** Until an action is acknowledged or definitively
   refused, it is laid over whatever the server or computer says, so a
   stale snapshot, event or bootstrap read never flickers the old state
   back.
5. **A refusal rolls back, quietly.** A definitive refusal (a 4xx other
   than 408/429, or the computer's or machine's own refusal) drops the
   action and its overlay, so the server's state shows again, and the
   screen says why in a subtle notice. "Already done" (404 on archive,
   leave or delete) counts as done.
6. **One per thing.** A newer action on the same thing replaces an older
   one still waiting (rename twice sends the last name; archive then
   unarchive sends unarchive). An acknowledgement only removes the exact
   action it answers, never a newer one queued meanwhile.

## The intent outbox

`IntentOutbox` (`Sources/HappyCore/Sync/IntentOutbox.swift`) is the one
implementation of these rules for both account kinds. Each account keeps
its rows in its own database. The agent's local state is the overlay laid
from the rows themselves; the legacy account writes the row first and its
`session` change second, and every launch makes `session.archiving` agree
with the rows, so a kill between the two still keeps the row out:

| Account kind | Database | Table |
| --- | --- | --- |
| Agent | `Application Support/Agents/<account>/direct.sqlite` (`SyncStorage`) | `intent`, migration `direct-v3-intents` |
| Legacy | `Application Support/Happy/accounts/<id>/…sqlite` (`LocalStore`) | `intent`, migration `v8-intents` |

An `Intent` is `{ id, kind, target, value, createdAt, attempts,
nextAttemptAt }`. `id` is the idempotency key. `kind` + `target` is the
slot: one row per slot (`archive` and `unarchive` share one). `value` is
what the action carries (a title, answers).

- `enqueue` writes the row (replacing the slot's older one) and publishes
  the pending list; the account applies it as an overlay at once.
- Delivery takes due rows oldest first, one at a time, through the
  account's `deliver` closure. Success deletes the row by `id`; a thrown
  `IntentRefusal` deletes it and publishes a rejection; anything else
  bumps `attempts` and `nextAttemptAt` and moves on, so one unreachable
  machine never holds back another chat's read.
- The owner turns delivery on only once the account is verified live
  (agent: after the bootstrap read; legacy: socket connected,
  `LegacySyncEngine.setConnected`), and off on pause, background and
  sign-out.
- `attempt(id)` sends one now whether or not the account is said to be
  reachable, for a screen that waits on the answer (legacy archive, leave
  and delete; agent question answers), and says `taken`, `refused(why)`
  or `waiting`. Waiting means the action stands and goes later: the
  screen moves on as if it were done.
- `verdict(id, within:)` and `outcome(id)` wait for an answer; nothing on
  the main thread waits on them.
- Each rejection says whether someone waiting on it was told (`heard`).
  One nobody heard (sent after a relaunch, or once back online) is said
  by the account's home: the agent home's notice row, the legacy home's
  alert. Either way the row is back by then.

Messages keep their own outboxes, which predate this one and already
follow the same rules with more to them (attachments, uploads, order
within a chat): `outbox` in `direct.sqlite` (agent,
`SyncEngine.drainMessages`) and `outbox` + `attachment` in `LocalStore`
(legacy, `LegacySyncEngine.flushOutbox`). Settings have theirs too
(`pendingSetting`, both kinds).

## What is covered

| Action | Agent | Legacy |
| --- | --- | --- |
| Mark a chat read (opening it) | intent `read`: the home dot and counters clear at once, kept through relaunch and stale reads, `POST /v0/agents/:id/read` | local only: `session.unread` is this phone's own (`markSessionRead`), nothing to send |
| Send a message | message outbox (existing), pending bubble, in order | message outbox (existing), "Sending…", in order, `dependsOn` |
| Rename a task or bot | intent `rename`, title shown at once | — (no rename in the legacy app) |
| Archive a task, bot or subtask | intent `archive` | intent `archive`: `session.archiving` kept through relaunch while it waits; one try now (`killSession`, else the server), the rest when the socket is back |
| Leave a task / Surface | intent `leave` | intent `leave` (`leaveTask` RPC) |
| Delete a session | — (no delete for agent work) | intent `delete`: gone here at once, a list read meanwhile doesn't bring it back (`LocalStore.deletePending`); refused, a full pass of the list brings it back |
| Settings (mute, hide projects, Prioritizing, …) | `pendingSetting` (existing) | `pendingSettings` (existing) |
| Permission mode / model | the dock's pick is kept locally and sent with the next message | kept in `composerState`, sent with the next message |
| Answer a question | intent `answer` (mutation ID), the form shows its answer while it waits | — RPC to the machine; see below |
| Task / bot made by its first message | `NewTask` (mutation ID, existing): made on send, retried with the message | — |

Not covered yet, and why:

- Legacy permission answers and question answers are RPCs to the machine
  that asked, through the relay; the machine drops a request it no
  longer holds, so a queued answer can arrive after the turn moved on.
  They stay online-only with an error, until the CLI accepts answers by
  request ID after a reconnect.
- Agent sidebar edits (move, fold, sections) are optimistic with three
  retries under one mutation ID (`Store.edit`) but not kept across a
  relaunch.
- A legacy bot's or task's archive and a task's leave need its machine.
  While the socket is up, a machine that doesn't answer is a refusal, as
  before. With the socket down, it is this phone that can't reach it, so
  the action waits.
- Legacy rename, pin and unarchive: the legacy app has none.

## What is kept per account kind

| | Agent (`Agents/<account>/`) | Legacy (`Happy/accounts/<id>/`) |
| --- | --- | --- |
| Home lists | `direct.sqlite` checkpoint `desktop` (bootstrap + cursor), `snapshot.json` (sidebar document, spaces, bots, tasks, Surfaces) | `LocalStore` `session`, `machine`, `project` |
| Chats | checkpoint `conversation:<agentId>`: every loaded message | `message` table, `chatHistory` paging state |
| Profiles, team members | bootstrap `profile`, checkpoint `users` | `accountProfile` |
| Avatars and pictures | `pictures/` (`OfflineFile.keepPicture`) | `session.avatar` descriptor + `AttachmentPictures` |
| Artifact metadata | checkpoint `artifacts` | — |
| Media | `media/` (`MediaStore`, docs/media.md) | `media/` beside `files/` |
| Drafts | `drafts` in the offline folder | `draft`, `composerState` |
| Pending actions | `intent`, `outbox`, `pendingSetting` | `intent`, `outbox`, `attachment`, `pendingSettings` |

Removing the account removes its folder, pending actions included.

## Schema and migrations

Migrations only add: a new table, or a column with a default. No migration
rewrites or drops what an earlier version kept, so an update opens on
everything the previous build saved, pending sends included.

- `SyncStorage`: `direct-v1` (checkpoint, setting, pendingSetting),
  `direct-v2-outbox`, `direct-v3-intents` (`intent(slot TEXT PRIMARY KEY,
  id TEXT UNIQUE, value BLOB, createdAt INTEGER)`).
- `LocalStore` (`Schema.swift`): `v1` … `v7-private-avatars`,
  `v8-intents` (the same `intent` table).
- `LocalStore` resets live-only state at launch (`thinking`, a `sending`
  outbox row back to `queued`); `archiving` is reset only for sessions
  with no pending archive intent.

## Conflicts and duplicates

- **Server state vs pending action**: pending wins (rule 4). An
  acknowledged action stays laid over what was last read until a read
  that began after the acknowledgement lands (agent: `SyncEngine.settling`,
  cleared by the next `reconcile`, which the ack schedules), so the
  moment between the ack and the next read can't flicker either. That
  read is the truth.
- **A newer server state after the ack**: the server wins; a chat read
  here and answered again on the computer shows unread again.
- **Two devices**: last writer wins on the server for names and settings
  (`updatedAt` on settings); read and archive are idempotent.
- **Lost acknowledgement**: the action is sent again under the same ID
  (or as the same state), so it takes effect once.
- **Messages**: a message's client ID is its `localId`; the server's echo
  carrying that ID replaces the pending bubble, so a retry never shows two.

## The title while away

Both kinds' headers say where sync is, as Telegram does:

| State | Shown |
| --- | --- |
| No network path (`NetworkPath`, `NWPathMonitor`) | "Waiting for network…" |
| Reaching the server or computer | "Connecting…" |
| Connected, catching up | "Updating…" |
| Live | the account's usual subtitle |

With no network path, home shows no "computer did not answer" notice: the
header already says it, and so does a legacy chat's, over its session's
status. When the path comes back the account reconnects at once rather
than at the end of its backoff (agent: `SyncEngine.reconnect`; legacy:
`AccountSession.networkReturned`, a fresh socket), and what waited is
sent.

## Tests

- `IntentOutboxTests` (HappyCore): coalescing, ack never removes a newer
  intent, refusal, backoff, order, persistence across a reopen.
- `SyncEngineTests`: a pending read and archive survive a kill and
  relaunch offline, then flush after reconnect; a stale bootstrap does
  not bring the unread dot back; a refusal rolls back with a notice.
- `LegacyIntentTests` (HappyCore): a legacy account's archive kept
  through a kill and relaunch offline and a stale list, then sent once;
  an archive not pending reset at launch; a delete a stale list doesn't
  undo; a refusal after a relaunch putting the row back, unheard; a
  task's archive offline waiting rather than refused.
- `SessionActionsTests`: a 4xx puts the archived row back at once; a 5xx
  keeps it waiting.
- `HostedOfflineAgentTests`: a paired computer read online, then
  airplane mode: a chat read and a task archived offline, the app killed
  and opened again still offline. Home is drawn from disk at once with
  the dot gone and the task gone and "waiting for network…" in the
  header; the chat read before opens from disk. When the network comes
  back the read and the archive each reach the computer once, and the
  dot doesn't come back.
- `HostedOfflineLegacyTests`: a Happy account in airplane mode archives a
  chat and sends two messages, is killed and opened again still offline:
  home opens with the chat still archived and "waiting for network…",
  the chat opens from disk with both messages "Sending…" and its header
  saying "waiting for network…". When the network is back each message
  is posted once, in order, the archive once, and the bubbles settle in
  the order they were sent.
