# iPad

In a window wide enough for it, the window is UIKit's own split view: the
account's home in the sidebar, everything it opens in the main panel beside
it. Narrower, it is the phone app: one stack, home at its root. The window
switches between the two as it is resized, folded or opened, and the same
screens move between them. Which one shows is the window's width and size
classes, never the device: an iPad full screen and an iPhone Duo open in
landscape split; an iPhone, a folded Duo and a thin iPad window don't.

The shell is `ShellViewController` (`Sources/HappyUI/Tablet`). The pure
rules (when to split, where the main panel sits, how the stack is
rewritten) are `SplitRule`, `MainPanelLayout` and `SplitStack` in
`Sources/HappyLayout/Tablet/SplitRules.swift`, with exact tests in
`Tests/HappyLayoutTests/SplitRulesTests.swift`. The hosted tests
(`HostedSplitShellTests`) drive the real `AppCoordinator` window wherever
it splits: an iPad, or an iPhone Duo open in landscape.

## The split view

`UISplitViewController(style: .doubleColumn)`, `.tile`, three columns set:

| Column | Holds |
| --- | --- |
| primary (sidebar) | `SidebarNavigationController`: home alone |
| secondary (main panel) | `main`, a `BrowserNavigationController`: whatever home opened, and everything pushed from it |
| compact | `phone`: AppCoordinator's stack, the phone's |

- **The sidebar is the account's home**, as it is on the phone: Happy
  Agent's `AgentHomeViewController` (`SidebarList` on UltraView) or Happy
  CLI's `LegacyHomeViewController`. Home knows it is a sidebar by one
  trait, `SidebarColumnTrait`: its ground goes clear, so the sidebar's
  glass shows behind the cards, and its chrome is the sidebar's, not the
  phone's (The sidebar's chrome, below).
- **The sidebar never pushes.** `SidebarNavigationController` turns every
  push onto it (a row, compose, Settings, What's New, a quick action, a
  link) into the main panel's new root (`ShellViewController.showInMain`).
  Opening the thing the main panel already shows (`MainPanelKey`: the
  route, the agent, the surface) goes back to its root instead of opening a
  second copy. Nothing in home had to change for this: it still calls
  `navigationController.pushViewController` or `push(_:context:)`.
- **The main panel holds all navigation.** Its screens push on `main`, as
  they would on a phone, with the system back button and swipe back
  (`PopGestureDelegate`). With nothing open it shows
  `MainPanelPlaceholderViewController`: desktop's owl (`StateSceneView`,
  `.owl`) and no words, in desktop's 128 panel square centred in the safe
  area (`MainPanelPlaceholderLayout`), never a stretched home. It plays
  once each time the panel empties and holds its last frame; a tap plays
  it again.
- **The selection follows the main panel.** Whenever its root changes the
  shell tells home (`MainPanelFollowing`), which selects that row: the row
  it was opened from, else the row of that conversation or session. On a
  phone nothing stays selected, as before.

### The sidebar's chrome

On a phone, and in a narrow window's one stack, home keeps the phone's
chrome: the switcher and settings (and Happy CLI's filter) in the header,
search and compose in the bottom toolbar. As the sidebar
(`Sources/HappyUI/Tablet/SidebarChrome.swift`, laid out by
`SidebarChromeLayout`):

- **The header holds the account switcher alone**, and Happy CLI's filter
  menu.
- **Search is a field at the top of the list** (`SidebarSearchField`,
  `SidebarSearchLayout`), as Telegram's chat list keeps its own: it
  scrolls with the rows and fades as it passes under the bar. Typing does
  what the phone's bar field does (`HomeViewController.beginSearch`,
  `search(_:)`, `endSearch`). While it is open the field stays at its rest
  with Cancel beside it, and home's list fades from under the results,
  which have no ground of their own on the sidebar's glass. Happy CLI's
  home has no search, on the phone or here.
- **Settings and compose are a bar at the sidebar's foot**
  (`SidebarBottomBar`, `SidebarBottomBarLayout`): settings in a glass
  circle at the bottom left; compose at the bottom right as the column's
  one prominent action, a 48-point prominent-glass pill in the app's
  primary (`Palette.roundButtonFill`, the send button's: black, light in
  dark) that says what it starts, "New work" for an agent and "New
  session" for Happy CLI. Both sit 16 off the sidebar's edges and foot,
  or the safe area where that is more; the list's bottom inset clears
  them and iOS's soft edge shades the rows under them. Where nothing can
  be started (Happy CLI with no computer) settings is alone.

