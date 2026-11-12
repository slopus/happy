import Foundation
import HappyWire
import Tailcat

public struct HTTP1Response: Sendable {
    public let status: Int
    public let headers: [String: String]
    public let body: Data
    public init(status: Int, headers: [String: String] = [:], body: Data = Data()) {
        self.status = status; self.headers = headers; self.body = body
    }
}

public protocol AgentTransport: Sendable {
    /// A raw connection, for the browser's scoped HTTP and CONNECT bridges:
    /// over a `.file` client.
    func browserConnection() async throws -> any BrowserStream
    /// A `.query`.
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response
    /// `request` as `category`: over that category's client, with its
    /// deadline. A transport with one way to the computer ignores it.
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String], category: RequestCategory) async throws -> HTTP1Response
    /// A bounded file write with a longer deadline than small API requests: a `.file`.
    func upload(path: String, credential: String, body: Data) async throws -> HTTP1Response
    /// `upload`, or a `request` with `method`, telling `sent` how many of
    /// the body's bytes have gone out as they go: a sending picture's ring.
    func send(method: String, path: String, credential: String, body: Data, upload: Bool, sent: @escaping @Sendable (Int) -> Void) async throws -> HTTP1Response
    /// `send`'s request as `category`.
    func send(method: String, path: String, credential: String, body: Data, category: RequestCategory, sent: @escaping @Sendable (Int) -> Void) async throws -> HTTP1Response
    /// `send` with headers of its own: a vault upload's `Content-Range`.
    func send(method: String, path: String, credential: String, body: Data, headers: [String: String], category: RequestCategory, sent: @escaping @Sendable (Int) -> Void) async throws -> HTTP1Response
    /// A GET whose body arrives as it is written, for an event stream: over
    /// the `.realtime` client.
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream
    /// Lets go of every connection so the next request makes a new one.
    func reset() async
    /// Lets go of `category`'s connections; the other categories' stay.
    func reset(_ category: RequestCategory) async
    /// Back from the background: every way to the computer is checked at
    /// once (the relay and every direct path), and only what doesn't answer
    /// is replaced; tunnels, requests under way and sessions stay.
    func resumed() async
    func close() async
    /// The bearer to write into a request this transport doesn't frame
    /// itself (an artifact request on a browser connection): `credential`,
    /// unless the transport signs its own requests in.
    func bearer(_ credential: String) async throws -> String
    /// A proxy tunnel at `path`, a CONNECT route such as
    /// `/v0/workspaces/:id/proxy`, open and past its `200`: CONNECT, or its
    /// WebSocket twin where the server has one (edge SSO contract §4).
    func proxyTunnel(_ path: String, credential: String) async throws -> any BrowserStream
}

/// A response head, and its decoded body as the bytes arrive. The body ends
/// when the server closes it; ending the iteration closes the stream.
public struct HTTP1Stream: Sendable {
    public let status: Int
    public let headers: [String: String]
    public let body: AsyncThrowingStream<Data, Error>
    public init(status: Int, headers: [String: String] = [:], body: AsyncThrowingStream<Data, Error>) {
        self.status = status; self.headers = headers; self.body = body
    }
}

extension AgentTransport {
    public func request(method: String, path: String, credential: String, body: Data?, headers: [String: String], category: RequestCategory) async throws -> HTTP1Response {
        try await request(method: method, path: path, credential: credential, body: body, headers: headers)
    }

    public func upload(path: String, credential: String, body: Data) async throws -> HTTP1Response {
        try await request(method: "PUT", path: path, credential: credential, body: body, headers: ["Content-Type": "application/json"])
    }
    /// A transport that can't tell its writes apart has sent it all once
    /// it is answered.
    public func send(method: String, path: String, credential: String, body: Data, upload: Bool, sent: @escaping @Sendable (Int) -> Void) async throws -> HTTP1Response {
        let response = upload
            ? try await self.upload(path: path, credential: credential, body: body)
            : try await request(method: method, path: path, credential: credential, body: body, headers: [:])
        sent(body.count)
        return response
    }

