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
content movement. Interactive dismissal uses the library's public system
keyboard broker with the keyframe engine still owning list motion.

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