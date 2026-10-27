# UltraList chat device QA

`Tests/HappyChatUITests/ChatUltraQATests.swift` drives the UltraList chat
on a physical device through `HappyChatHarness`. It records screenshots,
an optional screen recording, and per-frame numbers from the harness's
probe (`Harness/ChatUltraQAProbe.swift`). It is QA tooling and is not part
of the CI suite. Every chat it opens is a fixture or seeded chat in the
harness, and sends, permission answers and question answers go to
`FixtureChatControls`, so nothing reaches a server. The single exception is
`testR1RealAccountReadOnly`, described below.

## Tests

For runs without XCUITest, `-qaScript send` drives fixture sends, streamed
replies, a failed send and its retry; `-qaScript live` observes the live
fixture. Add `-qaProbe -qaRows -qaRun <name>` to record each row's presented
frame and opacity to `Documents/qa/<name>-rows.jsonl`, beside script marks
and the frame ledger. Without `-chatUltraList` this checks the default
UICollectionView renderer. `-qaFilm` records window snapshots at 30 fps;
measure frame timing in a separate run because snapshots add work.

| Test | Covers |
| --- | --- |
| `testSmokeLongFling` | Device, signing and capture work: a 1500-turn chat, one fling each way |
| `testC1LongKeyboardAndHistory` | The keyboard up on open, three typed lines, a partial and an interactive keyboard dismiss, pulling past the newest message, six flings back, jump to newest |
| `testL1LegacyLongKeyboardAndHistory` | C1 on UICollectionView, for comparison |
| `testC2LiveStreamHistoryAndSend` | Dragging and flinging while a reply streams, jump to newest, sending with the keyboard up, copying the reply |
| `testC3ToolsPermissionsDiffs` | Allowing and denying permissions, opening a tool group, opening and closing each tool on screen where it opened, a diff's Show more when one of its diffs holds lines back (the tool opened again and followed down to the bar; no diff in this fixture does, so it is recorded as not covered and left to C10), panning a strip (a diff's lines count) sideways, catching momentum |
| `testC10DiffShowMore` | The `showMore` fixture: a newest Write of 301 added lines, 280 shown and 21 held back. Opening it, tapping Show more, the row growing with nothing held back, and the reader's place kept: the newest edge at the newest message, the tapped row's top away from it. Records whether the row draws on the native canvas |
| `testC4MarkdownLinksCopyPictures` | Copying, the long-press menu or selection screen, options, attached and web pictures, panning code or a table, links |
| `testC5QuestionsAndSending` | Inline question answers, the question sheet, a failed send and its retry |
| `testC6DiagramsAndGiantMessage` | Mermaid diagrams and their web views, one 350-paragraph message, and messages either side of the 4096-point tile limit |
| `testC7HomeOpensChatsDetailsAndSetting` | Cold and warm opens from Home, header avatar to Details, worktree tabs, the renderer setting and its persistence |
| `testN1NavigationBarOwnership` | Which screen has the navigation bar: none on Home, the bar on a chat in portrait, in landscape none on a phone layout and the bar beside the sidebar on a window at least 768 points wide (a tablet layout, as an iPhone 12 is), the chat with its bar after an attempted back swipe let go early, and the ordinary bar on Settings. Checked at rest only: whether the swipe began and turned back, and any bar flash during a push, need a recorded pass |
| `testC8DarkLargeTextRotationAccessibility` | Dark appearance, Accessibility XL text with an accessibility audit, rotation with the keyboard up |
| `testC9ComposerControlsAndVoiceEntry` | The composer's chips and add menu (opened and closed, nothing chosen), and the voice button changing to Send when text is typed |
| `testL2LegacyAndUltraScreens` | The same screens on both renderers, for pixel comparison |
| `testR1RealAccountReadOnly` | Opt-in: the TEST account, read only (below) |

