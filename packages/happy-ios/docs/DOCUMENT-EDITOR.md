# Document editor

A document Surface opens in a native editor (`DocumentViewController`), for
Happy Agent accounts. It shows the document as desktop does, edits it as
rich text with Markdown shortcuts, and keeps it in step with desktop and
anyone else editing, offline included.

## What a document is

The daemon keeps each document Surface as a Yjs document. Desktop edits it
with BlockNote 0.51.4 through y-prosemirror, so the Yjs XmlFragment
`document` holds BlockNote's tree: a `blockGroup` of `blockContainer`s,
each with one block element (`paragraph`, `heading`, `bulletListItem`,
`numberedListItem`, `checkListItem`, `quote`, `codeBlock`, `divider`,
`image`, `table`, …) and an optional nested `blockGroup` for its children.
Text is an `XmlText` with formatting attributes (`bold`, `italic`,
`strike`, `code`, `link`, colours). Markdown is only a projection the
daemon makes for agents; the Yjs document is the truth.

So the phone edits the Yjs document itself, as desktop does. A Markdown
round trip would drop whatever Markdown can't hold (colours, nesting
details, block IDs) and turn every edit into a whole-document rewrite that
merges badly with someone typing on desktop.

### A Swift Yjs port

`Sources/HappyCore/Documents/Yjs` is a port of the parts of yjs 13.6 the
editor needs: the lib0 encoding (`YLib0`), structs and the struct store
(`YStructs`, `YStore`), update v1 encoding and decoding with pending
structs and delete sets, state vectors, transactions (`YDoc`), the XML
types (`YType`), relative positions, and awareness (`YPresence`). It is
pure Swift, so it runs on Linux and off the main thread, and it needs no
JavaScript runtime. A JS engine in the app would have meant a second
replica, a bridge on every keystroke and a large dependency for one screen.

It is checked against the real thing, not against itself.
`scripts/generate-document-fixtures.mjs` runs the daemon's own conversion
code over yjs and BlockNote at desktop's versions and writes
`Tests/HappyCoreTests/Fixtures/documents.json`:

- 34 documents covering every block type, every mark, nesting, hard
  breaks, tables, images and unsupported content. Each has its Yjs
  update, BlockNote's block JSON and the daemon's Markdown.
- 8 merges: two concurrent edits from fixed client IDs and the document
  yjs ends with.
- 6 cursor cases: y-prosemirror's absolute and relative positions, before
  and after another replica's edit.
- An awareness update as desktop sends one.

The tests read every fixture as BlockNote reads it, re-encode it, merge as
yjs merges, and project the same Markdown as the daemon
(`DocumentFixtureTests`, `DocumentMarkdownTests`, `DocumentCursorTests`).
`DocumentInteropTests` goes the other way: documents the Swift editor
wrote, read back by the script's `verify` mode with BlockNote.

## The model the editor works on

`DocumentEditor` (HappyCore) reads the tree into blocks and flattens them
into lines (`DocumentLine`: a block, its depth, its list number). It
writes changes back as the difference from what the document holds:

- `setRuns` changes one line's text and marks, writing only the
  difference into its `XmlText`.
- `replaceLines` is the one structural primitive. Split, join, retype,
  indent, paste and delete all go through it. It rebuilds the tree the
  flat lines describe and reconciles it by block ID, keeping every block
  that stays in order (a longest increasing run), so a structural edit
  touches only the blocks it moved.

Blocks the editor can't read (`.unsupported`) are never written over.
After each transaction it hands out the lines that changed
(`DocumentLinesChange`), whether the change was local or remote. The edits
themselves (Enter, Backspace at a line's start, indent, outdent, retype,
dividers) and the Markdown shortcuts are pure functions over lines
(`DocumentEdits`, `DocumentShortcuts`), tested on Linux.

## Why TextKit 2

The text view is a `UITextView` on TextKit 2 (`DocumentTextView`):

