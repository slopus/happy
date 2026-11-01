# Home list

The native app requires iOS 26. `Package.swift` and
`project.yml` declare that minimum. UltraView is a direct, iOS-only SwiftPM
dependency pinned to `2c2e35147b42f4e88edde4ec1ec36e53eaf27d1c`; its pre-1.0
API changes frequently. Portable core and layout code still supports Linux.
The same dependency draws both [chat lists](CHAT-RENDERERS.md).

The legacy Home list (`SessionListViewController`, flat or grouped by
project), which is also the iPad's sidebar, draws only on UltraList.
The UITableView renderer and the Appearance row that chose between them are
gone; an account's stored choice is deleted on its first launch
(`LocalSettings.Keys.retired`).

Home consumes `HomeDerivation`; the tablet sidebar keeps its own
`TabletSidebarDerivation`, its rows bridged into Home's row identities
(`TabletGroupedRow.ID.ultraBridgeID`). Selection, archive, project
expansion, workspace creation and session menus stay in the controllers.
The list is `UltraListView(engineMode: .keyframe)`, with typed
`HomeUltraRow` descriptors wrapping `NodeRow`. `HomeRowDrawing` and
`TabletHomeRowDrawing` measure off main with the existing HappyLayout
functions and draw through UltraView's background node pipeline. Small
native overlays retain asynchronous avatars, title shimmer, pulsing status
dots, provider icons and workspace buttons. The notices over the rows
(HomeListHeader.tsx) are the list's first row.

What the table did, the list does: a trailing swipe archives a session or
leaves a task, in the table's red, without a full swipe; a long press opens
the "Session" alert, or "Create workspace" on a project card; the open
chat's row is drawn and read selected in the sidebar; the status bar's tap
scrolls to the top (the list is the one scroll host in the window that
claims it); VoiceOver reads each row with its label, traits and an Actions
action for its long press; a new text size keeps the first row below the
header where it was (`preserveVisibleContent`). The table had no
pull-to-refresh, drag to reorder or search inside the list, and neither does
the list.

The adapter caches unchanged descriptors and prepared content by identity
and revision. Revisions increase across removal and reinsertion, so old
measurements and bitmaps cannot masquerade as a new row. Inset changes use
`applyChanges` without a collection. Collection changes preserve a visible
anchor. A list let go of (`deactivate`) discards pending preparation
results, cancels avatar work and disconnects actions.

`HomeUltraListTests` compares native row geometry at several text sizes and
exercises superseded measurements, unchanged row reuse, old actions, and
asynchronous identity reuse. `HomeListTextSizeTests` and
`TabletSidebarTextSizeTests` run the lists in a window through text-size
changes and late environments and headers. `HostedHomeUltraParityTests`
covers the swipe, long press, selection, status bar and VoiceOver.
`HomeRendererUITests` drives the real Home screen with the existing offline
seeded account through `HappyChatHarness -screen home`. Harness arguments
choose phone grouping and a 1000-session stress fixture. Fixtures are
guarded by `DEBUG || HAPPY_FIXTURES` and are excluded from shipped builds.