When a fixture contains a feature, the test must find it, act on it and
check the result. If any of those steps fails, the test fails. When a
feature can't be exercised offline, the test records it as `NOT COVERED`
together with the reason, and that record never counts as a pass. Each
test attaches a `coverage` list. Starting voice is never covered, because
it asks for the microphone and fetches voice credentials from the server.

## Harness flags

- `-fixture <name> -chatUltraList`: opens a fixture chat on UltraList.
  Leave out `-chatUltraList` to use UICollectionView.
- `-screen home -renderer UITableView -grouping flat -sessionCount 0
  -archiveCount 0 -chatUltraList`: opens the seeded Home, which pushes
  chats through normal navigation. `-renderer stored` keeps the stored
  renderer choices.
- `-qaProbe`: installs the probe. `-qaRun <name>` names its files, and
  `-qaDark` shows the window in dark appearance.
- `-giantParagraphs N` (1…1000): sets the size of the `giant` fixture's message.
- `-keyboard`: opens the chat with the composer focused.
- `-qaRealChat`: the read-only TEST account (below).

## Running

Build for testing once, then run the suite in separate passes. For the
iPhone 12 and the Mac mini, see the repository's agent instructions.

```
xcodebuild build-for-testing -project Happy.xcodeproj -scheme HappyChatUI \
  -configuration Debug -destination id=<UDID> -derivedDataPath <dd> \
  DEVELOPMENT_TEAM=<team> CODE_SIGN_STYLE=Automatic -allowProvisioningUpdates
```

Use `-configuration Preview` together with `ENABLE_TESTABILITY=YES
'SWIFT_ACTIVE_COMPILATION_CONDITIONS=$(inherited) HAPPY_FIXTURES'` to get an
optimized build that still contains the fixtures. Make frame claims from
that build and functional claims from Debug. The probe's state reports
which build it is running in (`build`).

Copy the generated `.xctestrun` and edit the copy for each pass:

- **Video**: `PreferredScreenCaptureFormat = screenRecording` and
  `SystemAttachmentLifetime = keepAlways`. XCTest records the screen for
  each test. The recording is variable frame rate and holds at most about
  30 fps while the screen moves, so use it to look at the run, not to count
  frames.
- **Timing**: `PreferredScreenCaptureFormat = screenshots` and
  `SystemAttachmentLifetime = deleteOnSuccess`. Remove `DYLD_INSERT_LIBRARIES`
  (the Main Thread Checker) from `TestingEnvironmentVariables`. Take frame
  numbers from this pass, never from a video pass.
- **Animation Hitches**: start `xcrun xctrace record --template 'Animation
  Hitches' --device <UDID> --all-processes` around a timing pass. The trace
  is the authority on composited frames.

Set `UserAttachmentLifetime = keepAlways` in every pass and run with
`-parallel-testing-enabled NO`. `TEST_RUNNER_QA_PASS=<name>` prefixes the
probe's file names, so passes don't overwrite one another. Export
attachments with `xcrun xcresulttool export attachments`. The probe's files
are in the harness's container under `Documents/qa`
(`xcrun devicectl device copy from --domain-type appDataContainer
--domain-identifier com.slopus.happy.chat-harness --source Documents/qa`).

### Rules the tests keep

- **Nothing reads the app while it moves.** Every accessibility read makes
  the app serialize its view tree on the main thread, which takes 125–200 ms
  on an iPhone 12 and shows up as missed frames. Gestures are aimed through
  SpringBoard's coordinate space. A step performs its action, waits a fixed
  time without reading, and only then reads the windows the action
  produced. Quiescence waits are turned off. If you add a step, keep the
  reads outside the period of motion, deceleration and settling.
- **Every step must produce windows.** When a step that should produce
  action windows produces none, it fails instead of passing silently.
- **System alerts are never answered.** An interruption monitor fails the
  test and returns without tapping anything. Before running, clear any
  pending permission prompt by hand.
