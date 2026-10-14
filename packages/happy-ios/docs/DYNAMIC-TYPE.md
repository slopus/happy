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
| Input measure | `ReactCommon/react/renderer/components/textinput/BaseTextInputShadowNode.h` 61-71, then `.../RCTTextLayoutManager.mm` 223-236 | a TextInput's height is its text laid out by TextKit 1 (an `NSLayoutManager`, `usesFontLeading = NO`, no line fragment padding), ceiled as above |
| Input view | `Libraries/Text/TextInput/Multiline/RCTUITextView.mm` 37-62, `RCTTextInputComponentView.mm` 89, 819 | a multiline input is `[RCTUITextView new]`, UIKit's default TextKit 2 text view; nothing asks it for its `layoutManager`, so it stays TextKit 2 and draws its text inside the TextKit 1 frame |

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
- Troubleshooting, the offline checklist home shows when every computer is
  offline, and the QR scanner (happy-app opens the system's, which scales).
- Their inputs (the server field, the secret key) and the text not drawn by
  `StyledLabel` (What's New's paragraphs, the Claude command, terminal
  lines).
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
  That measure is TextKit 1 (`ComposerTextMeasure`), as Fabric's is (the
  table's input measure), and the input's frame is exactly its height; the
  text view inside it is TextKit 2, as RN's `RCTUITextView` is (so is New
  session's prompt, at its designed size). TextKit 2 lays a scaled line
  (22 × m, fractional) out a little short, and more so each line: the
  TextKit probe's Mac run (38512168032) found 1.5, 2.5, 3.5 and 5.5pt to
  spare for 1, 2, 3 and 5 lines at the largest size. RN's composer is the
  same TextKit 2 view (`RCTUITextView.mm` 37-62, made by
  `RCTTextInputComponentView.mm` 89, 819) in the same TextKit 1 frame
  (`RCTTextLayoutManager.mm` 223-236), so its text has the same space to
  spare; that is read from RN's source, not measured in RN. So the text
  sits inside its frame, never past it: in all 59 of the probe's rows
  under the cap TextKit 2's own height was within the frame, the two
  TextKits broke all 84 rows into the same lines, and at every one of the
  twelve sizes they wrapped a test sentence at the same character. As the
  shortfall grows with the lines, no single adjustment makes TextKit 2 lay
  out the measured height, and the measure stays TextKit 1. At the default
  size (Large) a one-line caret reaches half a point into the 4pt bottom
  padding, in both TextKits alike; it stays inside the view. UIKit
  resolves a TextKit 2 view's Writing Tools to the complete, inline
  experience, as RN's composer has it, where a TextKit 1 view gets the
  panel; on the Mac simulator that is the resolved property, read without
  Writing Tools being available, not rewriting at work. None of the
  composer's text views is TextKit 1: the card, the flat panel and New
  session's prompt are all TextKit 2, so all three resolve it alike. That
  closes review item TK-L3 (a TextKit 1 composer gets only the panel,
  where RN's gets the inline experience): R1 made the card TextKit 2
  again, and New session's prompt stays TextKit 2.
  The measure lays the text out with font leading off
  (`usesFontLeading = false`), as Fabric's does (the table's input
  measure). Until the port's composer tests first ran on the Mac (38518414723) it left it on, and a
  line in a fallback font that has leading was measured taller than the
  text view lays it out: Japanese falls back to Hiragino Sans, whose
  leading is half its size, and Arabic to Geeza Pro, so at the default
  size the card's input was 95 tall for the Japanese test text where the
  text needs 74, and 57 for the Arabic where it needs 52. IBM Plex Sans,
  PingFang SC and Apple Color Emoji have no leading, so Latin and emoji
  measure as before. It goes by line, not by text: each of the 95 lines
  whose height changed holds at least one font with leading, and no line
  without one changed; the Japanese and Arabic texts mix fonts without
  leading (PingFang SC, IBM Plex Sans) into the same lines. The diagnostic
  probe's run (38523578708) measured every row both ways, 255 rows over
  the card, the flat panel, New session's prompt and the growth texts:
  with leading off the measure is the TextKit 1 twin's height exactly on
  all 181 rows under the cap, the 39 rows that differed agree, none that
  agreed differs, and none of the 179 Latin rows moves. The other 37 rows
  still differ only past the cap, where the measure stops a line past it
  by design and every one scrolls at 120 either way. Three texts that
  scrolled no longer do, as their text fits: the card's Japanese at XXXL
  (120 to 98) and the flat panel's Japanese and Arabic at AX-L (120 to
  111). In all 34 rows whose frame moves, the TextKit 2 text fits its new
  frame, in TextKit 1's lines. Disclosed, and not explained or not
  verified:
  - A TextKit 1 text view's layout manager reports `usesFontLeading` on,
    yet lays the text out line for line as a bare layout manager with it
    off does, on all 181 rows (FA-L1). The change rests on RN's source
    and on those rows, not on knowing why.
  - With leading off, TextKit 2's rendering surface (how far it may draw,
    not where its lines end) reaches past the frame's bottom on 8 Arabic
    rows, by 1 to 3pt: the card at S 48 in 47, M 51 in 50, L 54 in 52,
    XL 60 in 58, XXL 65 in 63 and XXXL 71 in 68, the flat panel at AX-M
    96 in 95 and AX-L 114 in 111; under the old frames, none. Its lines
    end inside the bottom padding (at L, 47.4 in 52). RN's composer is
    the same TextKit 2 view in the same frame, so it reaches as far past
    (read from its source, not measured in RN). Whether any text is
    actually cut is not proven; nothing is padded for it (FA-L2).
  - On the Japanese text's first lines, which start in PingFang SC,
    leading on added 0.56 of Hiragino's leading, not all of it (FA-L3).
