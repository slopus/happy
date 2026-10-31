#if canImport(Network)
import Foundation
import Network

/// One authenticated loopback listener per page capability. WKWebView's native
/// CONNECT support preserves the page's real origin, TLS and WebSocket protocol.
public actor BrowserProxy {
    public enum Scope: Sendable {
        case artifact(id: String, version: Int, authority: BrowserPolicy.Authority, workspaceID: String?)
        case workspace(id: String)
        case liveArtifact(id: String, workspaceID: String, authority: BrowserPolicy.Authority)
    }
    public nonisolated let username = UUID().uuidString
    public nonisolated let password = UUID().uuidString
    private let client: AgentClient
    private let scope: Scope
    private let queue = DispatchQueue(label: "app.happy.browser", qos: .userInitiated)
    private var listener: NWListener?
    private var ready: CheckedContinuation<UInt16, Error>?
    private var jobs: [UUID: (Task<Void, Never>, NetworkBrowserStream)] = [:]

    public init(client: AgentClient, scope: Scope) { self.client = client; self.scope = scope }

    public func start() async throws -> UInt16 {
        guard listener == nil else { throw BrowserError.unavailable }
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        let listener = try NWListener(using: parameters)
        self.listener = listener
        listener.newConnectionHandler = { [weak self] connection in
            Task { await self?.accept(connection) }
        }
        listener.stateUpdateHandler = { [weak self] state in Task { await self?.state(state) } }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                ready = continuation
                listener.start(queue: queue)
            }
        } onCancel: { Task { await self.stop() } }
    }

    private func state(_ state: NWListener.State) {
        switch state {
        case .ready:
            if let port = listener?.port?.rawValue { ready?.resume(returning: port); ready = nil }
        case .failed(let error): ready?.resume(throwing: error); ready = nil
        case .cancelled: ready?.resume(throwing: CancellationError()); ready = nil
        default: break
        }
    }

    public func stop() {
        listener?.cancel(); listener = nil
        ready?.resume(throwing: CancellationError()); ready = nil
        for (task, stream) in jobs.values { task.cancel(); stream.connection.cancel() }
        jobs.removeAll()
    }

    private func accept(_ connection: NWConnection) {
        guard listener != nil, jobs.count < 64 else { connection.cancel(); return }
        let stream = NetworkBrowserStream(connection)
        connection.start(queue: queue)
        let id = UUID()
        let authorization = "Basic " + Data("\(username):\(password)".utf8).base64EncodedString()
        let client = client, scope = scope
        let task = Task { [weak self] in
            do { try await Self.serve(stream, client: client, scope: scope, authorization: authorization) }
            catch { /* A cancelled tab or connection ends only its own stream. */ }
            await stream.close()
            await self?.finished(id)
        }
        jobs[id] = (task, stream)
    }

    private func finished(_ id: UUID) { jobs[id] = nil }

    private nonisolated static func serve(_ local: NetworkBrowserStream, client: AgentClient, scope: Scope, authorization: String) async throws {
        let (head, rest) = try await BrowserRelay.head(local)
        guard head.value("proxy-authorization") == authorization else {
            try await local.write(Data("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"Happy\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8))
            return
        }
        let parts = head.line.split(separator: " ")
        guard parts.count == 3, parts[0] == "CONNECT", parts[2] == "HTTP/1.1",
              let url = URL(string: "http://\(parts[1])"), url.path.isEmpty, url.query == nil,
              let authority = BrowserPolicy.Authority(url: url) else { throw BrowserError.forbidden }
        do {
            switch scope {
            case .artifact(let id, let version, let allowed, _) where allowed == authority:
                try await local.write(Data("HTTP/1.1 200 Connection Established\r\n\r\n".utf8))
                // CONNECT cannot already contain an HTTP request from WebKit.
                guard rest.isEmpty else { throw BrowserError.malformed }
                let request = try await BrowserRelay.head(local)
                try BrowserPolicy.checkArtifactOrigin(request.0, authority: authority)
                try await artifact(local, client: client, id: id, version: version, initial: request)
            case .workspace(let id):
                let remote = try await client.browserTunnel(workspaceID: id, target: authority)
                do {
                    try await local.write(Data("HTTP/1.1 200 Connection Established\r\n\r\n".utf8))
                    if !rest.isEmpty { try await remote.write(rest) }
                    try await BrowserRelay.duplex(local, remote)
                } catch { await remote.close(); throw error }
            case .liveArtifact(let artifactID, let workspaceID, let allowed) where allowed == authority:
                try await local.write(Data("HTTP/1.1 200 Connection Established\r\n\r\n".utf8))
                guard rest.isEmpty else { throw BrowserError.malformed }
                let request = try await BrowserRelay.head(local)
                let target = request.0.line.split(separator: " ").dropFirst().first ?? ""
                if target.hasPrefix("/api/") {
                    try BrowserPolicy.checkArtifactOrigin(request.0, authority: authority)
                    try await artifact(local, client: client, id: artifactID, version: 1, initial: request)
                } else {
                    var head = request.0
                    head.fields.removeAll { ["connection", "proxy-authorization", "proxy-connection", "x-happy-proxy-route"].contains($0.0.lowercased()) }
                    // Each HTTP connection is classified once. Closing ordinary
                    // responses prevents a later /api request bypassing the gate.
                    head.fields.append(("Connection", head.value("upgrade") == nil ? "close" : "Upgrade"))
                    let remote = try await client.browserTunnel(workspaceID: workspaceID, target: authority)
                    do {
                        try await remote.write(head.data)
                        if !request.1.isEmpty { try await remote.write(request.1) }
                        try await BrowserRelay.duplex(local, remote)
                    } catch { await remote.close(); throw error }
                }
            default:
                let workspaceID: String
                switch scope {
                case .artifact(_, _, _, let workspace):
                    guard let workspace else { throw BrowserError.unavailable }
                    workspaceID = workspace
                case .liveArtifact(_, let workspace, _): workspaceID = workspace
                case .workspace(let workspace): workspaceID = workspace
                }
                // Even public CDNs, redirects and WebSockets are resolved and
                // connected by the computer. There is no phone-network fallback.
                let remote = try await client.browserTunnel(workspaceID: workspaceID, target: authority)
                do {
                    try await local.write(Data("HTTP/1.1 200 Connection Established\r\n\r\n".utf8))
                    if !rest.isEmpty { try await remote.write(rest) }
                    try await BrowserRelay.duplex(local, remote)
                } catch { await remote.close(); throw error }
            }
        } catch {
            // No internal error, token, daemon response body or path escapes.
            try? await local.write(Data("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8))
            throw error
        }
    }

    private nonisolated static func artifact(_ local: any BrowserStream, client: AgentClient, id: String, version: Int, initial: (BrowserHTTPHead, Data)? = nil) async throws {
        let (head, initialBody): (BrowserHTTPHead, Data)
        if let initial { (head, initialBody) = initial }
        else { (head, initialBody) = try await BrowserRelay.head(local) }
        // A single, framed request per authenticated upstream connection. Never
        // forward pipelined bytes into the daemon's unrestricted HTTP parser.
        let (request, body) = try await BrowserRelay.requestBody(head, initial: initialBody, stream: local)
        let remote = try await client.artifactConnection(head: request, artifactID: id, version: version)
        do {
            if !body.isEmpty { try await remote.write(body) }
            // Responses are never buffered: status, duplicates, chunk framing,
            // binary bodies and SSE are relayed exactly, with no body timeout.
            let (response, bytes) = try await BrowserRelay.head(remote)
            try await local.write(response.artifactResponse().data)
            if !bytes.isEmpty { try await local.write(bytes) }
            if response.line.split(separator: " ").dropFirst().first == "101" {
                try await BrowserRelay.duplex(local, remote)
            } else {
                // Watch disconnect concurrently so an EventSource stops upstream
                // when the page closes, even while it has no events to send.
                try await withThrowingTaskGroup(of: Void.self) { group in
                    group.addTask { try await BrowserRelay.pipe(remote, to: local) }
                    group.addTask { _ = try await local.read(maximumBytes: 1) }
                    defer { group.cancelAll() }
                    do { _ = try await group.next() }
                    catch { await local.close(); await remote.close(); throw error }
                    await local.close(); await remote.close()
                }
            }
            await remote.close()
        } catch { await remote.close(); throw error }
    }
}

/// Network.framework owns the socket; async reads and writes have bounded buffers.
final class NetworkBrowserStream: BrowserStream, @unchecked Sendable {
    let connection: NWConnection
    init(_ connection: NWConnection) { self.connection = connection }
    func read(maximumBytes: Int) async throws -> Data {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                connection.receive(minimumIncompleteLength: 1, maximumLength: maximumBytes) { data, _, _, error in
                    if let error { continuation.resume(throwing: error) }
                    else { continuation.resume(returning: data ?? Data()) }
                }
            }
        } onCancel: { connection.cancel() }
    }
    func write(_ data: Data) async throws {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                connection.send(content: data, completion: .contentProcessed { error in
                    if let error { continuation.resume(throwing: error) }
                    else { continuation.resume() }
                })
            }
        } onCancel: { connection.cancel() }
    }
    func close() async { connection.cancel() }
}
#endif