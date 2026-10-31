# Offline first

Steve's requirement: the app loads from disk, in place, and then keeps
syncing, without reloading everything all the time. His later correction:
disk must never block the main thread, so a short loader while the disk is
read is fine almost everywhere; a chat must open from disk.

So the rule is:

1. Every screen reads what it shows from the phone's disk, **off the main
   thread**. A loader for the length of that read is fine.
2. Nothing waits on the network when the data is on disk. A screen never
   wipes what it shows to fetch it again.
3. The network moves only deltas, from a stored cursor, wherever the wire
   allows.
4. Opening a chat shows the stored transcript as soon as the disk read
   returns, and then fetches only what came after it.

## Audit

Cold start, account switch, return from background, socket reconnect, chat
open and back to home, for each kind of data. "Disk" is where it lives on
the phone. "Before" is the state on main at 04726154e; "now" is after this
work.

### Happy (relay) accounts

| Data | Disk | Cold start | Account switch | Foreground / reconnect | Chat open / back |
|---|---|---|---|---|---|
| Sessions (home) | `account-<id>.db` `sessions` | Read from SQLite on IO, then `/v2/sessions?changedSince=` from the watermark | The store points at the other account's database, which stays open (`AppGraph.databases`). A new `AccountSync` runs a delta from that account's watermark | Delta from the watermark; a full listing only once a day, to catch deletions | Unchanged |
| Messages | `messages` (one contiguous seq run per chat) | A chat shows its stored run, then `after_seq=` from the run's end | Same, per account | Open chats: `after_seq=` only | Stored run at once; `after_seq=`; older pages only on scroll, plus at most 5 pages in the background per sign-in |
| Outbox, composer drafts | `outbox`, `composer` | Read on IO; interrupted sends re-queued | Per account | Flushed on reconnect | n/a |
| Settings | `account` (settings + version, pending) | Read on IO | Per account | Pending changes pushed with their version, then `GET` (versioned, small) | n/a |
| Profile | `account` | Read on IO | Per account | `GET` whole (no delta endpoint; small) | n/a |
| Machines | `machines` | Read on IO | Per account | `GET` whole (no delta endpoint; an empty answer never wipes) | n/a |
| Presence | memory only (seeded from stored `active`) | From stored rows | Rebuilt from the new account's rows | Socket ephemerals | n/a |
| Projects | memory (`ProjectServices`) | Fetched | Fetched | Fetched on `new-project`/`update-project` | n/a |
| Images, attachments | Coil disk cache (128 MB) + memory | Disk cache | Shared | Disk cache | Disk cache |

Relay accounts were already offline first: everything comes from SQLite
through flows that run on `Dispatchers.IO`, and sync is a delta from stored
cursors. What was missing was a guard that it stays that way, and proof
that reconnects and switches don't list everything again (tests below).

### Agent connections (Happy Protocol V2)

| Data | Disk before | Disk now | Before | Now |
|---|---|---|---|---|
| Home catalog | `agent-connections/<id>.json` | same | Read **on the main thread** in `AgentSession`'s constructor, which home calls from composition | Read on IO when the session starts; home shows its loader for that read |
| Journal cursor | in the catalog file | same | Kept only within one `live()` run: every return to the foreground, account switch and cold start read the whole `GET /v0/bootstrap/desktop` again | A catalog with a cursor resumes `/v0/events/stream` from it. Only a `hello` with `gap` or a refused cursor reads the snapshot again |
| Conversation transcript | **nothing** | `<id>.conversation<agentId>.json` beside the catalog | Every open: loader until `bootstrap` and the newest 100 runs came back; with no network, "Couldn't load" and an empty chat | The kept runs show as soon as the disk read returns; then `bootstrap` (small: the agent, its draft, the queue) and `messages?after=<last message of the newest finished run>`. The newest run is read again whole if it may still be going |
| Artifacts list | first page kept (`keepResource("artifacts")`) | same | Kept page first, then fetched | unchanged |
| Surfaces (todo, document) | **nothing** | `<id>.surface<surfaceId>.json` | Loader until fetched; offline, an error | Kept body first (read on IO), then fetched |
| Bot and project pictures | memory only, per run | `<id>.pictures/` | Fetched over the tunnel on every start; offline, ThumbHash only | Memory, then disk, then the tunnel |
| Agent's own avatar | `agent-avatars/` | same | Disk | unchanged |
| User settings, pending | in the catalog | same | unchanged | unchanged |

### The main thread

`DiskThread` (data/DiskThread.kt) is the guard: every account store
access (`HappyStore.db`), every agent catalog, kept resource, kept
conversation and picture read and write calls `DiskThread.check()`, which
throws on the main thread when `DiskThread.strict` is on (tests).
Debug builds also turn on StrictMode's disk read and write detection,
logged (`HappyApplication.onCreate`).

