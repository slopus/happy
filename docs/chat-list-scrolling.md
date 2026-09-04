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

Measured in `dev/chat-scroll`, raising the keyboard:

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

## Experimental: `ChatListLegend.tsx`

A non-inverted Legend List variant, **on by default**, with the `legendChatList`
local setting (Settings → Developer → "Legend List chat") to switch back to the
inverted FlashList. Same props either way, swapped at the call site in
`SessionView.tsx`.

**Requires Legend List v3.** We were pinned at `2.0.0-beta.3` — a beta of an
already-superseded major — and it crashes immediately on React 19.2 with
"Rendered fewer hooks than expected" / "Do not call Hooks inside useEffect(...)"
thrown from inside `LegendListInner2`/`StateProvider`, i.e. the library's own
internals. v3.3.10 fixes it. Do not downgrade.

v3 migration notes that bit us:

- The root `@legendapp/list` export is **removed**; import from
  `@legendapp/list/react-native`.
- `maintainVisibleContentPosition` defaults to `{ size: true, data: false }`, so
  a bare `true` means something different than it did in v2. We pass
  `{ size: true, data: true }` explicitly.
- Imperative scrolls return `Promise<void>`.
- `keyExtractor` is no longer inferred from `data` in all positions.

### The keyboard shrinks the viewport in a second step

This is the one that matters, and it is invisible until you read
`AgentContentView.ios.tsx:45-57`. Raising the keyboard is **two** changes:

1. A Reanimated `translateY` lifts the whole content view. Content moves up.
2. On `onEnd`, a matching positive `paddingTop` is applied to the same view.
   That **shrinks the list's viewport** by the keyboard's height, so the list
   ends above the keyboard instead of behind it.

An inverted list is immune to step 2 — its origin is the bottom edge, so the
newest message holds and the far end absorbs the change. A list that reads
downward measures from the top, so losing ~306pt of viewport leaves it exactly
306pt short of the end. The symptom is unmistakable: **content rises with the
keyboard, then instantly drops back down behind it, as if the keyboard was never
presented.**

**The fix is to not resize.** Step 1 alone already puts the list's bottom edge on
the keyboard's top edge, which is everything a chat needs; step 2 only exists so
the list re-lays out instead of hanging off the top of the screen, which an
inverted list does not notice. `AgentContentView.ios.tsx` now skips the padding
when the non-inverted list is active, and the list never sees a size change at
all.

Two failed attempts are worth recording, because both looked reasonable:

1. **Turning the `layout` trigger off.** It is the only trigger that can correct
   a viewport resize, so this made the drop permanent instead of transient.
2. **Turning it on and raising the threshold to 1.** The correction then fires,
   but it necessarily runs *after* the resize is painted — so the drop still
   shows for one frame and springs back. A visible flash instead of a visible
   drop. No threshold value removes it, because the ordering is the problem.

The general lesson: a correction that runs after a layout change cannot hide
that layout change. Remove the change instead.

Two more traps in the same area, for whoever tunes this next:
`maintainScrollAtEnd={true}` silently enables all four triggers
(`normalizeMaintainScrollAtEnd`, `react-native.mjs:7081`), and
`state.pendingMaintainScrollAtEnd` (`react-native.mjs:752`) keeps the
within-threshold test true once set — a latch of the same shape as FlashList's
`pendingAutoscrollToBottom`.

### Legend List sets the same native anchor

`react-native.mjs:6145` puts `{ minIndexForVisible: 0 }` on the underlying
ScrollView whenever `maintainVisibleContentPosition.size || .data` is set — the
identical top anchor FlashList hardcodes. Legend List's advantage is not that it
avoids it, but that its own JS layer is keyed by item rather than subview index,
and that the triggers are separable.

### The collapsed-by-default race (caused the scroll-up jump)

Track which groups the reader **opened**, never which are closed. Seeding a
"collapsed" set once at mount means a group arriving from a newly paged-in page
is absent from it, renders **fully expanded** for one painted frame — 30-50 tool
rows, roughly 2,000-8,000pt — and is only collapsed by an effect on the next
commit. Inverted, that happened off-screen past the far end. Non-inverted, it
happens directly above the reader, once per page.

Default-closed makes a new group collapsed by construction: no effect, no second
commit, nothing to compensate.

