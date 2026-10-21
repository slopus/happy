# Bot invitation App Clip

The guest screen is UIKit shared by the App Clip and the installed native app.
It has no owner authentication, account store, file access, tool approval, or
owner RPC client. The Clip compiles only the guest sources and one pure layout.
It links only Apple frameworks, including AppClip, Foundation, UIKit, Security,
and CryptoKit.

## Targets and provisioning

Normal `project.yml` builds keep their existing entitlements and do not embed
an unprovisioned Clip. They link the shared guest screen and route existing
`app.happy.engineering` browsing-web activities to it. When the full app is
already presenting a modal, the guest screen opens from the topmost modal.
Without a valid invitation link, launch, authentication, root navigation and
the existing URL-context handling follow the original app flow. The guest
screen and its Keychain vault are created only when an invitation is opened.
Non-invitation browsing-web activities are ignored as before.

`AppClip/project.yml` creates the isolated development parent
`com.slopus.happy.botclip.dev` and embedded `com.slopus.happy.botclip.dev.Clip`.
They do not replace any installed Happy variant. `HappyBotGuestUI` tests the
same screen in an ordinary app (`com.slopus.happy.botguest.harness`); a harness
launch is not evidence of an App Clip launch.

`AppClip/FullApp.yml` opts the full native parent into Clip embedding. Generate
it only after the necessary App IDs and profiles exist:

```sh
cd packages/happy-ios
xcodegen --spec AppClip/FullApp.yml --project .
```

The opt-in Clip identifiers are each native variant's bundle identifier plus
`.Clip`. Its parent-application-identifiers entitlement names that variant,
and the parent entitlement names the corresponding Clip. Both require explicit
App IDs and profiles; a wildcard profile cannot sign a Clip. The Clip's domain
service is `appclips:app.happy.engineering`, and the parent's is
`applinks:app.happy.engineering`. No App Group or credential migration is
configured. A session redeemed in the Clip does not migrate to the newly
installed parent in v1. Opening that invitation and joining in the installed
app takes a second seat because its Keychain is separate. Owners should size
the link's member limit with that in mind.

## Invocation and guest capabilities

`https://app.happy.engineering/bot/invite/<opaque-token>` is accepted in every
variant. Preview additionally accepts
`https://securities-feels-twin-texture.trycloudflare.com/bot/invite/<opaque-token>`.
Only Preview app/Clip Info plists enable this extra host; Development and
Production retain the first-party-only parser. The API uses the link's HTTPS
origin, with no sign-in.
`HappyGuestPreviewInvites` is the Preview-only Info setting; the exact host is
`GuestInvitation.previewHost`. This trycloudflare hostname is an ephemeral
demo host, not the stable deployment domain. Replace it before a durable
release. Default app entitlements do not add this domain; the parent/Clip
association stays opt-in in `AppClip/FullApp.yml`.
The exact path has a 16–512-character ASCII base64url token. User info, a custom
port, a query, a fragment, extra segments, and untrusted hosts are rejected.
Cold and warm browsing-web `NSUserActivity` delivery use the same parser.
Reopening the same invitation resumes its stored session without re-redeeming.
The debug `_XCAppClipURL` fallback runs only when no actual invocation arrived.

A new guest sees one screen: "Join a Happy bot", "Your name", and Join. There
is no public preview endpoint; opening this screen does not claim a seat. The
same shared screen runs in the installed app. Existing sessions and pending
joins skip name entry. The composer shows "Message as <name>" after joining.
The screen also explains that everyone joining the link can see the chat,
including earlier messages, and that member names are unverified.

Names normalize to NFC, collapse spaces, and trim, then require 1–40 grapheme
clusters. Allowed characters are Unicode letters, marks and numbers, spaces,
`. ' - _` and the right curly apostrophe U+2019. Control/format/private/
unassigned characters, line/paragraph separators, leading combining marks,
and more than four combining marks per grapheme are rejected. A clear error
keeps the guest on name entry. Names are never logged by guest code.

All credentials use the app's default Keychain access group, service
`happy-ios:bot-guest`, account `scoped-sessions`, with
`AfterFirstUnlockThisDeviceOnly` accessibility. They never use the owner's
Keychain services or UserDefaults. The registry contains scoped sessions for
several invitations, indexed by a SHA-256 capability identifier, and the last
active invitation. It also securely stores a pending message and its stable
localId until acknowledgment.

Before the first redeem reaches the network, the Keychain stores the pending
invitation, chosen name, and a 32-byte random base64url nonce. One actor-owned task per
invitation completes the handshake even if its presenting view is dismissed
or backgrounded. Repeated requests with the same nonce recover the session
after a lost response. The returned credentials replace the pending invitation
and nonce atomically. Launch without an invocation restores either the scoped
session or the pending handshake. No guest capability is logged by this code.
The saved name stays fixed during recovery. Only a bridge `400 invalid_name`,
guaranteed to precede any seat claim, allows correction with the same nonce.
Expiration, revocation, and Leave remove the current guest's stored session.
Sessions more than 24 hours beyond their expiry are pruned from the registry.