    public func send(method: String, path: String, credential: String, body: Data, category: RequestCategory, sent: @escaping @Sendable (Int) -> Void) async throws -> HTTP1Response {
        try await send(method: method, path: path, credential: credential, body: body, upload: false, sent: sent)
    }

    public func send(method: String, path: String, credential: String, body: Data, headers: [String: String], category: RequestCategory, sent: @escaping @Sendable (Int) -> Void) async throws -> HTTP1Response {
        let response = try await request(method: method, path: path, credential: credential, body: body, headers: headers, category: category)
        sent(body.count)
        return response
    }

    public func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        throw PairingError.unavailable
    }

    public func reset() async {}

    public func reset(_ category: RequestCategory) async { await reset() }

    public func resumed() async {}

    public func bearer(_ credential: String) async throws -> String { credential }

    public func proxyTunnel(_ path: String, credential: String) async throws -> any BrowserStream {
        try await connectTunnel(path, credential: credential)
    }

    /// CONNECT `path` on a fresh browser connection.
    func connectTunnel(_ path: String, credential: String) async throws -> any BrowserStream {
        let stream = try await browserConnection()
        do {
            try await AgentClient.connect(stream, target: path, credential: credential)
            return stream
        } catch {
            await stream.close()
            throw error
        }
    }

    func request(_ path: String, credential: String, method: String = "GET", body: Data? = nil, headers: [String: String] = [:], category: RequestCategory = .query) async throws -> HTTP1Response {
        try await request(method: method, path: path, credential: credential, body: body, headers: headers, category: category)
    }
}

/// The computer's API, one transport per account. HTTPS uses
/// platform-verified TLS; otherwise it goes over the account's
/// `TailcatClients`: one client for the event stream and queries, up to
/// three for files and the browser, and `server.tailcat` is a logical
/// authority, never a DNS lookup. A request over Tailcat goes on a flow its
/// client kept open from an earlier one (`IdleFlows`), or a new one; over
/// HTTPS each request owns a fresh stream, closed once answered. A query
/// must be answered within 35 seconds, a file within 15 minutes.
public final class AgentHTTPTransport: SelfMeteringTransport {
    let port: UInt16
    let publicUrl: String?
    private let tailcatAvailable: Bool
    let authority: String
    /// The account's recorder, once a metered transport is over this one.
    let meter: MeterSlot
    let clients: TailcatClients<Tunnel>
    private let publicFlows = PublicFlows()

    /// One Tailcat client, its id with the recorder while it is up, and
    /// the flows it keeps open between requests.
    final class Tunnel: Sendable {
        let client: TailcatClient
        let id: UUID?
        let idle = IdleFlows()
        init(_ client: TailcatClient, id: UUID?) { self.client = client; self.id = id }
    }

    public convenience init(address: String, port: UInt16, publicUrl: String? = nil, tailcatAvailable: Bool = true) {
        self.init(port: port, publicUrl: publicUrl, tailcatAvailable: tailcatAvailable) { _, key in
            return try await TailcatClient.connect(to: address, configuration: Self.tailcatConfiguration(key: key))
        }
    }

    static func tailcatConfiguration(key: NodePrivateKey) -> TailcatClient.Configuration {
        var config = TailcatClient.Configuration()
        config.connectTimeout = 20
        config.privateKey = key
        // Serve the first request over DERP while this client's direct path is probed.
        config.relayFirst = true
        config.mapCache = mapCache
        return config
    }

    /// The relay map saved across launches: a cold launch connects with it
    /// at once instead of fetching it first.
    static let mapCache = FileDERPMapCache(directory: FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("tailcat", isDirectory: true))