- The chat's worktree tab strip, on its own (`ChatWorktreeTabStrip` sets
  the trait on itself). Its heights are fixed (the 40 capsule, the 32
  tabs); only the tabs' widths come from their names, up to 200. The names
  are measured off the main thread (`WorktreeTabNames`, one per account),
  kept by text, face and `TextEnvironment`, and a strip places its tabs
  once theirs are in; a size change measures them again. A name taller
  than its tab is centred on it and cut by the capsule.

- The iPad sidebar's list grouped by project, its own rows only: the
  "Bots" and day headings, the computers' rules, the checkouts' headings
  (project, branch, line changes) and the archive toggle draw scaled, and
  their heights are measured at that size off the main thread
  (`TabletGroupedHeights`, from one line of each style, ceiled to the
  screen's pixels as its label measures it, through the
  HappyLayout layouts), keyed by the heading, the list's width and the
  text size and screen scale, and measured again only for what changed.
  A heading's key holds the person's words (a computer's name, a
  project, a branch) but none of the app's: "Bots", the days and "Show
  archived" are one line in any language, so the derivation never reads
  the screens' language, which is the main thread's. A new text size or screen scale goes through the sidebar's
  pipeline: every heading is measured again there, and only rows whose
  height moved make the table ask again. The chats (56,
  ActiveSessionsGroupCompact.tsx `sessionRow`) and the archived cards
  (88, SessionsList.tsx `sessionItem`) are fixed heights in RN, so they
  stay that tall at every size and draw their text scaled inside,
  centred. What outgrows them is cut where RN cuts it: a chat's at its
  own 56 row (it sits in react-native-gesture-handler 2.30's Swipeable,
  whose container is `overflow: 'hidden'`, Swipeable.tsx 585), not at
  the card, so it never spills over the rows next to it; an archived
  card's at the card's edge, borders and rounded corners included
  (`sessionItemContainer`'s `overflow: 'hidden'`). The glyphs, the
  faces and the `+` keep their size. Each cell sets the trait on itself;
  the list does not, because its bots (home's flat rows) and its notices
  are planned there at the designed size.
- Home's "No sessions yet" (EmptyMainScreen.tsx with a computer linked):
  the title, the line under it, "Start New Session" and "Show archived".
  Their sizes are measured off the main thread (`NoSessionsMeasure`, the
  labels' own styles and line limits through TextKit 1, ceiled to the
  screen's pixels, and through the HappyLayout layouts; a line that runs
  past the width, cut short or wrapped with its space past the edge, as
  "Show archived" and the title are at the largest size, takes the whole
  width, as a label measuring itself does), keyed by the
  words, the content's width, the text size, the screen scale and whether
  the archive is offered; a result for anything else is refused. The view
  lays out only what was measured, and gives the two buttons their
  labels' sizes, so nothing on it measures text on main. The 56 glyph and
  the button's 50 minimum keep their size. Taller than the space between
  the header and the dock, RN's plain View would push the title under the
  header and the button under the dock; here the content starts at the
  top of the safe area and scrolls instead (`NoSessionsLayout`), so every
  control can be reached. The title's and the line's 30 and 22 point
  lines are this app's tokens; RN gives them the font's own line (31.2,
  20.8), at every size, so the two don't match to the pixel.
- The iPad sidebar's own controls: New session, Settings and the empty
  state (EmptySessionsTablet). Each sets the trait on itself and is
  measured from its text as drawn when the sidebar lays out
  (`TabletSidebarLayout`), so the button and the row grow with it and
  the list takes what is left; the glyphs, the 40 archive button and
  the paddings keep their size.
- Home's session list (`SessionListViewController`), flat and grouped by
  project, with the notices over it, and the iPad sidebar's flat list,
  which is the same list. Its heights come from one environment worked
  out off the main thread (`HomeTextEnvironment`): one line of each
  style the rows draw, as a one-line label measures it (the style's
  line × RN's multiplier, up to the screen's next pixel,
  `TextStyle.oneLine(in:)`), the glyph boxes and the hairline. It is
  made from the text size and the screen scale alone, which is all it
  depends on, and only one made for the size and scale last asked for
  lands; any other is refused and the rows keep the heights they have.
  A flat session (FlatSessionRow.tsx) is as tall as its lines: 10 +
  max(60, the title's line or the corner's 22, the project's line, 1,
  the workspace's line or its row's 18) + 10, so 81 as designed, 80 at
  the smallest size, where the avatar holds the row, and 235⅔ with a
  workspace (189⅓ without) at the largest on a 3x screen
  (`FlatSessionRowLayout.Lines`). The headings are their line and
  their padding, as before. The project card (52 + 8), the worktree
  rows (48) and the bots' and archived chats' rows (48) are fixed
  `height`s in RN (ProjectHomeList.tsx), so they stay that tall and
  their text, scaled, is centred in them and spills past when taller.
  The notices are measured off the main thread at the size, keyed by
  their words, the list's width, how wide a group may grow and the
  environment; a height for anything else is refused. The first show
  has no rows until the first environment is in, one hop; a new size
  keeps every row on screen while it is worked out, then moves the
  heights in one batch with the row at the top of the list kept where
  it was. That batch reconfigures every session row, so a cell the
  table has already made for a row below the screen takes the new
  lines too. Between the new size and its heights the labels are
  already drawn at it, in the old heights; RN commits the new fonts and
  the new layout together, so for that moment the native list differs
  from RN's. The glyphs, the avatars, the `+` and the paddings keep
  their size.
  Not yet: the cells still measure their labels' widths on the main
  thread when they lay out (the timestamp's, the workspace's, a
  heading's, the line changes'), as they did at the designed size; no
  height depends on it.
  Happy Agent's line counts (`RigGitLineChanges`) end the third row as
  RN's do: 11pt with no line height, so their line is Plex's own 1.3
  em at the size, up to the screen's pixel. That line is in the
  environment too and the row's kind says whether it has counts, so a
  row with counts and no workspace grows its third row past 18 at the
  largest sizes, as RN's does. "+12" and "-3" ask for weight 600 in the
  default family, `IBMPlexSans-Regular`, which expo-font makes an alias
  for that one face; RCTFontUtils.mm's closest weight has nothing else
  to pick, so they are drawn regular, and so are they here (from RN
  0.83.1's and expo-font 55.0.4's source; not yet seen on a device).
  Still not ported, so the third row is not yet RN's whole: the draft
  glyph (13, `create-outline`) before the counts. This much of the
  row's `workspaceMeta` gap stays open. The glyph keeps its 13 at every
  size, under the row's 18, so it would not change a height.

## Header titles

happy-app has two kinds of header on iOS (`app/(app)/_layout.tsx`):

- UIKit's, through react-native-screens, on most screens. Its title is
  `IBMPlexSans-SemiBold` 17 (`DEFAULT_TITLE_FONT_SIZE`), made with
  `scaleMultiplier:1.0` (react-native-screens 4.22.0
  `ios/RNSScreenStackHeaderConfig.mm` 41, 480-505), so it never scales.
- Its own `Header.tsx` (`header: createPlainHeader`: Settings, message
  detail, session info, machine, changes, What's New) and
  `OnboardingHeader` (Welcome, Link Your Computer, Home's link state). The
  title is an RN `<Text>` (16, semibold; the subtitle 11), so it scales,
  uncapped, in a header that keeps its height.

Here the bar's own title is react-native-screens' (IBMPlexSans-SemiBold
17, a font and a colour: `AppCoordinator.nativeTitleAttributes`) and never
scales. Settings, What's New, Welcome, Home, session info, machine and
changes put their title in a title view that follows the text size and is
fitted again in the bar when the size changes (session info, machine and
changes through `setPlainHeaderTitle`, which keeps `title` for the back
button). On those three only the title follows; their rows don't yet.

Fixed RN sizes stay fixed: icons, the wordmark, the checklist boxes,
paddings, and minimum heights (rows 44, buttons 50/44/32, Get help 36),
which taller text grows past. In the composer: the 44 and 40 input
minimums and the 120 cap (two lines at the largest size already scroll),
the 42 and 40 action rows and the 40 chips in them, the 32 send, the 48
suggestion rows. Text taller than a fixed row is centred on it and spills
past; in the 42 row it is cut by the middle box, as RN's
`overflow: 'hidden'` cuts it.

## Not yet wired

- The rest of the sidebar (the grouped list's bots and the notices over
  them), the chat, message detail, diffs and the file viewer: their
  heights are planned off main at the designed size.
  Their measurers take a `TextEnvironment` as an input and cache key, a
  text size change invalidates every height as a width change does, and
  then their screens opt in.
- Home's dock (the same card, under a screen that doesn't follow, so it
  stays at the designed size) and the new-session screen.
- The `createPlainHeader` title of message detail (Chat's).
- The rows of session info, machine and changes.
- On a device: the composer at each size, the chips' native menus over
  their scaled labels, and a size change while typing (the typed text is
  restyled in place, which may end an IME composition in progress) have
  not been looked at; only the geometry is tested.
- On a device with Apple Intelligence: Writing Tools rewriting the
  composer's text inline. Only the behaviour UIKit resolves (complete) is
  tested, and the TextKit 2 editor's spare space is from the simulator.
- On the Mac simulator: the port's own tests of the TextKit 2 composer
  (its fit and carets at every size in `ComposerEditorGeometryTests` and
  the card's and New session's tests, and `ComposerWritingToolsTests`)
  ran once, before the measure turned leading off (38518414723): the
  card's and Writing Tools' passed; the geometry matrix and two of New
  session's height tests failed, on the Japanese and Arabic measure and
  on their own checks of carets past the cap and of New session's
  carets. They have not run since. Those two checks have changed, from
  the probe's run (38523578708):
  - Past the cap, `scrollRangeToVisible` never moved the text in the test
    bundle, in either TextKit, in a window with a scene whether shown or
    not, so a caret is no longer checked inside the view once scrolled
    to. Each is checked within reach instead: inside the text's content
    and no taller than the view. In the probe that held at all 784 carets
    on the 77 rows past the cap, in both phases. That is the test
    bundle's arithmetic, not a device: the text following the caret
    while typing past the cap is UIKit's own behaviour, the same view as
    RN's, and has not been looked at (FB-L1).
  - New session's prompt has no insets, and its first caret starts a
    point above the view and its last ends half a point below, in
    TextKit 1 and 2 alike; its carets are now held to a TextKit 1 twin's,
    and its text's layout fragments and lines to the view, which they
    stay inside on all 10 of the probe's rows. TextKit 2's rendering
    surface reaches 1 to 3pt above it, and below it for Japanese and
    emoji (67 in 66) and Arabic (50 in 44, with the measure's leading
    off; 50 in 49 before); RN's prompt is the same view with no insets
    either, and whether any text is cut is not proven (FC-L1).
  - A text that scrolls from exactly the cap (the flat panel's five lines
    at M: 120 in 120) is checked as scrolling with its content as tall as
    the view, as RN scrolls from the cap (`MultiTextInputLayout`).
  - Thai, Devanagari and Korean join the texts, under the same checks.
- Measured text boxes ceil to pixels as RN's do.
- Fonts made outside `TextStyle` (session info's duplicate sheet, code
  blocks).
