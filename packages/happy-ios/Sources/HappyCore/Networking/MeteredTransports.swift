import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Bytes counted where only the request and the answer are seen, as
/// HTTP/1.1 would frame them: the request line, the headers and the body.
/// TLS and TCP are not in it, and a body counts as it was decoded.
enum HTTPFraming {
    static func head(method: String, target: String, headers: [String: String]) -> Int {
        // "GET /path HTTP/1.1\r\n", "Name: value\r\n" each, "\r\n".
        method.utf8.count + target.utf8.count + 12 + headers.reduce(0) { $0 + $1.key.utf8.count + $1.value.utf8.count + 4 } + 2
    }

    static func responseHead(status: Int, headers: [String: String]) -> Int {
        // "HTTP/1.1 200 \r\n" with no reason, the headers, "\r\n".
        15 + headers.reduce(0) { $0 + $1.key.utf8.count + $1.value.utf8.count + 4 } + 2
    }

    static func target(_ url: URL) -> String {
        let path = url.path.isEmpty ? "/" : url.path
        return url.query.map { "\(path)?\($0)" } ?? path
    }
}

/// An account's HTTP, counted: requests to its own server on `http`,
/// everything else (presigned storage, pictures) on `media`.
public struct MeteredHTTPTransport: HTTPTransport {
    public let base: HTTPTransport
    public let metrics: ConnectionMetrics
    let serverHost: String?

    public init(base: HTTPTransport, metrics: ConnectionMetrics, serverURL: URL) {
        self.base = base
        self.metrics = metrics
        serverHost = serverURL.host?.lowercased()
    }

    func channel(_ request: HTTPRequest) -> ConnectionChannel {
        request.url.host?.lowercased() == serverHost ? .http : .media
    }

    private func metered(_ request: HTTPRequest, _ send: () async throws -> HTTPResponse) async throws -> HTTPResponse {
        let channel = channel(request)
        let start = ConnectionMetrics.uptime()
        metrics.sent(HTTPFraming.head(method: request.method, target: HTTPFraming.target(request.url), headers: request.headers) + (request.body?.count ?? 0), on: channel)
        do {
            let response = try await MetricsScope.$metrics.withValue(metrics) {
                try await MetricsScope.$channel.withValue(channel) { try await send() }
            }
            metrics.received(HTTPFraming.responseHead(status: response.status, headers: response.headers) + response.body.count, on: channel)
            metrics.request(channel, status: response.status, duration: ConnectionMetrics.uptime() - start)
            return response
        } catch {
            if !(error is CancellationError) {
                metrics.request(channel, status: nil, duration: ConnectionMetrics.uptime() - start)
                metrics.failed("\(channel.name): \(MeteredError.describe(error))")
            }
            throw error
        }
    }

    public func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        try await metered(request) { try await base.send(request) }
    }

    public func sendImage(_ request: HTTPRequest, limit: Int) async throws -> HTTPResponse {
        try await metered(request) { try await base.sendImage(request, limit: limit) }
    }

    public func send(_ request: HTTPRequest, progress: @escaping HTTPUploadProgress) async throws -> HTTPResponse {
        try await metered(request) { try await base.send(request, progress: progress) }
    }
}

/// A WebSocket counted on `channel`: each one opened and closed (a closed
/// socket's receive throwing counts as its close), its text frames' bytes,
/// and a later one opened as a reconnect.
public struct MeteredWebSocketConnector: WebSocketConnector {
    public let base: WebSocketConnector
    public let metrics: ConnectionMetrics
    let channel: ConnectionChannel

    public init(base: WebSocketConnector, metrics: ConnectionMetrics, channel: ConnectionChannel = .socket) {
        self.base = base
        self.metrics = metrics
        self.channel = channel
    }

    public func connect(to url: URL) async throws -> WebSocketConnection {
        do {
            let connection = try await base.connect(to: url)
            return MeteredWebSocketConnection(base: connection, metrics: metrics, channel: channel)
        } catch {
            metrics.failed("\(channel.name): \(MeteredError.describe(error))")
            throw error
        }
    }
}

final class MeteredWebSocketConnection: WebSocketConnection, @unchecked Sendable {
    private let base: WebSocketConnection
    private let metrics: ConnectionMetrics
    private let channel: ConnectionChannel
    private let lock = NSLock()
    private var closed = false

    init(base: WebSocketConnection, metrics: ConnectionMetrics, channel: ConnectionChannel) {
        self.base = base
        self.metrics = metrics
        self.channel = channel
        metrics.connectionOpened(channel)
        metrics.streamOpened(channel)
    }

    deinit { markClosed() }

