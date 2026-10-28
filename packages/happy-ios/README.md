# happy-ios

The native iOS client for Happy: Swift, UIKit and GRDB, ported from
`packages/happy-app`. Read [AGENTS.md](AGENTS.md) before changing anything.
It has the rules, the target layout and how to build on Linux (with `swift`
and `xtool`) and on macOS (with XcodeGen and Xcode).

The app requires iOS 26 and Swift 6.2. Home uses UITableView by default;
Settings → Appearance → Home list renderer can select UltraList. The choice
is local to each account and takes effect without restarting. See
[Home renderers](docs/HOME-RENDERERS.md) for the implementation and checks.

```sh
swift test --build-system native   # Linux or macOS: crypto, wire, store, sync, layout
xtool dev build                    # Linux: the dev app bundle, needs `xtool sdk`
xcodegen && open Happy.xcodeproj   # macOS
```

## Native Mac app

`HappyMac` is a genuine **AppKit / macOS SDK** target, not Catalyst,
"Designed for iPad", SwiftUI, or the Tauri client. UIKit and AppKit share
account composition, SQLite, crypto, sync and presentation models through
`HappyClientKit`, while keeping their views separate. Requires macOS 14+
and Xcode 26+ (Swift 6.2). This is a functional relay-client port, not yet
full mobile feature parity.
See [Mac build and behavior](docs/MAC.md) for building, testing and limitations.

```sh
xcodegen
xcodebuild -project Happy.xcodeproj -scheme 'Happy Mac' \
  -destination 'platform=macOS' \
  -derivedDataPath .build-mac build
open .build-mac/Build/Products/Debug/HappyMac.app
```

The chat fixtures (`Sources/HappyUI/Chat/Fixtures`) are built in Debug and
where `HAPPY_FIXTURES` is set, never in the shipped app. The hosted tests use
them, so to run those in Preview:

```sh
xcodebuild test -scheme HappyUIKitHosted -configuration Preview ENABLE_TESTABILITY=YES \
  "SWIFT_ACTIVE_COMPILATION_CONDITIONS=\$(inherited) HAPPY_FIXTURES" ...
```
