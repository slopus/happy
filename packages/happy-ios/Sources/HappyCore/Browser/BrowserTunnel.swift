import Foundation
import Tailcat

/// Backpressured bytes: each read/write finishes before the next is issued.
public protocol BrowserStream: Sendable {
    var authority: String { get }
    func read(maximumBytes: Int) async throws -> Data
    func write(_ data: Data) async throws
    func close() async
    /// Lets go of a stream whose answer is no longer wanted. Over Tailcat
    /// it is reset, so the computer stops sending: `close` would take the
    /// rest of the answer in and discard it.
    func abort() async
}

extension BrowserStream {
    public var authority: String { "server.tailcat" }
    public func abort() async { await close() }
}

extension TailcatConnection: BrowserStream {}

extension AgentTransport {
    public func browserConnection() async throws -> any BrowserStream { throw BrowserError.unavailable }
}

extension TailcatHTTPTransport {
    /// Over a `.file` client: a page's bytes are a file's, and its many
    /// short flows never crowd the event stream's or the queries' stack.
    public func browserConnection() async throws -> any BrowserStream {
        let lease = try await lease(.file)
        do { return try await flow(lease, .file) } catch {
            lease?.release()
            throw error
        }
    }
}

/// Where a page's tunnels open. A workspace's network is the one its
/// workspace resolves to now. A live artifact's is the one it was made on
/// (`live.networkId`), through `CONNECT /v0/artifacts/:id/proxy`, where the
/// daemon checks every destination against the artifact's URL.
public enum BrowserNetwork: Equatable, Sendable {
    case workspace(String)
    case artifact(String)

    /// The outer CONNECT's route; nil for an ID that isn't one.
    public var path: String? {
        switch self {
        case .workspace(let id): BrowserPolicy.validID(id) ? "/v0/workspaces/\(id)/proxy" : nil
        case .artifact(let id): BrowserPolicy.validID(id) ? "/v0/artifacts/\(id)/proxy" : nil
        }
    }

    /// The artifact route's refusals that mean its page can't open: the
    /// artifact is missing or not live, or its network isn't served (404);
    /// the network's machine opens no connections (501) or is away (503).
    public static let unavailable: Set<Int> = [404, 501, 503]
}

extension AgentClient {
    /// The computer's recorder, when the client's transport counts.
    var metrics: ConnectionMetrics? { (transport as? MeteredAgentTransport)?.metrics ?? (transport as? AgentEndpointTransport)?.metrics }

    /// Authentication is injected here and never returned to the web process.
    public func browserTunnel(workspaceID: String, target: BrowserPolicy.Authority) async throws -> any BrowserStream {
        try await browserTunnel(.workspace(workspaceID), target: target)
    }

    /// A tunnel to `target` opened in `network`. A live artifact's route
    /// refusing to open (`BrowserNetwork.unavailable`) is
    /// `BrowserError.liveUnavailable`; nothing falls back to another network.
    public func browserTunnel(_ network: BrowserNetwork, target: BrowserPolicy.Authority) async throws -> any BrowserStream {
        guard let path = network.path else { throw BrowserError.forbidden }
        let start = ConnectionMetrics.uptime()
        let stream: any BrowserStream
        do { stream = try await transport.proxyTunnel(path, credential: token) } catch {
            if !(error is CancellationError) {
                let status: Int? = if case BrowserError.upstream(let code) = error { code } else { nil }
                metrics?.request(.browser, status: status, duration: ConnectionMetrics.uptime() - start)
            }
            if case .artifact = network, case BrowserError.upstream(let status) = error, BrowserNetwork.unavailable.contains(status) {
                throw BrowserError.liveUnavailable
            }
            // No way to the computer at all is the link failing (502), as
            // a failure inside the tunnel is, not the proxy's own (500).
            if error is CancellationError || error is BrowserError || error is AgentClientError { throw error }
            throw BrowserProxyFailure.upstream(error)
        }
        do {
            try await Self.connect(stream, target: target.text, credential: nil)
            metrics?.request(.browser, status: 200, duration: ConnectionMetrics.uptime() - start)
            return stream
        } catch {
            if !(error is CancellationError) {
                let status: Int? = if case BrowserError.upstream(let code) = error { code } else { nil }
                metrics?.request(.browser, status: status, duration: ConnectionMetrics.uptime() - start)
            }
            await stream.close()
            if error is CancellationError { throw error }
            if case BrowserError.upstream = error { throw error }
            throw BrowserProxyFailure.upstream(error)
        }
    }

    public func artifactConnection(head: BrowserHTTPHead, artifactID: String, version: Int) async throws -> any BrowserStream {
        let stream = try await transport.browserConnection()
        do {
            let request = try head.artifactRequest(artifactID: artifactID, version: version, credential: try await transport.bearer(token), authority: stream.authority)
            try await stream.write(request.data); return stream
        }
        catch { await stream.close(); throw error }
    }

    static func connect(_ stream: any BrowserStream, target: String, credential: String?) async throws {
        var head = "CONNECT \(target) HTTP/1.1\r\nHost: \(credential == nil ? target : stream.authority)\r\n"
        if let credential { head += "Authorization: Bearer \(credential)\r\n" }
        try await stream.write(Data((head + "\r\n").utf8))
        let (response, rest) = try await BrowserRelay.head(stream)
        guard response.line.split(separator: " ").dropFirst().first == "200", rest.isEmpty else {
            throw BrowserError.upstream(Int(response.line.split(separator: " ").dropFirst().first ?? "") ?? 502)
        }
    }
}

