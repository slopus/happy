# The iOS performance gym

A runnable suite that scrolls long Stem Cells conversations in the simulator
and measures every frame, so a scrolling regression fails a run instead of
reaching a phone. It is modelled on happy-desktop's gym
(`packages/happy-desktop-gym`): the same throwaway Happy Agent, a fake model,
scripted workloads, and budgets per workload.

## What is where

- `scripts/perf-gym/gym.py`: the runner. It builds the fixtures, starts the
  throwaway daemon, builds the app, runs the workloads, and checks the budgets.
- `scripts/perf-gym/fakellm.py`: the fake model the throwaway daemon talks to.
  A message `stream P W` gets a reply of P Markdown sections (a paragraph, a
  list, a table and code), streamed one word every W ms. A message
  `status TEXT` makes the agent call its `set_status` tool with TEXT, so a
  sidebar row has a status line to show. A message `tool NAME JSON` makes it
  call its tool NAME with that JSON object (`create_artifact`, `post_story`).
- `scripts/perf-gym/budgets.json`: the most each workload may cost.
- `scripts/perf-gym/baselines/`: measured runs on the synthetic chats, before
  and after the October 2026 transcript work (e7363747a), and on the gym's
  fixed daemon (`preview11.json`), with the same Mac and simulator.
- `Tests/HappyDirectUITests/ScrollPerfGymTests.swift`: the workloads, as UI tests.
- `Sources/HappyUI/Perf/GymFrameMeter.swift`: the app's own frame meter and
  scripted scroll. It is compiled only into DEBUG and `HAPPY_FIXTURES` builds,
  and runs only with `STEM_GYM_METER=1`.

Everything the runner makes goes into its work folder, `GYM_WORK`. The default
is `<repo>/.context/gym`, which is gitignored. That covers the daemon's home and
configuration, the fixtures, derived data, logs and results. Nothing touches
`~/.happy`.

## Running it

```sh
cd packages/happy-ios
python3 scripts/perf-gym/gym.py up        # synthetic chats, throwaway daemon, fake model
python3 scripts/perf-gym/gym.py build     # the app and its UI tests; again after changing the app
python3 scripts/perf-gym/gym.py run       # primes, runs every workload, checks budgets
python3 scripts/perf-gym/gym.py run fling-to-top image-heavy --no-prime
python3 scripts/perf-gym/gym.py compare scripts/perf-gym/baselines/before.json scripts/perf-gym/baselines/after.json
python3 scripts/perf-gym/gym.py down
```

`run` exits non-zero when a workload goes over a budget or its test fails, and
prints one `PASS` or `FAIL` line per workload. Results are written to
`<work>/results/<label>.json`, and the logs and `.xcresult` bundles sit beside
them.

What it needs:

- Xcode and XcodeGen;
- Happy Agent 0.4.110-preview.11, the gym's fixed daemon (`AGENT_VERSION` in
  `gym.py`). The first run copies it from
  `~/.happy/dist/version/0.4.110-preview.11/happy-agent` into
  `<work>/../gym-agents/`, as Happy Agent's updater later prunes old versions
  from `~/.happy/dist`, and checks its `--version`. Another daemon through
  `--agent` or `HAPPY_AGENT_BIN`. Keep it fixed so a run compares the
  app, not the daemon. From 0.4.110-preview.6 until the fix in .9, the mobile
  connector cut history pages over about 130 KB short (the app reads an empty
  chat), and the app asks for desktop's 100 runs a page;
- full access outside the sandbox: it binds local ports and drives the
  simulator;
- free local ports 24821 for the mobile connector and 24823 for the fake model,
  or others through `GYM_CONNECTOR_PORT` and `GYM_FAKE_PORT`;
- a short work folder, because the daemon's unix socket lives in it.

The runner makes and boots its own simulator, "Happy Perf Gym", an iPhone 17
Pro, and pairs the app with the throwaway daemon as desktop would: it asks for
a pairing, opens the QR link in the simulator and confirms the emoji.

The build is the gym's own: the Debug configuration, so the meter and the test
hooks are in, but with `-O` and whole-module optimization, so the numbers are
close to a release build's.

## The workloads

| Workload | What it does |
| --- | --- |
| `open-cold` | Opens the long chat from the sidebar after a launch, and times the push until the transcript shows. |
| `open-warm` | The same, back and in again, with the chat read ahead. |
| `fling-to-top` | Twelve fast flings from the newest message back into history. A fling goes about 2,500 pt, so they stay within the history on the phone. |
| `fling-to-bottom` | Far back first (not measured), then flings up and back down to the newest message. |
| `slow-drag` | Drags at 300 pt/s, a finger reading line by line, up into history and down again. |
| `image-heavy` | Flings through the chat heaviest with pictures. |
| `scroll-while-streaming` | Sends `stream 30 40`, then flings and drags through history while the reply streams in. |
| `sidebar` | Flings the sidebar down its rows and back twice, then folds and unfolds two section headings. Frame-meter totals over the whole run (`allLate`, `allMax`, `mainMax`): the transcript-only counts stay 0. |
| `history-paging` | Makes the phone forget the long chat, then runs to the top three times (`top`, 40,000 pt/s) and flings around it while each older page lands. |

