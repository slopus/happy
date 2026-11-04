# happy-ios

The native iOS client for Happy: Swift, UIKit and GRDB, ported from
`packages/happy-app`. Read [AGENTS.md](AGENTS.md) before changing anything.
It has the rules, the target layout and how to build on Linux (with `swift`
and `xtool`) and on macOS (with XcodeGen and Xcode).

The app requires iOS 26 and Swift 6.2. Home's list and both chats draw on
UltraView's UltraList; see [Home list](docs/HOME-RENDERERS.md) and
[Chat list](docs/CHAT-RENDERERS.md) for the implementation and checks.

```sh
swift test --build-system native   # Linux or macOS: crypto, wire, store, sync, layout
xtool dev build                    # Linux: the dev app bundle, needs `xtool sdk`
xcodegen && open Happy.xcodeproj   # macOS
```

## Production continuation

The native iOS app continues the existing `com.ex3ndr.happy` App Store Connect
listing with **2.0.0 (155)**, following the React Native app's 1.8.0 (154).
Development and preview keep their separate bundle identities and share the
same version. The version is set once in `project.yml` (see
[Versioning](AGENTS.md#versioning)); production's build number is set in
`App/Info-Production.plist` and the Happy target's Release settings. The
client header reads the bundled version. Keep the existing signing team and
default Keychain access group so the RN credentials and Expo installation ID
survive an in-place upgrade.

Follow [the release skill](../../.agents/skills/release/SKILL.md) from a clean
local `main` matching freshly fetched `origin/main`. This release is for
**TestFlight only**: upload to App Store Connect without submitting for App
Store review or public release. After successful submission, tag the exact
source commit `native-ios-2.0.0-build155`; future iOS tags follow
`native-ios-<version>-build<build>`. Never move an existing tag. No GitHub
Release is needed for this TestFlight build.

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
