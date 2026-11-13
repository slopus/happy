# Telegram's attachment menu vs ours

Source: Telegram Android 13.1.1, commit `3de37c8cfb039452be7398909461da6288babf15`
(the same pin as `research/telegram-glass.md` and `ui/NavMotion.kt`). Files under
`TMessagesProj/src/main/java/org/telegram/`:

- `ui/Components/ChatAttachAlert.java`: the sheet, its open animation, the tab bar,
  the caption bar and the send button
- `ui/ActionBar/BottomSheet.java`: the scrim, the close animation, nested-scroll
  drag to dismiss (`ContainerView`, `checkDismiss`)
- `ui/Components/ChatAttachAlertPhotoLayout.java`: the gallery grid
- `ui/Cells/PhotoAttachPhotoCell.java`, `ui/Components/CheckBox2.java`,
  `ui/Components/CheckBoxBase.java`: a gallery cell and its numbered check
- `ui/Components/ChatAttachAlertDocumentLayout.java`, `ui/Cells/SharedDocumentCell.java`:
  the File tab
- `ui/Components/glass/GlassTabView.java`: one tab of the bottom bar
- `ui/Components/ChatActivityEnterView.java` (`SendButton`): the send pill and its counter
- `res/drawable-xxhdpi/sheet_shadow_round.9.png`: the sheet's background (corner measured
  from the pixels)

Our port: `ui/attach/` (the sheet, grid, file list, tab bar, caption bar, check,
preview), `attachments/MediaGallery.kt` (MediaStore), `attachments/PickedMedia.kt`
(what is picked, staged for sending). The numbers below are `AttachSpec` /
`AttachMotion` in `ui/attach/AttachSpec.kt`, and `AttachSpecTest` pins them.

## The sheet

