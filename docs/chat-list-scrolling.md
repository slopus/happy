# Chat List Scrolling

Everything learned while making `ChatList.tsx` stable. Written down because
almost none of it is discoverable from the libraries' documentation — most of it
came from reading FlashList's and React Native's source, and from measuring the
simulator frame by frame.

## The one-paragraph version

A chat list has exactly one fixed reference point: the newest message, sitting
just above the composer. Every scroll bug we hit came from some part of the
system disagreeing about where that point is. The shipped fix is an **inverted
list**, which makes the newest message *be* scroll offset 0, so the keyboard,
history paging, and new messages all stop needing corrections. The one thing it
cannot do is expand a work group in place — that is a real, unsolved limitation,
not an oversight.

## `maintainVisibleContentPosition` (mVCP)

The prop that makes chat lists possible. Normally a scroll view keeps the scroll
*offset* fixed when content is inserted, so anything added above what you are
reading shoves it down. This prop keeps a chosen *subview* fixed instead and
adjusts the offset to compensate.

```
maintainVisibleContentPosition = {
    minIndexForVisible: 0,          // which subview to anchor on
    autoscrollToTopThreshold: 200,  // ...unless already within N of the top
}
```

### Trap 1: `autoscrollToTopThreshold` is in POINTS, not a fraction

`autoscrollToBottomThreshold` is FlashList's own, implemented in JS, and is a
*fraction of the viewport*. `autoscrollToTopThreshold` sits right next to it in
the same object and is **not implemented by FlashList at all** — it is forwarded
to React Native's native mVCP, which takes **points**.

Passing `0.2` there is a fifth of a pixel and is indistinguishable from off. We
lost real time to this.

### Trap 2: `minIndexForVisible` indexes MOUNTED SUBVIEWS, not your data

From `RCTScrollViewComponentView.mm:1051-1067`:

```objc
int minIdx = props.maintainVisibleContentPosition.value().minIndexForVisible;
for (NSUInteger ii = minIdx; ii < _contentView.subviews.count; ++ii) {
    UIView *subview = _contentView.subviews[ii];
    hasNewView = subview.frame.origin.y + subview.frame.size.height > contentOffset.y;
    if (hasNewView || ii == count - 1) { _firstVisibleView = subview; break; }
}
```

It walks `_contentView.subviews` — the ~15 currently mounted cells, in mount
order, reused and repositioned by the recycler. Not the data array. So
`minIndexForVisible: 47` does not mean "anchor data item 47"; it means "skip 47
mounted cells", which with 15 mounted runs off the end.

**The anchor is chosen by position and array order, never by identity.** There is
no key, tag, or ref that says "anchor here". This is why a zero-height
placeholder row does not help either: it is not scanned any earlier and is not
special.

### Trap 3: FlashList hardcodes `minIndexForVisible: 0`

`RecyclerView.js:308-316` spreads it *after* your object:

```js
return { ...maintainVisibleContentPosition, minIndexForVisible: 0 };
```

Whatever you pass is overwritten. FlatList could use `1` (HEAD did, to avoid
anchoring on the streaming row); FlashList cannot. Probably deliberate — with
recycling, subview order is an internal detail and `0` is the only value with a
stable meaning.

### Trap 4: the `pendingAutoscrollToBottom` latch

`useBoundDetection.js` only *clears* that latch inside the
`autoscrollToBottomThreshold >= 0` branch. Toggling the threshold to `-1` to
"turn following off" strands the latch true, and the next append consumes it —
a scroll you did not ask for, arbitrarily later.

Do not toggle the threshold. Pick one value.

### Trap 5: `onStartReached` / `onEndReached` are latches

They fire once on entering the threshold zone and re-arm only after the list is
observed *outside* it. A short window can come to rest inside the zone, so the
latch never re-arms and a reader scrolling into history is never heard from
again. `ChatList` does its own near-edge detection in `handleScroll` instead.

## Why the list is inverted

A normal list puts the scroll origin on the **oldest** message — the one point in
a conversation that never stops moving as history loads. The newest message then
lives at a coordinate that changes on every content change and every viewport
resize, so each one needs a correction computed from an estimate.

The keyboard is where that becomes unfixable rather than merely fragile:

