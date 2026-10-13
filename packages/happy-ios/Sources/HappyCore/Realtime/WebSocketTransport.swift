import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// One open WebSocket carrying text frames.
public protocol WebSocketConnection: Sendable {
    func send(_ text: String) async throws
    /// The next text frame. Throws when the socket closes.
    func receive() async throws -> String
    func close() async
}

public protocol WebSocketConnector: Sendable {
    func connect(to url: URL) async throws -> WebSocketConnection
}

public enum WebSocketError: Error, Equatable, Sendable {
    case binaryFrameUnsupported
    case closed
}

public struct URLSessionWebSocketConnector: WebSocketConnector {
    let session: URLSession

    public init() {
        session = NetworkSession.make()
    }

    public init(session: URLSession) {
        self.session = session
    }

    public func connect(to url: URL) async throws -> WebSocketConnection {
        let task = session.webSocketTask(with: url)
        // Session metadata can be large (see the server's maxHttpBufferSize).
        task.maximumMessageSize = 8 * 1024 * 1024
        task.resume()
        return URLSessionWebSocketConnection(task: task)
    }
}

final class URLSessionWebSocketConnection: WebSocketConnection, @unchecked Sendable {
    // URLSessionWebSocketTask is safe to use from any thread.
    private let task: URLSessionWebSocketTask

    init(task: URLSessionWebSocketTask) {
        self.task = task
    }

    func send(_ text: String) async throws {
        try await task.send(.string(text))
    }

    func receive() async throws -> String {
        switch try await task.receive() {
        case .string(let text):
            return text
        case .data:
            throw WebSocketError.binaryFrameUnsupported
        @unknown default:
            throw WebSocketError.binaryFrameUnsupported
        }
    }

    func close() async {
        task.cancel(with: .normalClosure, reason: nil)
    }
}