What StrictMode found on a cold start before:

- `AppGraph`'s constructor (account registry, the Keystore-backed
  credentials, preferences, the legacy database delete) ran on the main
  thread: `MainActivity.onCreate` asked `HappyApplication.graph`, a `lazy`.
  Now the graph is built on its own thread (`HappyApplication.graphReady`);
  the activity holds its first frame (the system splash stays up) until
  it's ready, without blocking the main thread, and does
  `setForeground`/`requestSync` from `repeatOnLifecycle(STARTED)`.
- `PushRegistrationEffect` built `PushServices` and read its preferences
  in composition. `PushServices` is now built on the graph's thread first.
- `AgentSession` read its catalog file in its constructor, called from
  composition (above).

The relay paths (home, chat, switch) had no store access on the main
thread: `OfflineFirstJourneyTest` runs them with `DiskThread.strict` on.

## Compared with the references

- **happy-ios** keeps everything in GRDB and reads only from it; the
  network moves deltas (sessions changed since a cursor, messages after a
  session's seq, versioned settings). Its direct (agent) accounts keep a
  `desktop` checkpoint with its cursor and one `conversation:<agentId>`
  checkpoint per chat: the newest 100 runs, pending and outgoing, written
  half a second after a change. It restores that checkpoint before
  following the conversation. On every connect it still reads
  `/v0/bootstrap/desktop` whole (`reconcile`) and a chat's newest page
  whole (keeping older kept runs). `ThreadRules.assertOffMain` guards its
  storage. Android now matches its kept conversation (same 100-run window,
  same shape) and its main-thread rule, and goes further on the wire: it
  resumes the journal from the kept cursor, and asks a chat only for
  `after=` its newest finished run.
- **happy-app** (web/RN) keeps settings and profile in MMKV and nothing
  else: sessions and messages are fetched on every start and held in
  memory (its decrypt cache holds 1000). Its sync semantics (sessions by
  `changedSince`, messages by `after_seq`, settings by version) are what
  the relay delta follows; it is not a reference for persistence.

## What the wire can't do incrementally

- **Relay machines and profile** have no delta endpoint; they are read
  whole on each sync (both are small).
- **Relay session deletions** don't show up in `changedSince`; a full
  listing runs once a day (and on first sync).
- **Relay socket** keeps no recovery state, so every reconnect runs the
  delta sync rather than replaying missed updates.
- **Agent conversation `bootstrap`** (the agent, its draft, the queue) is
  read whole on each open; it has no cursor. It is small.
- **Agent messages:** `after=` returns what came after a message, so a
  chat catches up its newest run and the runs since. Deletions and edits
  to older, finished runs while the chat was closed aren't seen until the
  history is read whole again (a daemon that ignores `after`, more than 4
  pages behind, or a gap). iOS has the same blind spot.
- **Agent home** comes from the journal; Surface membership and order come
  only whole with the snapshot, so a Surface event still reads it again.
- **Surfaces** (todos, documents) have no cursor; they are read whole after
  the kept copy is shown.

## Numbers

Measured on the `offline_first_api35` emulator (API 35, arm64), opening a
Happy Agent conversation of 60 runs, from asking for the screen to its first
frame with messages, median of 5 (`ConversationOpenTimingTest`):

| Case | Before (agent read on every open) | Now (kept history first) |
|---|---|---|
| Agent answers at once (in-process) | 280 ms | n/a |
| Agent answers in 600 ms (a typical tunnel round trip) | 721 ms | 46 ms |
| No network | nothing, ever (loader, then "Couldn't load") | 52 ms |

The relay chat already opened from SQLite; `OfflineFirstJourneyTest`
covers it with the server gone.

## Tests

- `journeys/OfflineFirstJourneyTest` (Robolectric, `DiskThread.strict` on
  throughout):
  - a cold start with the server shut down shows the kept home and chat;
  - switching accounts and back shows each kept home, and the way back
    lists only sessions `changedSince` its watermark;
  - a socket drop and reconnect lists only changed sessions, and the open
    chat asks only `after_seq=` its newest message, nothing older.
- `conversation/ConversationTest`: a kept chat shows before the agent
  answers; it catches up `after=` its newest finished run and keeps the
  older runs; a newest run that may be going is read again whole; a daemon
  that ignores `after` is read as the newest page; offline, the kept chat
  stays and says why; the kept file round-trips every block kind.
- `agent/AgentSessionTest`: the catalog comes from disk off the main
  thread; a cold start resumes the journal from the kept cursor with no
  snapshot, and only a gap reads it; going behind and coming back reads no
  snapshot.
