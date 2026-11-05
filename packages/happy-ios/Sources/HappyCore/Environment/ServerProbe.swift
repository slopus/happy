import Foundation

public enum ServerCheckResult: Equatable, Sendable {
    case ok
    /// It answered, but not with 2xx.
    case serverError
    /// It answered without the Happy Server greeting.
    case notHappyServer
    case unreachable
}

/// Checks that a URL is a Happy Server before the app switches to it. Same
/// test as sources/sync/serverProbe.ts: a GET whose text includes the
/// greeting, or else a /health that names happy-server.
public struct ServerProbe: Sendable {
    public static let greeting = "Welcome to Happy Server!"
    public static let healthService = "happy-server"

    private let transport: HTTPTransport

    public init(transport: HTTPTransport) {
        self.transport = transport
    }

    public func check(_ url: URL) async -> ServerCheckResult {
        let request = HTTPRequest(method: "GET", url: url, headers: ["Accept": "text/plain"])
        guard let response = try? await transport.send(request) else { return .unreachable }
        guard (200..<300).contains(response.status) else { return .serverError }
        if String(decoding: response.body, as: UTF8.self).contains(Self.greeting) { return .ok }
        // happy-server-self-host serves the web app, so its / answers with the
        // app's HTML instead of the greeting. Its /health still names the server.
        return await reportsHappyServerHealth(url) ? .ok : .notHappyServer
    }

    private struct Health: Decodable {
        let service: String?
    }

    private func reportsHappyServerHealth(_ url: URL) async -> Bool {
        let request = HTTPRequest(method: "GET", url: url.appendingPathComponent("health"), headers: ["Accept": "application/json"])
        guard let response = try? await transport.send(request),
              (200..<300).contains(response.status),
              let health = try? JSONDecoder().decode(Health.self, from: response.body) else { return false }
        return health.service == Self.healthService
    }
}
