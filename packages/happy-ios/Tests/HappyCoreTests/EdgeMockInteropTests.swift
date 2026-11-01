#if canImport(Network)
import Foundation
import Network
import XCTest
@testable import HappyCore

/// Against the edge SSO mock server (`scripts/edge-sso-mock/server.mjs`,
/// a real HTTP server in another process), when `HAPPY_EDGE_MOCK_PORT` names its plain-HTTP port: the
/// code flow with PKCE and `resource`, refresh rotation, and a WebSocket
/// tunnel carrying a forward-proxy request. Skipped otherwise.
final class EdgeMockInteropTests: XCTestCase {
    private var port: Int? { ProcessInfo.processInfo.environment["HAPPY_EDGE_MOCK_PORT"].flatMap(Int.init) }

    private func method(_ port: Int) -> OAuthMethod {
        OAuthMethod(id: "jwt", name: "Acme SSO", authorizationUrl: "http://127.0.0.1:\(port)/oauth/authorize", tokenUrl: "http://127.0.0.1:\(port)/oauth/token",
                    refreshUrl: "http://127.0.0.1:\(port)/oauth/token", clientId: "happy", scope: "happy offline_access", resource: "https://happy.acme.example")
    }

    /// Signs in as the app does, the mock's consent page standing in for the browser.
    private func signIn(_ port: Int) async throws -> (OAuthAccess, OAuthGrant) {
        let request = try OAuthSignInRequest(method: method(port), redirectUri: "happy://oauth/callback")
        let (page, _) = try await URLSession.shared.data(from: request.url)
        let html = String(decoding: page, as: UTF8.self)
        let link = try XCTUnwrap(html.range(of: #"href="([^"]+)""#, options: .regularExpression).map { String(html[$0].dropFirst(6).dropLast()) })
        let callback = try XCTUnwrap(URL(string: link.replacingOccurrences(of: "&amp;", with: "&")))
        return try await OAuthTokenClient().complete(request, callback: callback)
    }

    func testCodeFlowRefreshAndAWebSocketTunnel() async throws {
        guard let port else { throw XCTSkip("HAPPY_EDGE_MOCK_PORT not set") }
        let (access, grant) = try await signIn(port)
        XCTAssertNotNil(grant.refreshToken)
        XCTAssertEqual(grant.resource, "https://happy.acme.example")

        // Rotation: a new refresh token replaces the old, which the mock
        // then refuses.
        let (renewed, rotated) = try await OAuthTokenClient().refresh(grant)
        XCTAssertNotEqual(renewed.token, access.token)
        XCTAssertNotEqual(rotated.refreshToken, grant.refreshToken)
        await XCTAssertThrowsAsync(try await OAuthTokenClient().refresh(grant)) {
            XCTAssertEqual($0 as? OAuthError, .server(code: "invalid_grant", description: "The session ended."))
        }

        // No bearer: the "load balancer" redirects, and that needs signing in.
        let refused = try PlainStream(port: UInt16(port))
        await XCTAssertThrowsAsync(try await WebSocketTunnel.open(refused, path: "/v0/workspaces/w1/proxy/websocket", credential: "expired", keepalive: false)) {
            XCTAssertEqual(($0 as? TunnelRefusal)?.requiresSignIn, true)
        }

        let stream = try PlainStream(port: UInt16(port))
        let tunnel = try await WebSocketTunnel.open(stream, path: "/v0/workspaces/w1/proxy/websocket", credential: renewed.token)
        try await tunnel.write(Data("GET http://localhost:3000/ HTTP/1.1\r\nHost: localhost:3000\r\n\r\n".utf8))
        var answer = Data()
        while true {
            let bytes = try await tunnel.read(maximumBytes: 65536)
            if bytes.isEmpty { break }
            answer.append(bytes)
        }
        let text = String(decoding: answer, as: UTF8.self)
        XCTAssertTrue(text.hasPrefix("HTTP/1.1 200 OK\r\n"), text)
        XCTAssertTrue(text.contains("GET http://localhost:3000/ HTTP/1.1"))
        await tunnel.close()
    }
}

/// Plain TCP to the mock on this machine.
private final class PlainStream: BrowserStream, @unchecked Sendable {
    let authority: String
    private let connection: NWConnection

    init(port: UInt16) throws {
        authority = "127.0.0.1:\(port)"
        connection = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
        connection.start(queue: DispatchQueue(label: "edge-mock"))
    }

    func read(maximumBytes: Int) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            connection.receive(minimumIncompleteLength: 1, maximumLength: maximumBytes) { data, _, complete, error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: data ?? Data()) }
                _ = complete
            }
        }
    }

    func write(_ data: Data) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            connection.send(content: data, completion: .contentProcessed { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            })
        }
    }

    func close() async { connection.cancel() }
}
#endif
