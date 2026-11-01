import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct HTTPRequest: Sendable, Equatable {
    public var method: String
    public var url: URL
    public var headers: [String: String]
    public var body: Data?

    public init(method: String, url: URL, headers: [String: String] = [:], body: Data? = nil) {
        self.method = method
        self.url = url
        self.headers = headers
        self.body = body
    }
}

public struct HTTPResponse: Sendable {
    public var status: Int
    public var body: Data
    /// As the server sent them; read case-insensitively.
    public var headers: [String: String]

    public init(status: Int, body: Data, headers: [String: String] = [:]) {
        self.status = status
        self.body = body
        self.headers = headers
    }
}

/// The only thing that touches the network for HTTP. Tests replace it.
public protocol HTTPTransport: Sendable {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse
    func sendImage(_ request: HTTPRequest, limit: Int) async throws -> HTTPResponse
    /// `send`, telling `progress` how many of the body's bytes have been
    /// written so far, and out of how many, as they go.
    func send(_ request: HTTPRequest, progress: @escaping HTTPUploadProgress) async throws -> HTTPResponse
}

/// Bytes of a request body written so far, and its whole length.
public typealias HTTPUploadProgress = @Sendable (_ sent: Int64, _ total: Int64) -> Void

extension HTTPTransport {
    public func sendImage(_ request: HTTPRequest, limit: Int) async throws -> HTTPResponse {
        let response = try await send(request)
        guard response.body.count <= limit else { throw URLError(.dataLengthExceedsMaximum) }
        return response
    }

    /// A transport that can't see its bytes go says all of them went once
    /// it is answered.
    public func send(_ request: HTTPRequest, progress: @escaping HTTPUploadProgress) async throws -> HTTPResponse {
        let response = try await send(request)
        let total = Int64(request.body?.count ?? 0)
        progress(total, total)
        return response
    }
}

public final class URLSessionTransport: HTTPTransport, @unchecked Sendable {
    // URLSession is thread-safe.
    let session: URLSession
    private let imageDownloader = PictureDownloader()

    public convenience init() {
        self.init(session: NetworkSession.make())
    }

    /// Explicit sessions remain available to injected transports and tests.
    public init(session: URLSession) {
        self.session = session
    }

    public func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        var urlRequest = Self.urlRequest(request)
        urlRequest.httpBody = request.body
        #if canImport(FoundationNetworking)
        let (data, response) = try await session.data(for: urlRequest)
        #else
        let (data, response) = try await session.data(for: urlRequest, delegate: ConnectionsDelegate.current())
        #endif
        return try Self.response(data, response)
    }

    /// An upload task, whose delegate hears each write of the body to the
    /// socket (`didSendBodyData`), so the share reported is bytes sent.
    public func send(_ request: HTTPRequest, progress: @escaping HTTPUploadProgress) async throws -> HTTPResponse {
        #if canImport(FoundationNetworking)
        let response = try await send(request)
        let total = Int64(request.body?.count ?? 0)
        progress(total, total)
        return response
        #else
        guard let body = request.body, !body.isEmpty else {
            let response = try await send(request)
            progress(0, 0)
            return response
        }
        let delegate = UploadProgressDelegate(total: Int64(body.count), report: progress, connections: ConnectionsDelegate.current())
        let (data, response) = try await session.upload(for: Self.urlRequest(request), from: body, delegate: delegate)
        return try Self.response(data, response)
        #endif
    }

    private static func urlRequest(_ request: HTTPRequest) -> URLRequest {
        var urlRequest = URLRequest(url: request.url)
        urlRequest.httpMethod = request.method
        for (name, value) in request.headers {
            urlRequest.setValue(value, forHTTPHeaderField: name)
        }
        return urlRequest
    }

    private static func response(_ data: Data, _ response: URLResponse) throws -> HTTPResponse {
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        var headers: [String: String] = [:]
        for (name, value) in http.allHeaderFields {
            if let name = name as? String, let value = value as? String { headers[name] = value }
        }
        return HTTPResponse(status: http.statusCode, body: data, headers: headers)
    }

    public func sendImage(_ request: HTTPRequest, limit: Int) async throws -> HTTPResponse {
        guard let response = await imageDownloader.response(request, limit: limit) else { throw URLError(.badServerResponse) }
        return response
    }
}

/// One upload task's delegate: each write of its body, as URLSession
/// reports it, out of the body's length when the task doesn't know it.
final class UploadProgressDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    let total: Int64
    let report: HTTPUploadProgress
    let connections: ConnectionsDelegate?

    init(total: Int64, report: @escaping HTTPUploadProgress, connections: ConnectionsDelegate? = nil) {
        self.total = total
        self.report = report
        self.connections = connections
    }

    #if !canImport(FoundationNetworking)
    func urlSession(_ session: URLSession, task: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics) {
        connections?.urlSession(session, task: task, didFinishCollecting: metrics)
    }
    #endif

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        let expected = totalBytesExpectedToSend > 0 ? totalBytesExpectedToSend : total
        report(min(totalBytesSent, expected), expected)
    }
}


/// Tells the account that asked (`MetricsScope`) each connection URLSession
/// opened for its request, rather than reused from its pool. URLSession
/// closes pooled connections on its own and never says, so only opens are
/// counted on this path.
final class ConnectionsDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    let metrics: ConnectionMetrics
    let channel: ConnectionChannel

    init(metrics: ConnectionMetrics, channel: ConnectionChannel) {
        self.metrics = metrics
        self.channel = channel
    }

    /// One for the request running now, if a metered transport is over it.
    static func current() -> ConnectionsDelegate? {
        guard let metrics = MetricsScope.metrics else { return nil }
        return ConnectionsDelegate(metrics: metrics, channel: MetricsScope.channel ?? .http)
    }

    #if !canImport(FoundationNetworking)
    func urlSession(_ session: URLSession, task: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics) {
        let opened = metrics.transactionMetrics.filter { $0.resourceFetchType == .networkLoad && !$0.isReusedConnection }.count
        for _ in 0..<opened { self.metrics.connectionOpened(channel) }
    }
    #endif
}