The sidebar floats over the main column, whose ground is the chat's
(`Palette.surface`), light and dark: one surface behind and beside it.
iOS 26 shades a scroll view's top under its bar, but only across the
scroll view, which in the main panel starts at the sidebar's edge, so the
shade ended in a line above the sidebar. While the sidebar floats beside
them, the main panel's screens go without that soft top edge
(`ShellViewController.updateTopEdges`); the chats keep their own header
fade. With the sidebar hidden, or the window a phone's, it is back.
`UIBackgroundExtensionView` was tried and left out: it mirrors the chat's
text, blurred, under the sidebar's glass.

### Where the main panel sits

iOS 26's sidebar floats over the secondary column: the column runs under
the sidebar, with the sidebar as its leading safe area. The screens ported
from the phone lay out from their bounds, so they would draw under it.
The secondary column is therefore `MainColumnViewController`, which holds
`main` inside the column's horizontal safe area (`MainPanelLayout`), under a
navigation controller whose own bar never shows. Every screen gets a plain
rectangle, as on a phone, its bar's title centred over what is visible.
When the sidebar hides, the safe area goes and the main panel takes the
whole window, in the split's own animation.

Only the sidebar's side is taken out (the left, or the right in a
right-to-left language). The other side's safe area is the screen's, and
stays with the screens inside: an iPhone Duo's status bar runs up the
right edge in an 84-point column (iOS 27.1's vertical bar), and the bar's
own buttons move into that column. Held short of it, the main panel left
an empty strip with the buttons floating in it; given it, the chat's bar
puts its buttons there and the transcript centres in what is clear.

### The sidebar's width

`SplitRule.sidebarWidth`: 30% of the window, as happy-app's drawer, held to
340–360. The system's own 320 cut the account's pill to "Connectin…" beside
its two buttons; 340 is the least that keeps it whole. An 11-inch iPad
upright leaves the main panel 480, more than a phone.

### Hiding the sidebar

The sidebar's button is at the leading edge of the main panel's root
(`placeToggle`), the system's `sidebar.left` sending the system's
`toggleSidebar(_:)`, which is what ⌃⌘S sends from the keyboard and the
menu. The split's own `displayModeButtonItem` isn't used: it is a new
object at every change and draws nothing outside the bars the split places
it in itself, and the split would put it over the sidebar
(`displayModeButtonVisibility = .never`).

Hiding gives the main panel the whole window (`.secondaryOnly`); showing
brings the sidebar back (`.oneBesideSecondary`). The choice is kept per
window in its scene session's `userInfo` (`happy.sidebarHidden`), so it
survives relaunch and each window has its own. It is reapplied when the
window expands again after being narrow, and kept through rotation by
`preferredDisplayMode`. Mode changes the split makes itself while the
window resizes or collapses are not taken for the person's choice.

## Readable widths

Nothing stretches across a wide main panel. Content is held to 800
points, centred, on any device (`ContentWidthLimit`, `ContentWidth`): a
window narrower than that is never held, so a phone upright or a folded
Duo uses its whole width, and a Duo open in landscape or a Pro Max on its
side keeps to the column as an iPad does. happy-app held only 13-inch
screens to it, which left an 11-inch iPad's chat and settings running
across a landscape window or a main panel with the sidebar hidden.

- The chats' rows lay out in that column (`ChatColumn`), and the agent
  chat's composer card keeps to it too (`ChatScreenLayout`'s
  `maxContentWidth`), so the two line up.
- Settings, its pages, the agent's profile, the session info and the
  profile editor lay out at the column's width; the margins either side are
  their scroll view's insets (`UIScrollView.readableColumn`), so a finger
  anywhere in the panel still scrolls them.