| | Telegram | where |
|---|---|---|
| scrim | black at `dimBehindAlpha` 51/255 = 0.2 | `BottomSheet.dimBehindAlpha`, `SheetBackDrawable` |
| open: sheet | `translationY` from the container's height to 0 on a **spring, damping 0.75, stiffness 350** | `onCustomOpenAnimation`, `appearSpringAnimation` |
| open: scrim | 0 → 0.2 over **400 ms**, delay 20 ms, `OvershootInterpolator(0.7)` | same, `currentSheetAnimation` |
| open: tabs | each tab pops in: tab *a* starts at `32 × (3 − a)` ms of a 400 ms clock (delay 20), scale 0 → **1.1** over 200 ms `EASE_OUT` (0, 0, .58, 1) with alpha `EASE_BOTH` (.42, 0, .58, 1), then 1.1 → 1.0 over 100 ms `EASE_IN` (.42, 0, 1, 1) | `ATTACH_ALERT_PROGRESS` |
| close | down by its height + 10 dp (+ the nav bar) and the scrim to 0, **250 ms `EASE_OUT`** (0, 0, .58, 1) | `BottomSheet.dismiss` |
| corner radius | **24 dp** (a circle fitted to the 9-patch's edge: 73 px at xxhdpi), square once the sheet reaches the top | `sheet_shadow_round.9.png`, `drawChildBackground` `rad` |
| grabber | 36 × 4 dp, radius 2, `sheet_scrollUp` (#E1E4E8), 10 dp under the sheet's top; fades as the selection header comes in | `drawChildBackground` |
| resting height | the grid's first row at **2/5 of the height** under the status bar (+4 dp: `+56 − 52`); 1/3.5 in landscape on a phone | `ChatAttachAlertPhotoLayout.onPreMeasure` |
| sheet top over the first row | 24 dp (`dp(11)` + `dp(13)`); **50 dp** while something is selected (`+ dp(26)` for the header) | `updateLayout`, `getY` |
| tap above the sheet | dismisses (only while the top bar is hidden) | `onInterceptTouchEvent` |

**Expanding and dismissing by drag.** The sheet is the list: the grid fills the window and
its top padding is the empty space above the sheet, so scrolling the grid up raises the
sheet's top until it meets the top. ChatAttachAlert turns BottomSheet's own swipe off
(`canDismissWithSwipe() = false`), which turns nested scrolling on: a drag down the list
that the list can't take (it is at its top) moves the whole sheet down
(`onNestedScroll`), a drag up takes that back first (`onNestedPreScroll`). Flings are not
passed on (`onNestedPreFling` is false). On lifting (`onStopNestedScroll`) `checkDismiss(0, 0)`:
the sheet goes if it was pulled **0.8 cm** or more (≈ 50 dp), otherwise it springs back in
`250 × (pulled / 0.8 cm)` ms, `DEFAULT` (.25, .1, .25, 1). The velocity rule
(3500 px/s) is in the same function but is never reached from a list drag.

**Reaching the top.** When the first row's offset is within the top bar (≤ 56 + 12 dp),
the top bar (back and the tab's title) fades in over `180 × |Δalpha|` ms and the sheet's
background slides up under it to cover the status bar, its corners going square as the bar
comes in (`rad = 1 − alpha`). Released half under the bar, the grid snaps to full
(`onScrollStateChanged`: `smoothScrollBy` to `7 dp + top bar`).

## The gallery grid

| | Telegram |
|---|---|
| columns | **3** on a phone held upright, **4** on a tablet or a phone on its side |
| padding and gap | `PADDING` 2 dp each side, `GAP` 2 dp between cells and rows |
| cell size | `(width − 2 × PADDING − 2 × GAP) / columns` (the gap term stays 2 × GAP at 4 columns too) |
| cell | square, no corners, `chat_attachPhotoBackground` (black 5%) behind while loading |
| video badge | bottom left, 4 dp in, 17 dp tall, radius 4, `chat_mediaTimeBackground` (black 0x66), 5 dp side padding: a play glyph and the length, 12 dp bold white |
| check | `CheckBox2` 24 dp in a 26 dp box, **5 dp from the top and right**; its tap area is the 42 × 42 corner |
| picking | the picture shrinks to **0.787** in 200 ms (`AnimatorSet`'s accelerate-decelerate), so a ring of the sheet shows round it |

**The check** (`CheckBoxBase`, background type 6, size 24):

- unpicked: a white ring, stroke 1.5 dp at radius 10.5 dp, over black 5% (the picture background) at radius 11 dp
- picking runs one progress 0 → 1 over **200 ms `EASE_OUT`**:
  - the first half fills the circle from its rim inward (radius 11.5 dp, a hole of `r × (1 − 2p)` cleared), in `chat_attachCheckBoxBackground` (Telegram blue #229AF0)
  - a ring in the sheet's own colour sweeps round it (−360° × p, stroke 1.5 at 11.8 dp)
  - the second half draws the number, 14 dp bold white (10 dp for three digits, 8 above), scaled horizontally from 0 to 1, its baseline 18 dp down the 24 dp box
- the number is the order of picking; unpicking renumbers the rest at once

## The tab bar

| | Telegram |
|---|---|
| bar | 70 dp tall across the bottom; glass pill inset 7 dp (so 56 dp tall), radius 28 (`mainTabs` glass: theme ground at 0.76, hairlines 0.4 dp) |
| tabs | inside 11 dp of padding, so 48 dp tall; width `min(84, text + 2 × lerp(16, 8, (text − 40) / 16))`, spare width shared equally |
| tab | icon 24 dp, 4 dp from the top; label 11 dp bold, top at 28.33 dp; colour `glass_tabUnselected` (#1A1D21 / white) → `glass_tabSelected` (#1A91E6), label `glass_tabSelectedText` (#0D7FCF) |
| selected | a stadium behind the tab in the selected colour at **9%**, scaled from **0.6** to 1, colours blended, **320 ms** decelerate (`BoolAnimator`); the label goes extra bold |
| icons | Lottie outline → filled on select |

## Picking: the caption bar and send

When the first item is picked (`updateCountButton` → `showCommentTextView`):

| | Telegram |
|---|---|
| timing | **180 ms**, `DecelerateInterpolator` (1 − (1 − t)²), all together |
| tab bar | down 36 dp and out |
| caption | fades in: a glass field, radius 22, inset 7 dp, the container padded 7/5 dp; leaves room for send on the right |
| send | a 52 × 38 pill (`dialogFloatingButton`, Telegram blue) with a plane, 11 dp from the right and 10 from the bottom of its 110 × 50 box; the box scales 0.2 → 1 and fades in |
| counter | on the pill's top left corner (centre 50 dp left of its right edge, top on the pill's top), `max(18, 9 + text)` dp, the pill's colour with a 2 dp clear ring, 12 dp bold white; each change **bounces 0.9 → 1 in 180 ms**, `OvershootInterpolator` |
| header | "N selected" (16 dp bold) where the grabber was, in 180 ms; the sheet grows 26 dp at its top for it |

## The File tab

Telegram lists storage roots (Internal Storage, a Gallery that sends without compression,
Music) and then **Recent files** from Downloads. Rows (`SharedDocumentCell`, picker type)
are 64 dp (+1 for a divider), a 42 dp icon 12 dp down and 15 in, the name at 72 dp
(16 dp bold) and the details under it (13 dp). Roots get a circle in a colour of their own
(storage #60C255, gallery #F2C04B); files a square with the extension in white, coloured by
type: `.doc .txt .psd` blue, `.xls .csv` green, `.pdf .ppt .key` red,
`.zip .rar .ai .mp3 .mov .avi` yellow, anything else by its extension's first letter.

## Switching tabs

`showLayout` with `animated`: **phase one, 180 ms `DEFAULT`**: the old page moves down
78 dp and its contents fade over the first 70%; the new one fades in (alpha 0 → 1) while
its offset goes 0 → 78 dp. **Phase two**: the new page springs back to 0,
**damping 0.75, stiffness 500**. The selected stadium moves with the tabs' own 320 ms.

## What we do

The same numbers, in Compose:

- **Window.** A full-window `Dialog` (no platform dim: our scrim is the 0.2 black) whose
  content is `AttachSheetLayout`; tests draw the layout itself.
- **Open/close.** `Animatable` offsets: the spring (0.75, 350) up; 250 ms
  `CubicBezierEasing(0, 0, .58, 1)` down by height + 10 dp. Scrim on its own 400 ms
  overshoot(0.7) clock (`AttachMotion.overshoot`). Tabs pop in by `AttachMotion.tabScale` /
  `tabAlpha` from the same 400 ms clock.
- **Drag.** A `NestedScrollConnection` on the grid and the file list: overscroll down at the
  top moves the sheet, scrolling up takes it back first, flings don't move it; on lifting the
  sheet goes at 0.8 cm (computed from the display's xdpi as Telegram does) or comes back in
  `250 × pulled / 0.8 cm` ms. Predictive back pulls the sheet down by the gesture's
  progress and closes it on commit.
- **Theme.** Telegram's blue is our accent only where Telegram uses its brand colour (the
  check, the send pill, the counter, the selected tab), as `AttachColors` in light and dark
  (Telegram's night values: the same blue, white unselected glyphs). The sheet is
  `colors.surface`; the glass is our `Glass` (`GlassSpec`) over the grid.
- **Foldables.** The sheet takes `ContentTokens.sheetMaxWidth` and centres, so on the 750 dp
  inner screen it is a 640 column, 55 in, the scrim either side. From 600 dp of sheet it
  has Telegram's tablet 4 columns, so a cell there (~157 dp) stays near a phone's (~134 dp)
  instead of stretching to 210.
- **The File tab** lists sources Android lets us read: Browse (the system document
  picker, `OpenMultipleDocuments`), Gallery (the system photo picker, sent as files) and
  Paste, then Recent files: the files sent from here before, kept readable with
  persisted URI grants. Android 11+ gives no app the Downloads folder Telegram lists,
  so its "Internal Storage" browser and Downloads list are not ported.
- **The tab bar** narrows to `80 × tabs + 36` and centres, Telegram's rule for a bar of
  few tabs (its poll attach), since we have two.
- **Preview.** A tap on a cell's picture opens it in the app's own viewer
  (`PictureViewer`: zoom for photos, playback for videos, open and close in
  220 ms ease-out, the grid's thumbnail drawn until the photo is read); the
  check picks, through a 48 corner (Telegram's 42).
- **Confirm as well as send.** Telegram's send pill stays in the caption bar
  and sends at once. The header's far end adds a check and the count (iOS's
  `SelectedButtonNode` shape): the picks go into the composer with the
  caption as its draft, and are sent from there.
- **Not ported:** the camera cell and in-sheet camera, albums drop-down, the in-sheet photo
  editor, spoilers, captions above media, scheduled and silent sends, the Lottie tab icons
  (outlined → filled vector swap on the same 320 ms).
