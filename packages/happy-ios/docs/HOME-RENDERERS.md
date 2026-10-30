# Home renderers

The native app requires iOS 26. `Package.swift` and
`project.yml` declare that minimum. UltraView is a direct, iOS-only SwiftPM
dependency pinned to `2c2e35147b42f4e88edde4ec1ec36e53eaf27d1c`; its pre-1.0
API changes frequently. Portable core and layout code still supports Linux.
The same dependency also powers the optional [chat renderer](CHAT-RENDERERS.md).

UITableView remains the default. Settings → Appearance → Home list renderer
selects UITableView or UltraList. `LocalSettings.homeListRenderer` persists
the choice in the account's existing defaults suite. Missing and unknown
values resolve to UITableView; signing out clears the preference. Changing
the choice replaces only the list controller, preserving the account,
Home feed, dock, navigation stack, grouping and latest row model.

Both renderers consume `HomeDerivation`; the tablet sidebar retains its
own `TabletSidebarDerivation`. Selection, archive, project expansion,
workspace creation and session menus remain in the existing controllers.
The custom renderer is `UltraListView(engineMode: .keyframe)`, with typed
`HomeUltraRow` descriptors wrapping `NodeRow`. It never hosts a table or
table cells. `HomeRowDrawing` and `TabletHomeRowDrawing` measure off main
with the existing HappyLayout functions and draw through UltraView's
background node pipeline. Small native overlays retain asynchronous avatars,
title shimmer, pulsing status dots, provider icons and workspace buttons.

The adapter caches unchanged descriptors and prepared content by identity
and revision. Revisions increase across removal and reinsertion, so old
measurements and bitmaps cannot masquerade as a new row. Inset changes use
`applyChanges` without a collection. Collection changes preserve a visible
anchor. Switching away discards pending preparation results, cancels avatar
work and disconnects actions from the old renderer.

`HomeListRendererSettingsTests` covers defaults, invalid values, persistence,
account isolation and clearing. `HomeUltraListTests` compares native row
geometry at several text sizes and exercises superseded measurements,
unchanged row reuse, old actions, and asynchronous identity reuse. Existing
Home text-size and banner checks continue to cover the table default.
`HomeRendererUITests` drives the real Home screen with the existing offline
seeded account through `HappyChatHarness -screen home`. Harness arguments
choose renderer, phone grouping, and a 1000-session stress fixture. Fixtures
are guarded by `DEBUG || HAPPY_FIXTURES` and are excluded from shipped builds.