- **It keeps UIKit's text input.** Marked text, autocorrect, dictation,
  the hardware keyboard, selection handles, the edit menu and Writing
  Tools all work as in any text view. A custom text view would have to
  rebuild each of them.
- **A block is a paragraph, and a paragraph is a layout fragment.** Each
  line is one paragraph of the text. TextKit 2 lays out each paragraph as
  an `NSTextLayoutFragment`, and `DocumentLayoutFragment` draws the line's
  marker beside its text: a bullet, a number, a task's box, a quote's bar
  or a code block's fill. The markers aren't characters, so the text and
  the document's text agree offset for offset, and the caret can't land
  inside a bullet.
- **Layout follows the viewport.** TextKit 2 lays out what is on screen
  and estimates the rest, so a 10,000-word document opens and types like
  a short one. TextKit 1 lays out from the start up to wherever you are.
- **A paragraph is replaced alone.** A change replaces only the
  paragraphs it touched, and TextKit 2 lays out only those again.

Blocks without text (a divider, a picture, a table, something unsupported)
are one U+FFFC drawn by `DocumentObjectAttachment`. A hard break inside a
block is U+2028, so it stays one paragraph. The line and its marks ride
on each character as attributes (`.documentLine`, `.documentMarks`).
Frames come from HappyLayout (`DocumentIndent`, `DocumentMarkerLayout`,
`DocumentObjectLayout`), with exact-frame tests in `DocumentLayoutTests`.
TextKit starts an indented paragraph's fragment at its indent, so markers
are placed left of the fragment's origin.

## Typing

`DocumentTextController` keeps the text view and the editor saying the
same thing:

- **Typing goes into the text view as UIKit puts it there.** Then the
  paragraphs it touched are read back into the editor, which writes the
  difference to the document. The storage delegate gathers the edited
  range, and `textViewDidChange` reads it back. A line is recognized by
  its first character's line attribute, or by its newline's when typing
  into an empty line carried in the line above's attributes.
- **Enter, Backspace at a line's start, the bar and the shortcuts are
  edits on the lines.** Enter continues a list, leaves an empty item,
  ends a heading with a paragraph and keeps a code block's newlines
  (three Enters leave it). Backspace at the start of a nested line lifts
  it; at the start of an item it unformats it; otherwise it joins.
  `DocumentTextView.insertText` asks the delegate first, as the on-screen
  keyboard does, so text coming another way gets the same behaviour.
- **Markdown shortcuts as you type:**
  - `#`, `##`, `###` and a space make a heading;
  - `-`, `*` or `+` and a space make a bullet; `1.` makes a numbered item;
  - `[]` or `[x]` makes a task; `>` makes a quote;
  - three backticks (with a language, if you like) make a code block;
    `---` makes a divider;
  - `**bold**`, `__bold__`, `*italic*`, `_italic_`, `~~strike~~` and
    `` `code` `` format when the closing mark is typed.
- **Rebuilding.** Whatever changes the lines comes back from the editor
  as a `DocumentLinesChange`. Only those paragraphs are built again and
  replaced. After a read-back, only what the text view can't know is
  rebuilt: a new ID, a list number, a neighbour's spacing.
- **The formatting bar.** A Liquid Glass bar above the keyboard
  (`DocumentToolbar`) has:
  - text styles;
  - bold, italic, strike, code and link;
  - bullet, numbered and task lists, quote and code block;
  - outdent and indent, divider, and done.

  Its buttons light up for the selection.
- **Hardware keys:**
  - ⌘B, ⌘I, ⌘K (link), ⌘⇧S (strike) and ⌘E (code);
  - ⌘⌥0–3 for text and heading levels;
  - ⌘⇧7, ⌘⇧8 and ⌘⇧9 for numbered, bullet and task lists;
  - Tab and ⇧Tab to indent and outdent;
  - ⇧Return for a hard break.
- **Tasks.** Tapping a task's box (a 44-point target) ticks it, and
  VoiceOver announces the new state.

## Sync

### Daemon routes

