# Product observations from native screenshot review

Initial review used mobile source `a186dc04`, native Android API36 development
builds, dark mode, and dedicated phone/7-inch/10-inch emulators. The owner then
requested small product fixes and new captures. The three issues below were
fixed in the real app, not hidden by screenshot-only rendering. The selected
Android sets were retaken with those changes. Sample content still comes
through the isolated encrypted integration harness. Check the intended release
build and physical devices before treating emulator coverage as full platform
verification. No OTA or store upload is part of this work.

## Android model-picker readability

- Reproduce: open a populated conversation, then open the model picker.
- Observed on phone and both tablet targets: conversation text remains sharply
  visible through the menu and overlaps provider/model labels. The foreground
  is difficult to read; this is not a composition or image-resizing artifact.
- Relevant implementation: `packages/happy-app/sources/components/MobileGlass.tsx` uses an Android
  `View` fallback with the translucent glass background, without the iOS blur
  layer. Inspect the picker material and Android contrast as a product fix.
- Original raw evidence: `.context/play-store/phone-models-inspect.png` and the
  first tablet model-picker captures, retained privately as outtakes.
- Fix: `FloatingOverlay` uses an opaque Android surface, while `AgentInput` and
  both `HomeDock` writing states use the opaque input color. Android does not
  have the iOS blur layer. iOS glass and web materials are unchanged.
- Native verification: the new model cards have no transcript text behind the
  menu labels; session rows no longer show through the phone's home input.

## Small landscape tablet loses its session header

- Reproduce: on the 1920×1080 / 288dpi 7-inch-class Android device, open a session
  in landscape. The native session header and its Changes entry are absent.
- The ordinary authenticated session Changes route still works and loads the
  public source diff; the underlying capability is available.
- `packages/happy-app/sources/utils/deviceCalculations.ts` intentionally classifies devices below
  its 9-inch heuristic as phones. `packages/happy-app/sources/-session/SessionView.tsx` then hides
  the whole header for native landscape phones. The resulting navigation
  limitation should be reviewed separately from the device-classification
  decision, including compact tablets and foldables.
- Fix: Android keeps the existing 48dp compact landscape `ChatHeaderView`, with
  the matching content inset and no duplicate floating back button. Device
  classification, tablet/sidebar architecture, and iOS behavior are unchanged.
- Native verification: the 7-inch plan now reaches Changes by tapping the real
  session header and its Changes action, not through the earlier deep-link
  workaround. The same real file RPC loads the source diff.

## Session timestamps truncate their AM/PM suffix

- Observed in the phone list and 10-inch sidebar: the latest session time is
  shortened to `12:55 A…`, although the title also occupies a separate truncating
  column. Short weekday/date stamps fit, so older rows do not reveal the issue.
- Original evidence: first-take `02-sessions.png` in both Android targets, and
  the 10-inch `04-multiplayer.png`. The full timestamp remains in the accessibility tree;
  this is a visible width/layout issue, not incorrect fixture time data.
- Reproduce with a two-digit 12-hour time plus AM/PM in the default locale, then
  review the timestamp's width allocation across phone and sidebar layouts.
- Fix: `FlatSessionRow` uses the timestamp's intrinsic width, with a 56dp minimum
  and no flex shrinking. Its text stays mounted but visually/accessibly hidden
  while the status dot is overlaid, so clearing unread does not resize the slot
  or move the title. Time formatting, sorting, and unread semantics are unchanged.
- Native verification: the replay opens the new conversation and returns to the
  list before capture; the selected images show its full AM/PM timestamp.

## Small tablets and foldables need width-aware navigation

- Owner feedback: the 7-inch landscape screenshots waste space in the phone
  layout. The same limitation would affect sufficiently wide unfolded phones.
- Cause: the shared layout hook used the estimated 9-inch device threshold,
  although logical points/DPI do not establish a device's physical diagonal.
- Fix: tablet-style navigation uses the current window width, starting at
  768 logical pixels. The minimum 250px sidebar leaves 518px for content.
  Narrow windows keep the single-column UI; wider windows share the same
  sidebar, header, chat insets, and dock decision. Height does not control the
  breakpoint, so an Android keyboard cannot collapse the sidebar.
- This is ordinary production responsiveness, not a screenshot override.
  Device diagnostics and native platform flags are unchanged. Actual foldable
  hardware still needs validation; emulator rotation checks do not prove every
  hinge, safe-area, or multi-window configuration.
- Native rotation exposed stale React Native `Dimensions`: after the 7-inch
  window changed from 1067×600 to 600×1067 logical pixels, its cached dimensions
  stayed in landscape. The existing Unistyles runtime reported the correct
  current window bounds and reacted in both directions without a reload.
  Navigation, orientation, drawer width, chat layout, and the compact composer
  now share a window-metrics hook: Unistyles on Android API 30+, React Native
  elsewhere. Earlier Android uses physical display bounds in Unistyles, so it
  must retain React Native's window metrics for split-screen sizing. No native
  dependency, injected dimensions, new provider, or capture-specific code was added.
- Native verification on the final bundle: rotate the same open conversation
  from 1067dp-wide landscape to 600dp-wide portrait and back, without reloading.
  The sidebar disappears and returns, and the compact composer follows the
  narrow layout. Opening and closing the real Android keyboard preserves the
  wide sidebar and selected conversation. Phone portrait remains single-column.

## Screenshot selection feedback

- The third Android tablet scene was captured with its Changes file collapsed,
  leaving a largely empty view. Retakes must show useful expanded content,
  reached through normal app controls and fully loaded before capture.
- Android phone compositions should have a restrained Android-specific frame,
  without copying Apple's frame or painting over the captured native UI.
  Tablet exports remain native UI-only.

## Capture/setup issues, not confirmed product bugs

- A one-shot sample conversation producer loses its presence. The producer now
  owns a normal live session connection until capture ends, then confirms
  deactivation through the same non-deleting archive endpoint as the CLI.
  This avoids stale active fixtures between takes; no archive filter or Agent
  metadata is patched.
- Tool-service interruption stopped the owned emulators/server. Runtime recovery
  preserved their private account/database and did not reset app data.
- A later Metro reload still served old route/style modules during live editing.
  The owned gym was stopped; only its exact private transform cache and file-map
  were moved into a recoverable ignored backup. Restart plus normal device reload
  produced the current UI. Stale-bundle outtakes were rejected, not published.
- Native file loading is asynchronous. Plans must wait for visible diff content,
  not select a screenshot containing a loading spinner.
- Fictional participant envelopes verify author rendering, not authenticated
  multi-account team sharing. That separate product flow still needs proof
  before publishing the collaboration card in a store listing.