## Bridge contract

The invocation HTTPS origin must host or reverse-proxy the invitation bridge:

- `POST /v1/bot-invites/redeem` with `{token, redeemNonce, displayName}` returns
  `{sessionId, sessionToken, botName, expiresAt, readOnly, displayName, memberId}`.
  Timestamps are Unix
  milliseconds. A nonce is 43 base64url characters from 32 random bytes.
- `GET /v1/bot-guest/sessions/<sessionId>/messages?wait=25&after=<cursor>` uses
  the scoped bearer token. It returns `{messages, cursor, status}`, where each
  message is `{id, role: "user" | "assistant", text, createdAt, senderName, isMine}`, the cursor is
  a nullable numeric string, and status is `online` or `offline`.
- `POST` to that messages endpoint sends `{localId, text}` with the scoped
  bearer. The server deduplicates localId. The native limit is 4,000 UTF-16 code
  units, matching the server's string limit. Validation failures preserve the
  editable draft and clear its rejected pending ID.
- Scoped `POST .../report` records a report for owner inspection; scoped
  `POST .../block` revokes that guest session. The More menu exposes Report and
  Leave; Leave wipes locally after the block succeeds.

401/404 end unavailable or revoked access; 410 ends expired access; 409 on
redeem retains legacy already-used handling. `410 invite_full` is a distinct
terminal "no free seats" state; other 410 responses mean expired. Full,
expired and revoked redemption remove the saved pending capability. A link
admits its configured number of distinct nonces, each with its own scoped
session but ONE shared invitation conversation. The same nonce recovers its
existing member even when all seats are occupied. Late joiners see the entire
history. The backend supplies `senderName` and `isMine` for every message;
the client labels your own messages "You", other members with their server
name, and bot replies with the server bot name. Names inside message bodies
remain plain body text. Legacy messages lacking these fields keep the old
private-session presentation. Leaving or revoking one member ends only that
member's access and does not erase shared history or end the group.
403 on send makes the
screen read only while preserving its transcript and polling. 429 and 503 are
retryable and respect Retry-After. Ordinary network failures retry with capped
exponential backoff. There is one client poll at a time; request timeout is 35
seconds for the 25-second server wait. Background and dismissal cancel polling,
and foreground resumes it. Server authorization, not the phone's clock, decides
whether credentials have expired.
Empty successful pages wait at least one second before the next poll, or four
seconds while offline, so an early-returning bridge cannot create a tight loop.
A `limit_reached` error stops further sends while keeping the transcript.

The dedicated ephemeral URLSession has no cookie or credential storage, cache,
or owner Authorization injection and refuses redirects. It invalidates when
discarded. Server session IDs are validated before path construction. Text is
plain UITextView content, with data detectors disabled; no HTML or Markdown is
interpreted. Message derivation and deduplication run off the main actor; UIKit
appends only new text. Read-only conversations hide the composer.

## Development and checks

All iOS builds and tests run through Xcode on the designated Mac mini:

```sh
cd packages/happy-ios/AppClip
xcodegen generate
xcodebuild -project HappyBotDevelopment.xcodeproj -scheme HappyBotClip \
  -configuration Debug -destination 'id=<iPhone-UDID>' \
  -derivedDataPath ../ClipDerivedData -allowProvisioningUpdates build
xcodebuild -project HappyBotDevelopment.xcodeproj -scheme HappyBotClip \
  -destination 'platform=iOS Simulator,id=<simulator-UDID>' \
  CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES test
```

Debug builds accept a process environment `HAPPY_GUEST_API_ORIGIN` (for example
`http://127.0.0.1:17891` behind an SSH reverse forward). It never comes from an
invitation parameter and is compiled out of distribution builds. Only the
debug Clip plist permits local networking; distribution has no ATS exception.
The standalone compiler flag prevents importing the full app's package modules
even if they happen to be available during a combined parent/Clip build.

For live simulator checks, use normal ad-hoc simulator signing
(`CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES`); an unsigned simulator app can
fail its own Keychain operations. This requires no host private key or Keychain
access-control change. Invoke the Clip with a real invitation and local bridge
origin, then run `HappyBotClipLive` for an actual model reply, keyboard clearance,
and process-relaunch restore. `HappyBotClipReadOnly` checks a separately invoked
read-only invitation. Neither live scheme contains an invitation credential.
The live scheme also has `testNamedMemberAda`, `testNamedMemberGrace`, and
`testInviteHasNoFreeSeats`. Run them individually on three isolated simulators
invoked with one two-seat link. They cover name entry, separate actual model
replies, restore without onboarding, and the third member's full state. Named
live tests use the debug bridge origin `http://127.0.0.1:17892`.

