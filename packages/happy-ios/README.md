# happy-ios

The native iOS client for Happy: Swift, UIKit and GRDB, ported from
`packages/happy-app`. Read [AGENTS.md](AGENTS.md) before changing anything.
It has the rules, the target layout and how to build on Linux (with `swift`
and `xtool`) and on macOS (with XcodeGen and Xcode).

```sh
swift test --build-system native   # Linux or macOS: crypto, wire, store, sync, layout
xtool dev build                    # Linux: the dev app bundle, needs `xtool sdk`
xcodegen && open Happy.xcodeproj   # macOS
```

The chat fixtures (`Sources/HappyUI/Chat/Fixtures`) are built in Debug and
where `HAPPY_FIXTURES` is set, never in the shipped app. The hosted tests use
them, so to run those in Preview:

```sh
xcodebuild test -scheme HappyUIKitHosted -configuration Preview ENABLE_TESTABILITY=YES \
  "SWIFT_ACTIVE_COMPILATION_CONDITIONS=\$(inherited) HAPPY_FIXTURES" ...
```