    /// `connect` makes one client of `category` with its own node key.
    init(port: UInt16, publicUrl: String? = nil, tailcatAvailable: Bool = true, connect: @escaping @Sendable (RequestCategory, NodePrivateKey) async throws -> TailcatClient) {
        self.port = port; self.publicUrl = publicUrl; self.tailcatAvailable = tailcatAvailable
        authority = publicUrl.map { String($0.dropFirst("https://".count)) } ?? "server.tailcat:\(port)"
        let meter = MeterSlot()
        self.meter = meter
        clients = TailcatClients(connect: { category, key in
            do {
                let client = try await connect(category, key)
                return Tunnel(client, id: await Self.up(client, port: port, metrics: meter.metrics))
            } catch {
                if !(error is CancellationError) { meter.metrics?.failed("Tailcat connect: \(MeteredError.describe(error))") }
                throw error
            }
        }, disconnect: { tunnel in
            if let id = tunnel.id { meter.metrics?.tunnelDown(id) }
            await tunnel.idle.shut()
            await tunnel.client.close()
        })
    }

    public func attach(_ metrics: ConnectionMetrics) { meter.metrics = metrics }

    /// Tells the recorder `client` is up, and how to ask it its path and flows.
    private static func up(_ client: TailcatClient, port: UInt16, metrics: ConnectionMetrics?) async -> UUID? {
        guard let metrics else { return nil }
        let id = UUID()
        let address = await client.serverAddress
        metrics.tunnelUp(id, info: info(address, port: port), flows: { [weak client] in
            guard let statistics = await client?.flowStatistics else { return nil }
            return TunnelFlows(open: statistics.open, closing: statistics.closing,
                               openLimit: TailcatFlowStatistics.openLimit, closingLimit: TailcatFlowStatistics.closingLimit)
        }) { [weak client] in
            switch await client?.path {
            case .relay: .relayed
            case .direct(let endpoint): .direct(endpoint: endpoint)
            case nil: nil
            }
        }
        return id
    }

    public func close() async {
        await clients.close()
        await publicFlows.shut()
    }

    /// A computer whose daemon restarted has forgotten a tunnel's session
    /// and drops what it sends until the tunnel rekeys, minutes later; a new
    /// tunnel handshakes at once.
    public func reset() async {
        for category in RequestCategory.allCases { await reset(category) }
    }

    /// `.realtime` and `.query` share a Tailcat client: resetting either
    /// lets go of both.
    public func reset(_ category: RequestCategory) async {
        await clients.reset(category)
        await publicFlows.close(category)
    }

    /// A tunnel kept through a suspension may or may not still work: its
    /// relay connection, socket and direct paths, and a WireGuard session
    /// past its 180 seconds. Each tunnel is woken: the relay is pinged and
    /// replaced only if it doesn't answer within two seconds, every direct
    /// path is probed and one that stopped answering dropped, a dead socket
    /// rebound, and an expired session rekeyed at once rather than at the
    /// next 30-second idle mark. All at once: a wake can wait on its relay
    /// connecting again, and one at a time the last tunnel woke only after
    /// every relay before it. The flows kept between requests are let go:
    /// one may have gone out the old way, or died with the suspension.
    public func resumed() async {
        await withTaskGroup(of: Void.self) { group in
            for tunnel in clients.connected() {
                group.addTask {
                    await tunnel.idle.drop()
                    await tunnel.client.wake()
                }
            }
        }
    }

    /// The way a `category` request goes: a lease on one of that
    /// category's Tailcat clients, or none over HTTPS.
    func lease(_ category: RequestCategory) async throws -> TailcatClients<Tunnel>.Lease? {
        if let publicUrl {
            guard !publicFlows.isShut else { throw CancellationError() }
            _ = try AgentOrigin(publicUrl)
            return nil
        }
        guard tailcatAvailable else { throw PairingError.unavailable }
        return try await clients.lease(category)
    }

    /// Lets go of `lease`'s client after a failure on it; HTTPS has none.
    /// `ifSilent`, a client the event stream shares stays while it brings bytes back.
    func reset(_ lease: TailcatClients<Tunnel>.Lease?, ifSilent: Bool = false) async {
        if let lease { await clients.reset(lease, ifSilent: ifSilent) }
    }

    /// A TCP flow to the computer over `lease`'s client, or over HTTPS
    /// without one, counted on the channel the request that opens it names
    /// (`MetricsScope.channel`). Closing it lets go of the lease.
    func flow(_ lease: TailcatClients<Tunnel>.Lease?, _ category: RequestCategory) async throws -> any BrowserStream {
        let counted = try await openFlow(lease, category)
        return lease.map { LeasedStream(counted, lease: $0) } ?? counted
    }