- Keyboard shrinks `layoutMeasurement.height` (e.g. 874 → 292).
- A normal list ends up ~582pt short of the newest message.
- FlashList's stick-to-bottom threshold is a fraction of the **shrunken**
  viewport (`0.2 x 292 = 58pt`), so it measures the reader as far from the bottom
  and declines to follow.
- Widening the threshold enough to fire would also drag a reader out of history
  every time a message arrived.

**FlashList has one threshold for two events that need opposite answers**:
"the viewport resized" and "content was added".

Inverted needs no answer at all: offset 0 is the newest message *and* the edge
the keyboard moves, so a viewport resize changes nothing. History lands at the
far end, off-screen, where it cannot shift anything.

Measured on device, raising the keyboard:

| | peak drift from newest |
|---|---|
| normal | 582pt, never recovers |
| inverted | 0 |

## The cost of inverting: groups expand upward

The anchor is the bottom-most visible row, so rows inserted into a group above it
push the tapped ribbon off the top of the screen.

Measured in the harness, expanding a group in an inverted list:

| content inserted | tapped row |
|---|---|
| below the ribbon (reading order) | `OFF-SCREEN` |
| above the ribbon | `PINNED (0)` |

Mitigation shipped: an expanded group renders `AgentWorkGroupHeader` at **both**
ends of its content, the trailing one labelled "Hide". Both rows are the same
component and therefore exactly as tall, so the trailing copy lands on the exact
pixels the reader just tapped. Verified: SSIM 0.999907 between before-expand and
after-collapse (control: 0.937 while expanded).

**If you change the height of that row, this breaks.**

## What FlashList actually buys us

Be honest about this, because it is less than it looks:

- **`getItemType`** — real. `LayoutManager.js:49-58` keeps a per-type rolling
  average (`heightAverageWindow.getCurrentValue(getItemType(index))`), so an
  unmeasured row is estimated from rows of its own kind. Exact for constant-height
  types; only *reduces* error for diffs and JSON dumps.
- **Cell recycling** — we deliberately **opt out**. `renderItem` puts a `key` on
  the row content because rows carry local state (expanded diffs, collapsed
  output) that must never leak into a different message. So we pay for a recycler
  and use it as a virtualizer.
- **mVCP** — strictly *worse* than FlatList here: we lost `minIndexForVisible`.

The migration was still worth it, but for one reason only: per-type sizing made
~200 flat heterogeneous rows viable, which is what let `ToolGroupView` (551
lines, a nested self-measuring container) be deleted and replaced with flat rows.
That deletion is what removed `preserveToolGroupAnchor` — the old
`measureInWindow` + `scrollToOffset` correction on every expansion.

## Ecosystem findings (searched 2026-09)

Every source agreed independently: **inverted lists are now considered the
mistake**, and the ecosystem built tools to replace them.

- **`react-native-keyboard-controller` v1.21 → `KeyboardChatScrollView`**
  (Mar 2026). Purpose-built for the exact keyboard problem above. Usage is one
  prop: `renderScrollComponent={KeyboardChatScrollView}`. **We already depend on
  this package** (`~1.21.1`) and use it in `_layout.tsx` and `HomeDock.tsx`, just
  never on the chat list.
- **Legend List** (`@legendapp/list`) — most-recommended for chat in 2026. No
  invert; uses padding (`alignItemsAtEnd`, `maintainScrollAtEnd`). Its mVCP is
  implemented **in JS, keyed by `keyExtractor` and data index**, not by native
  subview — exactly the limitation that blocked us. Also exposes `getState()`
  with `positionByKey`, and `alwaysRender: { keys }`. **Already in
  `package.json`** at `2.0.0-beta.3`.
