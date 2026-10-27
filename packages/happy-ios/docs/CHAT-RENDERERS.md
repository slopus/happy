# Chat renderers

Settings → Appearance → Chat list renderer chooses UICollectionView or
UltraList. UICollectionView remains the default, including for missing or
unknown stored values. The choice is local to each account and clears on
sign-out. Home has its own independent renderer preference.

Both paths consume the existing off-main `ChatRows` pipeline, rendered
history window, `ChatRowPlan` measurements and changesets. The composer,
permissions, question forms, copy menus, links and history pager keep their
existing controller actions. Returning to an open chat after changing its
renderer preserves its current plans and reading position.

On UICollectionView, following at the newest edge uses a 0.4-second
ease-out (`ChatFollowMotion`). Small arrivals and streamed height changes
apply their geometry immediately, then the collection slides as one block.
Overlapping slides add together, keeping a growing reply attached to its
neighbours. Changes taller than the far inset use UIKit's batch animation
with the same timing; new rows rise fully drawn from below their settled
position. A reader away from the newest edge keeps their reading anchor.
Reduce Motion bypasses the added follow animations.

This behavior belongs to the Happy account chat (`ChatViewController`).
The experimental Stem Cells chat has its own scroll view and layout.

`ChatUltraListAdapter` uses `UltraListView(engineMode: .keyframe)` with
inverted content and inverted rows. `NodeRow` prepares and draws static
boxes, text and icons in the library's bounded preparation window. TextKit
drawing and link hit testing share a lock because they can run on different
queues. Drawings resolve the captured appearance explicitly and redraw after
appearance or display-scale changes.

Static drawing uses 512-point bitmap tiles. Rows taller than 4096 points use
the established native canvas to bound retained bitmap memory. A row also
uses that canvas if its painter order requires a static mark above earlier
live content. The pooled native overlay retains scrollers, diff controls,
images, timers and Mermaid pages across revisions of the same row. Row
opacity applies once to each drawing and overlay.

The adapter reads positions from the library's committed row descriptors and
frames. Ordinary mutations carry no absolute scroll target, so background
preparation cannot replay an old target after a drag starts. Following near
the newest edge and pinning an expanded tool are checked against the
committed window and a user-motion generation. Insets compensate for dock
and keyboard movement while idle; under a finger they preserve physical
content movement.

On UltraList with the floating dock (a phone in portrait) the keyboard
comes from UltraView's own integration (`ChatUltraKeyboard` over the
library's `KeyboardDismissalController`), only while the chat is shown. A
finger dragging down from the list carries the keyboard, the dock and the
newest inset together, and its release plays the library's dismissal or
return. Keyboard frame notifications go to the controller first; the rest
move the inset on the library's keyboard transition. The dock, the scroll
button, the scrim and an empty chat's placeholder ride the inset's motion
through `applyViewportMotion`. Where the controller can't drive the
keyboard, the list keeps the system's interactive dismissal.

Docked (a tablet, a phone on its side) the list's frame ends at the dock
and changes height with the keyboard, and UltraView has no public way yet
to carry a list's frame or clip on that motion. There, as on the
UICollectionView renderer, the keyboard layout guide moves the screen and
the controller is never made.

The dependency revision is pinned in `Package.swift` and `Package.resolved`;
the XcodeGen project consumes that local package. Renderer settings tests
cover persistence, defaults, invalid values, independent Home selection and
account clearing. UIKit tests cover native view reuse, stale actions, tall
rows and painter order. Hosted tests exercise reading anchors, keyboard and
dock insets, older pages, renderer switching and a prepared token arriving
after a drag starts. The chat harness selects UltraList with
`-chatUltraList`, reports the actual renderer and waits for displayed content.
The Home harness also accepts `-chatUltraList`; its seeded sessions open
through the normal Home navigation and SQLite-backed chat path. Without that
flag its fresh launch uses UICollectionView; `-renderer stored` retains both
renderer preferences for persistence checks.
`-fixture diagrams` exercises asynchronous Mermaid sizing and `-fixture giant`
contains one very tall message; `long` instead contains many ordinary rows.