    /// `flow` without the lease: one a request may leave open for the next.
    private func openFlow(_ lease: TailcatClients<Tunnel>.Lease?, _ category: RequestCategory) async throws -> any BrowserStream {
        let raw: any BrowserStream
        if let lease { raw = try await lease.client.client.openTCP(port: port) }
        else if let publicUrl { raw = try publicFlows.open(AgentOrigin(publicUrl), category) }
        else { throw PairingError.unavailable }
        return meter.metrics.map { MeteredStream(raw, metrics: $0, channel: MetricsScope.channel ?? (lease == nil ? .http : .tailcat)) } ?? raw
    }

    /// How long `category`'s request may take, written and answered.
    static func deadline(_ category: RequestCategory) -> Duration { category == .file ? .seconds(15 * 60) : .seconds(35) }

    public func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        try await request(method: method, path: path, credential: credential, body: body, headers: headers, category: .query)
    }

    public func request(method: String, path: String, credential: String, body: Data?, headers: [String: String], category: RequestCategory) async throws -> HTTP1Response {
        try await perform(method: method, path: path, credential: credential, body: body, headers: headers, category: category, sent: nil)
    }

    private func perform(method: String, path: String, credential: String, body: Data?, headers: [String: String], category: RequestCategory, sent: (@Sendable (Int) -> Void)?) async throws -> HTTP1Response {
        guard ["GET", "POST", "PATCH", "PUT", "DELETE"].contains(method), Self.safe(path: path, credential: credential, headers: headers) else { throw PairingError.invalidResponse }
        let lease = try await lease(category)
        defer { lease?.release() }
        do {
            return try await exchange(lease: lease, category: category, method: method, path: path, credential: credential, body: body, headers: headers, timeout: Self.deadline(category), sent: sent)
        } catch {
            // The stream's heartbeats say whether the tunnel is gone or only this request.
            if Self.lostTunnel(error) { await reset(lease, ifSilent: true) }
            throw error
        }
    }

    /// Whether `error` says the tunnel carried nothing back (a timeout, a
    /// stream it could not open), rather than a refused or garbled answer.
    static func lostTunnel(_ error: Error) -> Bool {
        if error is CancellationError { return false }
        if let error = error as? PairingError { return error == .unavailable }
        return true
    }

    public func upload(path: String, credential: String, body: Data) async throws -> HTTP1Response {
        try await upload(path: path, credential: credential, body: body, sent: nil)
    }

    public func send(method: String, path: String, credential: String, body: Data, upload: Bool, sent: @escaping @Sendable (Int) -> Void) async throws -> HTTP1Response {
        upload
            ? try await self.upload(path: path, credential: credential, body: body, sent: sent)
            : try await perform(method: method, path: path, credential: credential, body: body, headers: [:], category: .query, sent: sent)
    }

    public func send(method: String, path: String, credential: String, body: Data, category: RequestCategory, sent: @escaping @Sendable (Int) -> Void) async throws -> HTTP1Response {
        try await perform(method: method, path: path, credential: credential, body: body, headers: [:], category: category, sent: sent)
    }

    public func send(method: String, path: String, credential: String, body: Data, headers: [String: String], category: RequestCategory, sent: @escaping @Sendable (Int) -> Void) async throws -> HTTP1Response {
        try await perform(method: method, path: path, credential: credential, body: body, headers: headers, category: category, sent: sent)
    }

    private func upload(path: String, credential: String, body: Data, sent: (@Sendable (Int) -> Void)?) async throws -> HTTP1Response {
        guard body.count <= 72 * 1024 * 1024 else { throw PairingError.invalidResponse }
        return try await perform(method: "PUT", path: path, credential: credential, body: body, headers: [:], category: .file, sent: sent)
    }

    private func exchange(lease: TailcatClients<Tunnel>.Lease?, category: RequestCategory, method: String, path: String, credential: String, body: Data?, headers: [String: String], timeout: Duration, sent: (@Sendable (Int) -> Void)?) async throws -> HTTP1Response {
        try await withThrowingTaskGroup(of: HTTP1Response.self) { group in
            group.addTask {
                let response = try await self.exchange(method: method, path: path, credential: credential, body: body, headers: headers, idle: lease?.client.idle, sent: sent) {
                    try await self.openFlow(lease, category)
                }
                // An answer came back over the client: it is there (`reset(_:ifSilent:)`).
                lease?.heard()
                return response
            }
            group.addTask { try await Task.sleep(for: timeout); throw PairingError.unavailable }
            defer { group.cancelAll() }
            guard let response = try await group.next() else { throw PairingError.unavailable }
            return response
        }
    }

    /// The request on the newest flow `idle` kept, or on a new one from
    /// `open`; a response framed to its last byte leaves its flow in `idle`
    /// for the next request. A kept flow can have been let go by the
    /// computer as the request went out: a GET that got not a byte back on
    /// one goes again, once, on a new flow. Any other method's failure is
    /// thrown, as it may have been done. Without `idle` (HTTPS) the stream
    /// is closed once answered.
    func exchange(method: String, path: String, credential: String, body: Data?, headers: [String: String], idle: IdleFlows?, sent: (@Sendable (Int) -> Void)?,
                  staleAfter: Duration = AgentHTTPTransport.staleAfter, open: () async throws -> any BrowserStream) async throws -> HTTP1Response {
        let epoch = idle?.epoch ?? 0
        if let idle, let kept = await idle.take() {
            do { return try await exchange(on: kept, reused: true, epoch: epoch, method: method, path: path, credential: credential, body: body, headers: headers, idle: idle, sent: sent, staleAfter: staleAfter) }
            catch is StaleFlow {}
        }
        return try await exchange(on: try await open(), reused: false, epoch: epoch, method: method, path: path, credential: credential, body: body, headers: headers, idle: idle, sent: sent, staleAfter: staleAfter)
    }

    /// How long a kept flow has to show it is still there: the computer
    /// taking the request's head, a Tailcat write returning once it is
    /// acknowledged. A flow gone quiet holds a request no longer, and a
    /// slow answer on a live one is waited for as on a new one.
    static let staleAfter: Duration = .seconds(5)

    /// A kept flow that carried a GET's request and nothing back.
    private struct StaleFlow: Error {}

    private func exchange(on stream: any BrowserStream, reused: Bool, epoch: Int, method: String, path: String, credential: String, body: Data?, headers: [String: String], idle: IdleFlows?, sent: (@Sendable (Int) -> Void)?, staleAfter: Duration) async throws -> HTTP1Response {
        var received = 0
        // Decoded once the flow is kept or closed: its reuse depends only on the framing.
        return try ContentCoding.decoded(try await withTaskCancellationHandler {
            do {
                var head = "\(method) \(path) HTTP/1.1\r\nHost: \(self.authority)\r\nAuthorization: Bearer \(credential)\r\nAccept: application/json\r\nContent-Length: \(body?.count ?? 0)\r\n"
                // JSON unless the caller names the type (a picture's bytes).
                if body != nil, !headers.keys.contains(where: { $0.lowercased() == "content-type" }) { head += "Content-Type: application/json\r\n" }
                // A large JSON answer comes compressed, unless the caller says otherwise.
                if !headers.keys.contains(where: { $0.lowercased() == "accept-encoding" }) { head += "Accept-Encoding: \(ContentCoding.accepted)\r\n" }
                for (name, value) in headers { head += "\(name): \(value)\r\n" }
                let headBytes = Data((head + "\r\n").utf8)
                if reused { try await Self.write(headBytes, to: stream, within: staleAfter) } else { try await stream.write(headBytes) }
                if let body {
                    var offset = 0
                    while offset < body.count {
                        try Task.checkCancellation()
                        let end = min(body.count, offset + 256 * 1024)
                        try await stream.write(Data(body[offset..<end]))
                        offset = end
                        // Written to the tunnel: what a sending picture's ring shows.
                        sent?(offset)
                    }
                }
                var parser = HTTP1Parser()
                while true {
                    try Task.checkCancellation()
                    let bytes = try await stream.read(maximumBytes: 65536)
                    received += bytes.count
                    if let response = try parser.append(bytes, eof: bytes.isEmpty) {
                        if let idle, parser.reusable, !Task.isCancelled { await idle.put(stream, epoch: epoch) }
                        else { await stream.close() }
                        return response
                    }
                }
            } catch {
                await stream.close()
                if reused, received == 0, method == "GET", !Task.isCancelled, !(error is CancellationError) { throw StaleFlow() }
                throw error
            }
        } onCancel: { Task { await stream.close() } })
    }

    /// `data` written to `stream`, or `PairingError.unavailable` once
    /// `limit` passes first.
    private static func write(_ data: Data, to stream: any BrowserStream, within limit: Duration) async throws {
        try await withThrowingTaskGroup(of: Bool.self) { group in
            group.addTask { try await stream.write(data); return true }
            group.addTask { try await Task.sleep(for: limit); return false }
            defer { group.cancelAll() }
            guard try await group.next() == true else { throw PairingError.unavailable }
        }
    }
}

