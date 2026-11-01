# Telegram's chat list vs ours

What makes Telegram's chat scroll, open and animate the way it does. How our
conversation measures against it on a big real chat. What we should change.

Telegram source: Telegram Android, commit `3de37c8cfb039452be7398909461da6288babf15`
(the same pin as `ui/NavMotion.kt` and [telegram-glass.md](telegram-glass.md)). All
paths are under `TMessagesProj/src/main/java/org/telegram/`. Ours were measured on
2026-10-31 from main at 7f6a279ea, plus this change's benchmark.

## Short version

- **Steady scrolling is already fine.** We scroll the heaviest real chat
  (702 rows, 292k characters of answers):
  - On the Galaxy Z Fold7 at 120 Hz, 3.1% of frames miss their deadline and
    0.7% miss it twice over.
  - On the emulator at 60 Hz, 1.7% miss and 0.1% miss twice over.

  Telegram's structure would not change this much.
- **What is slow is everything around scrolling.** All on the Fold:

  | | cost |
  |---|---|
  | opening the chat | 98 ms of main thread, first frame 82 ms |
  | each streamed update of an answer | **21 ms** of main thread, at 20 updates a second |
  | keyboard open/close | 29% of frames missed |
  | glass header and dock while scrolling | about 4–5 ms of every frame |

  Telegram avoids each of these with a technique, not with RecyclerView:
  - Layouts are computed off the main thread, so a cell only draws.
  - Updates go to the one cell that changed.
  - The keyboard moves the list as a translation, with one layout at the end.
  - Only the glass rects are blurred.
