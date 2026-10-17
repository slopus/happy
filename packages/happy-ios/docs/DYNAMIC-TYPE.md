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
size changes; everywhere else it draws as designed. A new label draws
nothing until it is first measured, laid out, drawn, read or put on a
window, and then takes the traits UIKit would hand it before its next
layout: a label made and set up off its screen and then put in it draws
its text once, at the screen's size, where it used to draw once as
designed and again when the screen's size reached it (`StyledLabelRenderTests`).
A screen opts in only when every height on it is measured from its text as
drawn, never from a plan made at the designed size.

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
  `StyledLabel` (the Claude command, terminal lines).
- What's New's releases: the titles, summary lines, paragraphs and bullets
  are laid out off the main thread at the list's width and text size
  (`ChangelogPlan`, with the screen's `TextEnvironment` in its input), so
  a new size plans every release again once, off the main thread, and the
  old plan stays drawn until the new one is in. `GroupedListMeasureTests`
  checks the drawn frames against the plan at L, XXXL, AX-M and AX-XXXL.
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

- The iPad sidebar's list grouped by project: the "Bots" and day
  headings, the computers' rules, the checkouts' headings (project,
  branch, line changes), the archive toggle and the bots draw scaled,
  and their heights are measured at that size off the main thread
  (`TabletGroupedHeights`, from one line of each style, ceiled to the
  screen's pixels as its label measures it, through the
  HappyLayout layouts), keyed by the heading, the list's width and the
  text size and screen scale, and measured again only for what changed.
  A bot is home's flat row (FlatSessionRow.tsx) and is as tall as it is
  on home: its lines are the ones `HomeTextEnvironment` works out (the
  same `TextStyle.oneLine(in:)`), and its key is only whether it has the
  workspace's line and line counts, so 81 at the designed size whatever
  it shows, and 235⅔ with a workspace at the largest on a 3x screen; a
  new size reconfigures every bot in the batch that moves the heights,
  so a cell made ahead for a row off screen takes the new lines too.
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
  faces and the `+` keep their size. Each cell sets the trait on itself,
  and the notices over the list (home's header) too. They are measured
  off the main thread as home's are (`HomeRowMeasurer.headerHeight`),
  keyed by their words, the list's width, how wide a group may grow and
  the text size and screen scale; only a height measured for what was
  last asked for lands, and the header shows the words it was measured
  with.
- Session info and the machine screen (Header.tsx's title and every row:
  the Item rows, the line counts and the changed files beside "Changes",
  the trailing values, which are the system font at 14 × the multiplier,
  and the raw JSON blocks, Menlo 12 on an 18 line, both × the
  multiplier). Their rows are measured from their labels as drawn when
  the list lays out, as Settings' are; a size change lays the list out
  again. The raw JSON blocks are the exception: they are laid out off
  the main thread at the text size (`CodeBlockView`), and the block grows
  when its layout lands. The glyphs, the 29 icon squares and the 44 row minimum keep
  their size. Session info's duplicate sheet (DuplicateSheet.tsx) sets
  bare font sizes, so its text is the system font at its size × the
  multiplier and the row preview's 19 line likewise; the card, its list
  and its buttons are laid out from the labels as drawn, so they grow
  with the text, and the list shrinks first and scrolls, so the card stays
  inside 85% of the window (`DuplicateSheetLayout`; upright on a phone
  the list's 420 cap holds it even at the largest size).
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
  The draft glyph (13, `create-outline`) leads the counts in the row's
  `workspaceMeta`, as RN's does. It keeps its 13 at every size, its box
  13⅓ tall at most, under the row's 18, so it changes no height; the
  sidebar's 14 in a chat's slot and 12 over an archived card's avatar
  sit in fixed boxes too.

- Home's dock, resting and open (HomeDock.tsx). The capsule keeps its
  56 and its prompt, scaled, is centred in it and cut at its edge, as
  `composerSurface`'s `overflow: 'hidden'` cuts it. The open composer's
  screen follows (`followsTextSize()`), so Composer's card draws scaled
  there as in the chat, its text measured off the main thread with the
  text size in its key (`textKey(fitting:)`), which the open's two-frame
  wait and the Session | Bot premeasure already use. A picker row is
  RN's 42, or one line of `focusConfigTriggerValue` (17, Plex's 1.3 em)
  when that is taller; the menu's value, the system's body font, which
  scales on its own, is centred in it and moves no height. The lede, the
  status line and the faces' "Avatar" and credit draw scaled. Their
  heights come from `HomeDockText`, made off the main thread for the
  text size, the screen and the lede's lane, and asked for by home as it
  lays out, so the open finds them made; the open waits for them inside
  the same two frames as the card's text. The 24 icon box, the 42
  minimum, the 32 segmented control, the faces and the die keep their
  size.
- The new-session screen (new/index.tsx). The prompt draws at `16 × m`
  on a `22 × m` line, measured off the main thread with the scaled style
  and line in its key, so a new size measures it again; the typed text
  is restyled in place, its selection kept. Empty, it is one line up to
  the screen's next pixel, as Fabric ceils an input's box, and it is
  centred in the 44 field to the pixel above, so its snapped frame keeps
  the height measured: centred exactly, a height an odd number of pixels
  off the 44 starts on half a pixel, and the frame was a pixel taller or
  shorter than the text (37⅓ for 37 at XS; and an empty line of 18.11
  was snapped to 18). The 44 field, the 120 cap,
  the 40 action row, the 36 harness capsule and the 38 controls keep
  their size. Every label's size (the place rows, the offline help, the
  harness's name, the pickers' options, sections, notes and empty
  lines, a settings page's title) comes from `MeasuredLabelSizes`: the
  label's words, style, lines, alignment, text size, screen and width,
  measured off the main thread as a label measures itself. A size not
  yet measured stands as one line of its style at the width asked, and
  the screen lays out again once when the pass lands, so a label that
  wraps, or one whose width places what follows it (the harness's
  chevron), is a frame late the first time it is seen. The search and
  path fields are one line of their style. The header's pill grows with
  its title in a 44 capsule.

- The chat's rows, its header and the bars over its composer, and message
  detail. The list (`ChatListView`) carries the trait itself, and so do
  the placeholder over it, the header's title views, the CLI warning and
  each bar over the composer; the screen's own view doesn't (the composer
  and the worktree tab strip set it on their own). Message detail calls
  `followsTextSize()`. happy-app sets no cap in the chat
  (`maxFontSizeMultiplier` appears only in `OnboardingContent.tsx`), so
  nothing is capped.
  - Planned off main at the size: the list's `TextEnvironment` and the
    rows' words go into every row's input (`ChatRowText` in
    `ChatRowStyle`; `MessageDetailInput.text`), so `RowPlanner`, which
    keys on the input and the width, measures every row again once on a
    new size: one off-main pass and one apply, all reconfigures, nothing
    inserted or moved. A streamed token after it still measures only its
    own bubble. A result planned for another size is refused; the next
    pass has the new one.
  - What grows: every chat style's size and line by the multiplier, the
    kern as given (`ChatTextStyle.attributes(in:)`), the spans' faces and
    inline code (`ChatSpans`), code blocks and their syntax runs
    (`ChatSyntax.string(in:)`), the running tool's timer (it draws at its
    row's size, not its traits', in the room the row measured for "000.0s"),
    and the diffs inside tool cards (`DiffChunkPlan(text:)`,
    `DiffHeaderPlan(text:)`). What stays: the glyphs (the tool header's 24
    and 20, the status 16, the goal's 16, the chevrons), the paddings and
    margins, the 32 older end, the markdown table's 8.5 a character column
    estimate, and the minimums (the 44 work header, the 34 permission
    buttons, the 44 options), which taller text grows past. The user
    bubble's status line keeps `pendingStatusText`'s fixed 14, and its
    text is cut there from a little past the default size; RN's `height:
    14` also stops it growing (read from MessageView.tsx, not seen in RN).
  - A new size keeps the reader's row where it was (`ChatScrollAnchor`)
    and message detail the text at the top of the screen
    (`MessageDetailReadingPlace`). Until the new plans land the old ones
    stay drawn whole: the text is in the plan, so a row never mixes sizes.
  - The placeholder (EmptyMessages, the pending chat's and the deleted
    state) is measured off main (`ChatPlaceholderMeasure`, through
    `OffMainPlan`): its words are read on main when it is shown, then a
    background task measures them at its width, text size and screen
    scale, and only a plan for what was asked last is drawn, whole. Its
    height only centres the column (`ChatPlaceholderLayout`), so the
    keyboard moving the dock measures nothing. Until the first plan is in
    it shows nothing, the loading spinner included; after a change the
    last plan stays until the next. Its glyphs (72, 64, 48), margins and
    paddings, the paging spinner and RoundButton's 32 stay.
  - The header (ChatHeaderView) and the CLI warning under it, measured
    off main (`ChatHeaderMeasure`, through `OffMainPlan`): what they say
    is read on main, a background task lays their text out at the width
    they have, the text size and the screen, and the view draws the plan
    for what it asked last. On a phone the capsule asks the bar for the
    size its plan made at its widest says, and is planned again at what
    the bar hands over when that is less; it keeps
    `MOBILE_GLASS_CONTROL_SIZE`'s 44 at every size, the title and its row
    centred on its middle, and cuts what runs past it, as
    `mobileTitlePillGlass`'s `overflow: 'hidden'` does (from XXXL, or
    XXL with line changes, the two lines are taller than 44). The line changes are drawn
    from the plan too (`ChatGitChangesPlan`), in the project list's
    styles. On a tablet the column is measured to the row the bar leaves
    it and spills past the bar's height, as RN's unclipped header content
    does. The pill grows with its label; its 14 glyphs stay. Until its
    first plan is in, a title shows nothing and the pill isn't placed.
    UINavigationBar holds the text size its title view inherits to XXL
    (its content view's `maximumContentSizeCategory`, on the iOS 26.5
    simulator: 19.76 for a 16 title); Header.tsx's RN Text has no such
    cap, so the screen hands the title views its own size
    (`ChatHeaderTitleView.text`) and they plan at that.
  - The bars over the composer (InactiveArchivedHint, AgentGoalBar,
    AgentQuestionBanner, RigActivityBar), measured off main
    (`ChatDockBarMeasure`): each reads its words on main when it is shown
    and is laid out by its HappyLayout layout at the width the dock asks
    for. The dock takes a bar's height from its plan, so a bar that comes
    has no height until its plan is in; then it tells the screen, which
    lays the dock out again, animated as a bar coming or going is. A new
    text size marks the screen for layout, which asks each bar for its
    height at the new size. A bar that goes forgets its plan, so it comes
    back with nothing old in it. What stays: the glyphs (the
    banner's 20 and its 18 chevron, the goal's 18 and its 30 pt buttons,
    the rig's 12, the copy glyph's 16), the paddings and margins, Resume's
    44, which its label (SF 15, a line of about 17.9) spills out of from
    AX-XL as RN's fixed `height` lets it, and the commands' 48 minimum, which they grow past. The
    dock's height feeds the list's newest-edge inset and the scroll
    button's place (`ChatScreenLayout`), which follow it.
  - A text box ends on the screen's next pixel, as RN's does
    (`ChatTextLayout`, `PixelGrid.ceil`): the screen's scale comes with
    the text size (`TextEnvironment.displayScale`) on every string made at
    it. Text made at the designed size names no screen and still ends on
    the next whole point (the answer sheet, the copy menu).
  - Centred text drawn in a frame hugging it is laid out at that frame's
    width (`MeasuredText.layout(for:)`, `ChatTextLayout.leading`):
    measured wider, TextKit puts it in the middle of the wider width, and
    a frame hugging it would draw it off to the right and cut it. It was
    so before for the event lines, the placeholder and the capsule's
    title.
  - Tested on Linux: the layouts at XS, the default, XXXL, AX-M and
    AX-XXXL (`ChatTextSizeLayoutTests`, `ChatPlaceholderLayoutTests`,
    `ChatChromeTextSizeLayoutTests`), the changesets
    (`ApplyPerfChatTextSizeTests`) and the reading place. UIKit tests
    (`ChatRowsTextSizeTests`, `MessageDetailTextSizeTests`,
    `ChatRowWordsTests`, `ChatHistoryViewsTests`, `ChatChromeTextSizeTests`:
    the plans' text at the multiplier and fitting its frames, the designed
    size unchanged, the cells drawing their plans, the placeholder
    measured again at a new size or width but not a new height, the bars
    with no height until their plans are in and growing at each size, the
    capsule keeping 44 and cutting what spills, centred text laid out at
    its frame's width, and the fixture chat, its dock and the message
    screen planned again at a new size) pass on the iOS 26.5 simulator
    (an iPhone at scale 3), all 26. Their first run there found the bar's
    XXL cap on the title views (the header, message detail's title),
    since fixed, and frames that differed from the plan's only by
    floating-point readback (now compared to within 1e-6,
    `assertSameFrame`). Nobody has looked at the screens on a simulator
    or a device.

- Diffs, on the Changes screen (`SessionChangesViewController`) and in the
  file viewer (`SessionFileViewController`), which opt in, and in the
  chat's and message detail's tool cards, which hand their environment to
  `DiffChunkPlan(text:)` and `DiffHeaderPlan(text:)` (nil is the designed
  size, so a caller that passes nothing is unchanged). happy-app sets no
  cap anywhere in `components/diff/*`, `DiffMetrics.tsx`, `CodeView`,
  `file.tsx` or `SimpleSyntaxHighlighter`.
  - What grows: DiffFileView's mono `fontSize` (12, its numbers and hunk
    rows 11) and its line, `Math.round(fontSize × 1.5)`, both times the
    multiplier as RN scales a `fontSize` and a `lineHeight`
    (`DiffMetrics(scale:)`); MonoProbe's advance, measured over 50 "M"s
    at the size drawn (`DiffStyle.metrics(text:)`, kept per drawn size),
    and with it the gutter's columns, the marker's two columns and the
    code's width; the header's path, badge and counts, the hint and
    messages, "Show N more lines", the image labels, the notices and the
    empty text. What stays: the gutter's 12 (or 4) of padding, the code's
    6 inset, the hunk dots' 6, the bar's 1 + 10 + 10 and its spinner, the
    header's paddings, its 16 file icon and 14 chevron, the 160 image
    boxes, the 20 section spinner.
  - Two deliberate differences. DiffFileView.tsx gives each scroll-mode
    row `height: metrics.lineHeight` as well as `lineHeight`; the height is
    a Yoga size, which RN never scales, so above the default size RN's
    rows stay 18 tall and cut a taller line, and its gutter rows overlap.
    Here a row is its scaled line, up to the screen's next pixel, as RN
    measures a one-line Text (at the largest size on 3x, 64⅓). And
    MonoProbe refuses a measurement outside 0.35 to 1.2 em of its
    designed `fontSize`, while measuring a scaled Text, so from the
    multiplier 2 up (AX-L and larger) it keeps 0.6 em of 12 and RN's
    gutter and code width are too narrow for their text; it also keeps
    the first advance per designed size for good, through a size change.
    Here the window is of the size drawn and a new size measures again
    (`DiffMetrics.acceptsAdvance`).
  - Off the main thread: every plan is measured for its width and text
    size (`DiffFilePlan`, `DiffChunkPlan`, `DiffSectionPlan`,
    `FileLinesPlan`), and the caches compare the environment as they
    compare the width (`DiffSectionMeasurer`, the file viewer's plans). The
    Changes list's notices and empty text are measured there too, with
    the sections. The parsed diff documents hold no measurement and are
    not keyed on it.
  - A new text size: the list measures every section again and, when the
    same files come back, puts the code line that was at the top of the
    screen back there, by section, file, row and how far into the row, or
    by how far into a header or the rest of a section
    (`DiffReadingPlace`). The file viewer does the same by line
    (`FileLinesLayout.place`), also across a new width or its colour
    landing. The offset is put on the nearest of the screen's pixels
    (`ScrollPlace.offset`), so the place is at most half a pixel off;
    while the offset is still the one it was put at, the next size
    starts from the place kept, not one found again from that offset
    (`KeptPlace`), so a run of sizes doesn't add up their half pixels,
    and back at the first size the line is where it was. Once the reader
    scrolls, the place is found afresh. Until the new plans land the old
    ones stay drawn: the rows, the header, the bar and the list's notices
    draw at their plan's size, not their traits' (the bar's and notices'
    labels opt out of the trait), so a diff never mixes sizes. The Changes and file screens'
    own labels (the retry and loading states, the file viewer's path and
    Diff/File buttons) follow the trait and are measured on main when
    they lay out, as Settings' are.
  - The file viewer's lines (mono 14 on 20, scaled) are measured
    wrapped at their row's width and ceiled to the screen's pixels as RN
    ceils a Text's box (`FileLinesLayout.textHeight`); the 16 padding,
    DiffDisplay's 8 and 1 and its 3 bar stay. Jumping to a line keeps
    file.tsx's `(line − 1) × 20 − 40`, unscaled, as RN does, so at a
    larger size it lands short of the line, as RN's does.
  - Still on main, as at the designed size: a shown code row's text
    width (to window a long line), the bar's label width and the file
    viewer's header. No height depends on them.
  - Tested: the arithmetic on Linux at five sizes (the metrics, the rows,
    gutters and markers with the estimate and with a fixed advance, the
    bar, a chunk, the reading place, the file viewer's boxes and its
    place). UIKit tests (`DiffTextSizeTests`: the advance against UIKit's
    at six sizes from XS to AX-XXXL, every row's text, number and marker
    fitting its frame, the drawn rows equal to the plan's, the bar at its
    plan's size, the header, the section cache keyed on the size, the
    list keeping the reader's place through three sizes to within half
    a pixel and back at Large exactly, the file viewer's lines against a
    label) pass on the iOS 26.5 simulator; drawn frames are compared to
    the plan's within 1e-6, as UIKit reads a frame back an ulp off. Not
    seen on a device.

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
scales. Settings, What's New, Welcome, Home, session info, machine,
changes and message detail put their title in a title view that follows
the text size and is fitted again in the bar when the size changes
(session info, machine and changes through `setPlainHeaderTitle`, which
keeps `title` for the back button). Session info and machine follow the
text size in their rows too, and so do changes' (above).

The bar holds the text size a title view inherits to XXL: its content view
has `maximumContentSizeCategory` XXL (iOS 26.5 simulator), where RN's Text
in Header.tsx goes on scaling. A title view's own trait override is past
the cap. Message detail sets its title view's to the screen's
(`MessageDetailViewController.updateTitleTextSize`), and the chat hands its
header the screen's size (above). The other screens' title views still
stop at XXL (19.76 for a 16 title).

UINavigationBar holds the text size a title view inherits to XXL: its
content view has `maximumContentSizeCategory` XXL (found by the chat's run
on the iOS 26.5 simulator: 19.76 for a 16 title), where the RN Text in
Header.tsx and OnboardingHeader goes on scaling. A title view's own trait
override is past the cap, so those seven screens put theirs in the bar
through `setScaledTitleView`, which sets the view's size category to the
screen's, read from the controller's own traits, and again on each change
of the screen's (in the controller's trait change its view's are still the
old ones). A screen not yet on a window leaves the view what it inherits
until it is. The title views at five sizes up to the largest in a real
navigation bar, a size change both ways, a title set before its screen is
shown, and What's New's are UIKit tests (`NavigationTitleTextSizeTests`),
which pass on the iOS 26.5 simulator. The view is fitted to its label's
box ceiled to the screen's pixels; the bar centres it in its 44 and
rounds that frame out to whole pixels, so a title an odd number of pixels
off the 44 gets one pixel more height than it measured (25 in 25⅓ at
XXL, 71⅔ in 72 at AX-XXXL), never less, and the label keeps its box in
it. Message detail and the chat do the same in their own code (Chat's).

Fixed RN sizes stay fixed: icons, the wordmark, the checklist boxes,
paddings, and minimum heights (rows 44, buttons 50/44/32, Get help 36),
which taller text grows past. In the composer: the 44 and 40 input
minimums and the 120 cap (two lines at the largest size already scroll),
the 42 and 40 action rows and the 40 chips in them, the 32 send, the 48
suggestion rows. Text taller than a fixed row is centred on it and spills
past; in the 42 row it is cut by the middle box, as RN's
`overflow: 'hidden'` cuts it.

## Not yet wired

- The rest of the chat screen: the answer sheet (AgentQuestionModal,
  whose RN `<Text>`s scale) and the copy menu, which is UIKit's.
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
- Measured text boxes ceil to pixels as RN's do (the chat's text at the
  designed size still ceils to whole points).