/// Kept for callers that construct the original tunnel-only transport.
public typealias TailcatHTTPTransport = AgentHTTPTransport

/// The HTTPS flows open now, by category, so a reset closes only its own.
final class PublicFlows: @unchecked Sendable {
    private let lock = NSLock()
    private var flows: [UUID: (RequestCategory, any BrowserStream)] = [:]
    private var shutDown = false

    var isShut: Bool { lock.lock(); defer { lock.unlock() }; return shutDown }

    func open(_ origin: AgentOrigin, _ category: RequestCategory) throws -> any BrowserStream {
        let id = UUID()
        let stream = try HTTPSBrowserStream.open(origin) { [weak self] in self?.forget(id) }
        lock.lock()
        guard !shutDown else { lock.unlock(); Task { await stream.close() }; throw CancellationError() }
        flows[id] = (category, stream)
        lock.unlock()
        return stream
    }

    private func forget(_ id: UUID) { lock.lock(); flows[id] = nil; lock.unlock() }

    func close(_ category: RequestCategory) async {
        let closing = lock.withLock {
            let closing = flows.filter { $0.value.0 == category }
            for id in closing.keys { flows[id] = nil }
            return closing
        }
        for (_, stream) in closing.values { await stream.close() }
    }

    func shut() async {
        let closing = lock.withLock {
            shutDown = true
            let closing = Array(flows.values)
            flows.removeAll()
            return closing
        }
        for (_, stream) in closing { await stream.close() }
    }
}