- **Device settings are left alone.** Text size and appearance are set
  through launch arguments. VoiceOver is not turned on: the audit and the
  label order are evidence to review, not a VoiceOver pass.

## What the probe measures

The probe samples every display frame with a `CADisplayLink`. It writes
`<run>-frames.csv` (one row per frame) and `<run>-windows.json`, and serves
summaries to the tests through two accessibility elements whose contents
are refreshed only at rest. An **action window** opens on a touch, on list
motion, on a chat apply or when the dock moves. It closes after half a
second with none of those, or after 20 seconds. A finger that lands during
an apply-only window (a stream, an opening) starts a new window.

Window fields:

- `gapP50/P95/P99/MaxMs`, `missedFrames` and `hitches` are gaps between
  display-link callbacks, which run on the main thread. A gap means the
  main thread missed a frame. It doesn't prove the render server missed one,
  because UltraList momentum runs in the render server. `callbackDelay` and
  `pastTargetFrames` measure scheduling lateness.
- `turnMaxMs` and `turnsOverFrame` come from the main thread's run-loop turns
  (`MainThreadMonitor`).
- `applyMaxMs` is the longest time a single chat apply (`ApplyPerf`: list,
  session, snapshot) held the main thread synchronously. `applyTotalMs` is
  the sum of all measured chat applies in the window, not the main thread's
  total busy time. UltraList's asynchronous preparation and drawing don't
  appear here. They appear as not-ready rows.
- `notReadyFrames`, `notReadyRunMax` and `notReadyMax` count rows that were
  mounted and on screen but whose bitmap wasn't drawn yet. This means "not
  drawn yet", not necessarily blank pixels. `uncoveredMax` includes the
  insets and the empty space of a short chat. Use screenshots and video to
  judge blank pixels. A row counts only from the first frame after its
  layer's first commit (`uncommitted` in the frames): before that the
  render server doesn't have it, and its model frame can be mid-change.
  Each not-ready row on screen is logged to `<run>-notready.jsonl` with its
  visible rect and the NodeRow hosts it holds.
- `restDriftMax` is how far the rows moved together while nothing should
  have moved them. `awayApplyDriftMax` is the same during an apply more than
  220 points from the newest message. `touchRowDriftMax` is how far the last
  tapped row moved. Legitimate animations also show up in these numbers, so
  read each value against what its action should do. The tests check only
  the one that matches each step.
- `memoryMaxMB` is the process footprint, sampled every half second.

Openings from Home (`opens` in the state) are measured from the lifted
finger:

- `mountMs`: the first frame with the list mounted.
- `visibleMs`: the first frame where the list's layer has been committed
  (it has a presentation layer) and is on screen as presented.
- `readyMs`: the first frame with every row on screen drawn.
- `settledMs`: the first frame with no navigation transition running and
  the presented position equal to the model's.

`mountMs`, `visibleMs`, `readyMs` and `settledMs` are target times of
display frames, accurate to one frame. None of them is the start of the
push animation.

Openings also record counts and maxima over the opening:
`notReadyVisibleFrames`, `missedFrames`, `turnMaxMs` and `applyMaxMs`. When
the opening closes, they also copy the opened ChatViewController's own
timings in ms:

- `constructionMs`: building it before the push.
- `loadingMs`: its view load.
- `openingLayoutMs`: its layouts while opening.
- `constructionStageMs`: each deferred construction step, one per frame
  after the first.

These are synchronous durations the chat already measures, not frame
times. Any of them can be partial when the opening closes early or times
out.
`handlerMs` is when the window finished delivering the lifted finger, and
`pushStartedInDelivery` records whether a navigation transition coordinator
existed by then. Home's rows select through a tap recognizer that waits
for the long press to fail, so selection and the push can run after
delivery ends: false doesn't mean the push started late, and neither value
is a latency.

