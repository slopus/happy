# Remote-only browser and artifact proxy

Every HTTP(S) request and WebSocket from the in-app browser goes through the
agent connection, including public sites and CDN resources. There is no direct
phone-network path or fallback.

WebKit uses `WKWebsiteDataStore.proxyConfigurations` (public API since iOS 17)
with an authenticated HTTP CONNECT listener bound to **127.0.0.1 only**.
`WKURLSchemeHandler` cannot carry ordinary WebSockets, so no custom web scheme
or JavaScript replacement for fetch/WebSocket is used. The native proxy
configuration has no domain exclusions and `allowFailover = false`.

`BrowserProxy` and `BrowserRelay` run outside the main actor. Each direction
reads at most 64 KiB and waits for its write before reading again. Heads are
limited to 32 KiB and 35 seconds; response bodies have no idle deadline. Closing
a page cancels its listener, local sockets and upstream requests, including SSE.
There are at most 64 simultaneous connections per page.

Artifact API requests lease exclusive upstream keep-alive connections from a
per-page pool (at most six idle connections, reused for five seconds). Local
WebKit connections still close after each response, so every request is
classified and authorized independently. No request is pipelined or replayed
automatically after a transport failure. SSE holds its own lease until the page
disconnects. A socket returns to the pool only after its exact content length,
or complete chunk framing and trailers, has arrived. EOF-delimited responses,
upgrades, `Connection: close`, truncated responses and failed writes are never
pooled. Closing the page also closes idle and leased upstream sockets.

Daemon responses, including 400, 409 and 413, pass through unchanged. Locally
generated failures have a `browser_proxy_*` JSON code and `X-Happy-Proxy-Error`
header: validation is 400, forbidden origins/routes 403, oversized requests 413,
unavailable routes/capacity 503, and upstream timeout 504. Actual upstream
transport or malformed-response failures are 502. Native `BrowserProxy` logs
the same safe code and status, without tokens, URLs, headers or response bodies.
After a response or opaque tunnel starts, errors close that stream; they never
append a second HTTP error response to its bytes.

## Routing

- A chat link uses that chat's workspace. Outside chat, the standard navigation
  controller supplies AppContext, and the active connection is resolved when
  the link opens, not cached across account switches. The fallback is an active
  workspace explicitly marked local `compute.type: host`, never an arbitrary
  runner. Without a usable connection or route, loading fails with retry and
  **never creates a direct WebKit view**.
- Each target opens authenticated `CONNECT /v0/workspaces/:id/proxy`, then
  nested `CONNECT host:port`. The daemon chooses the workspace's runner. Its
  CONNECT contract permits arbitrary valid host:port targets, including public
  destinations. DNS resolution occurs remotely. TLS and WebSocket bytes remain
  untouched, preserving real origins, cookies and redirects.
- Bundled artifacts get a unique synthetic HTTP origin and a nonpersistent
  WebKit store. `/api/*` maps only to `/v0/artifacts/:id/api/*`; other paths map
  only to the opened version's files. All methods and query strings survive.
  The daemon's `/api/v1/client.js` supplies its own SDK; no stale copy is injected.
  Live data, identity, conditional writes and debug reporting share this route.
  SSE and upgrade responses stream without response buffering. External
  resources use the artifact source's workspace (or host fallback) over CONNECT.
  A bundled artifact can still serve its own files/API without a workspace,
  but external requests then fail closed.
- A live artifact (`live.url`, made with `create_artifact` and `url`) opens
  the URL of the version shown, a pinned version its own, http or https.
  Every tunnel its page opens, to its own origin or any other host, is
  `CONNECT /v0/artifacts/:id/proxy` then nested `CONNECT host:port`
  (`BrowserNetwork.artifact`). That route reaches the network the artifact
  was made on (`live.networkId`, say the creating agent's own container), and
  the daemon checks every destination against the artifact's current URL;
  the phone names no network and no allowlist. No workspace is looked up for
  it, and nothing falls back to a workspace, the network or another proxy. The
  page gets no data bridge: its `/api/*` is the site's own and reaches the site
  with no daemon credential. HTTPS stays end to end, as for any link. Its
  store is the page's own nonpersistent one. A refusal of the artifact route
  itself (404: the artifact is gone or not live, or its network isn't served;
  501; 503) is `BrowserError.liveUnavailable`, shown as "This Page's Computer
  Isn't Available"; a destination refused inside the open tunnel (the
  daemon's 403, or a dev server that isn't running) stays what it was.
  Over Tailcat the route is CONNECT to the daemon; over HTTPS it is the
  route's WebSocket twin (`/v0/artifacts/:id/proxy/websocket`) when health
  offers twins, through the same `proxyTunnel` as every other route.