/// One Tailcat client's flows left open by the requests before, newest
/// last, so the next request skips a TCP handshake over the relay and the
/// computer the process it starts for each connection. Each is read while
/// it waits: a byte, the end or an error says the computer let it go, and
/// it is closed and forgotten, as it is once idle for `idleLimit`, under
/// the computer's 60 seconds. At most four are kept.
final class IdleFlows: @unchecked Sendable {
    private struct Entry {
        let id: UUID
        let flow: any BrowserStream
        /// True once `take` called it off with the flow still open.
        let watch: Task<Bool, Never>
    }

    static let limit = 4
    let idleLimit: Duration
    private let lock = NSLock()
    private var entries: [Entry] = []
    private var dropped = 0
    private var isShut = false

    init(idleLimit: Duration = .seconds(50)) { self.idleLimit = idleLimit }

    var count: Int { lock.withLock { entries.count } }

    /// Which `drop` a request began after: a flow `put` with an older one
    /// may have gone out the old way, and is closed.
    var epoch: Int { lock.withLock { dropped } }

    /// Keeps `flow`, unless shut or dropped since `epoch`: then closes it.
    func put(_ flow: any BrowserStream, epoch: Int) async {
        let id = UUID(), idleLimit = idleLimit
        let watch = Task { [weak self] () -> Bool in
            let open = await withTaskGroup(of: Bool.self) { group in
                group.addTask {
                    do { _ = try await flow.read(maximumBytes: 1) } catch { return Task.isCancelled }
                    return false
                }
                group.addTask { (try? await Task.sleep(for: idleLimit)) == nil }
                defer { group.cancelAll() }
                return await group.next() ?? false
            }
            if !open { await self?.evict(id) }
            return open
        }
        let entry = Entry(id: id, flow: flow, watch: watch)
        let closing = lock.withLock { () -> [Entry] in
            guard !isShut, epoch == dropped else { return [entry] }
            entries.append(entry)
            return entries.count > Self.limit ? [entries.removeFirst()] : []
        }
        for entry in closing { await close(entry) }
    }

