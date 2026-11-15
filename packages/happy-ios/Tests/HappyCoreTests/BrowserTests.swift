import Foundation
@testable import HappyCore
import XCTest

final class BrowserTests: XCTestCase {
    func testClassification() throws {
        for host in ["localhost", "localhost.", "a.localhost", "127.0.0.1", "127.1", "0x7f000001", "2130706433", "0.0.0.0", "Mac.local", "intranet", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.2", "169.254.1.2", "100.64.0.1", "[::1]", "[fd00::1]", "[fe80::1]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]"] {
            XCTAssertEqual(BrowserPolicy.route(try XCTUnwrap(URL(string: "http://\(host):5173/"))), .web, host)
        }
        for host in ["example.com", "172.32.0.1", "192.169.1.2", "8.8.8.8", "[2606:4700::1111]"] {
            XCTAssertEqual(BrowserPolicy.route(try XCTUnwrap(URL(string: "https://\(host)/"))), .web, host)
        }
        XCTAssertEqual(BrowserPolicy.route(URL(string: "https://preview.example.com")!), .web)
        XCTAssertEqual(BrowserPolicy.route(URL(string: "mailto:steve@example.com")!), .system)
        XCTAssertEqual(BrowserPolicy.route(URL(string: "tel:1234")!), .system)
    }

    func testAuthority() {
        XCTAssertEqual(BrowserPolicy.Authority(url: URL(string: "https://EXAMPLE.com")!)?.text, "example.com:443")
        XCTAssertEqual(BrowserPolicy.Authority(url: URL(string: "http://[::1]:5173")!)?.text, "[::1]:5173")
        XCTAssertNil(BrowserPolicy.Authority(url: URL(string: "http://user:secret@localhost")!))
        if let malformed = URL(string: "http://:80") { XCTAssertNil(BrowserPolicy.Authority(url: malformed)) }
    }

    func testWorkspaceSelectionUsesArtifactThenChatThenLocalHost() async throws {
        let client = AgentClient(transport: RoutingTransport(responses: [
            "/v0/artifacts/art1": #"{"artifact":{"updatedSource":{"workspaceId":"artifactworkspace"}}}"#,
            "/v0/agents/chat1": #"{"agent":{"id":"chat1","workspaceId":"chatworkspace","status":"idle"}}"#,
            "/v0/workspaces": #"{"workspaces":[{"id":"runnerworkspace","status":"active","compute":{"type":"host","runnerId":"runner1"}},{"id":"hostworkspace","status":"active","compute":{"type":"host"}}]}"#,
        ]), token: "test")
        let artifact = try await client.browserWorkspace(agentID: "chat1", artifactID: "art1")
        let chat = try await client.browserWorkspace(agentID: "chat1")
        let host = try await client.browserWorkspace()
        XCTAssertEqual(artifact, "artifactworkspace")
        XCTAssertEqual(chat, "chatworkspace")
        XCTAssertEqual(host, "hostworkspace")
        let runnerOnly = AgentClient(transport: RoutingTransport(responses: ["/v0/workspaces": #"{"workspaces":[{"id":"runnerworkspace","status":"active","compute":{"type":"host","runnerId":"runner1"}}]}"#]), token: "test")
        do { _ = try await runnerOnly.browserWorkspace(); XCTFail("must not silently use a runner as the host fallback") }
        catch { XCTAssertEqual(error as? BrowserError, .unavailable) }
    }

    func testAChatOpensInItsAgentsNetworkAndAnOlderComputerInTheWorkspace() async throws {
        let client = AgentClient(transport: RoutingTransport(responses: [
            "/v0/agents/chat1": #"{"agent":{"id":"chat1","workspaceId":"botworkspace","status":"idle"}}"#,
            "/v0/workspaces/botworkspace/agents/chat1/proxy": #"{"networkId":"c-chat1_env2"}"#,
        ]), token: "test")
        let network = try await client.agentNetwork("chat1")
        XCTAssertEqual(network, .network("c-chat1_env2"))
        XCTAssertEqual(network.path, "/v0/networks/c-chat1_env2/proxy")
        // A daemon without the agent network route has only the workspace's.
        let older = AgentClient(transport: RoutingTransport(responses: ["/v0/agents/chat1": #"{"agent":{"id":"chat1","workspaceId":"hostworkspace","status":"idle"}}"#]), token: "test")
        let fallback = try await older.agentNetwork("chat1")
        XCTAssertEqual(fallback, .workspace("hostworkspace"))
        // A server signed in to has no workspace proxy: no network named is none at all.
        let server = AgentClient(transport: RoutingTransport(responses: ["/v0/agents/chat1": #"{"agent":{"id":"chat1","workspaceId":"teamworkspace","status":"idle"}}"#]), token: "test", signsIn: true)
        do { _ = try await server.agentNetwork("chat1"); XCTFail("fell back to the workspace's proxy") }
        catch { XCTAssertEqual(error as? BrowserError, .unavailable) }
        for id in ["", "-a", "Host", "a/b", "a..b", String(repeating: "a", count: 129)] { XCTAssertNil(BrowserNetwork.network(id).path, id) }
        XCTAssertNotNil(BrowserNetwork.network("host").path)
    }

    func testArtifactBoundaryAndQueryArePreserved() throws {
        XCTAssertEqual(try BrowserPolicy.artifactPath(target: "/api/v1/kv/entry?key=a%2Fb", artifactID: "art1", version: 2), "/v0/artifacts/art1/api/v1/kv/entry?key=a%2Fb")
        XCTAssertEqual(try BrowserPolicy.artifactPath(target: "/nested/app.js", artifactID: "art1", version: 2), "/v0/artifacts/art1/versions/2/files/nested/app.js")
        for target in ["//other/api/v1", "/api/../agents", "/api/%2e%2e/agents", "/api/%252e%252e/agents", "/api/a%2fb", "/api/a%5cb", "/api/a%00", "/api/a\r\nX:yes", "http://other/"] {
            XCTAssertThrowsError(try BrowserPolicy.artifactPath(target: target, artifactID: "art1", version: 2), target)
        }
    }

    func testRequestTranslationPreservesMethodsAndConditionsButReplacesCredentials() throws {
        let raw = Data("PUT /api/v1/kv/entry?key=a HTTP/1.1\r\nHost: page\r\nAuthorization: attacker\r\nProxy-Authorization: local\r\nX-Happy-Proxy-Route: attacker\r\nIf-Match: version1\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}".utf8)
        let (head, rest) = try XCTUnwrap(BrowserHTTPHead.parse(raw))
        let translated = try head.artifactRequest(artifactID: "art1", version: 3, credential: "native-token")
        XCTAssertEqual(translated.line, "PUT /v0/artifacts/art1/api/v1/kv/entry?key=a HTTP/1.1")
        XCTAssertEqual(translated.value("Authorization"), "Bearer native-token")
        XCTAssertEqual(translated.value("If-Match"), "version1")
        XCTAssertNil(translated.value("Proxy-Authorization"))
        XCTAssertNil(translated.value("X-Happy-Proxy-Route"))
        XCTAssertEqual(rest, Data("{}".utf8))
    }

    func testResponsePreservesErrorStatusAndDuplicateCookies() throws {
        let raw = Data("HTTP/1.1 409 Conflict\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nETag: x\r\nRetry-After: 3\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n".utf8)
        let (head, rest) = try XCTUnwrap(BrowserHTTPHead.parse(raw))
        let result = head.artifactResponse()
        XCTAssertEqual(result.line, "HTTP/1.1 409 Conflict")
        XCTAssertEqual(result.fields.filter { $0.0 == "Set-Cookie" }.count, 2)
        XCTAssertEqual(result.value("Retry-After"), "3")
        XCTAssertEqual(result.value("Transfer-Encoding"), "chunked")
        XCTAssertEqual(rest, Data("2\r\n{}\r\n0\r\n\r\n".utf8))
    }

    func testStreamingForwardsEachChunkBeforeReadingAnother() async throws {
        let source = Bytes([Data("data: first\n\n".utf8), Data("data: update\n\n".utf8)])
        let destination = Bytes([])
        try await BrowserRelay.pipe(source, to: destination)
        let writes = await destination.writes
        XCTAssertEqual(writes, [Data("data: first\n\n".utf8), Data("data: update\n\n".utf8)])
    }

    func testConnectAuthenticatesOnlyOuterTunnelAndKeepsWorkspace() async throws {
        let bytes = Bytes([Data("HTTP/1.1 200 OK\r\n\r\n".utf8), Data("HTTP/1.1 200 OK\r\n\r\n".utf8)])
        let client = AgentClient(transport: Transport(bytes), token: "native-token")
        let stream = try await client.browserTunnel(workspaceID: "runnerworkspace", target: BrowserPolicy.Authority(url: URL(string: "http://localhost:5173")!)!)
        await stream.close()
        let written = await bytes.writes.map { String(decoding: $0, as: UTF8.self) }
        XCTAssertTrue(written[0].hasPrefix("CONNECT /v0/workspaces/runnerworkspace/proxy"))
        XCTAssertTrue(written[0].contains("Authorization: Bearer native-token"))
        XCTAssertTrue(written[1].hasPrefix("CONNECT localhost:5173"))
        XCTAssertFalse(written[1].contains("native-token"))
    }

    func testConnectErrorClosesStream() async throws {
        let bytes = Bytes([Data("HTTP/1.1 403 Forbidden\r\n\r\n".utf8)])
        let client = AgentClient(transport: Transport(bytes), token: "token")
        do { _ = try await client.browserTunnel(workspaceID: "work1", target: BrowserPolicy.Authority(url: URL(string: "http://localhost")!)!); XCTFail() }
        catch { XCTAssertEqual(error as? BrowserError, .upstream(403)) }
        let closed = await bytes.closed
        XCTAssertTrue(closed)
    }

    func testLiveArtifactTunnelsThroughItsOwnProxyForHTTPAndHTTPS() async throws {
        for (url, target) in [("http://127.0.0.1:4191/", "127.0.0.1:4191"), ("https://preview.example.com/app", "preview.example.com:443")] {
            let bytes = Bytes([Data("HTTP/1.1 200 OK\r\n\r\n".utf8), Data("HTTP/1.1 200 OK\r\n\r\n".utf8)])
            let client = AgentClient(transport: Transport(bytes), token: "native-token")
            let stream = try await client.browserTunnel(.artifact("art1"), target: XCTUnwrap(BrowserPolicy.Authority(url: XCTUnwrap(URL(string: url)))))
            await stream.close()
            let written = await bytes.writes.map { String(decoding: $0, as: UTF8.self) }
            XCTAssertTrue(written[0].hasPrefix("CONNECT /v0/artifacts/art1/proxy HTTP/1.1\r\n"), url)
            XCTAssertTrue(written[0].contains("Authorization: Bearer native-token"))
            XCTAssertTrue(written[1].hasPrefix("CONNECT \(target) HTTP/1.1\r\n"), url)
            XCTAssertFalse(written[1].contains("native-token"))
            XCTAssertFalse(written.contains { $0.contains("/v0/workspaces/") || $0.contains("/api/") })
        }
        XCTAssertNil(BrowserNetwork.artifact("../agents").path)
    }

    func testTheLoopbackOpensOnAnAliasForTheComputersOwnLoopback() throws {
        let link = try XCTUnwrap(URL(string: "http://localhost:5173/app?x=1"))
        let alias = try XCTUnwrap(BrowserPolicy.Loopback.alias(link))
        XCTAssertEqual(alias.absoluteString, "http://name.happy-loopback.invalid:5173/app?x=1")
        XCTAssertEqual(BrowserPolicy.Loopback.shown(alias), link)
        for (url, target) in [("http://127.0.0.1:4191/", "127.0.0.1:4191"), ("http://127.1:4191/", "127.0.0.1:4191"), ("ws://[::1]:24678/", "[::1]:24678"), ("https://LOCALHOST.:8443/", "localhost:8443")] {
            let alias = try XCTUnwrap(BrowserPolicy.Loopback.alias(XCTUnwrap(URL(string: url))), url)
            XCTAssertTrue(alias.host?.hasSuffix(".happy-loopback.invalid") == true, url)
            XCTAssertEqual(BrowserPolicy.Loopback.target(try XCTUnwrap(BrowserPolicy.Authority(url: alias)))?.text, target, url)
        }
        XCTAssertEqual(BrowserPolicy.Loopback.shown(try XCTUnwrap(URL(string: "http://ipv6.happy-loopback.invalid:4191/"))).absoluteString, "http://[::1]:4191/")
        for url in ["http://127.0.0.2/", "http://example.com/", "http://a.localhost/", "http://name.happy-loopback.invalid/", "mailto:a@b.c"] {
            XCTAssertNil(BrowserPolicy.Loopback.alias(try XCTUnwrap(URL(string: url))), url)
        }
        XCTAssertNil(BrowserPolicy.Loopback.target(try XCTUnwrap(BrowserPolicy.Authority(url: XCTUnwrap(URL(string: "http://localhost:80"))))))
    }

    func testALoopbackAliasNamesTheLoopbackInEachRequestAndPassesTheRest() async throws {
        let alias = "name.happy-loopback.invalid"
        let local = Bytes([
            Data("POST /api HTTP/1.1\r\nHost: \(alias):5173\r\nOrigin: http://\(alias):5173\r\nContent-Length: 5\r\n\r\nhel".utf8),
            Data("loGET /next HTTP/1.1\r\nHost: \(alias):5173\r\nReferer: http://\(alias):5173/app\r\n\r\n".utf8),
            Data("GET /hmr HTTP/1.1\r\nHost: \(alias):5173\r\nOrigin: http://\(alias).example.com\r\nUpgrade: websocket\r\n\r\nframe ".utf8),
            Data("Host: \(alias):5173".utf8),
        ])
        let remote = Bytes([], holds: true)
        try await BrowserRelay.loopback(local, remote, initial: Data(), alias: alias, host: "localhost")
        let sent = String(decoding: await remote.writes.reduce(Data(), +), as: UTF8.self)
        XCTAssertEqual(sent, "POST /api HTTP/1.1\r\nHost: localhost:5173\r\nOrigin: http://localhost:5173\r\nContent-Length: 5\r\n\r\nhello"
            + "GET /next HTTP/1.1\r\nHost: localhost:5173\r\nReferer: http://localhost:5173/app\r\n\r\n"
            // Another site's Origin stays; after the upgrade nothing is read as HTTP.
            + "GET /hmr HTTP/1.1\r\nHost: localhost:5173\r\nOrigin: http://\(alias).example.com\r\nUpgrade: websocket\r\n\r\nframe Host: \(alias):5173")

        // TLS carries its own name: its bytes pass as they are.
        let hello = Data([0x16, 0x03, 0x01]) + Data(alias.utf8)
        let secure = Bytes([], holds: true)
        try await BrowserRelay.loopback(Bytes([]), secure, initial: hello, alias: alias, host: "localhost")
        let passed = await secure.writes.reduce(Data(), +)
        XCTAssertEqual(passed, hello)
    }

    func testLiveArtifactProxyRefusalsMeanItsComputerIsUnavailable() async throws {
        let target = try XCTUnwrap(BrowserPolicy.Authority(url: XCTUnwrap(URL(string: "http://localhost:4191"))))
        for status in [404, 501, 503] {
            let client = AgentClient(transport: Transport(Bytes([Data("HTTP/1.1 \(status) Refused\r\n\r\n".utf8)])), token: "token")
            do { _ = try await client.browserTunnel(.artifact("gone1"), target: target); XCTFail() }
            catch { XCTAssertEqual(error as? BrowserError, .liveUnavailable, "\(status)") }
        }
        // The same refusal from a workspace's proxy says only its status.
        let workspace = AgentClient(transport: Transport(Bytes([Data("HTTP/1.1 404 Not Found\r\n\r\n".utf8)])), token: "token")
        do { _ = try await workspace.browserTunnel(.workspace("work1"), target: target); XCTFail() }
        catch { XCTAssertEqual(error as? BrowserError, .upstream(404)) }
        // A destination the daemon's policy refuses, or a dev server that isn't
        // running, is answered inside the open tunnel: not the computer's absence.
        let inner = AgentClient(transport: Transport(Bytes([Data("HTTP/1.1 200 OK\r\n\r\n".utf8), Data("HTTP/1.1 403 Forbidden\r\n\r\n".utf8)])), token: "token")
        do { _ = try await inner.browserTunnel(.artifact("art1"), target: target); XCTFail() }
        catch { XCTAssertEqual(error as? BrowserError, .upstream(403)) }
        let failure = BrowserFailure(BrowserError.liveUnavailable)
        XCTAssertEqual(failure.code, "browser_proxy_live_unavailable")
        XCTAssertEqual(BrowserProxyRefusal(status: failure.status, code: failure.code).problem, .liveUnavailable)
    }

    func testANetworkThatCarriesOnlyItsLoopbackLeavesTheRestToThePhone() async throws {
        func authority(_ url: String) -> BrowserPolicy.Authority { BrowserPolicy.Authority(url: URL(string: url)!)! }
        let loopback = ["http://localhost:5173", "http://app.localhost:3000", "http://127.0.0.1:5173", "http://127.8.9.10", "http://[::1]:5173",
                        "http://ipv4.happy-loopback.invalid:5173", "http://name.happy-loopback.invalid:3000"]
        let outside = ["https://fonts.googleapis.com", "http://192.168.1.10:5173", "http://10.0.0.1", "http://localhost.example.com",
                       "http://128.0.0.1", "http://[::2]", "https://example.com:8443"]
        for url in loopback {
            XCTAssertTrue(BrowserDestinations.loopback.tunnels(authority(url)), url)
            XCTAssertTrue(BrowserDestinations.all.tunnels(authority(url)), url)
        }
        for url in outside {
            XCTAssertFalse(BrowserDestinations.loopback.tunnels(authority(url)), url)
            // Absent, as on a computer: the computer reaches everything.
            XCTAssertTrue(BrowserDestinations.all.tunnels(authority(url)), url)
        }
        XCTAssertEqual(BrowserDestinations("loopback"), .loopback)
        XCTAssertEqual(BrowserDestinations(nil), .all)
        XCTAssertEqual(BrowserDestinations("anything"), .all)

        // The lookup's marker reaches the page's network.
        let cloud = AgentClient(transport: RoutingTransport(responses: [
            "/v0/agents/chat1": #"{"agent":{"id":"chat1","workspaceId":"w1","status":"idle"}}"#,
            "/v0/workspaces/w1/agents/chat1/proxy": #"{"networkId":"c-chat1","kind":"runner","destinations":"loopback"}"#,
        ]), token: "test")
        let route = try await cloud.agentRoute("chat1")
        XCTAssertEqual(route.network, .network("c-chat1"))
        XCTAssertEqual(route.destinations, .loopback)
        let network = BrowserAgentNetwork(client: cloud, agentID: "chat1")
        let cdn = authority("https://cdn.example.com")
        let tunnelsCDN = try await network.tunnels(cdn)
        XCTAssertFalse(tunnelsCDN)
        let tunnelsDev = try await network.tunnels(authority("http://localhost:5173"))
        XCTAssertTrue(tunnelsDev)

        // Without the marker, a refusal of the destination teaches it, and only past the loopback.
        let plain = AgentClient(transport: RoutingTransport(responses: [
            "/v0/agents/chat1": #"{"agent":{"id":"chat1","workspaceId":"w1","status":"idle"}}"#,
            "/v0/workspaces/w1/agents/chat1/proxy": #"{"networkId":"c-chat1"}"#,
        ]), token: "test")
        let learning = BrowserAgentNetwork(client: plain, agentID: "chat1")
        let before = try await learning.tunnels(cdn)
        XCTAssertTrue(before)
        let reservedPort = await learning.refused(authority("http://localhost:3128"))
        XCTAssertFalse(reservedPort, "a refused loopback port is never dialed from the phone")
        let learned = await learning.refused(cdn)
        XCTAssertTrue(learned)
        let after = try await learning.tunnels(cdn)
        XCTAssertFalse(after)

        // The nested CONNECT's refusal says which it is.
        let body = Data(#"{"error":"Destination not allowed","code":"destination_not_allowed"}"#.utf8)
        let refusing = AgentClient(transport: Transport(Bytes([Data("HTTP/1.1 200 OK\r\n\r\n".utf8), Data("HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\n\r\n".utf8), body])), token: "token")
        do { _ = try await refusing.browserTunnel(.network("c-chat1"), target: cdn); XCTFail() }
        catch { XCTAssertEqual(error as? BrowserError, .outsideNetwork) }
        XCTAssertEqual(BrowserFailure(BrowserError.outsideNetwork).status, 403)
    }

    func testAStoppedComputesRefusalIsTheComputeGoneNotTheServer() async throws {
        let target = try XCTUnwrap(BrowserPolicy.Authority(url: XCTUnwrap(URL(string: "http://localhost:5173"))))
        func refusal(_ status: Int, _ code: String) -> [Data] {
            let body = Data(#"{"error":"x","code":"\#(code)"}"#.utf8)
            return [Data("HTTP/1.1 \(status) Refused\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\n\r\n".utf8), body]
        }
        // Happy Cloud answers the page's own CONNECT once the compute stopped,
        let nested = AgentClient(transport: Transport(Bytes([Data("HTTP/1.1 200 OK\r\n\r\n".utf8)] + refusal(503, "compute_offline"))), token: "token")
        do { _ = try await nested.browserTunnel(.network("c-chat1"), target: target); XCTFail() }
        catch { XCTAssertEqual(error as? BrowserError, .computeGone) }
        // and the network's own after its grace, or with no compute at all.
        for (status, code) in [(503, "draining"), (409, "no_compute")] {
            let outer = AgentClient(transport: Transport(Bytes(refusal(status, code))), token: "token")
            do { _ = try await outer.browserTunnel(.network("c-chat1"), target: target); XCTFail() }
            catch { XCTAssertEqual(error as? BrowserError, .computeGone, code) }
        }
        // A dev server that isn't running is still the server's answer.
        let dead = AgentClient(transport: Transport(Bytes([Data("HTTP/1.1 200 OK\r\n\r\n".utf8)] + refusal(502, "proxy_target_unavailable"))), token: "token")
        do { _ = try await dead.browserTunnel(.network("c-chat1"), target: target); XCTFail() }
        catch { XCTAssertEqual(error as? BrowserError, .upstream(502)) }
        // An agent with no compute names no network.
        let detached = AgentClient(transport: RoutingTransport(responses: [
            "/v0/agents/chat1": #"{"agent":{"id":"chat1","workspaceId":"botworkspace","status":"idle"}}"#,
            "/v0/workspaces/botworkspace/agents/chat1/proxy": #"{"error":"No compute","code":"no_compute"}"#,
        ], statuses: ["/v0/workspaces/botworkspace/agents/chat1/proxy": 409]), token: "test")
        do { _ = try await detached.agentNetwork("chat1"); XCTFail() }
        catch { XCTAssertEqual(error as? BrowserError, .computeGone) }
        let failure = BrowserFailure(BrowserError.computeGone)
        XCTAssertEqual(failure.code, BrowserProxyRefusal.computeGone)
        XCTAssertEqual(BrowserProxyRefusal(status: failure.status, code: failure.code).problem, .computeDisconnected)
        XCTAssertEqual(BrowserProblem.opening(BrowserError.computeGone, link: nil), .computeDisconnected)
    }

    func testPublicAuthoritySurvivesMeteringForConnectAndArtifactUpgrade() async throws {
        let bytes = Bytes([Data("HTTP/1.1 200 OK\r\n\r\n".utf8), Data("HTTP/1.1 200 OK\r\n\r\n".utf8)], authority: "agent.example.com:8443")
        let metered = MeteredStream(bytes, metrics: ConnectionMetrics(), channel: .browser)
        XCTAssertEqual(metered.authority, "agent.example.com:8443")
        let client = AgentClient(transport: Transport(bytes), token: "native-token")
        let stream = try await client.browserTunnel(workspaceID: "workspace", target: BrowserPolicy.Authority(url: URL(string: "https://example.com")!)!)
        await stream.close()
        let written = await bytes.writes.map { String(decoding: $0, as: UTF8.self) }
        XCTAssertTrue(written[0].contains("Host: agent.example.com:8443\r\n"))
        XCTAssertFalse(written[1].contains("native-token"))
        let (head, _) = try XCTUnwrap(BrowserHTTPHead.parse(Data("GET /api/v1/events HTTP/1.1\r\nHost: artifact.invalid\r\nAuthorization: attacker\r\nUpgrade: websocket\r\n\r\n".utf8)))
        let request = try head.artifactRequest(artifactID: "art1", version: 1, credential: "native-token", authority: bytes.authority)
        XCTAssertEqual(request.value("Host"), "agent.example.com:8443")
        XCTAssertEqual(request.value("Authorization"), "Bearer native-token")
        XCTAssertEqual(request.value("Connection"), "Upgrade")
    }

    func testChunkedRequestIsBoundedAndCannotSmuggleAnotherRequest() async throws {
        let (head, _) = try XCTUnwrap(BrowserHTTPHead.parse(Data("PUT /api/v1/kv/entry HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n".utf8)))
        let stream = Bytes([Data("2\r\n{}\r\n0\r\n\r\nGET /v0/config HTTP/1.1\r\n\r\n".utf8)])
        let (request, body) = try await BrowserRelay.requestBody(head, initial: Data(), stream: stream)
        XCTAssertEqual(body, Data("{}".utf8))
        XCTAssertEqual(request.value("Content-Length"), "2")
        XCTAssertNil(request.value("Transfer-Encoding"))
        let (bad, _) = try XCTUnwrap(BrowserHTTPHead.parse(Data("PUT /api/v1/kv/entry HTTP/1.1\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n".utf8)))
        do { _ = try await BrowserRelay.requestBody(bad, initial: Data(), stream: stream); XCTFail() }
        catch { XCTAssertEqual(error as? BrowserError, .malformed) }
    }

    func testThirdPartyFramesCannotBorrowArtifactAPI() throws {
        let authority = try XCTUnwrap(BrowserPolicy.Authority(url: URL(string: "http://artifact.invalid")!))
        for origin in ["https://attacker.example", "null", "http://artifact.invalid:1234"] {
            let (head, _) = try XCTUnwrap(BrowserHTTPHead.parse(Data("POST /api/v1/debug/log HTTP/1.1\r\nOrigin: \(origin)\r\n\r\n".utf8)))
            XCTAssertThrowsError(try BrowserPolicy.checkArtifactOrigin(head, authority: authority))
        }
        let (head, _) = try XCTUnwrap(BrowserHTTPHead.parse(Data("POST /api/v1/debug/log HTTP/1.1\r\nOrigin: http://artifact.invalid\r\nSec-Fetch-Site: same-origin\r\n\r\n".utf8)))
        XCTAssertNoThrow(try BrowserPolicy.checkArtifactOrigin(head, authority: authority))
    }

    func testArtifactSandboxAdjustmentPreservesOtherServerPolicies() throws {
        let (head, _) = try XCTUnwrap(BrowserHTTPHead.parse(Data("HTTP/1.1 200 OK\r\nContent-Security-Policy: sandbox allow-scripts; default-src 'self'\r\n\r\n".utf8)))
        XCTAssertEqual(head.artifactResponse().value("Content-Security-Policy"), "sandbox allow-scripts allow-same-origin; default-src 'self'")
    }

    private actor Bytes: BrowserStream {
        nonisolated let authority: String
        var pending: [Data]
        var writes: [Data] = []
        var closed = false
        /// Once its bytes are read, waits like a server with nothing to say.
        let holds: Bool
        init(_ pending: [Data], authority: String = "server.tailcat", holds: Bool = false) { self.pending = pending; self.authority = authority; self.holds = holds }
        func read(maximumBytes: Int) async throws -> Data {
            if pending.isEmpty, holds { try await Task.sleep(for: .seconds(60)) }
            return pending.isEmpty ? Data() : pending.removeFirst()
        }
        func write(_ data: Data) async throws { writes.append(data) }
        func close() async { closed = true }
    }
    private struct Transport: AgentTransport {
        let bytes: Bytes
        init(_ bytes: Bytes) { self.bytes = bytes }
        func browserConnection() async throws -> any BrowserStream { bytes }
        func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response { throw BrowserError.unavailable }
        func close() async {}
    }
    private struct RoutingTransport: AgentTransport {
        let responses: [String: String]
        var statuses: [String: Int] = [:]
        func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
            HTTP1Response(status: statuses[path] ?? (responses[path] == nil ? 404 : 200), body: Data((responses[path] ?? "{}").utf8))
        }
        func close() async {}
    }
}