Before the workloads, `testPrime` runs both chats to the top until no more
pages come, as someone who has read their long chats has them on the phone.
With the retention below, the phone then keeps the newest 100 runs.

`testStoryRingOpens` is a check, not a workload: run it alone. When the test
prints `GYM_POST_STORY <task>`, the gym has that task's agent post a story
with an html artifact as its one frame, while home is on screen and again
while the task's chat is. Each time, a tap on the new ring must open the
viewer with no relaunch, and the ring must read seen once the viewer closes.

### The synthetic chats

`gym.py synth` writes the fixtures that CI and the committed baselines use.
There is no real content in them, only seeded word salad, Markdown and
generated pictures:

- "Gym Long Chat": 270 turns. Each one has the person's question, the agent's
  thinking, up to four tool calls that nobody sees, and a Markdown answer with
  paragraphs, lists, tables and Swift code. One turn in eight presents
  screenshots, and one message in twenty sends a photo. The ids are cuid2 and
  every picture carries a real ThumbHash, as the daemon refuses records
  without them.
- "Gym Pictures": 90 turns, four in five presenting one to four pictures in
  columns.

`gym.py up` also turns Stories on, so the sidebar draws story rows, and adds
twelve short tasks (`SIDEBAR` in `gym.py`) whose agents set a status through
the fake model, enough rows for the `sidebar` workload to scroll.

### Real conversations, locally only

`gym.py export AGENT_ID...` copies conversations from this Mac's own Happy
Agent into `<work>/fixtures/live`, pictures included. It only ever sends GET
requests to that daemon and never prints its token. Load the copies with
`gym.py up --fixtures <work>/fixtures/live`, then run them with `gym.py run
--chat "<title>" --images "<title>"`.

The copies are the person's own words and pictures. They stay in the
gitignored work folder on that Mac. Never commit them, never send them
anywhere, and never paste more than their titles and sizes into a report.

## What is measured

The meter (`GymFrameMeter`) runs inside the app:

- a `CADisplayLink` records every frame's interval;
- a run-loop observer records how long the main thread was busy before each
  frame;
- the app's memory is `phys_footprint`, which is what Xcode's gauge shows.

Like XCTest's scroll metrics, the meter counts only frames while the transcript
moves. Each workload reports these pairs:

