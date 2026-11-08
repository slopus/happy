import Foundation
import HappyWire

/// Authenticated discovery is three-state: older daemons say nothing; null
/// explicitly removes an endpoint. Never infer removal from a failed request.
enum AgentEndpointAdvertisement: Equatable, Sendable {
    case unchanged
    case publicUrl(String?)

    static func decode(_ data: Data) throws -> Self {
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let config = root["config"] as? [String: Any] else { throw PairingError.invalidResponse }
        guard let apiValue = config["api"] else { return .unchanged }
        guard let api = apiValue as? [String: Any] else { throw PairingError.invalidResponse }
        guard let value = api["publicUrl"] else { return .unchanged }
        if value is NSNull { return .publicUrl(nil) }
        guard let value = value as? String else { throw PairingError.invalidResponse }
        return .publicUrl(try AgentOrigin(value).value)
    }
}

/// One saved account's routing decision, shared by identity, sync and files.
/// Persist before switching; stale responses cannot undo a newer decision.
actor AgentEndpoint {
    struct Snapshot: Sendable { let credentials: AgentConnectionCredentials; let revision: UInt64 }
    private var credentials: AgentConnectionCredentials
    private var revision: UInt64 = 0
    private var changing = false
    private var retired = false
    private var observers: [UUID: @Sendable (UInt64) async -> Void] = [:]
    private let save: @Sendable (AgentConnectionCredentials) async throws -> Void

    init(_ credentials: AgentConnectionCredentials, save: @escaping @Sendable (AgentConnectionCredentials) async throws -> Void) {
        self.credentials = credentials; self.save = save
    }

    func observe(_ id: UUID, invalidate: @escaping @Sendable (UInt64) async -> Void) throws -> Snapshot {
        guard !retired else { throw CancellationError() }
        observers[id] = invalidate
        return Snapshot(credentials: credentials, revision: revision)
    }

    func removeObserver(_ id: UUID) { observers[id] = nil }

    @discardableResult
    func apply(_ advertisement: AgentEndpointAdvertisement, from source: Snapshot) async throws -> Bool {
        // A signed-in server's origin is where its person signed in; a
        // daemon never moves the bearer somewhere else.
        guard !retired, !changing, source.revision == revision, credentials.signIn == nil,
              case .publicUrl(let url) = advertisement, url != credentials.publicUrl else { return false }
        changing = true
        defer { changing = false }
        var next = credentials
        next.publicUrl = url
        try await save(next)
        guard !retired else { return false }
        credentials = next; revision += 1
        let callbacks = Array(observers.values), revision = revision
        for callback in callbacks { await callback(revision) }
        return true
    }

    func retire() async {
        retired = true; revision += 1
        let callbacks = Array(observers.values), revision = revision
        observers.removeAll()
        for callback in callbacks { await callback(revision) }
    }
}

/// Stable client identity while its underlying transport changes. Closing old
/// streams makes their existing owners reconnect with the same token/cursors.
actor AgentEndpointTransport: AgentTransport {
    nonisolated let metrics: ConnectionMetrics?
    private let endpoint: AgentEndpoint
    private let make: @Sendable (AgentConnectionCredentials) -> any AgentTransport
    private let id = UUID()
    private var minimumRevision: UInt64 = 0
    private var selected: (any AgentTransport, AgentEndpoint.Snapshot)?
    private var closed = false

    init(endpoint: AgentEndpoint, metrics: ConnectionMetrics? = nil, make: @escaping @Sendable (AgentConnectionCredentials) -> any AgentTransport) {
        self.endpoint = endpoint; self.make = make; self.metrics = metrics
    }

    private func current() async throws -> (any AgentTransport, AgentEndpoint.Snapshot) {
        while true {
            guard !closed else { throw CancellationError() }
            let snapshot = try await endpoint.observe(id) { [weak self] revision in await self?.invalidate(revision) }
            guard !closed else { await endpoint.removeObserver(id); throw CancellationError() }
            guard snapshot.revision >= minimumRevision else { continue }
            if let selected, selected.1.revision == snapshot.revision { return selected }
            if selected != nil { await invalidate(snapshot.revision); continue }
            let raw = make(snapshot.credentials)
            let base: any AgentTransport
            if let metrics { base = MeteredAgentTransport(base: raw, metrics: metrics) } else { base = raw }
            let value = (base, snapshot)
            selected = value
            return value
        }
    }

    private func invalidate(_ revision: UInt64) async {
        minimumRevision = max(minimumRevision, revision)
        guard selected.map({ $0.1.revision < revision }) ?? false else { return }
        let old = selected; selected = nil
        await old?.0.close()
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        try await request(method: method, path: path, credential: credential, body: body, headers: headers, category: .query)
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String], category: RequestCategory) async throws -> HTTP1Response {
        let (base, snapshot) = try await current()
        let response = try await base.request(method: method, path: path, credential: credential, body: body, headers: headers, category: category)
        if method == "GET", path == "/v0/config", response.status == 200, credential == snapshot.credentials.deviceToken {
            let advertisement = try AgentEndpointAdvertisement.decode(response.body)
            let changed = try await endpoint.apply(advertisement, from: snapshot)
            if changed, advertisement == .publicUrl(nil), snapshot.credentials.tailcatAvailable == false { throw PairingError.unavailable }
        }
        return response
    }

    func upload(path: String, credential: String, body: Data) async throws -> HTTP1Response {
        try await current().0.upload(path: path, credential: credential, body: body)
    }
    func send(method: String, path: String, credential: String, body: Data, upload: Bool, sent: @escaping @Sendable (Int) -> Void) async throws -> HTTP1Response {
        try await current().0.send(method: method, path: path, credential: credential, body: body, upload: upload, sent: sent)
    }
    func send(method: String, path: String, credential: String, body: Data, category: RequestCategory, sent: @escaping @Sendable (Int) -> Void) async throws -> HTTP1Response {
        try await current().0.send(method: method, path: path, credential: credential, body: body, category: category, sent: sent)
    }
    func send(method: String, path: String, credential: String, body: Data, headers: [String: String], category: RequestCategory, sent: @escaping @Sendable (Int) -> Void) async throws -> HTTP1Response {
        try await current().0.send(method: method, path: path, credential: credential, body: body, headers: headers, category: category, sent: sent)
    }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        try await current().0.stream(path: path, credential: credential, headers: headers)
    }
    func browserConnection() async throws -> any BrowserStream { try await current().0.browserConnection() }
    func proxyTunnel(_ path: String, credential: String) async throws -> any BrowserStream { try await current().0.proxyTunnel(path, credential: credential) }
    func bearer(_ credential: String) async throws -> String { try await current().0.bearer(credential) }
    func reset() async { await selected?.0.reset() }
    func reset(_ category: RequestCategory) async { await selected?.0.reset(category) }
    func resumed() async { await selected?.0.resumed() }
    func close() async {
        closed = true
        await endpoint.removeObserver(id)
        let old = selected; selected = nil
        await old?.0.close()
    }
}