- The phone's own loopback is never a page's. WebKit connects to it directly,
  proxy or not (measured for `127.0.0.1` and `[::1]` on an iPhone 12, iOS
  26.1, and for `localhost` there too), so a link or a page to `127.0.0.1`,
  `[::1]` or `localhost` opens on an alias, `ipv4`, `ipv6` or
  `name.happy-loopback.invalid` at the same port and scheme
  (`BrowserPolicy.Loopback`). The page starts there, and a main-frame
  navigation or redirect to the loopback reloads there. The proxy tunnels
  the alias as `CONNECT` to the loopback it stands for, so the daemon sees
  exactly what it did before. Each plain HTTP request's `Host`, plus an
  `Origin` or `Referer` on the alias, names the loopback again, so dev
  servers that check them (Vite, Next) answer. TLS passes untouched: its
  name is the alias. Every page also has a content blocker for anything
  else it loads (frames, scripts, fetches, WebSockets) from a host that is,
  as WebKit canonicalizes it: any `127.x.y.z` (so `127.1`, `2130706433`,
  `0x7f.1`; not a name like `127.example.com`),
  `localhost`, `*.localhost` (each with or without a trailing dot),
  `0.0.0.0`, `[::]`, `[::1]`, `[::ffff:127.*]`, `[::ffff:7f…]` or
  `[::ffff:0:0]`, with or without userinfo. That includes a subresource on
  the exact loopback, which fails, not reloads. A main-frame form POST to
  the loopback reloads on the alias as a GET.
  The address bar, errors and Share show the address as the link gave it.

## Security rules

The loopback listener requires random per-page proxy credentials held only in
native WebKit configuration. They are unrelated to daemon credentials. The
daemon bearer token is inserted only on the native side, only for the workspace
CONNECT or scoped artifact endpoint, never into HTML, JavaScript or the inner
target connection.

A link page gets a workspace **network** capability and may reach arbitrary
hosts, but gets **no authenticated daemon or artifact API bridge**. A request
whose target path happens to be `/api/*` or `/v0/*` remains an ordinary request
to the target service, with no daemon credentials. The daemon independently
authenticates its own HTTP listeners. A page cannot choose a runner or forge
the native `x-happy-proxy-route` routing context.

An artifact's authenticated bridge cannot name another artifact, another
version or a general daemon route. Traversal, encoded separators, nested
encodings and control bytes are rejected before path normalization. Cross-origin
`Origin`/`Sec-Fetch-Site` requests cannot borrow its API. Request bodies are
bounded to 1 MiB, including chunked uploads, and reframed to a single length;
pipelined bytes never enter an authenticated daemon connection. Authentication
and routing headers are replaced. Responses preserve status, duplicate headers,
cache conditions and binary/chunked bodies. The daemon's opaque-origin file
sandbox is replaced by a same-origin sandbox on the already isolated artifact
origin, so fetch, SSE and storage work.

Each browser has a nonpersistent data store; native origin rules scope cookies
and storage. Nothing is shared with another artifact or account. Safari is only
in the Share menu, explicitly labeled
“Open in Safari (outside proxy)”; synthetic bundled origins cannot open there.
Sharing a bundled artifact shares its tag.

`NSAllowsArbitraryLoadsInWebContent` remains necessary even though the remote
tunnel is encrypted: ATS checks the **page URL before CONNECT**. The hosted test
without that allowance failed with -1022. The exception applies only to WebKit,
not the production native API client; it permits HTTP dev servers and public
HTTP URLs while those bytes still travel through the agent tunnel.

## The browser screen

`BrowserViewController` keeps the standard header. Back and forward, then
reload (stop while loading) and share, sit at its right in two glass groups;
a long press on back or forward lists that way's history. The title is the
page's, with its host as the subtitle. Embedded in an artifact, the buttons go
in the artifact's header and its title stays. The page runs the full height,
under the header and the home indicator, and WebKit insets its content by the
safe area, so nothing moves when the header appears. Until it paints, the
screen's surface shows through (`isOpaque = false`). There is no pull to
refresh (Steve, for both apps); the header's button reloads.

The back swipe is the page's while it has history (`TakesBackSwipe`): the
shell's pop doesn't begin, and WebKit's own swipe goes back a page. On the
first page, or over the error page, the swipe closes the screen.

**Loading bar.** WebKit's `estimatedProgress` can't drive it alone: every
request first opens a tunnel to the computer, and WebKit counts nothing until
bytes arrive. Measured through the proxy, it sits at 0.1 for the whole tunnel
setup (1.5 s against the fake daemon, longer over Tailcat), then jumps to 1
within 30 ms. The old bar set that value unanimated and hid at 1, so it showed a
10 % stub and vanished; it was also at 0, invisible, while the session
connected. `BrowserProgress` now starts at 0.1 as soon as anything loads (the
connect included), creeps toward 0.7 while nothing is heard, takes WebKit's
estimate only when it is further, fills to 1 and fades. A redirect or a
replacing navigation continues the bar; it never goes back within a load.

**Error page.** A glyph, a title, a sentence and Try Again, which loads the
address that failed, not the last one that worked (`BrowserProblem`):