- **Mid-list expand/collapse is unsolved across every virtualizer.**
  [@reactreaper](https://x.com/reactreaper/status/2076053384155758726) (Jul 2026)
  moved a chat off Legend List specifically because middle-message height changes
  broke it, noting the same issue in all virtualization libraries; his follow-up
  advice was "don't virtualize chat lists". Legend List's own docs confirm mVCP
  anchors content *above* the viewport, and that a visible item growing in place
  (content below shifts) is **expected behaviour**, not a bug.

So the expand-in-place problem is not a FlashList defect. It is the state of the
art.

## The non-inverted Legend List attempt (tried, reverted)

A full non-inverted `ChatListLegend.tsx` was built and run on device, because
reading downward makes expand-in-place free. **It was reverted and the code
deleted** — it needed a Legend List v3 upgrade (v2, which we pin, crashes on
React 19.2 inside its own `StateProvider`), and the orientation it bought
traded one class of jump for another. Do not resurrect it without reading this
section; the API details are deliberately not recorded, since they belong to a
version we do not install.

Three findings from it are real, orientation-independent, and one of them is
**shipped in `ChatList.tsx` today**:

### 1. Collapsed-by-default, or you paint what you are about to throw away

*This is the one that shipped.* Track which groups the reader **opened**, never
which are closed. Seeding a "collapsed" set at mount means a group arriving
later — paged-in history, or a turn that just completed — is absent from that
set, renders **fully expanded for one painted frame** (30-50 tool rows, roughly
2,000-8,000pt), and is only closed by an effect on the next commit.

Inverted, that happened off-screen past the far end, which is why it hid for so
long. Non-inverted it happens directly above the reader, once per page — the
scroll-up jump. Either way it mounts a turn's worth of the heaviest rows in the
app to discard them a frame later.

Default-closed makes a new group collapsed by construction: no effect, no second
commit, nothing to compensate for.

### 2. A correction that runs after a layout change cannot hide it

The keyboard is **two** changes, and the second is invisible until you read
`AgentContentView.ios.tsx`: a Reanimated `translateY` lifts the content view,
then `onEnd` applies a positive `paddingTop` that **shrinks the list's
viewport**. An inverted list ignores step 2 — its origin is the bottom edge. A
downward-reading list measures from the top and lands exactly the keyboard's
height short of the newest message.

Two fixes were tried and both failed, for the same reason: turning the resize
*correction* off made the drop permanent, and tuning its threshold so it fires
made the drop show for one frame and spring back. No value works, because the
correction necessarily runs after the resize paints. **Remove the change
instead of correcting it** — which for an inverted list means doing nothing,
since it never sees the resize.

### 3. Follow-the-newest and expand-in-place are the same event

No library can separate "a message arrived" from "the reader opened a group":
both are data changes, and a newly inserted row also reports a size change.
Only the toggle handler knows why the data changed, so any stick-to-bottom
behaviour has to be suppressed *by the handler*, not inferred from the trigger.

An inverted list sidesteps this entirely — the anchor is already the newest
message, so expansion and arrival cannot fight.

## Testing methodology (learned the hard way)

**A jump is transient by definition.** The list leaves the newest message and
comes back. Anything sampled after `waitForAnimationToEnd` reports success while
the reader plainly saw it move. Screenshots taken after settling *cannot* observe
the bug.

Two things that work:

1. **Peak tracking.** Record the worst distance
   from the newest message since the last reset — not the settled distance.
2. **Video frames.** Record with maestro, then
   `ffmpeg -i out.mp4 -vf "fps=12,scale=200:-1" frames/f%03d.png` and tile them
   into a contact sheet. This is how the keyboard rebound (frames 58-60) and the
   single-frame collapse were both confirmed.

Also: a harness can give a **false pass**. Our first scroll harness
simulated the keyboard by growing `contentContainerStyle.paddingBottom` — a
*content-height* change, which is not the same event as the keyboard shrinking
the *viewport*. It reported success on a case that was broken in the app.

An inverted list resting at offset 0 emits **no scroll events**, so a readout fed
only by `onScroll` goes stale. Feed it from `onLayout` and `onContentSizeChange`
too.

## Files

- `sources/components/ChatList.tsx` — the chat list, inverted FlashList
- `sources/components/AgentWorkGroupHeader.tsx` — the ribbon; leading + trailing
- `scripts/perf-e2e.mjs` — budget gate over real sessions on a real simulator
- `docs/chat-list-acceptance.md` — the bar this has to clear

The scroll-drift harness that produced the measurements above
(`dev/chat-scroll.tsx`, peak-gap tracking) was scaffolding for the concluded
Legend experiment and has been deleted. Recover it from git history if you need
to re-measure: `git log --diff-filter=D -- '*chat-scroll.tsx'`.
