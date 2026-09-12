# expo-tailcat

Native, app-scoped HTTP and WebSocket connections through
[Tailcat](https://github.com/tailscale/tailcat), for Expo on iOS and Android.
No system VPN, Tailscale account, root access, or WebView. This package does not
join a normal Tailscale tailnet and does not implement a Tailcat server.

The Go library provides a WireGuard-encrypted userspace connection to one
remote Tailcat server. A loopback HTTP proxy exposes one explicitly selected
remote port to React Native's existing `fetch` and `WebSocket` implementations.
Request/response bodies stream natively; they are not base64-encoded across the
Expo bridge. Each local endpoint has a random 256-bit capability path.

## Status and compatibility

Unpublished, experimental `0.1.0`. Developed independently of `happy-app`.
The initial compatibility target is Expo SDK 55, React Native 0.83, iOS 15.1+
(the host Expo app may require newer), and Android API 26+ with arm64-v8a and
x86_64 binaries. Expo Go, web, 32-bit Android and background VPN operation are
not supported. Native changes require a new application binary, not an OTA.

Tailcat's API and wire format are unstable. The exact upstream revision and
Go/mobile toolchain are pinned in `go/go.mod` and `go/go.sum`. Use compatible
Tailcat versions on both ends; this is not a promise to interoperate with every
past or future CLI release.

## Usage

After publication, install with `pnpm add expo-tailcat`, add `expo-tailcat` to
your Expo `plugins`, and create a new native build. During source development,
build the native artifacts first; installation does not download binaries or
invoke Go. The example app and CI use the local package.

On the paired machine, explicitly expose the HTTP service:

```sh
tailcat serve 8080
```

Transfer the resulting `tc…` address over an authenticated private channel.

```ts
import { openTunnel } from 'expo-tailcat';

const tunnel = await openTunnel({ address: pairedAddress, port: 8080 });
try {
  const response = await fetch(tunnel.httpUrl + 'api/status');
  const status = await response.json();

  const socket = new WebSocket(tunnel.wsUrl + 'events');
  // Use socket.onopen/onmessage/onerror as usual.
  // Keep the tunnel alive for as long as the socket is needed.
} finally {
  await tunnel.close(); // Also closes in-flight HTTP requests and WebSockets.
}
```

Both base URLs end with `/` and contain a **secret path**. Append relative
paths (`'api/status'`), not absolute paths (`'/api/status'`), to retain that path.
Do not log or persist the URLs. For Socket.IO, set its `path` to a path under
this prefix as well; it must not default to `/socket.io` at the origin root.

Options:

| Option | Meaning |
| --- | --- |
| `address` | Required secret Tailcat address. |
| `port` | Required remote TCP service port, 1–65535. |
| `scheme` | Remote `http` (default) or `https`. The local URL remains loopback HTTP. |
| `hostname` | Remote HTTP Host and TLS certificate/SNI name; default `localhost`. No DNS lookup is used for the tunneled connection. |
| `derpMapUrl` | Optional HTTPS relay-map URL. Embedded relay metadata takes precedence upstream. |
| `connectTimeoutMs` | Dial, TLS handshake and response-header timeout; default 15000, range 100–120000. Streaming bodies have no fixed duration limit. |

HTTPS validates the remote certificate normally. There is no insecure TLS
switch. HTTP is encrypted over the Tailcat link, but traffic between a remote
Tailcat forwarder and its HTTP service depends on that service's configuration.
`openTunnel` checks remote TCP reachability, not HTTP health or TLS success.
Use `AbortController` to cancel HTTP requests.

## Lifecycle

`close()` is idempotent. `closeAllTunnels()` closes all endpoints and cancels
pending opens. Module teardown closes everything. The module also invalidates
all tunnels when the app backgrounds; Android additionally invalidates them
on network/interface changes rather than waiting for Go's slow Android polling.

Subscribe with `addTunnelsClosedListener(({ reason }) => ...)`, discard old
URLs, and reopen once the app is active and connectivity is available. The
subscription has `remove()`. There is no automatic replay of requests: callers
must decide whether retrying a POST is safe. iOS uses Tailscale's native network
monitor while active. Physical-device Wi-Fi/cellular handoff and battery usage
still need testing beyond the simulator gates.

## Security and limitations

- Treat Tailcat addresses as bearer credentials. Keep pairing authentication
  and application-level HTTP authorization. Client Tailcat identities are
  ephemeral; persistent client-key allowlisting is not exposed by this version.
- Bindings listen only on `127.0.0.1`. Requests require the exact local Host and
  capability path. Foreign browser Origins are rejected. Upstream Origin and
  Referer are removed to avoid leaking the local capability; forwarded proxy
  headers are not trusted. This is an API transport, not a general website proxy.
- Relative and same-origin redirects are rewritten through the tunnel.
  Cross-origin redirects remain external and follow the caller's normal HTTP
  behavior. HTML/JS bodies, cookie domains/paths and absolute URLs inside JSON
  are not rewritten. Prefer bearer-header auth to browser cookie workflows.
- The Expo plugin permits local cleartext for the proxy, not arbitrary remote
  HTTP, and raises Android's minimum SDK to 26 (preserving higher minimums).
  Android apps with an existing `networkSecurityConfig` must merge the
  loopback exception themselves instead of using this plugin; it refuses to
  silently overwrite their security policy. Bare apps can configure equivalent
  ATS/Android settings manually and use native autolinking without the plugin.
- Public Tailcat DERP relays are rate-limited and have no SLA. Operate private
  relays for production. The test suite never uses the public relay fleet.
- Go/netstack adds native binary size and runtime memory overhead. A manager
  creates a separate Tailcat client per tunnel; close unused tunnels promptly.
- Tailcat itself is experimental. Do not expose arbitrary ports, exit nodes,
  or privileged services to untrusted peers without a separate security review.

## Development and local checks

Requirements: Node 22+, pnpm 10.11.0, Go matching `go.mod`. Native builds also
need Xcode 26+ on macOS or an Android SDK/NDK (CI selects installed Xcode 26.2
and pins NDK 27.2.12479018).

```sh
cd packages/expo-tailcat
node --test test/*.test.cjs
node scripts/check-package.cjs
bash scripts/test-go.sh
```

Go tests start their own loopback-only DERP relay and Tailcat HTTP/WS service.
They cover binary POST bodies, status/headers/query preservation, escaped
paths, redirects, unauthorized requests, concurrency, cancellation, WS
text/binary/subprotocol, shutdown and reopen, with the race detector.

```sh
pnpm build:ios       # on macOS: device + simulator XCFramework
pnpm build:android   # arm64 + x86_64 AAR, 16 KB-aligned native library
pnpm --dir example install --ignore-workspace --frozen-lockfile --ignore-scripts
pnpm --dir example exec expo prebuild --no-install
```

`example/` is a tiny standalone Expo app; it does not install or build Happy.
Start the private fixture (`go run ./cmd/fixture` from `go/`), then run the
example in a native build. Android uses `adb reverse tcp:18081 tcp:18081` and
`adb reverse tcp:18443 tcp:18443`. Never expose the test fixture outside loopback:
it shares an ephemeral address and intentionally uses a test relay certificate.

## Resource-conscious GitHub Actions

`.github/workflows/expo-tailcat.yml` runs inexpensive JS and Go checks on
package changes. Native E2E is **opt-in**, via `workflow_dispatch` (`ios`,
`android`, or `both`) or a push whose commit message includes
`[expo-tailcat native]` (both platforms), `[expo-tailcat ios]`, or
`[expo-tailcat android]` (initial branch workflow bootstrap and targeted retries).

The native gate builds a release test app, launches an iOS simulator on macOS
or Android emulator on Linux, and waits for seven explicit HTTP/WS/lifecycle
test results from JS through the Expo bridge and Tailcat. Compilation alone is
not success. No Metro server, public relay or external UI automation service is
needed at runtime. Native libraries, Go downloads and Gradle dependencies are
cached. Tested libraries are retained for seven days. There is no publish step.

## Before publishing (separate, explicit workflow)

Build and pass both platform gates at the same commit. Retrieve both native
artifacts into `ios/Frameworks/` and `android/libs/`. Run `go mod download all`
and `pnpm licenses`, review notices, then check and inspect the package tarball.
`prepack` refuses to create a package missing either native artifact or notices.
Also review privacy/export-compliance declarations for the host app. This
repository does not publish automatically and no credentials belong in the
package.