| Cause | Shown as |
| --- | --- |
| No network path (`LinkState.waitingForNetwork`) | You're Offline |
| The proxy's tunnel to the computer failed (`browser_proxy_upstream_transport`) | Can't Reach <computer>; retried by itself when the link is back |
| No session or route (`BrowserError.unavailable`) | Can't Open This Page |
| A live artifact's own proxy refused (`BrowserError.liveUnavailable`, `browser_proxy_live_unavailable`) | This Page's Computer Isn't Available |
| The computer refused the target (502/503/504 on CONNECT), connection refused or lost | Server Isn't Responding, naming host:port |
| The proxy's own 502/503/504 response (`X-Happy-Proxy-Error`), whatever its body | Server Isn't Responding |
| An error status with no body | Page Error <status>; one with a body shows as the page |
| Timeout, DNS, TLS | Page Took Too Long, Can't Find the Server, Can't Open Securely |
| The web process stopped | Reloaded once quietly; a second stop shows This Page Stopped Working |
| A link to an app nothing opens | An alert over the page, or the error page when nothing was shown |

WebKit only says the proxy refused a tunnel, so `BrowserProxy` keeps the last
refusal per host (`BrowserRefusals`) and the screen reads it. Cancelled and
replaced loads (`NSURLErrorCancelled`, WebKit's 102 and 204) never show an
error. Hosted tests (`HostedBrowserStatesTests`) drive each case through real
WebKit and the proxy, and assert the bar's whole run and the buttons.

## Native artifact viewer

Markdown, image, image series and video artifacts are drawn natively
(`ArtifactViewController`), not in WebKit. Their own files are read through
`GET /v0/artifacts/:id/versions/:n/files/*path` (`AgentClient.artifactFile`),
a 4 MiB range at a time. A recording streams through `MediaStream`, an
`AVAssetResourceLoader` whose every request becomes a `Range` request on the
same route; the daemon answers `206`, so the player seeks without reading the
whole file.

A Markdown document resolves each picture and link against its own path
(`ArtifactMarkdown.resolve`), as a browser resolves them against the entry's
URL: `./`, `../` and percent-encoding are honoured, a leading `/` starts at the
version's root, and a path that would leave the version, or that decodes to a
separator, backslash or control byte, is refused. Links to other files of the
version open in the same viewer.

An absolute http(s) picture in a document goes through `BrowserFetcher`, never
the phone's network. `https` uses a URLSession whose only proxy is a
`BrowserProxy` on loopback (`.workspace` scope, the artifact's source
workspace), so TLS stays end to end. Plain `http` is one GET over a CONNECT
tunnel, because App Transport Security refuses plain-HTTP URLSession loads
before any proxy sees them (production allows arbitrary loads only in web
content). Nothing but the request is sent, with no cookies or cache.

## Contract gaps and limits

Live artifacts follow happy-agent API.md, "Live URLs" and
`CONNECT /v0/artifacts/:artifactId/proxy`. The route has no version selector:
the daemon checks a pinned version's URL against the artifact's current one, so
a pinned version whose URL has since changed is refused inside the tunnel.

The daemon exposes no unscoped host CONNECT endpoint, so host fallback needs a
local host workspace. Legacy relay chats have no workspace-to-agent-connection
mapping: the active agent connection can supply a host fallback, or the browser
shows the unavailable state. No device-local localhost or public fallback occurs.

Hosted tests use real WebKit and the loopback listener against a byte-level fake
daemon: artifact PUT and live SSE, relative JavaScript and WebSocket, a live
artifact through its own proxy with no API bridge (and its pinned version's
URL, and its unavailable page), chat workspace selection, and
public pages/resources on fake-only domains that cannot resolve on the phone.
They assert no failover/domain exclusions and no view when no connection exists.
Core tests cover framing, errors, credential boundaries and streaming; pure
layout tests assert exact frames. WebRTC/UDP is not a supported browser feature
and is not covered by these HTTP/WebSocket transport tests.

## Real daemon API regression

`HostedBrowserAPITests` is opt-in and uses the real daemon routes, database and
browser SDK. Start a fresh throwaway fixture for each run:

```sh
# In a separate happy-agent checkout with dependencies installed:
pnpm --filter @slopus/happy-agent-modules build
pnpm --filter @slopus/happy-agent build

# In this repository; keep this process running while Xcode runs the test:
HAPPY_AGENT_REPO=/absolute/path/to/happy-agent bun packages/happy-ios/scripts/browser-api-gym.ts
```

Run `HappyUIKitHostedTests/HostedBrowserAPITests` with the `HappyUIKitHosted`
scheme. The fixture writes its ephemeral connection details to the ignored
`.context/browser-api-gym.json`; without it, the test explicitly skips. Stop the
fixture afterwards to close its daemon and delete its test installation. It
never reads or writes the installed daemon's artifact data.

The 13 scenario groups cover 1,005 batched writes while SSE stays live, raw and
SDK pagination, write-ID replay, quoted/bare/stale conditional writes, conflict
bodies, deletes/tombstones, distinct-key changes and future cursors, UTF-8 large
body round trips, 413/404, and ETag/304. The test also asserts fewer than 30
upstream connections for the whole run. This uses real WebKit and the production
proxy, replacing only the remote encrypted link with a byte-transparent local
TCP-to-Unix adapter. Tailcat's own paired-IPStack regression separately covers
1,300 short HTTP requests alongside SSE, bounded closing-state eviction and
late FIN handling; closed flows must not consume its live 256/1,024 budgets.