The first visual response to a lift on Home is `firstVisuals` in the state.
It is tracked only when Home is on screen at the release, visible (not
hidden, and with an opacity above 0.01 counting its ancestors) and with no
chat shown over it, so tab and chat touches don't count. Each display-link
sample reads presentation layers only (the window's, Home's, and a new
ChatViewController's view if it is loaded; it never loads one). It has no
fallback to the model layer. The first response is the first sample where
one of these holds:

- `kind` shell: that chat's view and every view above it are committed,
  it intersects the window by at least 1 pt in width and in height, and it
  isn't hidden or transparent there.
- `kind` home: Home, still visible, is presented 0.5 pt or more from where
  it was at the release.

Times are ms from the release, all from that sample:

- `callbackMs`, `timestampMs`, `targetMs`: the display-link callback, its
  timestamp, and its target timestamp.
- `lowerMs`: the callback of the last earlier sample that read the window
  and Home as presented and saw no change (a chat not yet committed counts
  as not shown). The change happened after it.

The new chat is observed on its own, whether or not Home can still be read
(Home leaves the window once the push ends). A sample where the chat is
shown is a response even when Home can't be read. A sample that can't read
the window as presented, or that shows no change but can't read Home, is
unknown and counts in `unknownSamples`. It doesn't move `lowerMs`.

`targetMs` is the frame the change is bound for. It is not proof of when
the photons appeared, and the change can lie anywhere after `lowerMs`.
`shellCommittedMs` is the first frame with the new chat's view committed.
`samples` lists up to the first twelve seen frames as target ms, committed,
the chat's visible fraction, Home's horizontal shift, and whether Home could
be read (the shift is 0 when it couldn't). `chat` is true as
soon as a new chat's view commits, and stays false when none does within
two seconds. A result is complete after a chat commit, the first response
and twelve samples, or else at two seconds. Only the optimized timing pass
is evidence for these numbers.

On an iPhone 12 the display runs at 60 Hz, so no number here says anything
about 120 Hz devices. No run proves that frames are never lost. A run
reports what it measured in the windows it recorded.

## The TEST account, read only

`testR1RealAccountReadOnly` signs in to the shared TEST account and opens
its chats on UltraList through the real Home, in Home's order, up to five,
until one draws its messages. It flings that chat, opens Details and
returns. Never use any other account.

The account also holds synthetic and empty chats. The probe reports what a
chat shows instead of rows (`placeholder`) and where Home's chat rows are
(`homeChats`), without their text. A chat is passed over, its reading not
covered, only when it settles on "No messages yet" (`empty:noMessages`),
Load more after five empty pages (`empty:loadMore`), deleted, or pending.
Everything else fails at once and is not skipped: a failed read
(`loadFailed`, `empty:error`), a chat still loading or blank after 30 s,
rows that never draw, or a chat that never opens. The failure is attached
with the requests the transport refused, to tell this harness's limits
from the product's. If none of the five has messages, message reading is
NOT COVERED, and Details is still opened from the last chat tried.

- **Transport.** The harness (`Harness/ChatUltraQAReal.swift`) runs on an
  in-memory store with no socket. Its transport allows only GET and HEAD
  requests, `POST /v1/auth`, and the avatar and attachment download grants.
  It refuses every other request and counts the refusals, which the test
  attaches.
- **Secret.** Stage the recovery secret as a one-use file named
  `Documents/qa-real-secret` in the harness container. Pass it on stdin to a
  private temporary file, copy that file with `devicectl ... copy to`, and
  delete it. The harness reads the file and deletes it before signing in.
  Never put the secret in launch arguments, environment variables, logs or
  the `.xctestrun`. Afterwards, check the container's `Documents` to confirm
  the file is gone.
- **No pixels.** Run with `TEST_RUNNER_QA_REAL=1` in a timing pass that sets
  `SystemAttachmentLifetime = deleteAlways`. The test attaches only counts
  and timings, and the probe runs redacted, so it publishes no controls
  report. Delete any image or video found in the export, together with the
  result bundle. Report counts and geometry only.