    /// The newest flow still open, no longer read or kept; nil when none is.
    func take() async -> (any BrowserStream)? {
        while let entry = lock.withLock({ entries.popLast() }) {
            entry.watch.cancel()
            if await entry.watch.value { return entry.flow }
            await entry.flow.close()
        }
        return nil
    }

    /// Closes every flow kept, and every one a request already under way
    /// puts back; flows of later requests are kept again.
    func drop() async {
        let closing = lock.withLock { () -> [Entry] in
            dropped += 1
            defer { entries.removeAll() }
            return entries
        }
        for entry in closing { await close(entry) }
    }

    /// Closes every flow kept, and every one put after.
    func shut() async {
        lock.withLock { isShut = true }
        await drop()
    }

    private func evict(_ id: UUID) async {
        guard let entry = lock.withLock({ entries.firstIndex { $0.id == id }.map { entries.remove(at: $0) } }) else { return }
        await close(entry)
    }

    private func close(_ entry: Entry) async {
        entry.watch.cancel()
        await entry.flow.close()
    }
}

/// A flow that holds its client's lease until it is closed, or dropped, and
/// tells it each time bytes come back.
final class LeasedStream: BrowserStream, @unchecked Sendable {
    let base: any BrowserStream
    private let release: @Sendable () -> Void
    private let heard: @Sendable () -> Void

    init<Client: AnyObject & Sendable>(_ base: any BrowserStream, lease: TailcatClients<Client>.Lease) {
        self.base = base
        release = { lease.release() }
        heard = { lease.heard() }
    }

    deinit { release() }

    var authority: String { base.authority }
    func read(maximumBytes: Int) async throws -> Data {
        let bytes = try await base.read(maximumBytes: maximumBytes)
        if !bytes.isEmpty { heard() }
        return bytes
    }
    func write(_ data: Data) async throws { try await base.write(data) }

    func close() async {
        await base.close()
        release()
    }
}

extension TailcatHTTPTransport {
    /// What the recorder may show of a tunnel: its relay and the computer's
    /// public node key, never the address (it holds the tunnel's secrets).
    static func info(_ address: TailcatAddress, port: UInt16) -> TunnelInfo {
        let region = address.regions.first { $0.regionID == address.regionID } ?? address.regions.first
        let key = address.serverPublicKey.description
        let short = key.hasPrefix("nodekey:") ? "nodekey:" + key.dropFirst(8).prefix(8) + "…" : String(key.prefix(16)) + "…"
        return TunnelInfo(regionID: region?.regionID ?? address.regionID, regionCode: region?.regionCode ?? "", regionName: region?.regionName ?? "",
                          relayHost: region?.nodes.first { !$0.stunOnly }?.hostName, nodeKey: short, port: port)
    }
}

/// The recorder a transport reports to, set once it is metered.
final class MeterSlot: @unchecked Sendable {
    private let lock = NSLock()
    private var value: ConnectionMetrics?
    var metrics: ConnectionMetrics? {
        get { lock.lock(); defer { lock.unlock() }; return value }
        set { lock.lock(); value = newValue; lock.unlock() }
    }
}

/// Incremental HTTP/1.1 decoding with strict framing and bounded metadata.
/// Handles arbitrary TCP boundaries, length, chunked and close-delimited bodies.
struct HTTP1Parser {
    private var data = Data()
    private let limit = 8 * 1024 * 1024
    /// Whether the connection may carry another request, once the response
    /// is whole: HTTP/1.1, not `Connection: close`, and framed by its length
    /// or chunks to exactly the last byte read. A body that ends with the
    /// connection, or bytes past the response, end it.
    private(set) var reusable = false