    private func markClosed() {
        lock.lock()
        let first = !closed
        closed = true
        lock.unlock()
        guard first else { return }
        metrics.connectionClosed(channel)
        metrics.streamClosed(channel)
    }

    func send(_ text: String) async throws {
        try await base.send(text)
        metrics.sent(text.utf8.count, on: channel)
    }

    func receive() async throws -> String {
        do {
            let text = try await base.receive()
            metrics.received(text.utf8.count, on: channel)
            return text
        } catch {
            markClosed()
            throw error
        }
    }

    func close() async {
        await base.close()
        markClosed()
    }
}

/// A byte stream counted as one TCP flow over the tunnel: opened when
/// made, closed once, every byte read and written.
public final class MeteredStream: BrowserStream, @unchecked Sendable {
    public var authority: String { base.authority }
    let base: any BrowserStream
    private let metrics: ConnectionMetrics
    private let channel: ConnectionChannel
    private let lock = NSLock()
    private var closed = false

    public init(_ base: any BrowserStream, metrics: ConnectionMetrics, channel: ConnectionChannel) {
        self.base = base
        self.metrics = metrics
        self.channel = channel
        metrics.connectionOpened(channel, flow: true)
    }

    deinit { markClosed() }

    private func markClosed() {
        lock.lock()
        let first = !closed
        closed = true
        lock.unlock()
        if first { metrics.connectionClosed(channel, flow: true) }
    }

    public func read(maximumBytes: Int) async throws -> Data {
        let data = try await base.read(maximumBytes: maximumBytes)
        metrics.received(data.count, on: channel)
        return data
    }

    public func write(_ data: Data) async throws {
        try await base.write(data)
        metrics.sent(data.count, on: channel)
    }

    public func close() async {
        await base.close()
        markClosed()
    }

    public func abort() async {
        await base.abort()
        markClosed()
    }
}

/// A transport that counts its own wire (flows, bytes, its tunnel) once
/// given a recorder; the metered transport over it then counts only
/// requests, so nothing is counted twice.
public protocol SelfMeteringTransport: AgentTransport {
    func attach(_ metrics: ConnectionMetrics)
}

/// A paired computer's transport, counted: every request's status and
/// time on `tailcat`, or `media` for `.file` requests, the media and file
/// routes and uploads; the event stream as a stream; browser streams as flows on
/// `browser`. Bytes come from the transport under it when it counts its
/// own (Tailcat does, at the flow), else from the bodies here.
public struct MeteredAgentTransport: AgentTransport {
    public let base: any AgentTransport
    public let metrics: ConnectionMetrics
    private let countsBytes: Bool

    public init(base: any AgentTransport, metrics: ConnectionMetrics) {
        self.base = base
        self.metrics = metrics
        if let metering = base as? any SelfMeteringTransport {
            metering.attach(metrics)
            countsBytes = false
        } else {
            countsBytes = true
        }
    }

    /// The media and file routes, whose bytes are media's.
    static func channel(path: String) -> ConnectionChannel {
        let route = path.split(separator: "?", maxSplits: 1).first ?? ""
        if route.contains("/tool-calls/") && route.contains("/media/") { return .media }
        if route.hasPrefix("/v0/artifacts/") && route.contains("/files/") { return .media }
        return .tailcat
    }

    private func metered(_ channel: ConnectionChannel, method: String, path: String, headers: [String: String], body: Data?, _ call: () async throws -> HTTP1Response) async throws -> HTTP1Response {
        let start = ConnectionMetrics.uptime()
        if countsBytes { metrics.sent(HTTPFraming.head(method: method, target: path, headers: headers) + (body?.count ?? 0), on: channel) }
        do {
            let response = try await MetricsScope.$channel.withValue(channel) { try await call() }
            if countsBytes { metrics.received(HTTPFraming.responseHead(status: response.status, headers: response.headers) + response.body.count, on: channel) }
            metrics.request(channel, status: response.status, duration: ConnectionMetrics.uptime() - start)
            return response
        } catch {
            if !(error is CancellationError) {
                metrics.request(channel, status: nil, duration: ConnectionMetrics.uptime() - start)
                metrics.failed("\(channel.name): \(MeteredError.describe(error))")
            }
            throw error
        }
    }

    /// A `.file` request's bytes are media's, whatever its route.
    static func channel(path: String, category: RequestCategory) -> ConnectionChannel {
        category == .file ? .media : channel(path: path)
    }