`DocumentRoutes` covers these routes:

| Route | Use |
| --- | --- |
| `GET /v0/surfaces/document/:id/state?stateVector=` | Catch up: `{seq, update, stateVector}` holding only what the phone lacks. |
| `GET …/state?seq=` | A version as it stood, for history. |
| `POST …/updates {mutationId, update}` | Send a batch. Idempotent by `mutationId`. |
| `GET …/updates?afterSeq&limit` | The list of changes, for history. |
| `POST …/subscribe`, `…/unsubscribe {streamId}` | Live `document.update` and `document.presence` frames on the agent event stream. |
| `POST …/presence {streamId, awarenessClientId, update}` | This phone's cursor. |
| `PATCH /v0/surfaces/:id {name, mutationId}` | Rename. |

`DocumentStreams` routes the stream's document frames to the document
they belong to. `SyncEngine` hands them over before journal decoding and
tells it when the stream opens and closes.

### One document's sync

`DocumentSync` is an actor, off the main thread:

- **Its own replica.** It keeps its own replica of the document beside
  the editor's. The editor's local updates reach it through a stream.
- **Kept first.** Each update is kept on disk at once (`DocumentKeep`),
  then sent in batches: one batch in flight, at least 200 ms apart, under
  a mutation ID that a retry repeats. A batch is everything made here that
  the computer isn't known to have: local clients' structs past what it
  took, plus the delete set.
- **Changes from elsewhere.** They land in the replica first and go on to
  the editor only when they changed something.
- **Connecting.** Each connect subscribes the new stream, then catches up
  by state vector, so nothing a dropped stream carried is missed.
- **Refusals.** After the first refusal, the sync reads the computer's
  state and sends what it lacks. After a second, it takes the computer's
  copy (`.reset`), and the screen says the change was refused.
- **Presence.** BlockNote's awareness shape,
  `{user: {name, color}, cursor: {anchor, head}}`, with relative
  positions. It is sent at most every 250 ms and repeated every 15 s so
  the daemon keeps it.
- **The header.** It says Saved, Saving… or Waiting to sync.

`DocumentLibrary` (one per account, on `SyncEngine.documents`) holds a
sync while an editor has it open, and afterwards until everything made
here has been sent. When the stream comes back, it reopens documents kept
with unsent changes and sends them, even with no editor open. That covers
documents closed offline and those kept across a relaunch.

### Offline

Everything is kept under the account's folder, in
`documents/<surfaceId>/`:

| File | Holds |
| --- | --- |
| `state.yjs` | The replica, compacted. |
| `local.log` | Local updates since, as length-prefixed records appended as they happen. |
| `sending.json` | The batch on its way and its mutation ID. A relaunch resends it under the same ID. |
| `meta.json` | The last `seq`, the computer's state vector, this phone's client IDs and whether anything is unsent. |

A document opens from what was kept the moment the screen opens, then
catches up. With nothing kept and no computer, it says so.

### Remote changes and the selection

A remote update is merged on the main thread into the editor's replica
(`applyRemote`). Before the merge, the selection's ends become Yjs
relative positions, as y-prosemirror does. After the merge, the
selection is put back where they now point, so text inserted before the
caret moves the caret with it, and a merge into the same paragraph never
throws the caret to the start.

A merge waits while the person is composing (marked text) or while an
edit hasn't been read back yet, and lands right after.

Other editors' cursors show as bars in their colour, with their name for
3 s after they move (`DocumentCursorsView`). Their faces sit beside the
menu.

## History, rename, leave

- **History.** It lists the document's changes, newest first, with each
  author's avatar and name from the team, and the time. A row opens that
  version, read-only, read from `/state?seq` off the main thread.
- **Rename.** A `rename` intent with kind `surface`
  (`SyncEngine.deliver` → `PATCH /v0/surfaces/:id`). It is kept and
  retried like the other intents (docs/offline-first.md).
