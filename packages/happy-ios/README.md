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
