# Dynamic Type

happy-app scales text the way React Native 0.83 does on iOS, so the port
does the same, not UIKit's per-style ramp. Citations are to the
`react-native@0.83.1` npm package; read the source there.

## What React Native does

0.83 builds only the New Architecture (Fabric): `scripts/react_native_pods.rb`
99-103 forces it, and `scripts/cocoapods/new_architecture.rb` 156-157 always
says yes. The Paper path below is never taken.

| Step | Where | What |
|------|-------|------|
| Factor | `React/Base/RCTUtils.mm` 360-382 `RCTFontSizeMultiplier` | one factor per `UIContentSizeCategory`, read with `floatValue` |
| Into layout | `React/Fabric/Surface/RCTFabricSurface.mm` 183 | `layoutContext.fontSizeMultiplier` |
| Into text | `ReactCommon/react/renderer/components/text/ParagraphShadowNode.cpp` 79 | each paragraph's `textAttributes.fontSizeMultiplier` |
| Cap | `.../textlayoutmanager/platform/ios/.../RCTAttributedTextUtils.mm` 97-116 | with `allowFontScaling` (default on), `max >= 1 ? fminf(max, m) : m` |
| Font | same file 118-137, then `.../RCTFontUtils.mm` 333-406 `RCTFontWithFontProperties` | `size × m` (339) handed to UIFont, not rounded |
| Line height | `RCTAttributedTextUtils.mm` 224-228 | `lineHeight × m`, not rounded |
| Kern | `RCTAttributedTextUtils.mm` 186-188 | `letterSpacing` as given, not scaled |
| Inputs | `React/Fabric/Mounting/ComponentViews/TextInput/RCTTextInputComponentView.mm` 143, 291 | same attributes at `RCTFontSizeMultiplier()` |
| Text box | `.../RCTTextLayoutManager.mm` 391-392 | measured size ceiled to the screen's pixels |

Not scaled: Yoga sizes, paddings, fixed `height`s and icons.

Not used under Fabric: `React/Views/RCTFont.mm` 421-422 rounds
`size × m` to a whole point; that is Paper's `RCTTextAttributes.mm` 229-235.

Quirk not ported: the system-font cache (`RCTFontUtils.mm` 258-318) keys on
`%.1f` of the size (264), so two system fonts within 0.05pt can share
whichever was made first.

happy-app sets one cap: `maxFontSizeMultiplier={1.2}` on the onboarding
titles (`OnboardingContent.tsx`, `TITLE_MAX_SCALE`). It sets no
`dynamicTypeRamp`.

## Where it is ported

- `HappyLayout/TextScale.swift`: the factors, the cap, and
  `TextStyle`/`ChatTextStyle.scaled(_:)`. `maxScale` on a style is the cap;
  only `TextStyles.onboardingTitle` has one (1.2).
- `HappyUI/Theme/TextEnvironment.swift`: `TextEnvironment` (text size and
  display scale, from traits), `font(in:)`/`lineHeightValue(in:)` cached per
  face and size and safe off main, and the `FollowsTextSize` trait.

## Which screens follow it

A screen follows the text size when its controller calls
`followsTextSize()`, which sets the `FollowsTextSize` trait on its view.
`StyledLabel` draws scaled only under that trait, and draws again when the
size changes; everywhere else it draws as designed. A screen opts in only
when every height on it is measured from its text as drawn, never from a
plan made at the designed size.

Following now:

- Settings and every page under it (Account, Appearance, Agents, Language,
  Claude Code, What's New), the custom server page and the server
  confirmation.
- Onboarding: Welcome, Restore (QR and secret key), Link Your Computer. The
  hidden copies that reserve the block's height are in the tree, so they
  are measured at the same size. The titles stop at 1.2.
- Their inputs (the server field, the secret key) and the text not drawn by
  `StyledLabel` (What's New's paragraphs, the Claude command).
- The chat's composer, on its own: `SessionComposerView` sets the trait on
  itself, because its height is worked out from its text as drawn every
  time the chat lays out, and nothing in the chat's plan assumes it. The
  card (`AgentInputCardView`) draws its input, placeholder and line, chip
  labels and "·" scaled; the status, week and context text and the
  suggestion rows are scaled too. Each re-reads the traits before it
  measures, so a height asked for before the trait update is measured at
  the size it then draws. The input's text is measured off main
  (`ComposerTextHeights`), keyed on the scaled style, so a size change
  measures it again; the labels are measured on main. A size change
  redraws and asks the chat to lay out again. Tap targets are the measured
  frames, so they grow with the text; the slop around them is fixed, as
  RN's `hitSlop` is.

Fixed RN sizes stay fixed: icons, the wordmark, the checklist boxes,
paddings, and minimum heights (rows 44, buttons 50/44/32, Get help 36),
which taller text grows past. In the composer: the 44 and 40 input
minimums and the 120 cap (two lines at the largest size already scroll),
the 42 and 40 action rows and the 40 chips in them, the 32 send, the 48
suggestion rows. Text taller than a fixed row is centred on it and spills
past; in the 42 row it is cut by the middle box, as RN's
`overflow: 'hidden'` cuts it.

## Not yet wired

- Home, the session list, the sidebar, the chat, message detail, diffs and
  the file viewer: their heights are planned off main at the designed size.
  Their measurers take a `TextEnvironment` as an input and cache key, a
  text size change invalidates every height as a width change does, and
  then their screens opt in. `HomeRowHeights.flatSession` comes from the
  scaled lines instead of 81.
- Home's dock (the same card, under a screen that doesn't follow, so it
  stays at the designed size) and the new-session screen.
- On a device: the composer at each size, the chips' native menus over
  their scaled labels, and a size change while typing (the typed text is
  restyled in place, which may end an IME composition in progress) have
  not been looked at; only the geometry is tested.
- Navigation bar titles (`NavigationTitleView`, What's New's title).
- Measured text boxes ceil to pixels as RN's do.
- Fonts made outside `TextStyle` (session info's duplicate sheet, code
  blocks).
