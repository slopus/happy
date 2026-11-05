import Foundation
import HappyCore

/// An HTTP server in a dictionary: routes are "METHOD /path" and answer
/// with a closure, so a test can inspect what was sent and vary the reply.
final class FakeHTTP: HTTPTransport, @unchecked Sendable {
    typealias Handler = @Sendable (HTTPRequest) throws -> (Int, Data)

    private let lock = NSLock()
    private var routes: [String: Handler] = [:]
    private var _requests: [HTTPRequest] = []

    var requests: [HTTPRequest] { lock.withLock { _requests } }

    func requests(_ route: String) -> [HTTPRequest] {
        requests.filter { "\($0.method) \($0.url.path)" == route }
    }

    func on(_ route: String, _ handler: @escaping Handler) {
        lock.withLock { routes[route] = handler }
    }

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        let handler = lock.withLock {
            _requests.append(request)
            return routes["\(request.method) \(request.url.path)"]
        }
        guard let handler else { return HTTPResponse(status: 404, body: Data()) }
        let (status, body) = try handler(request)
        return HTTPResponse(status: status, body: body)
    }
}