## Distribution and remaining work

The web host needs AASA `appclips.apps` for the signed Clip and an `applinks`
entry for the parent. A deployed broker and AASA configuration are not supplied
by this native change. Signed physical installation, local invocation,
TestFlight invocation, and public QR/NFC/link invocation are separate checks.

TestFlight permits up to three App Clip invocation URLs per uploaded build;
testers launch them from TestFlight, and other invocation methods are not
supported there. Account Holder, Admin, or App Manager can manage experiences.
An approved App Store version's default experience gets an Apple-generated
`appclip.apple.com` link and demo URL. A TestFlight upload does not make a public
invitation link invoke the Clip. See Apple's
[Test an App Clip experience](https://developer.apple.com/help/app-store-connect/test-a-beta-version/test-an-app-clip-experience/).

Store readiness additionally needs content filtering, timely report handling,
owner/contact information, and the chatbot/content/age review requirements that
apply to this product. Report and Leave controls alone do not establish App
Store compliance. Native distribution must follow the repository release skill
from a fresh, clean `main`; no EAS App Clip distribution is wired by this change.

## Status and next actions

Preview 25 (`2026.10.1`, build `25`) is archived and verified on the designated
Mac mini in `~/happy-work/testflight-preview25-appclip-y1sar`. Its source is
`f35b9d32d0cb4732874932d4704403e555b5cc88`; the frozen archive predates the
subsequent main-integration audit, tests and documentation updates. Both parent
and Clip have matching dSYMs, and the parent's signed entitlements preserve
Preview 24's capabilities. The Clip is about 1.73 MB, uses only system
frameworks, and has no ATS exception or debug connection overrides.

Upload is blocked: Xcode currently has no App Store Connect account for team
`466DQWDR8C`. Supply an App Store Connect API key with Admin access, or sign in
to the authorized Apple account in Xcode. Then the release operator can export
and upload the preserved archive with:

```sh
cd ~/happy-work/testflight-preview25-appclip-y1sar
xcodebuild -exportArchive \
  -archivePath Happy-preview-25.xcarchive \
  -exportOptionsPlist ExportOptions-preview.plist \
  -exportPath export-preview25 \
  -allowProvisioningUpdates > upload-preview25.log 2>&1
```

For API-key authentication, additionally pass `-authenticationKeyPath`,
`-authenticationKeyID`, and `-authenticationKeyIssuerID` using the operator's
registered key. Keep the private key outside the repository. Export must obtain
explicit parent/Clip distribution profiles with the associated domains and
App Clip capabilities and set APNs to `production`. Verify processing in App
Store Connect after upload. Future binaries must follow the release skill from
fresh, clean main and include changes made after the frozen archive's source.

Remaining work:

- Resolve the existing native test baseline separately: the full suite ran
  2,357 tests (two skipped) with 12 assertion failures. The identical filtered
  command on clean `origin/main` and this change reproduces the same 11
  message fixture-byte assertions in `SendingDeliveryMetaTests` and one voice
  translation-catalog assertion in `TranslationCatalogTests`. Guest, layout
  and app-configuration checks pass (19 tests).
- In App Store Connect, add the App Clip invocation URL to Preview build 25's
  TestFlight configuration. Verify launch from TestFlight. A Safari or Messages
  link can open the installed Preview parent; it does not establish a public
  App Clip experience by itself.
- Replace the ephemeral demo host with a stable domain, such as a named tunnel
  or the production host. Parameterize the Preview host instead of the current
  fixed constant, update the parent/Clip domains and AASA together, and rebuild.
- Implement Clip-to-parent session migration through an approved shared
  credential scope. Until then, joining in the installed app takes another
  seat; owner credentials must remain separate from guest credentials.
- Add opt-in App Clip push notifications with the eight-hour ephemeral
  notification authorization window, scoped device-token registration, and
  appropriate expiry and revocation. The current Clip does not request it.
- Complete App Store 1.2/4.7 moderation, content filtering, report handling,
  contact details and age-rating requirements. Configure and verify a production
  App Clip experience on the production domain before public distribution.
- Provide Android and web fallbacks for invitation links, with a browser guest
  conversation or an appropriate app/store destination and name-only joining.
- Verify on a real iPhone: ordinary launch and owner login, cold/warm invitation
  opening in the installed Preview app, TestFlight Clip invocation, two-member
  shared history and labels, keyboard clearance, process-restart recovery, full
  invites, expiry, revocation and leaving only the current member. Current
  physical development builds are blocked by missing Xcode accounts and
  explicit App Clip-capable profiles; simulator developer invocation is the
  evidence available so far.