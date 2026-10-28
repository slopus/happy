# Native AppKit target

`HappyMac` is an independent `platform: macOS` XcodeGen application with
`SDKROOT: macosx`. Its entry point uses `NSApplication`, its window is an
`NSWindow`, and its views are AppKit. It does not link `HappyUI`, UIKit,
SwiftUI, Catalyst, WebKit or the Tauri client. Minimum macOS: 14.

## Shared platform boundary

`HappyClientKit` exports the existing platform-neutral Swift modules. There
is deliberately no generic wrapper that tries to make UIKit views act like
AppKit views:

- `NativeAccountFactory` is used by both the iOS `CompositionRoot` and Mac
  entry point. Platforms supply lifecycle callbacks, storage root and
  Keychain backend. iOS keeps exactly its previous Expo-compatible services,
  defaults suites and background-delivery lease. Mac namespaces Keychain and
  defaults by bundle ID and never reads iPhone MMKV.
- `AccountController` and `AccountSession` retain authentication, account
  switching, encrypted sync, GRDB storage and the durable outbox.
- `NativeSessionModel` consumes the existing `HomeFeed` and `ChatFeed`.
  `SessionList` and `ConversationRow` produce immutable presentation data
  off main; `ConversationChanges` identifies the changed rows. The model
  owns observation cancellation and rejects stale account/session updates.
- `MacDesktopLayout` holds deterministic frame geometry, tested independently
  of AppKit. UIKit retains its existing layout/view code unchanged.
- `Sources/HappyMacApp` owns the native controls, keyboard/menu behavior,
  sheets, window lifecycle and rendering. It does not implement a second
  protocol, database, auth flow or chat reducer.

## Build, run and test

Install Xcode 26+ (Swift 6.2) and XcodeGen. From `packages/happy-ios`:

```sh
xcodegen
xcodebuild -project Happy.xcodeproj -scheme 'Happy Mac' \
  -destination 'platform=macOS' -derivedDataPath .build-mac build
open .build-mac/Build/Products/Debug/HappyMac.app
xcodebuild -project Happy.xcodeproj -scheme 'Happy Mac' \
  -destination 'platform=macOS' -derivedDataPath .build-mac test
```

Choose a development team in Xcode if needed. For local-only ad-hoc builds
and hosted tests, append `CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual
DEVELOPMENT_TEAM=`. This is not a distribution signature. Publishing still
requires the release skill; no release or updater pipeline is added here.

`Happy Mac` runs Debug and archives Release. `Happy Mac (preview)` uses
Preview. Bundle IDs are `com.slopus.happy.native.mac.dev`,
`com.slopus.happy.native.mac.preview`, and `com.slopus.happy.native.mac`.
These do not replace iOS or Tauri apps. Each has its own Keychain service
namespace, sandbox, account registry and defaults.

## Implemented

- Native resizable/restorable window, 820×560 minimum, native menus and
  standard text editing. Settings uses ⌘,; New Session uses ⌘N;
  the conversation composer sends with ⌘Return.
- Create/restore a relay account, custom-server settings, recovery-server
  confirmation, sign-out confirmation and Keychain-backed persistence.
- Searchable session sidebar from the shared offline store; selectable text
  conversation rows; streamed updates; older history; durable message
  send/retry; Stop; simple Allow/Deny permission controls. Tool outputs are
  collapsed until expanded.
- Pairing URL entry and `happy://` open handling always require explicit
  approval before granting another device access.
- Basic new-session form for an online Happy CLI machine, agent and directory,
  with separate approval before creating a missing directory.
- Mac app icon generated from the existing Happy artwork; sandboxed outbound
  networking. Remote servers require HTTPS; local-network ATS access is allowed.

## Deliberate parity limits

This is a usable AppKit relay-client port, **not full feature parity with the
iOS interface**. Direct/Stem Cells connections, Happy Agent catalog/session
creation, account-switcher UI, structured question forms, attachments, rich
markdown/diff/file viewers, model/effort controls, stories, voice, camera,
guest/App Clip flows, push notifications, universal links and an automatic
updater are not yet ported. Existing relay sessions still use the same
underlying sync/reducer/sender. Draft text is retained per session only for
the current window lifetime; accepted messages use the durable outbox.

One window owns the active account. Closing and reopening preserves it;
quitting waits for the account session to stop. Losing focus reports presence
without suspending desktop sync. If another Happy variant is installed,
macOS chooses the registered `happy://` handler; paste the URL into the
intended app to avoid that ambiguity.

## Verification

The `HappyMacTests` hosted scheme verifies the actual macOS platform,
`NSWindow`, resize constraints, native editor/menus, shared presentation
diffs, default iOS Keychain service preservation, Mac credential namespacing,
pure layouts and both platforms' configuration files. Its screenshot test
captures only the running app's own AppKit window at two sizes using
`SCShareableContent.currentProcess` (macOS 14.4+) and keeps PNG attachments
in the test result bundle. This API does not request screen-recording
permission; the capture test skips on macOS 14.0–14.3.

The iOS regression build remains independent:

```sh
xcodebuild -project Happy.xcodeproj -scheme Happy \
  -destination 'generic/platform=iOS' -derivedDataPath .build-ios \
  CODE_SIGNING_ALLOWED=NO build
```