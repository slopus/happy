# Navigation measurements

The October 17, 2026 integration removes a repeated decode when a chat opens
with an agent state that Home already holds. The store reuses that immutable
payload only when the transaction still contains the same session, version
and ciphertext. A missing record, mismatched identity or missing payload
falls back to the database. Membership, metadata, message boundaries and
history markers always come from the transaction. Separate stores never
share this cache.

Two smaller changes avoid work during construction and measurement. A
compact composer creates its desktop controls only when it first becomes
wide. A label rendered while being measured or read does not explicitly
invalidate its measuring parent. Window and trait changes still invalidate
layout. Grouped-list caches must still release their access before measuring
children: label rendering is not a substitute for the reentrancy fix.

## Controlled device comparison

`HostedNavigationTimingTests` uses a seeded account and the production route,
with no network. The controlled comparison starts from a bare navigation
root, with a short chat as the first push in a fresh test-host process. It
then opens an empty controller, a chat with approximately 1 MB of agent
state, a chat with 300 messages, Session Info, Settings and Appearance, four
times each. Before and after use the same test and phase instrumentation.

Hardware: iPhone 12, iOS 26.1. Build: Preview, `-O`, no `DEBUG`, with
`HAPPY_FIXTURES` and testability enabled. Toolchain: Xcode 27.1 on Kirill Mac
Mini. Baseline source: `290731fe`, plus the test and phase instrumentation.

The table compares medians from `before-phases` and `after-nav-fixes`.
Short-chat warm samples exclude the first push; other rows include all four.
Times are milliseconds.

| Route | First callback before / after | Transition settled before / after | Chat readiness before / after |
| --- | ---: | ---: | ---: |
| Short chat, warm | 103.4 / 102.5 | 584.4 / 584.0 | 11.8 / 11.9 |
| Chat, 1 MB state | 181.6 / 141.3 | 652.7 / 633.6 | 102.8 / 79.3 |
| Chat, 300 messages | 125.5 / 125.0 | 611.8 / 608.9 | 65.8 / 66.6 |
| Empty controller | 53.2 / 53.5 | 522.3 / 528.5 | — |
| Session Info | 42.2 / 47.6 | 524.3 / 521.7 | — |
| Settings | 74.8 / 88.2 | 545.0 / 555.4 | — |
| Appearance | 90.5 / 94.6 | 565.8 / 571.2 | — |

The large-state path improves in this comparison. The first after sample
was slower (181.8 ms first callback, 91.3 ms readiness); its remaining three
samples were 137.2–142.6 ms and 78.9–79.6 ms. This is a modest reduction in
the time before the native transition, not a general navigation speedup.
Settings, Appearance, short chats and the message-heavy chat show no
established improvement. The test's ciphertext is a small sentinel; it does
not measure comparison and copying costs for a large encrypted string.

## What the clocks cover

The first callback records a `CADisplayLink.targetTimestamp` after the new
controller has joined the window. It approximates a presentation opportunity;
it does not prove when pixels reached the display. The settled callback
also requires both transition coordinators to have finished. Neither clock
includes touch delivery. The empty-controller result gives context for the
native navigation transition's own duration.

The route clock starts before constructing the destination. The separate
chat readiness clock starts after construction and initial view setup, so
it cannot explain the whole tap-to-transition delay. Added fixture-only
phase counters report construction, `viewDidLoad` and opening layout.
Warm short-chat construction was 14.5–18.9 ms before and 13.5–17.2 ms after;
the first construction was 50.6 / 51.6 ms. Initial opening layout was about
1 ms. These do not establish a construction speedup.

Cold first-chat baseline samples across three fresh hosts were 253.7,
208.1 and 193.1 ms. The first after sample was 184.9 ms. There is only one
after host in this comparison, so no cold-start improvement is claimed.
Existing cold traces include lazy UIKit keyboard tracking and dynamic
library loading. Resting Home initializes the composer model but creates
its explicit keyboard guide only when its focused overlay opens. The bare
host traces alone do not establish the cost of a first chat from Home.

The separate `testOpeningChatsFromTheRealHomeRoot` waits for Home's visible
resting dock and opens short and large-state chats through the normal route.
It validates production-root lifecycle and readiness, separately from the
controlled comparison. It does not first open Home's composer overlay,
whose keyboard guide belongs to `HomeDockFocusViewController`. Existing
hosted chat-navigation tests sample the title, avatar, tabs, list and composer
across the push and tab switch to check that content stays in place once
shown. The readiness cap and native navigation controller are unchanged.

This production-root check and all four existing chat-navigation tests
passed on the physical iPhone. Both Home pushes reported no missing readiness
requirements. Their first callbacks were 142.2 / 177.0 ms (short / large-state)
and readiness 16.1 / 80.1 ms. These are functional validation samples after
other chat tests in the same host, with unrelated Mac work in progress;
they are neither a cold measurement nor a production-root A/B comparison.

## Bounded cold Home trial

With the current fixes, the Home-root method was then run alone as the
first test in each fresh physical iPhone host. Home's resting dock was ready
before the first short-chat push; no preceding chat or focused Home overlay
initialized its keyboard. The same optimized Preview build settings applied.

A trial installed a hidden view constrained to Home's public keyboard
layout guide in `viewDidAppear`, after window attachment, then laid out the
view. It did not focus an input or show the keyboard. Two fresh hosts per
configuration gave the following milliseconds:

| Configuration / run | Home setup | Longest Home turn | First chat callback | Transition settled | Longest chat turn |
| --- | ---: | ---: | ---: | ---: | ---: |
| Current fixes 1 | 48.6 | 48.5 | 187.5 | 661.0 | 94.5 |
| Current fixes 2 | 47.9 | 47.9 | 197.1 | 683.1 | 96.5 |
| Early guide trial 1 | 47.0 | 47.0 | 184.5 | 662.8 | 90.0 |
| Early guide trial 2 | 57.0 | 57.0 | 194.6 | 670.0 | 92.6 |

All four tests passed, with no missing readiness requirements. The small
first-callback difference does not establish a useful, repeatable gain; a
preceding current-code pilot had already measured 174.1 ms. Home's second
trial setup was also slower. The guide change was discarded. These samples
do not prove whether this public setup triggers the loader seen in the older
trace, or eliminate UIKit's first-use cost. Cold and general navigation
latency remain open.

Home setup spans construction, window attachment and the wait for a visible
resting dock, excluding account seeding and the following 300 ms settle.
The busy-turn recorder includes its current partial turn: synchronous Home
setup can finish before the run loop first waits. The pilot's longest-turn
value of zero exposed that recorder gap and is excluded from the table.