- **Recommendation: (c), the hybrid inside Compose.** Keep the LazyColumn
  and the glass. Fix the streaming recomposition, the IME relayout and the
  shimmer. Then draw text rows as one Canvas each, from StaticLayouts built on
  the row builder's background lane.
  - The prototype of that row costs 20–22 ms to open where today's costs
    37–50 ms (200 answers, Fold), and scrolls with the same or a shorter tail.
  - A RecyclerView of View cells (b) opens a little faster again, 15 ms.
    But on the Fold it binds fresh rows more slowly, streams more slowly, and
    would mean rewriting every row type, selection, accessibility and about
    240 test assertions.
  - Plan: about 4–5 weeks in four phases, see [Plan](#plan). Phase 1 alone
    (about a week) removes most of what users feel.

## How Telegram does it

### The list

| What | Where | What it does |
|---|---|---|
| `ChatListRecyclerView` | `ui/ChatActivity.java:4675`, class at `:47682` | a `RecyclerListView` (`ui/Components/RecyclerListView.java:99`). Nested scrolling off, `clipToPadding(false)`, instant click, no highlight (`ChatActivity.java:6471-6481`) |
| `GridLayoutManagerFixed` | `ChatActivity.java:6555`, `androidx/recyclerview/widget/GridLayoutManagerFixed.java` | 1,000 spans, so grouped media lay out as a grid in one list. `reverseLayout = !reversed`, so the newest message sits at the bottom |
| Pools | — | ChatActivity sets no cache size and no pool sizes, so it gets RecyclerView's defaults (2 cached views, 5 pooled per view type) and GapWorker's prefetch at the display's rate. What makes binding cheap is not pool tuning. It is that binding costs almost nothing (below) |
| Paging | `ChatActivity.java:13901-13945` | asks for 50 more messages when the oldest loaded one is within 25 rows of the screen while scrolling, or within 5 otherwise. The first load is 25 messages on a high-end device and 15 otherwise (`initialMessagesSize`, `:3134-3137`) |

### The cell

`ui/Cells/ChatMessageCell.java` (29,615 lines) is one childless View
(`BaseCell extends ViewGroup`, `ui/Cells/BaseCell.java:27`) that draws everything
itself: bubble, text, media, buttons, reactions and time. It holds:

- **Precomputed text.** `MessageObject.generateLayout` (`messenger/MessageObject.java:8701`)
  builds the text as `TextLayoutBlock`s (`:971`). These are StaticLayouts of 10 lines each
  (`LINES_PER_BLOCK = 10`, or 5 with many animated emoji, `:1821-1822`), so a long
  message draws only the blocks on screen.
- **Built before the UI thread sees it.** `MessagesController.processLoadedMessages`
  (`messenger/MessagesController.java:11919`) creates each `MessageObject` with
  `generateLayout = true` (`:12093`) on the storage or network thread. Only then
  does it post to the UI thread (`:12176`). Binding a cell is setting a field.
- **Rich messages, which are what agent answers are.** `messenger/RichMessageLayout.java`
  (10,131 lines, built from `generateLayout` at `MessageObject.java:8706`) lays out
  a whole document into one cell: headings, lists, quotes, code (`RichPreformattedBlock`,
  `:5885`, with its own horizontal scroll), tables (`RichTableBlock`, `:4166`, with an
  `OverScroller` at `:4505`), math, a "thinking" block (`RichThinkingBlock`, `:6462`,
  shimmering on a 2 s gradient sweep) and media. A rebuilt message reuses its old
  blocks (`findPrevBlock`, `:419`). An over-long part is cut off at 900 dp
  (`PART_MAX_HEIGHT_DP`, `:152`, `:1262`).
- **No layout passes it doesn't need.** `requestLayout()` returns early while the cell
  is in its own `onMeasure` (`ChatMessageCell.java:13690`). `onMeasure` (`:13698`)
  relays out only when `MessageObject.checkLayout()` says the width changed. It
  reports the precomputed `totalHeight` (`:13717`). Text is drawn by `drawMessageText`
  (`:16789`).
- **Images.** These are `ImageReceiver`s, not Views (`:1948`). `messenger/ImageLoader.java`
  decodes on its own queues: `cacheOutQueue`, `imageLoadQueue` and `thumbGeneratingQueue`
  (`:129-132`). The memory cache is `min(30 or 15, memoryClass / 7)` MB (`:2076-2082`).
  An image fades in over 150 ms (`ImageReceiver.DEFAULT_CROSSFADE_DURATION`,
  `messenger/ImageReceiver.java:226`).
- **Emoji.** These are sprite pages loaded on `globalQueue` (`messenger/Emoji.java:119`)
  and drawn as `EmojiSpan`s (`:732`).
- **Accessibility.** A virtual node tree (`MessageAccessibilityNodeProvider`,
  `ChatMessageCell.java:27052`): links and buttons are virtual children.
- **Selection.** `ui/Cells/TextSelectionHelper.java:73` is Telegram's own, across
  cells, with a `Magnifier` (`:120`). It is not the platform's.

### Frame rate and glass

- **120 Hz.** `AndroidUtilities.setPreferredMaxRefreshRate` (`messenger/AndroidUtilities.java:2815`)
  sets the window's `preferredRefreshRate` to the screen's maximum. It is called from
  `LaunchActivity.java:7247`.
- **Glass.** `RecyclerListView` implements `IBlur3Capture` (`:99`). `capture` (`:3138`)
  redraws only the children that intersect a glass rect into the blur's RenderNode
  (`captureChildren`, `:3169`). The rest is in [telegram-glass.md](telegram-glass.md).

### Motion

All of Telegram's list motion shares one duration and one curve:
`ChatListItemAnimator.DEFAULT_DURATION = 250` ms and `DEFAULT_INTERPOLATOR =
cubic-bezier(0.199, 0.011, 0.279, 0.910)` (`ui/recyclerview/ChatListItemAnimator.java:46-47`).
Other curves in `ui/Components/CubicBezierInterpolator.java:11-15` are DEFAULT (.25, .1, .25, 1),
EASE_OUT (0, 0, .58, 1), EASE_OUT_QUINT (.23, 1, .32, 1), EASE_IN (.42, 0, 1, 1) and
EASE_BOTH (.42, 0, .58, 1).

| Motion | Where | Numbers |
|---|---|---|
| Insert | `ChatListItemAnimator.java:1395-1515` | alpha 0→1 and scale 0.9→1 over 250 ms. Rows start in a stagger: `(1 − bottom / listHeight) × 100` ms (`:1421`), so the bottom row goes first. The newest arriving at the bottom runs the "enter from bottom" translation instead (`runMessageEnterTransition`, `:252`) |
| Remove | `:1555-1570` | alpha to 0 over the remove duration. Rows above it move over 250 ms |
| Move / change | `:1630-1636` | 250 ms. Change animations are off, so an in-place update just redraws (`setSupportsChangeAnimations(false)`, `:75`) |
| Invalidate while animating | `:113-121` | a ValueAnimator for remove + move ticks `onListItemAnimatorTick`, so decorations follow the rows |
| Sent message flies out of the composer | `ui/TextMessageEnterTransition.java`, hooked by `ChatActivityEnterView.canShowMessageTransition` (`:8813`) and `startMessageTransition` (`:8804`) from `ChatActivity.java:38296`, drawn in `ui/MessageEnterTransitionContainer.java` above the list | only for one text block of 10 lines or fewer (`:129`). 250 ms linear, eased by the default curve (`:389-390`, `:471`). Text scales from the field's size to the bubble's (`:211`). The field's text fades back in. Alpha reaches 1 at 40% (`:472`). It crossfades through a bitmap when the colours differ or the line breaks change (`:255-277`) |
| Floating date | `ChatActivity.java:7099` (a `ChatActionCell` over the list), show `:13704`, hide `:13732` | fades in over 150 ms while scrolling. Fades out 150 ms after a 500 ms delay, 1,000 ms in some states (`:626`, `:13728`). The next day's header pushes it up (`:16581-16597`) |
| Scroll-to-bottom button | `ChatActivity.java:6825-6975`, `ui/Components/chat/layouts/ChatActivitySideControlsButtonsLayout.java:176-219` | shows after 100 dp of scrolling away (`scrollValue = dp(100)`) and hides after 100 dp back. 280 ms, decelerate. Alpha with scale 0.7→1 and 80 dp of slide. 56 dp button, 10 dp gap |
| Streaming bot answer | `ui/MultiLayoutTypingAnimator.java:40-46`, `:379`, `:456` | text is revealed at a caret moving at `max(40 dp/s, remaining / 1.05 s)`. A new block fades in over 0.2 s. The line being typed fades out over its last 50 dp |
| Streaming height | `ui/Components/chat/ChatActivityDraftMessageMeasureController.java` (`getOverrideMeasureHeight`), set from `ChatActivity.java:24817-24820`, `:25618` | the bot's draft is measured at least `viewport − previous message` tall, so it grows into space reserved for it rather than pushing the list on every token |
| Keyboard | `ui/ActionBar/AdjustPanLayoutHelper.java:42-43`, `:89`, `:413` | 250 ms, same curve. On API 30+ it follows the IME through `WindowInsetsAnimation.Callback` (`:413-438`). Otherwise an `OnPreDrawListener` animates a translation between the old and new heights (`:89-150`). Either way the list moves by translation, and its layout changes once |
| Swipe to reply | `ChatActivity.java:5060-5091` | starts at 0.4 cm left with \|dx\| / 3 > dy, while the list is idle. Limited to 80 dp. Haptic tick at 50 dp |

## Ours

| What | Where |
|---|---|
| The list | `ui/conversation/ConversationScreen.kt:443` `Transcript`: a `LazyColumn` with `reverseLayout`, `items(state.rows, key = ConversationRow::key, contentType = { it::class })`, older history asked for when the last visible row is within a screen of the oldest |
| Rows | `ConversationRowView` (`ui/conversation/ConversationRowViews.kt`): Compose per row type. Text rows are `AgentMessage` (`ui/chat/MessageView.kt:368`): `SelectionContainer { MarkdownView }` plus a copy button |
| Markdown | `ui/chat/MarkdownView.kt:138`: one `Text` per block. `SpansText` (`:205`) with `webLinkGestures`. Code is a `horizontalScroll` Box with `HighlightCache` (`:263`, `:330`). Tables use `IntrinsicSize.Min` (`:404`) |
| Row building | `conversation/Conversation.kt:133`: rows are derived on `Dispatchers.Default.limitedParallelism(1)`. `ConversationRowBuilder` (`conversation/ConversationRows.kt:98`) caches rows and parses markdown there. Text is measured on the main thread, in composition |
| Images | `RemoteImage` (Coil 3: memory 20%, disk 128 MB, crossfade, `ui/components/RemoteImage.kt:64-66`). Inline pictures are base64-decoded and sized on the main thread in `remember` (`ConversationRowViews.kt:247-265`) |
| Glass | the list records itself into a GraphicsLayer (`glassSource`, `ui/components/Glass.kt:237`). The header (`GlassBarLayout`, a SubcomposeLayout, `ui/components/GlassBar.kt:88`) and the dock's band (`glassFade`, `Glass.kt:267`) redraw it blurred every frame |
| Keyboard | the dock has `imePadding()` (`ConversationScreen.kt:399`), so the list's bottom padding changes on every frame of the IME animation |
| Legacy | `ui/chat/ChatList.kt:286`: the relay-mode list, also a reversed LazyColumn |

## Measurements

### The chats

**Real.** The heaviest conversation on Steve's agent connection is
jmvvzabn40n2j5ktdy8fizw3, "Build and Install Happy-Android to Galaxy". By blocks the next
heaviest are y8qb5t457reitvz42bqkmrpo (584 blocks, 341 tools), harjqwp9 (554) and
v97i8ygt (484). I recorded jmvvzabn40n2j5ktdy8fizw3 from the daemon's REST API, the
same wire the app reads (`GET /v0/agents/:id/messages`, all pages):

| | |
|---|---|
| runs | 104 |
| messages | 431: 42 user, 373 agent, 16 service |
| tool calls | 366: Bash 107, set_status 56, send_agent_message 55, Edit 45, create_subtask 35, archive_subtask 32, Read 31, … |
| text | 204 blocks, 292,114 characters (median 1,133, p90 3,956, max 6,226) |
| other blocks | 131 reasoning, 30 media presentations, 46 file diffs, 107 exec outputs |
| rows on screen | 702: Tool 336, Reasoning 131, Text 82, Collaborator 67, User 42, Media 30, Failure 13, Notice 1 |

The recording is private and stays out of git. The committed copy,
`app/src/androidTest/assets/heavy-chat.json.gz` (567 KB), comes from
`tools/bench/scramble-chat.py`:
- Every letter and digit is replaced at random, keeping case, punctuation,
  whitespace and markdown, so lengths, line breaks and block structure are the
  same.
- Ids are remapped consistently.
- Thumbhashes are dropped.
- Only enum-like keys (type, role, status, kind, mimeType, reason, model,
  effort, …) keep their values.

It renders to the same 702 rows.

**Stress.** `HeavyChat.stress()` (400 turns, seeded):

| | |
|---|---|
| messages | 1,657 |
| tool calls | 1,430 |
| text | 1.51 M characters of markdown with headers, lists, code and tables |
| other blocks | 441 reasoning, 27 inline pictures, 20 media |
| rows | 3,057 |

### Devices and method

| | |
|---|---|
| **Fold** | Galaxy Z Fold7 (SM-F966U1), inner screen 1968 × 2184, **120 Hz**. Dark mode. Ran the scrambled recording (`-e chat recorded`) |
| **Emulator** | Pixel 7 AVD, API 35, **60 Hz**, 4 cores, host GPU, on a Mac whose load was 20–50 during the runs. Ran the private recording (`-e chat real`) |
| **Build** | the debug variant with `-Phappy.debuggable=false` (so ART compiles it, `cmd package compile -m speed -f`), installed as `com.slopus.happy.chatbench` beside the signed-in dev app. A debuggable build runs two to three times slower and is not what ships |

**Frame metrics.** `FrameRecorder` reads FrameMetrics, the source JankStats uses:
- *total* runs from the intended vsync to the frame's completion.
- *ui* is the main thread's input, animation, layout and draw.
- *missed* counts frames past FrameMetrics' own deadline, which gfxinfo's
  "Janky frames" counts too. *janky (2×)* counts frames past twice the deadline.
- At 120 Hz a total above 8.3 ms is latency, not a dropped frame. The deadline
  the system gives a pipelined frame is longer.

**CPU.** Main-thread CPU time (`Debug.threadCpuTimeNanos`) is the figure that
holds still on a loaded host.

### The conversation screen, real chat

| | Fold, 120 Hz | Emulator, 60 Hz |
|---|---|---|
| **open**, first frame (5 opens) | total p50 81.8, ui p50 67.9 ms. **Main CPU 98 ms** (87–106) | total p50 44.8, ui p50 31.0 ms. Main CPU 36 ms |
| **scroll**, 8 + 8 long flings, top to bottom and back | 2,919 frames. Total p50 / p90 / p99 = **10.4 / 13.8 / 22.3**, max 70.0 ms. ui p99 7.2 ms. **Missed 3.1%, janky 0.7%**. Main 2.52 ms a frame | 1,802 frames. 17.5 / 23.7 / 41.4, max 84.8 ms. ui p99 3.0 ms. Missed 1.7%, janky 0.1%. Main 0.88 ms a frame |
| **stream**, an answer growing at 20 updates a second | total p50 / p90 / p99 = 9.2 / 25.7 / 32.2 ms. Missed 3.1%. **Main 21.2 ms an update** | 20.9 / 25.4 / 32.2 ms. Missed 0.3%. Main 5.3 ms an update |
| **older**, a page arriving under a reader at the oldest row | missed 1 of 3 and 1 of 1 frames. The rows on screen moved 0 px | missed 1 of 3 and 1 of 13 frames. The rows moved 0 px, then 95 px |
| **IME**, open and close × 4 | 203 frames. 18.8 / 25.7 / 28.9 ms. **Missed 29.1%, janky 3.9%**. ui p90 9.5 ms, main 5.65 ms a frame | 188 frames. 17.2 / 18.5 / 21.7 ms. Missed 13.3%, janky 0 |
| **legacy ChatList** scroll, same messages | 3,120 frames. 4.7 / 6.5 / 14.4 ms. Missed 1.4%, janky 0.3% | 1,724 frames. 17.4 / 23.4 / 43.9 ms. Missed 2.5% |

### The conversation screen, stress chat (3,057 rows)

| | Fold | Emulator |
|---|---|---|
| open, main CPU | 101 ms (first frame total 79.9, ui 67.8) | 66 ms (ui 58.3) |
| scroll | 3,009 frames. 9.9 / 12.4 / 19.7 ms. Missed 3.1%, janky 0.6% | 1,276 frames. 23.7 / 46.8 / 93.0 ms. Missed 7.2%, janky 0.5% |
| stream | main 21.3 ms an update. Missed 2.8% | main 5.3 ms an update |
| older | the rows moved 0..1 px, then 0..6 px | moved 0..186 px, then −4,879..130 px |
| IME | missed 24.3%, janky 3.9% | missed 12.8%, janky 0.5% |
| legacy scroll | 5.3 / 7.6 / 15.3 ms. Missed 1.6% | 17.5 / 26.1 / 74.2 ms. Missed 3.1% |

Notes:
- **Length doesn't matter.** Four times the rows costs the same per frame:
  LazyColumn only ever holds what is on screen. Open costs 98 ms against 101 ms
  on the Fold.
- **The glass is the scroll cost on the Fold.** The legacy list (no glass)
  scrolls at a total p50 of 4.7 ms. The conversation (glass header and dock)
  scrolls at 10.4 ms. The main thread is the same in both (2.5–2.7 ms a frame),
  so the difference is RenderThread and GPU: re-blurring every frame. The
  prototype shows it in isolation: the canvas list goes from 4.8 to 8.5 ms p50
  when a glass bar is put over it.
- **Streaming recomposes the whole screen.** On the emulator a profile of the
  stream case put about 42% of main-thread time in recomposition and 34% in draw.
  ConversationScreen takes one `ConversationState`, and every update is a new one,
  so the title, the status, the composer and the dock all recompose with the row.
  The shimmer on the title and the status while the agent works took 9.9%
  (`Shimmer.kt:156`). The answer row alone, outside the screen, costs 7.0 ms an
  update on the Fold. The screen costs 21.2.
- **Opening is composition.** On the emulator a profile of the open case had about
  33% in measure under `GlassBarLayout`. Being a SubcomposeLayout, it composes the
  whole list inside its measure pass, so that is the rows' first composition and
  their text measurement. About 20% more was composition outside it.
- **IME relayouts every frame.** `imePadding()` on the dock changes the list's
  content padding on every frame of the inset animation, so the LazyColumn
  remeasures its visible rows each time. That costs 5.65 ms of main thread a frame
  on the Fold against 2.5 when scrolling, and the frame then waits on the glass.
- **Older history mostly keeps its place.** The Fold never moved more than 6 px. The
  emulator's large moves happened with a loaded host, where the fling that asked for
  the page was probably still settling when the page arrived. The case stays in the
  benchmark. Nothing is scheduled for it until it shows up on a device.

### Agent home

`ScrollFlingTest#agent_home`, emulator: 1,001 frames, total p50 / p90 / p99 = 17 / 21 / 32 ms,
janky 0.40%. It is not a problem. Home and settings mount cost is
cfiid8amh1cros9wb8wxtk3g's work.

## The prototype

`app/src/androidTest/kotlin/com/slopus/happy/bench/CanvasMessage.kt` is a
Telegram-style text row. `CanvasMessageBuilder` lays out an answer's markdown off the
main thread into a list of StaticLayout and rounded-rect draw ops, to AgentMessage's
spec:
- text 16/25 sp, headers, lists 6 dp apart with 16 dp indent
- code blocks: surfaceHighest, radius 8, mono 14/20, not wrapping, clipped, with
  the language label and the Copy button
- rules, and tables with measured columns and hairlines
- the copy row

It is drawn two ways:
- `CanvasMessage`: a Compose item that is one node, a fixed-height `layout {}` with
  `drawBehind` running the ops.
- `CanvasMessageView`: a childless View that measures to the precomputed height
  and draws the ops in `onDraw`, in a RecyclerView inside `AndroidView`. This is
  Telegram's structure.

The comparison takes the chat's first 200 answers each way, against today's
`AgentMessage` in a LazyColumn.

**Fold (real chat's answers):**

| | today's AgentMessage | Compose canvas item | RecyclerView canvas cell |
|---|---|---|---|
| layout off the main thread | — | 1.54 ms an answer | 1.58 ms |
| open, main CPU median | 37 ms | **22 ms** | 15 ms |
| open, first frame ui p50 | 36.3 ms | 19.9 ms | 12.7 ms |
| scroll, total p50 / p90 / p99 | 4.4 / 5.5 / 10.0 ms | 4.8 / 5.6 / 9.5 ms | 16.4 / 16.5 / 17.0 ms |
| scroll, missed / janky | 1.4% / 0.1% | 1.3% / 0.0% | 2.3% / 0.0% |
| scroll, main a frame | 2.47 ms | 2.37 ms | 1.32 ms |
| fresh rows (60 one-page jumps), total p90 / janky | 38.0 ms / 53% | **18.6 ms / 13%** | 20.3 ms / 30% |
| fresh rows, main ui a jump | 1.45 ms | 5.14 ms | 11.08 ms |
| stream, main a update | 7.01 ms | **5.50 ms** | 10.11 ms |
| under a glass bar: does the glass show the list? | — | yes (94% of the band changes with a 300 px scroll) | yes (94%) |
| under a glass bar: scroll total p50 / p99, missed | — | 8.5 / 14.6 ms, 3.2% | 19.5 / 20.0 ms, 1.5% |

**Fold (stress answers):** open main 50 / 20 / 16 ms. Stream 6.78 / 5.45 / 9.15 ms an
update. Fresh rows total p90 37.2 / 13.2 / 12.3 ms, janky 58% / 5% / 0%.

**Emulator (real chat's answers):**

| | AgentMessage | Compose canvas | RecyclerView canvas |
|---|---|---|---|
| open, main CPU | 27 ms | 7 ms | 6 ms |
| scroll, p50 / p90 / p99 | 19.3 / 38.7 / 79.1 | 17.4 / 21.2 / 25.9 | 17.3 / 19.4 / 22.1 |
| scroll, missed | 4.1% | 1.4% | 1.5% |
| stream, a update | 1.46 ms | 1.53 ms | 2.20 ms |

Off-thread layout costs 0.46 ms an answer on the emulator.

What it says:
- **Precomputed layouts are the win, not the RecyclerView.**
  - The Compose canvas item halves the cost of mounting rows: open 37 → 22 ms,
    and fresh rows' p90 38 → 19 ms with janky frames 53% → 13% on the Fold.
  - It flattens the emulator's scroll tail: p99 79 → 26 ms.
  - The RecyclerView cell opens a few ms faster again and uses less main thread
    while scrolling.
- **On the Fold the RecyclerView cell has costs a View cell inside Compose brings.**
  - Fresh rows cost 11 ms of main thread a jump: AndroidView relayouts and View
    measure.
  - Streaming costs more: `notifyItemChanged` rebinds and relayouts through the
    AndroidView.
  - Every frame finishes about two vsyncs after it was due: a total of 16.4 ms,
    while SurfaceFlinger stayed at 120 Hz through the flings. These are not missed frames
    (2.3%), but it is latency Compose's own list doesn't have.
- **The glass works with both.** `glassSource` records the AndroidView's drawing
  like any other content.
- **Today's text row is not slow once mounted.** Its steady scroll on the Fold is as
  good as the canvas item's. What it costs is composing and measuring
  `Text`s when rows appear, and that is what the canvas item removes.

## The options

### (a) Compose, plus Telegram's techniques

Keep everything; fix where the time goes:
- **Stop whole-screen recomposition on stream.** Hand the transcript its rows on
  their own (a `State` read only inside `Transcript`), and give the title,
  status and composer only the fields they show.
- **Draw-only shimmer.**
- **Keyboard as a translation.** Move the list with the IME animation (a
  `graphicsLayer` translation driven by the inset animation, as AdjustPanLayoutHelper
  does) and change its padding once at the end.
- **Inline pictures decoded off the main thread.**
- **Cheaper glass.** Look at what the glass costs on the GPU first.
- **Telegram's motion** on `animateItem`.

| | |
|---|---|
| Gains | most of what users feel: streaming (21 → ~7 ms an update, the isolated row's cost), the keyboard (29% missed → near the scroll's 3%), and the glass's share of every frame |
| Doesn't fix | the open, where 98 ms goes to composing and measuring Text |
| Cost | about a week, plus the motion |
| Risk | low. Nothing about rows, selection, accessibility or tests changes |

### (b) RecyclerView with View cells, in AndroidView

| | |
|---|---|
| Gains | the cheapest open (15 ms for 200 answers on the Fold) and the least main thread while scrolling (1.3 ms a frame) |
| Costs | rewrite every row type as a View: text, reasoning, user and collaborator bubbles, tool cards with their states, file diffs, exec output, media tiles, failures, notices, Mermaid. Plus our own text selection (Telegram has a 4,096-line `TextSelectionHelper`), link handling, an `AccessibilityNodeProvider` per cell, the shimmer and theme colours in Views, and the jump button and older pager over RecyclerView |
| Tests | the chat's Robolectric tests address it through Compose semantics (about 240 `onNodeWithText` / `onNodeWithTag` uses in 23 files). Those would move to Espresso or to custom matchers |
| Fold numbers | it is worse at fresh rows (11 ms a jump) and at streaming (10 ms an update), with two vsyncs of added latency |
| Effort | 5–7 weeks |
| Risk | high: accessibility and selection regressions, two UI toolkits in one screen |

### (c) Hybrid: Compose list, precomputed rows

(a), plus text rows (Text, Reasoning, User, Collaborator) drawn the prototype's way:
- **Layout.** `ConversationRowBuilder` already runs on a background lane and
  parses markdown there. It would also build the row's StaticLayouts at the
  list's width, font scale and theme. They are cached per row key, as
  `MessageObject` holds its `TextLayoutBlock`s, and rebuilt in the lane when
  the width or theme changes.
- **Drawing.** The row is one Compose node with a fixed height and a draw.
- **Splitting.** Long answers can split into 10-line blocks like Telegram's,
  so only visible blocks draw.
- **Streaming.** The streaming row rebuilds only its last block in the lane.

The details:

| | |
|---|---|
| **Markdown and code** | paragraphs, headings, lists, rules and tables are draw ops. A code block wider than the row needs its own horizontal scroll: either the row keeps a small scroll offset per block and a horizontal drag handler (Telegram's `RichPreformattedBlock`), or code blocks stay Compose children of the row (a `Layout` with the canvas around them). Start with the second, because it keeps `HighlightCache` and the Copy button as they are. Mermaid stays Compose |
| **Tool cards** | stay Compose. They are short, fixed-size and already cheap. The 336 tool rows are not where the time goes |
| **Links** | tap → `layout.getOffsetForHorizontal` on the hit line → the URL span. The same `webLinkGestures` behaviour, on a StaticLayout |
| **Selection and copy** | today's `SelectionContainer` selects across a message's blocks. A drawn row can't join it. Telegram writes its own. The cheaper way: long-press puts that one row into a selecting state, where it composes today's `SelectionContainer { MarkdownView }` in place (same height, same text). The row's Copy button stays. Steady state is the canvas, and selection is exactly today's |
| **Accessibility** | the row sets `semantics { text = …; customActions = links }` from the same parsed text. TalkBack reads it as today, and `onNodeWithText` finds it, so the Robolectric tests keep working |
| **Shimmer** | the reasoning row's and the header's shimmer move into draw-only animation: a shader offset changed in `drawWithContent`, with no state read in composition. Telegram's thinking block sweeps a gradient every 2 s the same way (`RichMessageLayout.java:6480-6535`) |
| **Glass** | unchanged: the list still records itself into the `glassSource` layer. The prototype under glass shows the blur sees it |
| **Robolectric screenshot tests** | they render drawn rows like any other Compose content. Text is drawn by the same StaticLayout either way, so screenshots change only where layout details differ (line height, paragraph spacing), and those are matched to AgentMessage's spec in the builder |
| **Gains** | (a)'s, plus about half the open and fresh-row cost |
| **Cost** | about 2 weeks on top of (a) |
| **Risk** | medium and contained to the text rows. A row type can fall back to today's composable at any time |

## Recommendation

**(c).** On the device that matters, the scroll is already at 120 Hz with about 3% of
frames late. What users feel is streaming, the keyboard and opening. Two of those are
fixed without touching rows at all (a). Opening and fresh rows need precomputed
layouts, which a Compose node draws as well as a View cell does. RecyclerView (b)
would buy a few ms of open for a rewrite of everything and a worse stream.

## Plan

| Phase | What | Measured by | Effort |
|---|---|---|---|
| **1. Hot spots** | Stream: rows to `Transcript` on their own, header and composer off the update path. Target ~7 ms an update on the Fold. Shimmer draw-only. IME: translation during the inset animation, one relayout at its end. Target under 5% missed. Inline pictures: decode and size off the main thread (`produceState` on `Dispatchers.Default`) | `conversation_stream`, `conversation_ime` | 4–6 days |
| **2. Glass cost** | Perfetto on the Fold: RenderThread and GPU per frame with the header and dock. Then capture only the bands under the glass plus 48 dp (Telegram's `captureChildren` by rect), and skip the re-blur on frames where the content didn't move. Target the legacy list's p50 (5 ms) plus 1–2 ms | `conversation_scroll` against `legacy_scroll`, `proto_compose_glass` | 2–4 days |
| **3. Precomputed text rows** | Layouts built in the row lane and cached per key, width, font scale and theme. Canvas rows for Text, Reasoning, User and Collaborator, with code blocks as Compose children. Links, semantics, long-press selection swap, 10-line blocks for long answers. Target: open under 50 ms of main thread on the Fold, fresh-row janky under 15% | `conversation_open`, `proto_rows_current` (extend it to the new rows) | 8–10 days |
| **4. Motion** | Telegram's 250 ms curve on `animateItem` (insert: alpha 0→1, scale 0.9→1, up to 100 ms stagger). The composer-to-message flight for a sent message of 10 lines or fewer. The streaming reveal (caret at max(40 dp/s, remaining / 1.05 s), 50 dp fade on the typing line) with the draft's height reserved so the list doesn't move per token. The jump button's 280 ms decelerate, scale 0.7→1, 80 dp slide, shown after 100 dp | screenshot tests of the end states. Frame metrics through each animation | 5–7 days |

That is about 4–5 weeks for all four phases. After each phase, run the benchmark on the
Fold and append the numbers here.

## Phase 1 and the streaming reveal: results

Measured 2026-10-31 on the Fold (120 Hz, dark, `-e chat recorded`), the same chatbench
build method as above. "Before" is main at 857be2598, run the same day. "After" is this
change.

| | before | after |
|---|---|---|
| **stream**, 120 updates at 20 a second | main 22.4 ms an update. Total p50 / p90 / p99 = 9.2 / 26.0 / 31.8 ms. ui p90 13.1 ms. **Missed 4.8%** | main 16.3 ms an update, of which **the stream adds 3.0** (see below). Total 10.1 / 15.1 / 23.5 ms. ui p90 5.9 ms. **Missed 0.3–0.4%**, janky 0 |
| **IME**, open and close × 4 | total p50 / p99 = 14.3–19.5 / 30–35 ms. ui p50 3.0–5.5. GPU p50 8.1. Main 4.2–5.9 ms a frame. Missed 25–29%, **janky 3.9–4.4%** | total 8.0–8.4 / 13.7–15.1 ms, max 17. ui p50 2.4. GPU p50 3.2. Main 3.9–4.3 ms a frame. Missed 21–50%, **janky 0–0.5%** |
| **scroll**, 8 + 8 flings | 2,919 frames. 10.4 / 13.8 / 22.3 ms. Missed 3.1%, main 2.52 ms a frame | 3,009–3,200 frames. 10.1–10.3 / 12.9–13.1 / 19.8–21.8 ms. Missed 2.9–3.5%, main 2.58 ms a frame |

On the emulator (60 Hz, interleaved with the same base): stream 6.16 → 4.0–4.9 ms an
update, missed 0.6 → 0%; IME main 1.89 → 1.51 ms a frame; scroll unchanged.

**Stream.** An update now costs about 3 ms of main thread on the Fold, against the 7 ms
target. The stream case measures the screen first with the agent working and no words,
for 3 s: the bar's shimmering title and status and its pulsing dot cost **240 ms of main
thread a second** (2 ms a frame at 120 Hz) before anything streams. That is the rest of the
16.3 ms. It existed before too, and is the next thing to take off this screen. The
recomposition test (`ConversationStreamingTest`) streams deltas and finds the header, the
dock, the composer, the transcript and every other row composed 0 times.

**IME.** The frames are twice as fast and never twice late, but "missed" got no better. The
keyboard's animation drives frames at 60 Hz (every 16.7 ms), while FrameMetrics gives
each one the 120 Hz deadline, 8.3 ms. A frame of 8.2 ms counts as made and one of 8.4 as
missed, and the frames now sit right there, so the share flips between runs. The frame
splits into ui 2.4 + RenderThread 2.0 + GPU 3.2 ms. Of the GPU time, 2 ms is the bar's blur,
which must follow the list moving under it: `-e glass off` gives a total p50 of 5.7 ms and
14.6% missed. The rest of what still misses:
- the frame the keyboard settles in;
- isolated caret-blink frames, whose GPU takes 7–8 ms with the glass on or off (the GPU
  clocking down between blinks while the keyboard is hidden).

Getting under 3% needs every frame under about 7 ms. That means taking the bar's blur off
the frames where only the keyboard moves, which is phase 2's.

What changed:
- **Streaming redraws one row.** A delta goes to the streaming block's `LiveText`, a
  StateFlow only its row reads, instead of a new `ConversationState`. The list, the header
  and the dock see nothing. The row takes the newest words once a frame
  (`withFrameNanos`). The Markdown is parsed on the conversation's lane, keeping the blocks
  that didn't change. The run's end publishes the final words at once.
- **The reveal** (`TextReveal`, Telegram's `MultiLayoutTypingAnimator`):
  - The caret moves at max(40 dp/s, what is left / 1.05 s). The typing line fades over 50 dp
    (DST_IN), and lines after the caret aren't drawn.
  - The row is laid out a line at a time, never shorter while words come. The list is
    drawn that much lower and eases up over 250 ms on cubic-bezier(0.199, 0.011, 0.279,
    0.910), so a frame of the reveal is a mask and one layer's translation, with no layout.
  - Scrolled into the answer, the reader's words stay put. Scrolled above it, nothing
    moves.
- **The keyboard** (`KeyboardLift`, AdjustPanLayoutHelper):
  - During the inset animation the transcript and the dock are placed higher by the
    keyboard's progress, each in its own layer.
  - The keyboard's height enters the layout once, at the animation's low end. It is read
    only where things are measured and placed, so nothing composes for it.
  - The list keeps its height and moves above the keyboard, with the keyboard's room over
    its top. The rows the keyboard uncovers are already composed, which took the settle
    frame from 11–22 ms of ui to 6–10.
  - Both composers moved to `TextFieldState`. The value field rebuilt an empty paragraph on
    every frame it moved, about a fifth of the main thread.
- **Glass** records a surface's layers again only when its area of the content moves. A
  surface that moves with the content (the dock with the transcript) keeps its blur. A
  caret blinking or a button pressed over the glass no longer re-records it.
- **Shimmer** draws in its own layer, reading its phase in draw only.
- **Inline pictures** are decoded and sized on the lane as their rows are built
  (`InlinePicture`, a 24 MB LRU), and looked up on the main thread.

Recordings: `fold-stream-light.mp4` and `fold-stream-dark.mp4` (200 updates under the glass
bar), with frame strips, in the task's `.context/streaming/`.

Benchmark additions:
- `-e theme light|dark`
- `-e glass off`
- `-e updates N`
- `-e frames dump`, which writes every frame's vsync time, total, ui, wait, RenderThread,
  GPU and deadline to `files/chat-frames.txt`.
- The `parts` line under each case.

## Phase 3, precomputed text rows: results

Answers, people's messages, collaborators' messages and opened thoughts are now
laid out where the rows are built, as Telegram's `MessageObject.generateLayout` is.
The row draws what it is given and measures nothing.

- **The typesetter** (`ui/conversation/Typesetter.kt`, one per process):
  - The conversation's lane calls `prepare` with every row set it publishes. It lays
    out the newest two screens of rows then and there, and the rest on the
    typesetter's own lane (`Dispatchers.Default.limitedParallelism(1)`).
  - A streaming block's words are laid out in `LiveText.update`, before its row
    reads them. Its settled paragraphs are reused by block identity, so a delta lays
    out only the paragraph that grew.
  - It keeps 1,200 rows, keyed by row key, with the words, geometry (column, density,
    font scale, direction) and palette they were made for.
- **What a layout is** (`Prose.kt`):
  - Compose's own `TextMeasurer`, one per thread with a shared font resolver. A drawn
    row is therefore pixel for pixel MarkdownView, which the tests check.
  - Paragraphs, headers, inline code, lists, rules and the collaborator's label are
    pieces at fixed places in *segments*. Code blocks, tables, options, diagrams and
    pictures stay composables between segments.
- **Drawn ahead.** The lane also draws each segment into an `android.graphics.Picture`
  in the current theme's colours. Shaping glyphs for the display list was the main
  thread's biggest new cost (`Layout.drawText` 8% of the jumps). A row now plays its
  picture back. A row whose picture is for another theme or width draws its layouts
  itself while the lane draws it again.
- **A new width** (fold, rotation, a pane) makes every layout stale. Rows draw the old
  one scaled to the new width. The lane lays them out again, the rows on screen first,
  and the rows swap to the new layout when it is ready. Nothing is laid out on the main
  thread.
- **Unchanged behaviour:**
  - Links: a tap opens them through the proxied browser, a long press shows the menu.
  - Semantics: each segment's texts are its `Text`, and its links are custom actions,
    so `onNodeWithText` finds them.
  - Long press: it puts that one answer back in today's `SelectionContainer` with the
    word selected. Once nothing is selected the answer is drawn again.
  - Light/dark, font scale and RTL, and the streaming reveal, which masks the drawn
    layouts.
- **Checks.** `ProseThread` counts every layout built on the main thread, and throws
  under `strict` in tests. The benchmark prints the count for each case. It was 0 in
  every case.

Tests (`ProseRowsTest`, Robolectric, native graphics):
- Pixel parity with `AgentMessage` in light, dark, RTL and font scale 1.6.
- Pixel parity of the drawn-ahead playback in light and dark.
- Bubble and collaborator parity.
- Semantics and link actions; link tap, long press and off-link.
- Long-press selection and the return to drawing.
- Cache keys, invalidation and part reuse.
- A width change with strict main thread.
- A whole chat opened and scrolled to its oldest row with strict main thread.
- Streaming through the builder with strict main thread.

### Emulator (Pixel 7 AVD, API 35, 60 Hz, `-e chat recorded`, 702 rows)

The host was shared and loaded (load average 40–110), so before and after were
interleaved, 3 × 2 runs each.

| | before (main) | after |
|---|---|---|
| `proto_rows_current`, 60 jumps to fresh rows | 1.76–2.08 ms a jump (one 3.88 outlier) | **1.30–1.57 ms a jump** |
| the same, without the drawn-ahead pictures | | 2.18–2.75 ms a jump |
| `conversation_open`, main cpu median | 17 / 41 ms | 16 / 17 ms |
| `conversation_scroll` | p50 17.9 / 29.7 ms. Missed 2.3 / 8.5% | p50 17.5 / 17.1 ms. Missed 2.2 / 1.8% |
| `conversation_stream` | 3.58 / 4.55 ms an update | 3.68 / 4.17 ms an update |
| the lane | | first screens 20–29 ms cpu; all 702 rows laid out and drawn in 330–550 ms, +9 MB heap |

Main-thread profile of the jumps (simpleperf, 4 kHz, main thread only):
- Before: `TextAnnotatedStringNode.measure` 12.5%, `SelectableTextAnnotatedStringNode` 6%,
  `measureLazyList` 50%.
- After, before the pictures were added: `measureLazyList` 32%. The text measure was gone,
  but `AndroidParagraph.paint` was 8% (glyph shaping as the display list records), which
  the pictures removed.

`proto_compose_prose` (200 answers through `ConversationRowView`) is the
prototype-doc comparison: open median 6–10 ms of main thread, against
`proto_compose_current`'s 27.

### Fold (Galaxy Z Fold7, inner screen, 120 Hz, dark), 2 × interleaved

| | before (main, fe1ad56f6's base) | after |
|---|---|---|
| `conversation_open`, main cpu median | 104 / 99 ms | **96 / 83 ms** |
| `conversation_scroll` | 3,211 / 3,061 frames. p99 24.5 / 21.3 ms. Missed 3.1 / 3.2%. ui max 39 / 34 ms | 3,100 / 3,001 frames. p99 **17.1 / 18.0 ms**. Missed 2.8 / 3.0%. ui max 18 / 19 ms |
| `proto_rows_current`, fresh-row jumps | p90 29.6 / 28.2 ms. **Janky 25.7 / 23.7%**. 4.36 / 4.56 ms of main a jump | p90 19.9 / 20.7 ms. **Janky 13.1 / 16.3%**. 4.11 / 3.96 ms a jump |
| `conversation_stream`, main an update | 16.2 / 16.3 ms | 17.4 / 17.3 ms |
| prose laid out on the main thread | | 0 in every case |
| the lane | | first screens 20–30 ms cpu. All 702 rows in 520–650 ms, +9.5 MB heap |

The open is 8–16% cheaper on the Fold, not the 40% asked for. Profiling the open (the
emulator at the Fold's size) shows why:
- Today's text measure, `SelectionContainer` and `MarkdownView` (about 25% of the open's
  main thread) are gone.
- What remains is composing and measuring the rest of the screen: the glass bar's
  layout 20%, the composer 4–5%, tool rows' `Text` 2%, and the subcomposition of every
  row (`LazyColumn` 11%).

A further cut needs the tool rows drawn the same way, and the screen's chrome composed
before the transcript.

`proto_compose_prose` on the Fold: open median 28–29 ms, jumps 0.96 ms of main, scroll
missed 0.4–0.7%, stream 5.3 ms an update.

## Phase 4, motion: results

Telegram's list motion, on its curve: 250 ms, cubic-bezier(0.199, 0.011, 0.279, 0.910)
(`TranscriptMotionSpec`, `ui/conversation/TranscriptMotion.kt`).

- **Insert** (`ChatListItemAnimator`).
  - When a row arrives at the newest end and the reader is there, the rows already shown
    move up for it. The list's layer is drawn the new rows' height lower and eases to 0,
    so no row is laid out or placed again for it.
  - Each new row fades from 0 and grows from 0.9 in its own layer. Its start waits
    `(1 − bottom / listHeight) × 100` ms, so the lowest row goes first.
  - Reading older history, nothing moves. More than 8 rows at once (a sync catching up)
    just appear, and so does everything with Reduce Motion.
  - A streaming answer comes in through its reveal, which already grows it from nothing.
- **The sent message's flight** (`TextMessageEnterTransition`).
  - Applies to a text of 10 lines or fewer with nothing attached, sent at the newest end.
  - The composer hands over its words as laid out and where they were. The row hides
    until they land. Over the screen, the bubble and the words move from the field to
    the row's words over 250 ms on the curve. The bubble is opaque by 40%.
  - When the bubble breaks the lines differently from the field, the field's words
    cross-fade into the bubble's picture, which the lane drew ahead.
  - Every frame of the flight draws two pictures and a rounded rect, and shapes no
    text.
- **The jump button** (`ChatActivitySideControlsButtonsLayout`).
  - Shown more than 100 dp from the newest message, and hidden inside it.
  - It moves over 280 ms decelerating: fading, growing from 0.7, rising 80 dp.
  - With Reduce Motion it just appears.

Tests:
- `TranscriptMotionTest`: the curve's values; the row above moving up between frames
  and settling; nothing moving while reading older; the flight's start, middle and
  landed frames, with the bubble drawn in its place after; a long message not flying.
- `ConversationJumpTest`: the 100 dp threshold and the 280 ms rise.

Fold recordings of `conversation_motion -e drive on` (two sends, each answered 1.2 s
later; away from the newest and back; the jump button): `fold-motion-dark.mp4` and
`fold-motion-light.mp4`. Frames over the whole recording: p50 5.4 ms, p99 17–23 ms,
janky 0.7–0.8%. Streaming with phase 4 against main at the same commit, interleaved
twice: 17.5–18.0 vs 17.6–17.9 ms of main an update, so no change.

## Phase 2, the glass's cost: results

Measured 2026-10-31 on the Fold (120 Hz, dark, `-e chat recorded`), non-debuggable
chatbench. "Before" is main at ca1a18607/c458fa14e~1; "after" is c458fa14e plus the
RenderThread shimmer and band sharing. Runs interleaved, ranges over 2–4 runs each.

| | before | after |
|---|---|---|
| **IME**, open and close × 4 | total p50 7.8–8.2 ms, GPU p50 3.3–3.4. Missed 37–46%. With `-e glass off`: 20% | total p50 5.6–6.4 ms, GPU p50 1.3. **Missed 18–26%**, janky 0–0.5%: the same as glass off |
| **scroll**, 8 + 8 flings | total p50 / p90 / p99 = 10.4–10.6 / 12.9–13.9 / 17.7–22.1 ms. Missed 2.5–3.7% | **9.2–9.3 / 10.9–11.1 / 13.6–14.6 ms**. Missed 2.7–3.2%, janky 0.1–0.2% |
| **working, nothing streaming** (`conversation_working`, 5 s) | main 1.8 ms a frame, 120 frames a second: 210–256 ms of main a second | **main 0 ms**. The RenderThread draws the shimmer and the dot at 60 Hz, 6.3 ms total p50 |
| **stream**, 120 updates | main 16.1–17.7 ms an update, of which 127–256 ms a second the working bar | 15.4–16.0 ms an update, none of it the bar |

Legacy ChatList (no glass) scrolls at 4.6 ms p50; the conversation with `-e glass off` at
5.8. Targets missed: the keyboard is not under 3%, and scroll is 9.2 ms, not near 4.7.

**Where the glass's GPU time went: the prefilter.** A trace of an IME frame had the bar's
full-size Gaussian prefilter (sigma 4 px over a 1968 × 572 layer) as most of the glass's
GPU. It is now three bilinear halvings to the 1/8 copy (`GlassLayers.record`): every
full-size pixel reaches the small copy, so it does the prefilter's job.
- Pixels: before vs after, light and dark, the bar and feather differ by at most 2 of 255
  and the body and the dock by at most 1. The status-bar band differs where the clock and
  the icons do.
- Steadiness (`glass_steps`, research/telegram-glass.md's method, 40 steps of 1 px):
  coefficient of variation per band 0.2–0.4 before and after. Dark, mean D 0.03/0.08/0.07
  before and 0.04/0.10/0.07 after for title/foot/feather, all under 0.2 of 255.
- Capturing straight into the half copy (one layer fewer) measured the same on the Fold,
  but it doubled the steps' CV to 1.2–1.4, so the full-size capture stays.

**The keyboard doesn't re-blur.** `KeyboardLift.travel` tells the transcript's
`GlassSource` where the keyboard is, where it started and where it ends. The bar, which the
list slides under, blurs the band the whole travel passes under once, as the animation
starts, and only moves that blur each frame (`GlassTravel`, `blurOf`). The dock and the
composer ride with the list and never re-blurred. During the animation the GPU's p50 went
from 3.3 to 1.3 ms, glass off's figure.

**Bands are shared.** Glasses over one source keep their blurred bands on it
(`GlassSource.bands`). A glass whose band lies inside another's draws from that, and two
that overlap (the composer's pill over the dock's fade) blur one band round both.

**The bar is one layer.** The bar's glass (blur, tint, feather mask) is recorded into an
offscreen layer of its own. A caret, a pressed button or the shimmer over it composites
that as it is. The feather's mask no longer needs a saveLayer per frame.

**The working bar costs the main thread nothing.** Two steps:
1. c458fa14e: the shimmer and the dot draw from one clock that writes no snapshot state.
   Each tick invalidates only its nodes' draws, at most 60 times a second. Main went from
   about 2 ms a frame at 120 Hz to 1.2 ms a frame at 60 Hz (127 ms a second). Every tick
   is still a whole main-thread frame (Choreographer, Compose's frame, a traversal, draw).
2. In the conversation's bar the title's and status's sweep and the dot's pulse are now
   AnimatedVectorDrawables (`res/drawable/shimmer_sweep.xml`, `status_dot_pulse.xml`, the
   same numbers) in a View of their own (`RenderThreadMotion.kt`). The RenderThread runs
   them with no main-thread frame at all, as it runs the platform's spinner. The text is
   still laid out and recorded by Compose, and the View draws that recording with the
   band over it (SrcAtop in a layer). Lists' shimmers keep the clock: they come and go
   with scrolling. Robolectric, Reduce Motion and API < 29 take the clock's path.

`ConversationWorkingTest` runs 30 frames of a working bar and finds no state written,
nothing composed, and the bar's pixels changing.

**What still misses on the keyboard.** The glass is out of it: glass on and glass off now
miss the same share. What is left:
- The animation's frames come every 16.7 ms against FrameMetrics' 8.3 ms deadline (see
  phase 1). Their p50 is 5.6–6.4 ms, so the share flips with a millisecond either way.
  The ones that miss are ui 4–6 ms plus RenderThread 2–3 ms. The ui is
  `insets_animation` (0.3–1.5 ms, the platform dispatching insets to the View tree),
  `measureAndLayout` (0.8–1.5 ms) and `onPositionedCallbacks` (0.3–0.5 ms, the glass's
  and the composer's `onGloballyPositioned` running as everything is placed again each
  frame).
- The frame the keyboard settles in (7–12 ms of ui).
- Caret-blink frames, below.

Under 3% needs the IME frames' main thread under about 3 ms. The next steps are moving
the glass's and the composer's position reads out of `onGloballyPositioned` (positions
read in draw), and placing the riding layers without a layout pass (a translation set from
the insets callback, as AdjustPanLayoutHelper does on a View). Neither is the glass's.

**Caret-blink frames.** Isolated frames 500 ms apart with 7–8 ms of GPU, glass on or off.
A trace has them drawing only the caret: about 0.6 ms of RenderThread and a handful of
ops, at a GPU frequency of 342–443 MHz. The GPU has clocked down between blinks and takes
the frame at that speed. It is not work we can remove; since the bar is its own layer, a
blink no longer re-runs any of the glass. They count as missed only because 7–8 ms plus
the wait passes 8.3 ms. Holding the GPU up for a caret would cost power to win a
statistic.

**Scroll.** RenderThread is 4.6 ms a frame against legacy's 1.3. About 0.6 ms of that is
recording the 16 glass layers. About 2.4 ms is flushing them: four blurs of about 1968 ×
330 at full size and their halvings. GPU p90 went 6.4 → 4.4 ms and the tail flattened
(p99 18–22 → 14 ms). The p50's remaining gap to the glass-off 5.8 ms is that flush. The
next step is Telegram's: draw the capture at the band's size into one merged node per
frame rather than one per glass (the bar's 1968 × 333, the fade's and the pill's), or
blur the bands at half size.

Pictures and video in the task's `.context/glass-cost/`:
- `before-conversation-{light,dark}.png` and `after-conversation-{light,dark}.png`, the
  same screen from `glass_steps`.
- `fold-keyboard-dark.mp4`: `conversation_ime` with the after build.
- `working-bar-renderthread-strip-emulator.png`: four frames of the RenderThread sweep and
  pulse.

Benchmark additions:
- `conversation_working`: the working screen for 5 s, nothing streaming.
- `glass_steps`: the 1 px steadiness measure, with the first and last screenshots in
  `files/glass-steps-*.png`.

## Running the benchmark

```sh
cd packages/happy-android
./gradlew -Phappy.debuggable=false -Phappy.applicationId=com.slopus.happy.chatbench \
  :app:assembleDebug :app:assembleDebugAndroidTest -x lintVitalDebug
adb -s <device> install -r -t app/build/outputs/apk/debug/app-debug.apk
adb -s <device> install -r -t app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb -s <device> shell cmd package compile -m speed -f com.slopus.happy.chatbench
adb -s <device> shell am instrument -w -e chat recorded \
  -e class com.slopus.happy.bench.ChatListBenchmark#conversation_scroll \
  com.slopus.happy.chatbench.test/androidx.test.runner.AndroidJUnitRunner
adb -s <device> shell cat /sdcard/Android/data/com.slopus.happy.chatbench/files/chat-bench.txt
```

- **`-Phappy.applicationId`** installs beside `com.slopus.happy.dev`, never over it. A
  differently signed build over the dev app would wipe its login.
- **`-Phappy.debuggable=false`** makes the debug build compile ahead of time, like the
  one users have. `lintVitalDebug` then runs, hence `-x`.
- **`-e chat`** picks the chat:
  - `recorded` (the default): the committed scrambled chat.
  - `real`: a recording pushed as `files/chat-fixture.json` in the app's external
    files.
  - `stress`: `HeavyChat.stress()`.

  To record another chat: page through `GET /v0/agents/<id>/messages?limit=100&omitToolData=true&before=<runId>`
  on the daemon, write `{"runs":[…]}`, then run `tools/bench/scramble-chat.py recording.json out.json.gz`.
- **Cases:**
  - `conversation_open`, `conversation_scroll`, `conversation_stream`,
    `conversation_older`, `conversation_ime`, `conversation_working`, `glass_steps`
  - `conversation_motion` (`-e drive on` sends, scrolls and jumps on its own, for recordings)
  - `legacy_scroll`
  - `proto_compose_current`, `proto_compose_canvas`, `proto_recycler_canvas`,
    `proto_rows_current`, `proto_compose_prose`
  - `proto_compose_glass`, `proto_recycler_glass`

  Run them one at a time; each takes 10–60 s.
- **Prototype dependency.** The prototype lives only in `androidTest`.
  `androidx.recyclerview` is an `androidTestImplementation` dependency, not the app's.
