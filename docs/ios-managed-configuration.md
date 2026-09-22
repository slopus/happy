# iOS managed app configuration

Happy supports Apple's MDM managed app configuration dictionary on iOS through
`com.apple.configuration.managed`. This requires a native build containing
`HappyManagedConfiguration` (Expo runtime 22 or a subsequent compatible runtime).
Existing App Store builds and Expo Go do not gain support from a JavaScript-only
OTA update. Android, web and desktop are unaffected.

## Configuration keys

Keys are case-sensitive. Both are optional. Unknown keys and invalid values are
ignored individually; do not rely on a malformed policy to restrict the app.
See [the JSON schema](ios-managed-configuration.schema.json) for the dictionary's
shape. This schema documents Happy's keys; it is not an Intune schema upload file.

| Key | Intune value type | Behavior |
| --- | --- | --- |
| `server_url` | String | HTTPS origin of the Happy relay, for example `https://happy.example.com` or `https://happy.example.com:8443`. Optional trailing slash is normalized. Credentials, URL paths, query strings, fragments and HTTP are rejected. Overrides the local server choice and build defaults; the server field becomes read-only. |
| `analytics_enabled` | Boolean | `false` prevents creation of the PostHog client, including automatic lifecycle capture, and locks the analytics switch off. `true` or omission leaves the existing user opt-out and build-level disable controls in effect; it does not force analytics on. Use a real Boolean, not the string `"false"`. |

The analytics key controls Happy's PostHog product analytics. It is not a blanket
network/telemetry firewall: console logging, optional log-server output, push
notifications, Expo updates, purchases and voice services have separate behavior.
The server key selects the main relay. It does not redirect every service; the
existing custom-server-for-voice setting still controls voice routing.

## Microsoft Intune

1. Deploy a supporting Happy native build as a **managed app** on an enrolled
   iOS/iPadOS device. The production bundle ID is `com.ex3ndr.happy`.
   Development and preview builds use `com.slopus.happy.dev` and
   `com.slopus.happy.preview`; target the installed variant.
2. Create an app configuration policy for **Managed devices**, platform
   **iOS/iPadOS**, and select that Happy app.
3. Enter the two settings with the types above, or use **Enter XML data**:

```xml
<dict>
    <key>server_url</key>
    <string>https://happy.example.com</string>
    <key>analytics_enabled</key>
    <false/>
</dict>
```

4. Assign the policy and allow the device to sync. Fully quit and reopen Happy.
   Merely backgrounding and foregrounding the app is not sufficient.
5. Confirm that the Server screen displays the managed URL, cannot be edited,
   and says “Managed by your organization”. In Account settings, analytics
   should be off and disabled with the same explanation.

This uses Apple's MDM channel. It does not add Intune SDK/MAM configuration for
unenrolled devices, and does not add Intune app protection policies.

## Lifecycle, precedence and removal

The policy is read synchronously into an immutable snapshot when the JavaScript
runtime starts, before server requests or PostHog initialization. Changes and
removal take effect after a full app restart. The app intentionally does not
switch an active authenticated session to another server as an MDM notification
arrives. Administrators requiring immediate changes must arrange a restart.

Managed values are not copied into MMKV or synchronized account settings. A
server override wins over the saved local choice, web injection and build
configuration. Removing it restores the normal server-selection rules after
restart. Removing the analytics restriction restores the user's existing choice;
it does not write an opt-in preference.

Deploy the server policy before pairing new devices where possible. When a
policy changes the effective server of an existing account, Happy requires the
user to reconnect rather than sending the old server's bearer token to the new
server. Newly saved managed credentials record their server. Previously saved
credentials are associated with the ordinary local/build server selection.
The same check applies on policy removal. The existing Keychain entry is retained
until the user signs in again; a policy change does not delete the account key.
Back up account recovery information before reconnecting to a different account.
This is not an account or session migration between relay servers.

## Validation

Automated regression coverage:

```sh
pnpm --filter happy-app test run sources/sync/managedConfiguration.spec.ts sources/sync/serverConfig.spec.ts sources/track/tracking.spec.ts sources/auth/tokenStorage.spec.ts
pnpm --filter happy-app typecheck
```

Before releasing, validate a native iOS build on a managed test device:

- No policy: normal local server selection and analytics controls work.
- Managed HTTPS URL: the initial API connection uses that URL; saved local
  settings and UI actions cannot override it.
- `analytics_enabled=false`: no PostHog client/requests, including on first
  launch with a configured PostHog project key. A synchronized account preference
  must not re-enable collection.
- `analytics_enabled=true`: a user's analytics opt-out remains respected.
- Policy changes and removal: current session remains stable; the next full
  restart applies the new configuration and restores local choices on removal.
- A different effective relay requires reconnecting; no old bearer token is sent
  to the new relay, and policy application does not delete the Keychain entry.
- Invalid values: wrong-case keys, string booleans, HTTP and non-origin URLs are
  ignored independently; a valid analytics restriction still applies alongside
  an invalid server key.
- Record a screen capture of the locked controls and device/network evidence
  of the effective server and disabled PostHog before requesting human review.

A successful Intune policy delivery only confirms delivery. Verify app behavior
as well. Native compilation, MDM delivery and device traffic checks require macOS
and an enrolled iOS device; JavaScript tests do not substitute for those checks.
