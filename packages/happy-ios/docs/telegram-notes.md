# Telegram-iOS: what the chat borrows, and what it does instead

Telegram-iOS is GPL-2.0. These notes describe techniques in our own words so
the chat can reimplement them in plain UIKit. No code was copied, and nothing
here depends on AsyncDisplayKit/Texture or Telegram's `Display` framework.

## What was read

All paths are in https://github.com/TelegramMessenger/Telegram-iOS (master,
October 2026), read as raw files over the web:

- `submodules/Display/Source/ListView.swift`: the list engine (the top of the
  file: the backing view, its state and the per-frame display link).
- `submodules/Display/Source/ListViewItem.swift`: the item protocol, its
  asynchronous `nodeConfiguredForParams` and `updateNode`, and
  `approximateHeight`.
- `submodules/Display/Source/ListViewItemNode.swift`: row nodes,
  `apparentHeight`, the spring constants and the insets/content-size
  bookkeeping.
- `submodules/Display/Source/ListViewIntermediateState.swift`: transactions
  (insert/delete/update with direction hints), scroll positions, the
  stationary offset and `fixScrollPosition`.
- `submodules/Display/Source/TextNode.swift`: Core Text layout as a value
  computed off the main thread (`TextNodeLayoutArguments` → `TextNodeLayout`).
- `submodules/Display/Source/KeyboardManager.swift`: moving the system
  keyboard with an interactive offset.
- `submodules/Display/Source/WindowContent.swift`: the window-level layout,
  `inputHeight` and `upperKeyboardInputPositionBound`.
- `submodules/TelegramUI/Sources/ChatHistoryListNode.swift`: the chat's use
  of the list (transitions, `stationaryItemRange`, scroll positions).
- `submodules/TelegramUI/Sources/ChatControllerNode.swift`: how the screen
  stacks the history, the input panel and the input node.
- `submodules/TelegramUI/Components/Chat/ChatMessageBubbleItemNode/Sources/ChatMessageBubbleItemNode.swift`:
  bubble composition and neighbour-aware layout.
- `submodules/AttachmentUI/Sources/AttachmentController.swift` and
  `submodules/MediaPickerUI/Sources/MediaPickerScreen.swift`: the attachment
  sheet and its media picker.
- `submodules/Display/Source/ListViewScroller.swift`, and in `ListView.swift`
  `updateScroller`, the inset update in the transaction code, the vertical
  scroll indicator's frame and the tracking state; in
  `ChatControllerNode.swift` the list's insets and scroll indicator insets
  and `dismissedInputByDragging`; in `WindowContent.swift` the keyboard pan
  and `dismissedKeyboardByCurrentGesture` (section 6).

## 1. The inverted list and keeping the scroll position

**What Telegram does.** `ChatHistoryListNode` sets the list's `rotated`
flag: the whole list is turned upside down and every row is turned back. Row
0 is the newest message and sits at the visual bottom, where the scroll
origin is. The list is not a `UIScrollView` with cells: `ListView` keeps its
own array of row nodes with explicit frames, and a hidden scroller only
supplies the gesture and deceleration. A display link drives everything
that moves.

Changes arrive as transactions: deletes, inserts and updates, each with a
direction hint (up or down) and an optional `stationaryItemRange` or
scroll-to target. While applying one, the engine keeps a "stationary" row
(or the requested scroll position) fixed on screen: after re-laying out the
rows it measures how far that row moved and shifts the whole stack back by
the same amount (`fixScrollPosition`, `stationaryOffset`). Inserting above
the reader therefore never moves what they are reading, and growth of the
newest row pushes older rows up instead of pushing itself under the input
panel. Rows that aren't measured yet are laid out with `approximateHeight`
and corrected when the real layout arrives, with the same anchoring
applied, so the correction is invisible.

**What we do.** A `UICollectionView` with a custom `UICollectionViewLayout`
and a flipped transform (`scaleY = -1` on the collection view and on each
cell's content):

- Index 0 is the newest row, so `contentOffset.y == -adjustedInset.top` is
  "at the newest message". Older history lands at the far end, off screen,
  so loading it never moves anything visible. That is the same reason
  happy-app's `ChatList.tsx` inverted its FlashList.
- The keyboard and the composer change the inset on the newest edge, which
  is the scroll origin, so the newest message stays put without any
  correction.
- The layout (`ChatListLayout` in `HappyLayout`) is a pure function from row
  heights to row frames: a prefix sum. It is tested on Linux. The collection
  view layout only asks it for frames and answers `layoutAttributesForElements`
  with a binary search over the prefix sums, so thousands of rows cost
  O(log n) per query.
- Anchoring when a row that isn't the newest changes height (a tool card
  finishing, a permission resolving): before applying the change we note the
  first visible row and its distance from the viewport's newest edge;
  afterwards we restore that distance with a `contentOffset` adjustment in the
  same transaction (`ChatListAnchor`, also pure and tested). A row that grows
  at index 0 needs nothing: in an inverted list it grows away from the
  origin.