    public func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        try await metered(Self.channel(path: path), method: method, path: path, headers: headers, body: body) {
            try await base.request(method: method, path: path, credential: credential, body: body, headers: headers)
        }
    }

    public func request(method: String, path: String, credential: String, body: Data?, headers: [String: String], category: RequestCategory) async throws -> HTTP1Response {
        try await metered(Self.channel(path: path, category: category), method: method, path: path, headers: headers, body: body) {
            try await base.request(method: method, path: path, credential: credential, body: body, headers: headers, category: category)
        }
    }

    public func upload(path: String, credential: String, body: Data) async throws -> HTTP1Response {
        try await metered(.media, method: "PUT", path: path, headers: [:], body: body) {
            try await base.upload(path: path, credential: credential, body: body)
        }
    }

    public func send(method: String, path: String, credential: String, body: Data, upload: Bool, sent: @escaping @Sendable (Int) -> Void) async throws -> HTTP1Response {
        try await metered(upload ? .media : Self.channel(path: path), method: method, path: path, headers: [:], body: body) {
            try await base.send(method: method, path: path, credential: credential, body: body, upload: upload, sent: sent)
        }
    }

    public func send(method: String, path: String, credential: String, body: Data, category: RequestCategory, sent: @escaping @Sendable (Int) -> Void) async throws -> HTTP1Response {
        try await metered(Self.channel(path: path, category: category), method: method, path: path, headers: [:], body: body) {
            try await base.send(method: method, path: path, credential: credential, body: body, category: category, sent: sent)
        }
    }

    public func send(method: String, path: String, credential: String, body: Data, headers: [String: String], category: RequestCategory, sent: @escaping @Sendable (Int) -> Void) async throws -> HTTP1Response {
        try await metered(Self.channel(path: path, category: category), method: method, path: path, headers: headers, body: body) {
            try await base.send(method: method, path: path, credential: credential, body: body, headers: headers, category: category, sent: sent)
        }
    }

    /// The event stream: a request until its head, then a stream open
    /// until its body ends, however it ends.
    public func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        let start = ConnectionMetrics.uptime()
        let metrics = metrics
        if countsBytes { metrics.sent(HTTPFraming.head(method: "GET", target: path, headers: headers), on: .tailcat) }
        let response: HTTP1Stream
        do {
            response = try await MetricsScope.$channel.withValue(.tailcat) {
                try await base.stream(path: path, credential: credential, headers: headers)
            }
        } catch {
            if !(error is CancellationError) {
                metrics.request(.tailcat, status: nil, duration: ConnectionMetrics.uptime() - start)
                metrics.failed("Event stream: \(MeteredError.describe(error))")
            }
            throw error
        }
        metrics.request(.tailcat, status: response.status, duration: ConnectionMetrics.uptime() - start)
        if countsBytes { metrics.received(HTTPFraming.responseHead(status: response.status, headers: response.headers), on: .tailcat) }
        metrics.streamOpened(.tailcat)
        let source = response.body
        let countsBytes = countsBytes
        let body = AsyncThrowingStream<Data, Error> { continuation in
            let reader = Task {
                do {
                    for try await bytes in source {
                        if countsBytes { metrics.received(bytes.count, on: .tailcat) }
                        continuation.yield(bytes)
                    }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in
                reader.cancel()
                metrics.streamClosed(.tailcat)
            }
        }
        return HTTP1Stream(status: response.status, headers: response.headers, body: body)
    }

    public func browserConnection() async throws -> any BrowserStream {
        let stream = try await MetricsScope.$channel.withValue(.browser) { try await base.browserConnection() }
        // A self-metering transport's flow already counts on `browser`.
        return countsBytes ? MeteredStream(stream, metrics: metrics, channel: .browser) : stream
    }

    public func proxyTunnel(_ path: String, credential: String) async throws -> any BrowserStream {
        let stream = try await MetricsScope.$channel.withValue(.browser) { try await base.proxyTunnel(path, credential: credential) }
        return countsBytes ? MeteredStream(stream, metrics: metrics, channel: .browser) : stream
    }

    public func bearer(_ credential: String) async throws -> String { try await base.bearer(credential) }

    public func reset() async { await base.reset() }
    public func reset(_ category: RequestCategory) async { await base.reset(category) }
    public func resumed() async { await base.resumed() }
    public func close() async { await base.close() }
}

enum MeteredError {
    /// An error in words that name what failed, never what was sent: no
    /// URL (a presigned one carries its signature), no token.
    static func describe(_ error: Error) -> String {
        if let error = error as? URLError { return "URLError \(error.code.rawValue)" }
        let type = String(describing: Swift.type(of: error))
        let text = String(describing: error)
        // An enum case is short and says it; anything long may carry data.
        guard text.count <= 60, !text.contains("://"), !text.lowercased().contains("bearer") else { return type }
        return text.hasPrefix(type) ? text : "\(type).\(text)"
    }
}
