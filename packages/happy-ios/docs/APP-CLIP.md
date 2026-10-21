# Bot invitation App Clip

The guest screen is UIKit shared by the App Clip and the installed native app.
It has no owner authentication, account store, file access, tool approval, or
owner RPC client. The Clip compiles only the guest sources and one pure layout;
It links only Apple frameworks, including AppClip, Foundation, UIKit, Security,
and CryptoKit.

## Targets and provisioning

Normal `project.yml` builds keep their existing entitlements and do not embed
an unprovisioned Clip. They link the shared guest screen and route existing
`app.happy.engineering` browsing-web activities to it. When the full app is
already presenting a modal, the guest screen opens from the topmost modal.

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
installed parent in v1; reusing that invitation in the parent can return 409.

## Invocation and guest capabilities

Only `https://app.happy.engineering/bot/invite/<opaque-token>` is accepted.
The exact path has a 16–512-character ASCII base64url token. User info, a custom
port, a query, a fragment, extra segments, and untrusted hosts are rejected.
Cold and warm browsing-web `NSUserActivity` delivery use the same parser.
Reopening the same invitation resumes its stored session without re-redeeming.
The debug `_XCAppClipURL` fallback runs only when no actual invocation arrived.

All credentials use the app's default Keychain access group, service
`happy-ios:bot-guest`, account `scoped-sessions`, with
`AfterFirstUnlockThisDeviceOnly` accessibility. They never use the owner's
Keychain services or UserDefaults. The registry contains scoped sessions for
several invitations, indexed by a SHA-256 capability identifier, and the last
active invitation. It also securely stores a pending message and its stable
localId until acknowledgment.

Before the first redeem reaches the network, the Keychain stores the pending
invitation and a 32-byte random base64url nonce. One actor-owned task per
invitation completes the handshake even if its presenting view is dismissed
or backgrounded. Repeated requests with the same nonce recover the session
after a lost response. The returned credentials replace the pending invitation
and nonce atomically. Launch without an invocation restores either the scoped
session or the pending handshake. No guest capability is logged by this code.
Expiration, revocation, and Leave remove the current guest's stored session.
Sessions more than 24 hours beyond their expiry are pruned from the registry.

## Bridge contract

The invocation HTTPS origin must host or reverse-proxy the invitation bridge:

- `POST /v1/bot-invites/redeem` with `{token, redeemNonce}` returns
  `{sessionId, sessionToken, botName, expiresAt, readOnly}`. Timestamps are Unix
  milliseconds. A nonce is 43 base64url characters from 32 random bytes.
- `GET /v1/bot-guest/sessions/<sessionId>/messages?wait=25&after=<cursor>` uses
  the scoped bearer token. It returns `{messages, cursor, status}`, where each
  message is `{id, role: "user" | "assistant", text, createdAt}`, the cursor is
  a nullable numeric string, and status is `online` or `offline`.
- `POST` to that messages endpoint sends `{localId, text}` with the scoped
  bearer. The server deduplicates localId. The native limit is 4,000 UTF-16 code
  units, matching the server's string limit. Validation failures preserve the
  editable draft and clear its rejected pending ID.
- Scoped `POST .../report` records a report for owner inspection; scoped
  `POST .../block` revokes that guest session. The More menu exposes Report and
  Leave; Leave wipes locally after the block succeeds.

401/404 end unavailable or revoked access; 410 ends expired access; 409 on
redeem means another nonce already used the invite. 403 on send makes the
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