- New rows at index 0 while the reader is within 200 pt of the newest edge
  (`ChatList.tsx`'s `autoscrollToTopThreshold`) keep them pinned to it.
  Further back, the anchor rule above keeps their reading position.

## 2. Precomputed, asynchronous text layout with manual frames

**What Telegram does.** Each item computes its layout as a value before any
view exists. `ListViewItem.nodeConfiguredForParams` and `updateNode` receive
an `async` hook and run the measurement on a background queue, then hand
back an `apply` closure that the main thread runs to install frames. Text is
a `TextNode` whose layout (`TextNodeLayout`: Core Text lines, line frames,
truncation, attachment and spoiler rectangles) is produced from
`TextNodeLayoutArguments` (attributed string, constrained size, maximum
lines, insets) entirely in Core Text, which is thread safe for layout. The
node then only draws the precomputed lines. A layout is reused as long as its
arguments are equal, so scrolling never re-measures.

**What we do.** The same split without nodes:

- `MarkdownParser` (pure Swift, `HappyCore/Markdown`) turns text into blocks
  and spans once per message text.
- `ChatTextMeasurer` (HappyUI) measures attributed strings with
  `NSAttributedString.boundingRect` / TextKit on a background serial queue.
  Both are safe off the main thread for measuring. It produces measured
  sizes, never views.
- Row layouts in `HappyLayout/Chat` are pure functions from those measured
  sizes to frames (`UserBubbleLayout`, `AgentTextLayout`, `MarkdownLayout`,
  `ToolRowLayout`, …), with exact-frame tests on Linux.
- `ChatLayoutCache` keeps the finished row layout per message id, width and
  content fingerprint. A streaming message invalidates only its own entry.
- Cells receive a finished layout and only assign frames. Each block's text
  is drawn by a `UILabel`/`UITextView` that is never asked to measure on the
  main thread during scrolling.
- If a row scrolls into view before its background measurement is done (a
  jump far back into history), it is measured synchronously once. That is
  Telegram's `synchronousLoads` escape hatch, used only when it must be.

## 3. Bubble resize animations

**What Telegram does.** Row nodes carry an `apparentHeight` that is animated
separately from their real layout. When an item's layout changes, the list
animates `apparentHeight` from the old value to the new one with a
spring/curve driven by its display link, re-stacking all rows every frame
from the apparent heights. Neighbours therefore move smoothly while the
bubble's own contents cross-fade or slide into their new frames inside it.
Status changes (sent → delivered) are applied as `updateNode` with
`ListViewItemUpdateAnimation.System`, so the row's subnodes animate between
two precomputed layouts.

**What we do.**

- Each row update produces a new precomputed layout. The cell animates from
  the old frames to the new ones with a `UIViewPropertyAnimator` (spring,
  ~0.3 s), the way frames are applied elsewhere, just inside an animation
  block.
- The collection view layout animates the height change through
  `performBatchUpdates` + `invalidateLayout(with:)`. `UICollectionView`
  interpolates both the cell frame and every neighbour's position, which
  gives the `apparentHeight` effect without a custom display link.
- Streaming agent text arrives several times a second. Updates are coalesced
  to one per display frame (`CADisplayLink`-free: a main-queue coalescer
  keyed by message id). Growth at index 0 extends away from the scroll
  origin, so the bubble grows upward smoothly while the newest edge stays
  pinned above the composer.
- Status changes that keep the height (pending → sent, the fixed-height
  status line `MessageView.tsx` reserves) are reconfigured in place with no
  layout invalidation, so they never jump.

## 4. Keyboard

**What Telegram does.**

- *Tracking.* The window computes one `ContainerViewLayout` that includes the
  keyboard's `inputHeight`. The chat controller lays out the history, the
  accessory panels and the input panel from that one value inside the
  keyboard's own animation curve, so they move together in one transaction.
- *Interactive dismiss.* `WindowContent` watches pans that reach into the
  keyboard's area and records `upperKeyboardInputPositionBound`, the finger's
  y. The effective input height shrinks to follow the finger
  (`inputHeightIsInteractivelyChanging`), and `KeyboardManager` moves the
  real keyboard view by shifting its layer bounds by the same offset. The
  input panel follows because it is laid out from that same input height.
  On release the keyboard is either dismissed or animated back depending on
  position and velocity. This reaches into the private keyboard window.
- *Insets.* Because the list is rotated, the keyboard height plus the input
  panel height become the list's inset at the newest edge, and the anchor
  rules in section 1 keep the newest message where it is as it changes.

**What we do.** No private keyboard views:

- `ChatKeyboardDock` (the screen's container, `HappyUI/Chat`) follows
  `view.keyboardLayoutGuide` (iOS 15+, deployment target 17). With
  `followsUndockedKeyboard` and interactive dismiss enabled on the
  collection view (`keyboardDismissMode = .interactive`), UIKit itself moves
  the guide with the finger during an interactive dismiss. The dock reads the
  guide's layout frame in `viewDidLayoutSubviews` and in a
  `UIKeyboardLayoutGuide` animation. The dock and composer are placed by a
  pure `ChatScreenLayout` from that one keyboard top, so the input bar
  follows the finger frame by frame without our own pan recognizer.
- Keyboard show/hide outside a drag uses the system's curve: frames are
  applied inside the `keyboardWillChangeFrame` animation (duration and
  curve from the notification), the equivalent of Telegram running its
  layout inside the keyboard transition.
- The list's inset at the newest edge is `dock height + keyboard overlap`.
  Since that edge is the scroll origin, keeping the bottom anchored is just
  keeping `contentOffset` at the origin when the reader was there. When they
  were further back, their content moves up by the same delta, as in
  Telegram.
- The composer reports its height through a protocol (`ChatComposerView`),
  and the dock animates the change in the same way, so a growing text view
  pushes the list up smoothly.

## 5. Attachments

**What Telegram does.** The paperclip opens `AttachmentController`, a sheet
whose tab bar switches between containers (gallery, file, location, …). The
gallery tab is `MediaPickerScreen`: a grid over `PHFetchResult` with
selection counts and an inline caption panel. It can expand to full screen
and sends selected assets straight from the sheet (`send(mode:…)`), with a
preview/editing step before sending.

**What we do.** The attachment flow belongs to the Composer workstream.
happy-app has no sheet: it uses the system pickers (`useImagePicker`) and
shows picked images in a strip above the text field
(`AgentInputAttachmentStrip`). The port keeps that:
`PHPickerViewController` for photos, `UIImagePickerController` for the
camera and `UIDocumentPickerViewController` for files. Each pick is copied
into the account's `files/` directory and becomes an `OutgoingAttachment`,
previewed in the strip and sent with the text through `ChatSending`. The
chat's part is only the container the composer lives in (section 4) and
rendering the resulting `file` tool rows.

## 6. The scroll indicator, and insets under the finger

**What Telegram does.**

- *Insets while the finger is down.* When the list's insets change (the
  input panel and the keyboard sit at the rotated list's scroll origin),
  `ListView` normally shifts every row by the change, so what is at the
  newest edge rides with the input panel. While the finger is tracking the
  list it doesn't, unless a caller opts in (`allowInsetFixWhileTracking`):
  the rows stay where the finger put them, and only how far the list can
  scroll changes. In an interactive dismiss the keyboard's top follows the
  finger, so its travel is never added to the drag's. Once the finger lifts,
  the next pass is not tracking, and the rest of the dismissal carries the
  rows down with the panel.
- *After the release.* The window notes whether the release itself
  finished dismissing the keyboard (`dismissedKeyboardByCurrentGesture`),
  so the list can decline to fling on top of it (`shouldStopScrolling`). A
  drag that began within 10 points of the newest edge and dismissed the
  input returns to the newest message (`didInteractivelyDragFromTopOrigin`).
- *The indicator.* The scroller is a hidden `UIScrollView` with a huge
  content size that only supplies the pan and the deceleration, so UIKit's
  indicators would mean nothing. `ListView` draws its own: a 3-point
  rounded bar 3 points in from the side and the ends. It is placed from
  the visible rows' indices times an average height of 44, because rows
  outside the window are not measured. It runs between scroll indicator
  insets that the chat keeps apart from the content insets: the keyboard and
  input panels at the newest end, the top chrome at the other, without the
  list's own padding. The list is rotated 180°, which mirrors it, so the
  indicator is placed at the left to show on the right. It takes no
  touches, so it can't be dragged.
- *Its newer list.* All of the above, and sections 1 to 4, describe the
  classic list (`ListViewImpl`). The rotated chat history now runs by
  default on a newer backend, `CoreListChatHistoryBackend`, kept behind a
  server switch: a virtual list view with its own scrolling physics. It
  draws no indicator at all; its indicator colour setting is stored and
  never read. So Telegram has no draggable indicator to learn from, only
  the rule for insets under the finger above.

**What we do.**

- The same rule for insets under the finger:
  `ChatScrollAnchor.visibleMinY(afterNewestInsetChange:…)` keeps the
  reader's anchor only while the collection view is not tracking. Under
  the finger the offset stays, and the inset change only adds to or takes
  from how far back the reader is. A frame-by-frame Linux test
  (`ChatInsetChangeTests`) shows the old rule moving the conversation by the
  finger's travel plus the keyboard's.
- No indicator, as in Telegram's newer list: `showsVerticalScrollIndicator`
  is off on the chat list. UIKit's own one could be pressed and dragged at
  the edge, scrubbing far through the history for a short drag, and on the
  flipped list it needed insets of its own. happy-app's FlashList shows the
  platform's default indicator; this is a deliberate difference
  (docs/FEATURES.md).

## What we deliberately don't copy

- Rotated custom node lists and a display-link-driven scroller: a flipped
  `UICollectionView` with a pure custom layout gives the same anchoring with
  UIKit's own scrolling physics, accessibility and 120 Hz ProMotion support
  (`CADisableMinimumFrameDurationOnPhone` is set by the app).
- Moving the private keyboard window: `keyboardLayoutGuide` and
  `.interactive` dismiss cover the same behaviour with public API.
- Telegram's spring constants and timing tables: our animations use UIKit
  springs with happy-app's durations.