- In a regular-width window the legacy chat docks its list under the
  bar and the worktree strip (`LegacyChatScreenLayout`'s `docked`), as
  happy-app's tablet did, but keeps the phone's bar: nothing scrolls under
  the glass, so no transcript shows through the strip or above the title.
  A narrow window is the phone's chat, unchanged.
- The composer's "+" is a card over the button in a regular window
  (`AttachMenuSheetLayout`), and the model and effort pickers are panels
  anchored to their control, so neither needed changing.

## Narrow windows: one stack

| Window | Layout |
| --- | --- |
| compact width: an iPhone upright, a folded iPhone Duo (466 × 678), Slide Over, a third of Split View | phone |
| compact height: any iPhone on its side, a Pro Max's 956 × 440 included, a folded Duo on its side (678 × 466) | phone |
| regular but under 768: a Duo open in portrait (669 × 951), an iPad mini upright (744), a 13-inch iPad's half in landscape (683) | phone |
| regular both ways and 768 or wider: a Duo open in landscape (951 × 669), every iPad full screen except the mini upright | split |
| any window not showing a home (onboarding, sign-in, server confirmation) | phone, full window |

**Why 768 and not the size classes alone.** The size classes are the
system's answer and are used: a window compact either way is always the
phone. A compact height is a phone on its side; a Pro Max there is
regular at 956 wide, but 440 tall leaves the sidebar's foot over its rows
and the chat a sliver above the keyboard, so it stays the phone it always
was. And a regular window can still be too thin. Beside a 320 sidebar, a 683 window leaves a
363 main panel, narrower than any iPhone, and the mini's 744 leaves 424.
From 768 the main panel is at least 448, an iPhone Pro Max's width. 768 is
also where happy-app's tablet shell started (`TabletBreakpoint`), so the
two apps change layout at the same width. Height counts only by its size
class, which turning the device changes and the keyboard doesn't, so the
keyboard never collapses the window. Every iPad window is regular in
height, so for an iPad the rule is what it was.

**An iPhone Duo.** Built with the iOS 27.1 SDK the app fills each display
edge to edge, its status bar a column up the right (iOS 27.1's vertical
bar). Measured on the iOS 27.2 Duo simulator, in points at @3x:

| Duo | Window | Size classes (w × h) | Safe area | Layout |
| --- | --- | --- | --- | --- |
| folded, upright | 466 × 678 | compact × regular | right 84, bottom 34 | phone |
| folded, on its side | 678 × 466 | compact × compact | right 84, bottom 34 | phone |
| open in landscape | 951 × 669 | regular × regular | right 84, bottom 34 | split: sidebar 340, main panel 611 |
| open in portrait | 669 × 951 | regular × regular | top 82, bottom 34 | phone |

Open in portrait is the phone: a sidebar of 340 would leave the main
panel 329, narrower than any iPhone, and a narrower sidebar cuts the
account's pill. It is the same answer as an iPad mini upright, by the
same rule. Folding and opening is a resize: the shell collapses and
expands through the split's delegate calls, and the stack, a sheet over
it and the call's bar all stay (`HostedSplitShellTests`).


The shell applies it by giving the split view a compact horizontal size
class (`traitOverrides`) whenever the window shouldn't split; the split
view then collapses as it does for a compact window, through the same
delegate calls.

### Rewriting the stack

The two layouts hold the same screens; collapsing and expanding move them
(`SplitStack`), in the split view's delegate calls just before it changes
(`topColumnForCollapsingToProposedTopColumn`,
`displayModeForExpandingToProposedDisplayMode`), and again after layout
for the first one, which asks no delegate:

    split   sidebar [home]   main [chat, profile]
    phone   [home, chat, profile]

    split   sidebar [home]   main [placeholder]
    phone   [home]

The placeholder never goes on the phone's stack. Because the very same
view controllers move, a chat keeps its composer draft, its scroll position
and its loaded rows; nothing is rebuilt or duplicated, and the selection
comes back with the main panel's root.

The old shell's reason for a custom container was that a split view has two
stacks where happy-app has one. That is solved by the rewrite: whatever the
layout, AppCoordinator sees one stack (`ShellViewController.stack`,
`setStack`) and the shell puts it where it belongs.

## Accounts, links and notifications

- **Switching accounts** dissolves the whole split view into the other
  account's (`AppCoordinator.install`, `crossfadeView`): its home in the
  sidebar, nothing open beside it. With Settings open in the main panel,
  Settings stays and home changes beside it, as on a phone.
- **Signing out** puts the first screen on the phone's stack, full window.
- **A notification or a link** sets the stack to home and the chat
  (`setStack([home, chat])`), so in a split window the chat is the main
  panel's root and its row is selected.

## What happy-app's tablet shell had that this doesn't

`TabletShellViewController` ported `SidebarNavigator.tsx`: a 250–360 drawer
at 30% of the window, a persistent header with zen mode and its own back
button, and screens that switched to happy-app's tablet look
(`TabletLayoutTrait`). The split view replaces it: the system sidebar and
its button instead of the drawer and zen, the system back button instead of
the persistent one, and the phone's screens in the main panel instead of a
tablet variant of each. The old shell, its sidebar and its list grouped by
project (SessionsList.tsx's hierarchy) are gone; the sidebar is home, flat
or in project cards as home is. So is `TabletLayoutTrait`, with the legacy
chat's tablet header and permission buttons: in the main panel the legacy
chat keeps the phone's bar and back button and only docks its list under
it.
