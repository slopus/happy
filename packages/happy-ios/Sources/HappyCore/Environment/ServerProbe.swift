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
/// test as app/(app)/server.tsx: a GET whose text includes the greeting.
public struct ServerProbe: Sendable {
    public static let greeting = "Welcome to Happy Server!"

    private let transport: HTTPTransport

    public init(transport: HTTPTransport) {
        self.transport = transport
    }

    public func check(_ url: URL) async -> ServerCheckResult {
        let request = HTTPRequest(method: "GET", url: url, headers: ["Accept": "text/plain"])
        guard let response = try? await transport.send(request) else { return .unreachable }
        guard (200..<300).contains(response.status) else { return .serverError }
        guard String(decoding: response.body, as: UTF8.self).contains(Self.greeting) else { return .notHappyServer }
        return .ok
    }
}