public enum BrowserRelay {
    /// Buffer only bounded requests (the artifact API's 1 MiB contract). Convert
    /// chunked uploads to one exact length so no trailer or pipelined request can
    /// enter the authenticated daemon connection.
    public static func requestBody(_ head: BrowserHTTPHead, initial: Data, stream: any BrowserStream) async throws -> (BrowserHTTPHead, Data) {
        let lengths = head.fields.filter { $0.0.lowercased() == "content-length" }
        let transfers = head.fields.filter { $0.0.lowercased() == "transfer-encoding" }
        guard lengths.count <= 1, transfers.count <= 1, lengths.isEmpty || transfers.isEmpty else { throw BrowserError.malformed }
        var body = Data()
        if let transfer = transfers.first {
            guard transfer.1.lowercased() == "chunked" else { throw BrowserError.malformed }
            var decoder = HTTP1BodyDecoder(chunked: true)
            var bytes = initial
            var received = 0
            while true {
                received += bytes.count
                guard received <= 1_114_112 else { throw BrowserError.tooLarge }
                body.append(try decoder.append(bytes))
                guard body.count <= 1_048_576 else { throw BrowserError.tooLarge }
                if decoder.finished { break }
                bytes = try await stream.read(maximumBytes: 65536)
                guard !bytes.isEmpty else { throw BrowserError.malformed }
            }
        } else {
            let text = lengths.first?.1 ?? "0"
            guard !text.isEmpty, text.utf8.allSatisfy({ (48...57).contains($0) }), let length = Int(text), initial.count <= length else { throw BrowserError.malformed }
            guard length <= 1_048_576 else { throw BrowserError.tooLarge }
            body = initial
            while body.count < length {
                let bytes = try await stream.read(maximumBytes: min(65536, length - body.count))
                guard !bytes.isEmpty, bytes.count <= length - body.count else { throw BrowserError.malformed }
                body.append(bytes)
            }
        }
        var request = head
        request.fields.removeAll { ["content-length", "transfer-encoding", "trailer"].contains($0.0.lowercased()) }
        request.fields.append(("Content-Length", String(body.count)))
        return (request, body)
    }

    public static func head(_ stream: any BrowserStream, initial: Data = Data()) async throws -> (BrowserHTTPHead, Data) {
        try await withThrowingTaskGroup(of: (BrowserHTTPHead, Data).self) { group in
            group.addTask {
                var buffer = initial
                while true {
                    try Task.checkCancellation()
                    if let head = try BrowserHTTPHead.parse(buffer) { return head }
                    let bytes = try await stream.read(maximumBytes: 65536)
                    guard !bytes.isEmpty else { throw BrowserError.unavailable }
                    buffer.append(bytes)
                }
            }
            group.addTask { try await Task.sleep(for: .seconds(35)); await stream.close(); throw BrowserError.timeout }
            defer { group.cancelAll() }
            return try await group.next()!
        }
    }

    public static func pipe(_ source: any BrowserStream, to destination: any BrowserStream) async throws {
        while true {
            try Task.checkCancellation()
            let bytes = try await source.read(maximumBytes: 65536)
            if bytes.isEmpty { return }
            try await destination.write(bytes)
        }
    }

    public static func duplex(_ first: any BrowserStream, _ second: any BrowserStream) async throws {
        try await duplex(first, second) { try await pipe(first, to: second) }
    }

    /// A page on a loopback alias, tunnelled to the computer's loopback:
    /// each request names `host` where it named `alias`. Bodies, responses,
    /// TLS and upgraded streams pass byte for byte.
    public static func loopback(_ local: any BrowserStream, _ remote: any BrowserStream, initial: Data, alias: String, host: String) async throws {
        try await duplex(local, remote) {
            var buffer = initial.isEmpty ? try await local.read(maximumBytes: 65536) : initial
            // A TLS handshake is never HTTP: its Host is sealed inside.
            guard buffer.first != 0x16 else { try await remote.write(buffer); try await pipe(local, to: remote); return }
            while true {
                var parsed = try BrowserHTTPHead.parse(buffer)
                while parsed == nil {
                    let bytes = try await local.read(maximumBytes: 65536)
                    if bytes.isEmpty { return }
                    buffer.append(bytes)
                    parsed = try BrowserHTTPHead.parse(buffer)
                }
                guard let (head, rest) = parsed else { return }
                try await remote.write(head.loopbackRequest(alias: alias, host: host).data)
                if head.value("upgrade") != nil {
                    if !rest.isEmpty { try await remote.write(rest) }
                    try await pipe(local, to: remote); return
                }
                var body = try BrowserResponseBody(request: head)
                var bytes = rest
                while true {
                    let used = try body.consume(bytes)
                    if used > 0 { try await remote.write(bytes.prefix(used)) }
                    if body.finished { buffer = Data(bytes.dropFirst(used)); break }
                    bytes = try await local.read(maximumBytes: 65536)
                    if bytes.isEmpty { return }
                }
            }
        }
    }

    private static func duplex(_ first: any BrowserStream, _ second: any BrowserStream, outgoing: @escaping @Sendable () async throws -> Void) async throws {
        try await withTaskCancellationHandler {
            try await withThrowingTaskGroup(of: Void.self) { group in
                group.addTask { try await outgoing() }
                group.addTask { try await pipe(second, to: first) }
                defer { group.cancelAll() }
                do { _ = try await group.next() }
                catch { await first.close(); await second.close(); throw error }
                await first.close(); await second.close()
            }
        } onCancel: { Task { await first.close(); await second.close() } }
    }
}