    mutating func append(_ bytes: Data, eof: Bool) throws -> HTTP1Response? {
        guard data.count + bytes.count <= limit + 65536 else { throw PairingError.invalidResponse }
        data.append(bytes)
        guard let divider = data.range(of: Data("\r\n\r\n".utf8)) else {
            guard data.count <= 32768, !eof else { throw PairingError.invalidResponse }; return nil
        }
        guard divider.lowerBound <= 32768,
              let head = String(data: data[..<divider.lowerBound], encoding: .utf8) else { throw PairingError.invalidResponse }
        let lines = head.components(separatedBy: "\r\n")
        let statusParts = (lines.first ?? "").split(separator: " ")
        guard statusParts.count >= 2, ["HTTP/1.1", "HTTP/1.0"].contains(String(statusParts[0])), let status = Int(statusParts[1]), (200...599).contains(status) else { throw PairingError.invalidResponse }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { throw PairingError.invalidResponse }
            let name = line[..<colon].lowercased()
            guard !name.isEmpty, headers[name] == nil else { throw PairingError.invalidResponse }
            headers[name] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        let body = Data(data[divider.upperBound...])
        let closes = headers["connection"]?.lowercased().split(separator: ",").contains { $0.trimmingCharacters(in: .whitespaces) == "close" } ?? false
        let persistent = statusParts[0] == "HTTP/1.1" && !closes
        if status == 204 || status == 304 { reusable = persistent && body.isEmpty; return HTTP1Response(status: status, headers: headers) }
        if let transfer = headers["transfer-encoding"] {
            guard transfer.lowercased() == "chunked", headers["content-length"] == nil else { throw PairingError.invalidResponse }
            var cursor = 0; var decoded = Data(); var chunks = 0
            while true {
                guard let lineEnd = body.range(of: Data("\r\n".utf8), in: cursor..<body.count) else {
                    guard body.count - cursor < 8192, !eof else { throw PairingError.invalidResponse }; return nil
                }
                guard lineEnd.lowerBound - cursor < 8192,
                      let text = String(data: body[cursor..<lineEnd.lowerBound], encoding: .utf8),
                      let countText = text.split(separator: ";", maxSplits: 1).first,
                      let count = Int(countText, radix: 16), count >= 0, count <= limit - decoded.count else { throw PairingError.invalidResponse }
                cursor = lineEnd.upperBound; chunks += 1
                guard chunks <= 65536 else { throw PairingError.invalidResponse }
                if count == 0 {
                    // No trailers, or bounded trailers terminated by a blank line.
                    if body.count >= cursor + 2, body[cursor..<cursor + 2] == Data("\r\n".utf8) {
                        reusable = persistent && body.count == cursor + 2
                        return HTTP1Response(status: status, headers: headers, body: decoded)
                    }
                    if let end = body.range(of: Data("\r\n\r\n".utf8), in: cursor..<body.count), end.upperBound - cursor <= 32768 {
                        reusable = persistent && body.count == end.upperBound
                        return HTTP1Response(status: status, headers: headers, body: decoded)
                    }
                    guard body.count - cursor <= 32768, !eof else { throw PairingError.invalidResponse }; return nil
                }
                guard body.count >= cursor + count + 2 else { if eof { throw PairingError.invalidResponse }; return nil }
                guard body[cursor + count..<cursor + count + 2] == Data("\r\n".utf8) else { throw PairingError.invalidResponse }
                decoded.append(body[cursor..<cursor + count]); cursor += count + 2
            }
        }
        if let length = headers["content-length"] {
            guard let count = Int(length), count >= 0, count <= limit else { throw PairingError.invalidResponse }
            if body.count >= count {
                reusable = persistent && body.count == count
                return HTTP1Response(status: status, headers: headers, body: Data(body.prefix(count)))
            }
            if eof { throw PairingError.invalidResponse }; return nil
        }
        guard body.count <= limit else { throw PairingError.invalidResponse }
        return eof ? HTTP1Response(status: status, headers: headers, body: body) : nil
    }
}