# Chat list

Both chats draw their transcripts on UltraList: the Happy account chat
(`LegacyChatViewController`, through `ChatListView` and
`ChatUltraListAdapter`) and the agents' chat (`ChatViewController`, through
`AgentChatUltraList`). The UICollectionView renderer, the agents' chat's
own scroll view and the Appearance setting that chose between them are
gone; an account's stored choice is deleted on its first launch
(`LocalSettings.Keys.retired`).

The legacy chat consumes the off-main `ChatRows` pipeline, rendered history
window, `ChatRowPlan` measurements and changesets. The composer,
permissions, question forms, copy menus, links and history pager keep their
controller actions.

`ChatUltraListAdapter` uses `UltraListView(engineMode: .keyframe)` standing
the natural way up, oldest row at the top, with bottom gravity
(`ListBottomGravity`): the list rests on its newest row and follows a reply
growing there by two lines of body text (`ChatFollow`). `NodeRow` prepares
and draws static boxes, text and icons in the library's bounded preparation
window. TextKit drawing and link hit testing share a lock because they can
run on different queues. Drawings resolve the captured appearance explicitly
and redraw after appearance or display-scale changes.

Static drawing uses 512-point bitmap tiles. Rows taller than 4096 points use
the native canvas (`ChatPlanView`) to bound retained bitmap memory. A row
also uses that canvas if its painter order requires a static mark above
earlier live content. The pooled native overlay retains scrollers, diff
controls, images, timers and Mermaid pages across revisions of the same row.
Row opacity applies once to each drawing and overlay.

The person's own bubble draws its time with the row, and its clock or checks
live over it (`ChatDrawItem.delivery`, `ChatDeliveryView`). The mark is the
row's last item, so it always sits above the bitmap. A send made at the
newest edge flies in from the composer (`ChatSendFlight`, see
docs/telegram-notes.md §7). The list veils the row the flight waits for from
the pass that inserts it, and that pass uses the flight's curve. The row is
unveiled in the transaction where the copy goes. Every other pass keeps its
own transition.

The agent's newest words come out a character at a time as they stream
(`ChatRevealDriver`, see docs/telegram-notes.md §8). A revealing row is as
tall as the lines it shows, and a pass for it growing a line runs 0.15 s.
A pass that moves nothing lands at once, so it never retimes a growth in
flight. Each row view keeps its canvas at the plan's full size from its top.
Its `ChatRevealPresenter` masks what is still to come and lays the glyph
copies over the row. In the legacy chat a revealing row draws on the native
canvas, its text drawn off the main thread, and stays there once revealed.
Which row reveals is `RevealFocus`'s (HappyLayout, tested in
`RevealFocusTests`): only the newest, with words that arrive on screen, and
any other finishes in 0.3 s. Both transcripts hand it their rows on every
apply and carry out its steps through `ChatRevealDriver.perform`.
`HostedStreamingRevealTests` streams replies into both chats at 35 ms
chunks. It samples every frame from the presentation layers: the row only
grows, smoothly, its words never move, and the newest row stays on the
composer. It also checks the reveal's own main-thread time. In both chats it
also checks five more cases from the reveal's own state each frame:
- a newer segment or message finishes the one before within 0.3 s;
- a burst shows whole;
- opening a chat mid-reply shows it whole;
- a row scrolled away and back goes on from where it was;
- the catch-up after the background shows whole.

The adapter reads positions from the library's committed row descriptors and
frames. Ordinary mutations carry no absolute scroll target, so background
preparation cannot replay an old target after a drag starts. Following near
the newest edge and pinning an expanded tool are checked against the
committed window and a user-motion generation. Insets compensate for dock
and keyboard movement while idle; under a finger they preserve physical
content movement. Reduce Motion drops the follow animations.

In every layout the keyboard comes from
UltraView's own integration (`ChatUltraKeyboard` over the library's
`KeyboardDismissalController`), only while the chat is shown. A finger
dragging down from the list carries the keyboard, the dock and the newest
inset together, and its release plays the library's dismissal or return.
Keyboard frame notifications go to the controller first; the rest move the
inset on the library's keyboard transition. The dock, the scroll button, the
scrim and an empty chat's placeholder ride the inset's motion through
`applyViewportMotion`. Where the controller can't drive the keyboard, the
list keeps the system's interactive dismissal.

Under the iPad's dock, the list's
frame stays where the dock rests and the keyboard moves its newest inset
instead, because UltraView has no public way yet to carry a list's frame or
clip on that motion. A backdrop
under the dock covers the rows the list runs under it
(`LegacyChatScreenLayout`'s `keyboardMovesInset`).
The phone keeps its floating dock and full-height list in both orientations.

The controller moves a docked keyboard only when the app's window covers the
screen: on a phone, and on an iPad running the app full screen. A smaller
iPad window (windowed apps, Stage Manager) and a floating, undocked or split
keyboard keep the system's interactive dismissal.

The agents' chat has the same keyboard (`ChatViewController.ultraKeyboard`)
wherever it is shown, since its list always runs under the card: the card,
the context meter, the jump button, the composer's scrim and new work's
panel ride the inset's motion. UltraList never moves inside a UIView
animation, so a layout made in one (the card growing a line, the sessions'
composer growing) passes the animation's own curve and duration to the
list's inset (`insetMotion`); given none, the inset moves at once while the
composer glides, and the rows jump ahead of it. That was the agents' chat's
keyboard jump once it moved onto UltraList: its inset went in the
keyboard's UIView animation with no transition of its own, so the rows
landed 311 points in one frame while the card took the keyboard's whole
animation.
`HostedChatKeyboardMotionTests` samples every frame of both chats from
their presentation layers, at the newest row and back in the history, as
the system keyboard shows and hides and as the composer grows, and
`ChatScrollUITests` drives both with a finger (`-screen agentChat` opens
the agents' chat in the harness).

The agents' chat preview (a context-menu preview of a chat) uses the same
list, untouchable, showing the newest row from its start
(`AgentChatUltraList.showsNewestFromItsStart`) under its fade.

The dependency revision is pinned in `Package.swift` and `Package.resolved`;
the XcodeGen project consumes that local package. UIKit tests cover native
view reuse, stale actions, tall rows and painter order. Hosted tests
exercise reading anchors, keyboard and dock insets, older pages and a
prepared token arriving after a drag starts. The chat harness reports the
renderer (always `UltraList`) and waits for displayed content. The Home
harness pushes its seeded sessions through the normal Home navigation and
SQLite-backed chat path. `-fixture diagrams` exercises asynchronous Mermaid
sizing and `-fixture giant` contains one very tall message; `long` instead
contains many ordinary rows.
