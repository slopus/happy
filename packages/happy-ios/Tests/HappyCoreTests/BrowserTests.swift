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
        var pending: [Data]
        var writes: [Data] = []
        var closed = false
        init(_ pending: [Data]) { self.pending = pending }
        func read(maximumBytes: Int) async throws -> Data { pending.isEmpty ? Data() : pending.removeFirst() }
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
        func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
            HTTP1Response(status: responses[path] == nil ? 404 : 200, body: Data((responses[path] ?? "{}").utf8))
        }
        func close() async {}
    }
}