- **Remove from Sidebar.** A `leave` intent, after a confirmation.
- **Deleting a document is not possible.** The daemon has no Surface
  deletion route: Surfaces have no deletion or archive lifecycle. The
  menu offers Remove from Sidebar instead. Deleting would need a daemon
  change, which is outside this package.
- **Markdown-only documents.** A computer without `collaborativeDocuments`
  serves documents as Markdown only; they open read-only.

## Accessibility and layout

- **Dynamic Type.** Text follows Dynamic Type through `DocumentStyle`
  (`scaled`). A size change restyles the document.
- **Light and dark.** Colours are `Palette.document*` tokens with light
  and dark values.
- **iPad.** Text keeps to the readable column (`ContentWidthLimit`),
  centred.
- **VoiceOver.**
  - It reads the text, and the bar's buttons have labels.
  - Objects are named: divider, picture with its caption, table.
  - Ticking a task is announced.
  - Not done: a list's bullet or number and a task's state are drawn, not
    text, so VoiceOver doesn't speak them as it moves through lines.

## Performance

The hosted test `testTypingLatencyOnALongDocument` measures this and
writes the result to `.context/evidence/latency.txt`. The document has
626 blocks and 10,006 words. The run was on the iPhone 17 Pro simulator
(iOS 27.0) on an M-series Mac, with the Debug configuration built `-O`:

| Main thread | p50 | p95 | max |
| --- | --- | --- | --- |
| Keystroke, all of it (UIKit's insert and layout, read back, Yjs write, paragraph check) | 3.32 ms | 4.26 ms | 5.50 ms |
| … of which the editor's own (read back, Yjs write, paragraph check) | 1.38 ms | 1.60 ms | 2.11 ms |
| Remote change (Yjs merge, changed lines, paragraph replaced) | 0.77 ms | 0.85 ms | 0.85 ms |

Opening the document takes 184 ms. The Yjs read, the editor and the
attributed text are built off the main thread; only installing them runs
on it.

Without `-O` (the plain Debug build the tests use), a keystroke is
5.96 ms at p50 (the editor's share 3.61 ms) and a remote change 1.12 ms.
The test fails if a keystroke's p50 is over 8.3 ms (one 120 Hz
frame) or a remote change's is over 4.2 ms.

The editor's share is still proportional to the block count: it flattens
the tree and diffs the lines once per transaction. That is the next
thing to cut for longer documents.

Signposts: `engineering.happy` / `Document`, with intervals `apply` and
`typing`.

## Tests

- **HappyCoreTests (Linux):** fixtures, Markdown, cursors, interop, the
  editor, edits and shortcuts, and `DocumentSyncTests`. The sync tests
  run against a fake daemon and cover:
  - batching, ending Saved;
  - a remote change reaching the editor once;
  - offline edits surviving a relaunch and going out once;
  - an unsent document no editor holds being sent when the stream
    returns;
  - presence spacing and peers.

  Refusals (catch up, then `.reset`) have no test yet.
- **HappyLayoutTests:** `DocumentLayoutTests`.
- **HappyUIKitHostedTests** (`HostedDocumentEditorTests`), on the
  simulator, against a fake computer that is a Yjs replica of its own:
  - open, type with shortcuts, toggle formatting from the bar and tick a
    task, then check the computer's Markdown and lines;
  - a desktop edit merged with the caret and selection held, in dark
    mode, with a peer's cursor;
  - an edit offline, kept, then sent once on reconnect;
  - the latency run above.

  They run in the Debug configuration (`NetworkPath.force` is
  Debug-only):

  ```sh
  xcodebuild test -project Happy.xcodeproj -scheme HappyUIKitHosted -configuration Debug \
    "SWIFT_ACTIVE_COMPILATION_CONDITIONS=\$(inherited) HAPPY_FIXTURES" \
    -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
    -only-testing:HappyUIKitHostedTests/HostedDocumentEditorTests
  ```

  `TEST_RUNNER_DOCUMENT_DEMO_PACE_MS=70` slows the typing for a screen
  recording.