The point is expand-in-place: in a non-inverted list, a group's rows are inserted
*below* the ribbon, pushing content down and leaving the ribbon where it was —
no measuring, no correction, no scroll call. It therefore needs only **one**
header row rather than the leading/trailing pair.

What inversion was buying is replaced by real props: `alignItemsAtEnd`,
`maintainScrollAtEnd` + `maintainScrollAtEndThreshold`, `initialScrollAtEnd`,
and `maintainVisibleContentPosition`.

Note `maintainScrollAtEnd` also accepts an options object:

```ts
interface MaintainScrollAtEndOptions {
    onLayout?: boolean;      // viewport resized (the keyboard)
    onItemLayout?: boolean;  // a row changed size (streaming)
    onDataChange?: boolean;  // a message arrived
}
```

That is **exactly the distinction FlashList collapses into one threshold** — the
root cause of the keyboard catch-22 above. Legend List lets the three events be
answered separately, which is the strongest argument for it over FlashList for
chat.

### Follow-the-newest fights expand-in-place

Splitting the triggers does **not** separate "a message arrived" from "the reader
opened a group": both are data changes, and a newly inserted row also fires
`onItemLayout` (`react-native.mjs:4919` — an item whose size was previously
unknown counts as a size change). Reading the flag off the trigger is therefore
impossible; only the toggle handler knows why the data changed.

Symptom: parked at the bottom, tap the last ribbon, and Legend scrolls to the
new end — carrying the ribbon off the top, so the second tap that would close it
again has nothing to aim at.

Fix: `maintainScrollAtEnd={toggledAt !== messages}`, where `toggledAt` is the
message array captured when the reader last toggled. Following is off from the
toggle until the next message arrives — one commit in a live session, the whole
reading session in an idle one, and no timer to unwind. It only has to hold near
the bottom; a reader further back is already covered by
`maintainScrollAtEndThreshold`.

### Do not group a turn the reader watched run

A running turn is not grouped at all (`collectAgentWorkGroups` skips turn 0 when
`collapseCurrentTurn` is false), so it reads as flat rows while it streams.
Grouping it the instant it finishes folds it up under a reader who is halfway
through it — a layout shift at the one moment they are certain to be looking.

`sawLiveTurn` latches once the screen has seen the session thinking, and keeps
`collapseCurrentTurn` false for the rest of the visit. Sending the next message
makes it an ordinary past turn, which groups and closes like any other; leaving
the screen unmounts the component and forgets it. Note this is deliberately
*not* wired to `AppState`: `inactive` fires for notification centre and app
switching, and collapsing there would fold the turn for a momentary glance away.

Keep `currentTurnComplete` separate from `collapseCurrentTurn` —
`buildAgentTurnCopyTextByMessageId` wants the real completeness, not the
grouping decision.

## Testing methodology (learned the hard way)

**A jump is transient by definition.** The list leaves the newest message and
comes back. Anything sampled after `waitForAnimationToEnd` reports success while
the reader plainly saw it move. Screenshots taken after settling *cannot* observe
the bug.

Two things that work:

1. **Peak tracking.** `dev/chat-scroll` records `peakGap` — the worst distance
   from the newest message since the last reset — not the settled distance.
2. **Video frames.** Record with maestro, then
   `ffmpeg -i out.mp4 -vf "fps=12,scale=200:-1" frames/f%03d.png` and tile them
   into a contact sheet. This is how the keyboard rebound (frames 58-60) and the
   single-frame collapse were both confirmed.

Also: a harness can give a **false pass**. The first version of `dev/chat-scroll`
simulated the keyboard by growing `contentContainerStyle.paddingBottom` — a
*content-height* change, which is not the same event as the keyboard shrinking
the *viewport*. It reported success on a case that was broken in the app.

An inverted list resting at offset 0 emits **no scroll events**, so a readout fed
only by `onScroll` goes stale. Feed it from `onLayout` and `onContentSizeChange`
too.

## Files

- `sources/components/ChatList.tsx` — shipped, inverted FlashList
- `sources/components/ChatListLegend.tsx` — experimental, non-inverted Legend List
- `sources/components/AgentWorkGroupHeader.tsx` — the ribbon; leading + trailing
- `sources/app/(app)/dev/chat-scroll.tsx` — harness, `happy://dev/chat-scroll`