| Key | Meaning |
| --- | --- |
| `hitchRatio` | Hitch time per second of scrolling, in ms/s (Apple's hitch time ratio). Under 5 is good, and over 10 is what people notice. |
| `late`, `dropped` | Frames that came more than half a frame late, and the frames they skipped. |
| `p50`, `p95`, `p99`, `max` | Frame intervals in ms. |
| `mainP95`, `mainMax` | The main thread's busy time per frame, and its longest single stretch. |
| `applies`, `applyMax` | The transcript's applies (`show`), and the longest one, timed until the frame that showed it. |
| `memMB`, `peakMB` | Memory. |
| `views`, `layers` | The transcript's view and layer count when the workload ends. |
| `renderCpu`, `appCpu` | CPU seconds over the workload, for the simulator's render server and for the app. |

The pairs that cover every frame, not only frames in motion, are prefixed
`all`.

The workloads scroll the transcript from inside the app (`GymScroll`). The UI
test posts a Darwin notification and then sleeps. Gestures driven by XCUITest
read the screen's accessibility tree before each one, which holds the app's main
thread for up to a second. Those holds counted as hitches and buried the app's
own costs. A scripted fling starts at 5,000 pt/s and slows by the clock as
UIScrollView's deceleration does. The screen treats it as a glide
(`GymFrameMeter.scrolling`): while it moves, nothing pulls the transcript back to
the newest message.

Each workload also runs XCTest's own metrics once (`GYM_ITERATIONS`):
`XCTOSSignpostMetric.scrollDecelerationMetric` or `scrollDraggingMetric`, and
`XCTHitchMetric`. In the simulator, only the durations come back. The hitch
metrics need a device.

### Profiling

On a device, record the hitches or a time profile with Instruments:

```sh
xcrun xctrace record --template 'Animation Hitches' --device <udid> --attach Happy --time-limit 30s
```

Attaching `xctrace` to the simulator app hung on the gym's Mac. Developer mode
for tools was off. `sample <pid> 30 -file out.txt` works on the simulator's app
process instead, and its main-thread tree is what found the costs below.

### What the simulator can't say

The simulator runs on the Mac's CPU, and its render server draws on the Mac's
GPU. Main-thread time, applies, view counts and memory carry over to a phone.
Absolute frame times don't. A phone has a slower CPU and a 120 Hz display, so
treat a hitch here as a larger one there. The budgets are set from simulator
runs on an M-series Mac. Compare a change against a baseline made on the same
machine.

## Budgets

`budgets.json` holds, for each workload, the most each key may reach, for
example `"scroll-while-streaming": {"hitchRatio": 150, "mainMax": 100}`. The
budgets sit about 50% above the after numbers in `baselines/`, so noise passes
and a return of the costs below fails. When a change makes something cheaper on
purpose, lower its budget with it.

## The baselines

`baselines/before.json` is 09b0036ba with only the meter added;
`baselines/after.json` is 7f8f3fbbd. Both on the synthetic chats, an M-series
Mac, iOS 26 simulator, the gym's `-O` build:

| Workload | Before | After |
| --- | --- | --- |
| open-cold | apply 4,261 ms, 16,333 views, 273 MB | apply 70 ms, 169 views, 146 MB |
| open-warm | apply 3,350 ms | apply 28 ms |
| fling-to-top | main max 47 ms, 272 MB | hitch 0.5, main max 15 ms, 152 MB |
| fling-to-bottom | main max 54 ms | hitch 0.25, main max 13 ms |
| slow-drag | main max 53 ms | main max 7 ms |
| image-heavy | main max 51 ms, 8,494 views | main max 11 ms, 567 views |
| scroll-while-streaming | hitch 683, 948 dropped, p95 98 ms, main max 637 ms | hitch 0, 0 dropped, p95 16.7 ms, main max 7 ms |
| history-paging | hitch 123, 151 dropped, main max 930 ms | hitch 0.9, 1 dropped, main max 16 ms |

Hitch ratio is ms/s. Before, flings show no hitches only because the meter
counts frames in motion: the cost was in every apply and in memory.

Those two ran on daemon 0.4.110-preview.4, whose connector cut large pages
short, so the prime read only part of each chat. `baselines/preview11.json`
is the gym's fixed daemon, 0.4.110-preview.11, with the app asking for 100
runs a page: the prime reads both chats whole (540 and 180 rows), and the
history-paging peak is 274 MB, against 215 MB with 50-run pages. Compare a
change with that one.

## What the gym found (October 2026)

These are Kirill's five longest conversations, loaded into a throwaway daemon.
The longest is 268 runs, 1,033 messages, 12 MB and 143 pictures. Before and
after numbers per workload are in `baselines/` for the synthetic chats.

1. **Every row was a live view.** The transcript kept a `ChatPlanView` for
   every row it had ever shown: 6,900 views and their layers, and about
   510 MB, on the longest chat. Each change re-applied every row on the main
   thread, so opening it held the main thread 1.9 s on the simulator. The rows are
   now virtualised, as desktop's transcript is with `@tanstack/react-virtual`.
   Every row's frame is still planned, but only rows within a screen of what
   shows have views (`StemCellChatMountedRows`), and they go only two screens
   away. A few rows that went off screen stay hidden, ready for the next.
2. **A long reply was one row of hundreds of views.** A 30-section answer is
   about 14,000 pt tall, with 330 marks and 210 texts. It came in whole and cost
   a 250 ms frame. A tall row is now cut between its marks into chunks of at
   least 1,024 pt (`StemCellChatChunks`), and only the chunks near the screen
   have views.
3. **Every layout pass read the whole conversation again.** `replan()` looked
   through every message's text for artifact and person references on the main
   thread. That ran on every layout pass and every streamed token, with
   Foundation's character-by-character `contains`. It was 65% of the main thread
   while a reply streamed. Now only text that changed is looked through, and
   the search is `memmem` over the text's UTF-8 bytes. Swift's own
   `firstRange(of:)` on the bytes was still 2% of the main thread.
4. **Drawing text.** Text coming on screen ahead of the scroll, a code
   block's and a table's included, is drawn into an 8-bit sRGB bitmap off the
   main thread (`ChatOffMainTextView`). Text on screen with nothing drawn yet
   is drawn at once; text that grew, as a reply streams, keeps its last
   drawing until the rest is drawn off the main thread. A paragraph planned
   again with the same words isn't drawn again. Before, code blocks drew on
   the main thread in 16-bit wide colour: half the flings' hitches.
5. **History retention.** The phone kept every run it had ever read, and
   rewrote the whole conversation to SQLite every 500 ms while it changed: 5 MB
   for the longest chat. It now keeps the newest 100 runs, desktop's window on a
   conversation nobody reads (`connectHappyAgent`'s `trimHistory`).
   An open conversation keeps what it reads until it passes 200 runs; then a
   run's end trims it to the newest 100 while the reader is at the newest
   message and the scroll at rest (desktop's rule for a watched session).
   Scrolling back past the kept runs pages them in again.
