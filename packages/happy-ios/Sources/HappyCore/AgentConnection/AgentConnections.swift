import Foundation
import HappyWire

/// Owns independent direct connections. Relay LocalStore, HappyAPI and
/// SyncEngine are never created for a direct device.
@MainActor
public final class AgentConnections {
    public private(set) var accounts: [AgentConnection] = []
    public private(set) var activeID: String?
    public var onChange: (() -> Void)?
    private let storage: AgentConnectionStorage
    private var credentials: [String: AgentConnectionCredentials] = [:]
    private var endpoints: [String: AgentEndpoint] = [:]
    /// Each signed-in server's bearer, shared by every transport to it.
    private var authorizations: [String: ServerAuthorization] = [:]
    /// What the token endpoint is reached through; tests replace it.
    var tokens = OAuthTokenClient()
    private var jobs: [String: Task<Void, Never>] = [:]
    private var generation: UInt64 = 0
    private var foreground = true
    private var loaded = false
    private var engines: [String: SyncEngine] = [:]
    private var selecting: Task<Void, Never>?
    /// Agents disconnected whose cleanup a kill interrupted: never listed
    /// again, while `finishRemoval` forgets them.
    var hidden: Set<String> = []
    let makeTransport: @Sendable (AgentConnectionCredentials) -> any AgentTransport
    var refreshInterval: Duration = .seconds(60)

    public init(credentials: any AgentConnectionCredentialStore, directory: URL?, makeTransport: @escaping @Sendable (AgentConnectionCredentials) -> any AgentTransport = { AgentHTTPTransport(address: $0.address, port: $0.port, publicUrl: $0.publicUrl, tailcatAvailable: $0.tailcatAvailable != false && ManagedSettings.current.allowsTailcat) }) {
        storage = AgentConnectionStorage(credentials: credentials, directory: directory)
        self.makeTransport = makeTransport
    }

    public var active: AgentConnection? { accounts.first { $0.id == activeID } }

    /// Each computer's traffic recorder, in memory while it is paired.
    private var meters: [String: ConnectionMetrics] = [:]

    /// The computer `id`'s recorder, nil once it is no longer paired.
    public func metrics(for id: String) -> ConnectionMetrics? {
        guard credentials[id] != nil else { return nil }
        return meter(id)
    }

    private func meter(_ id: String) -> ConnectionMetrics {
        if let meter = meters[id] { return meter }
        let meter = ConnectionMetrics()
        meters[id] = meter
        return meter
    }

    /// A transport to `id`'s computer that counts on its recorder.
    func transport(_ credential: AgentConnectionCredentials, for id: String) -> any AgentTransport {
        AgentEndpointTransport(endpoint: endpoint(credential, for: id), metrics: meter(id), make: maker(credential, for: id))
    }

    /// `makeTransport`, signing every request in for a signed-in server.
    private func maker(_ credential: AgentConnectionCredentials, for id: String) -> @Sendable (AgentConnectionCredentials) -> any AgentTransport {
        let make = makeTransport
        guard credential.signIn != nil else { return make }
        let authorization = authorization(credential, for: id), origin = credential.publicUrl ?? ""
        return { SignedInTransport(base: make($0), authorization: authorization, origin: origin) }
    }

    /// `id`'s bearer: created from its saved grant, with no access token
    /// yet, so the first request refreshes one.
    func authorization(_ credential: AgentConnectionCredentials, for id: String, access: OAuthAccess? = nil) -> ServerAuthorization {
        if let value = authorizations[id] { return value }
        let value = ServerAuthorization(grant: credential.signIn?.grant ?? OAuthGrant(clientId: ""), access: access, tokens: tokens) { [weak self] grant in
            try await self?.saveGrant(grant, for: id)
        }
        authorizations[id] = value
        return value
    }

    /// A rotated refresh token, saved over the old one.
    private func saveGrant(_ grant: OAuthGrant, for id: String) async throws {
        guard var value = credentials[id], value.signIn != nil, !hidden.contains(id) else { throw CancellationError() }
        value.signIn?.grant = grant
        try await storage.updateCredentials(value, id: id)
        credentials[id] = value
    }

    /// Whether `id` is a team server signed in to, rather than a pairing.
    public func isServer(_ id: String) -> Bool { credentials[id]?.signIn != nil }

    /// The origin of the signed-in server `id`.
    public func server(for id: String) -> String? { credentials[id]?.signIn != nil ? credentials[id]?.publicUrl : nil }

    private func endpoint(_ credential: AgentConnectionCredentials, for id: String) -> AgentEndpoint {
        if let value = endpoints[id] { return value }
        let value = AgentEndpoint(credential) { [weak self] next in
            guard let self else { throw CancellationError() }
            try await self.saveEndpoint(next, for: id)
        }
        endpoints[id] = value
        return value
    }

    private func saveEndpoint(_ value: AgentConnectionCredentials, for id: String) async throws {
        guard credentials[id]?.deviceToken == value.deviceToken, credentials[id]?.signIn == nil, !hidden.contains(id) else { throw CancellationError() }
        try await storage.updateCredentials(value, id: id)
        guard credentials[id]?.deviceToken == value.deviceToken, !hidden.contains(id) else { throw CancellationError() }
        credentials[id] = value
    }

    /// A stable account lifetime, shared by Home, Settings and conversations.
    /// Construction performs no I/O; the actor opens SQLite off-main on start.
    public func syncEngine(for id: String) -> SyncEngine? {
        if let engine = engines[id] { return engine }
        guard let client = agentClient(for: id) else { return nil }
        let engine = SyncEngine(client: client, directory: OfflineFile.directory(for: id))
        engines[id] = engine
        if foreground && activeID == id { Task { await engine.start() } }
        return engine
    }
    func credential(for id: String) -> AgentConnectionCredentials? { credentials[id] }
    /// What the connection's placeholder picture is picked by: its
    /// computer's address, the same on every phone paired with it.
    public func placeholderSeed(for id: String) -> String? { credentials[id].map { "agent:\($0.signIn == nil ? $0.address : $0.publicUrl ?? "")" } }
    func configureStorage(_ directory: URL?) async { await storage.configureDirectory(directory) }

    public func restore() async throws {
        guard !loaded else { return }
        let saved = try await storage.load(hiding: hidden)
        accounts = saved.accounts; activeID = saved.activeID; credentials = saved.credentials; loaded = true
        onChange?(); startConnections()
    }

    public func add(_ value: AgentConnectionCredentials, name: String) async throws -> AgentConnection {
        if !loaded { try await restore() }
        // Re-reading the same completed handshake updates its entry. A fresh
        // pairing has a new device ID and account, even on the same phone.
        let id = credentials.first { $0.value.address == value.address && $0.value.deviceID == value.deviceID && $0.value.deviceToken == value.deviceToken }?.key ?? "direct-\(UUID().uuidString.lowercased())"
        var account = AgentConnection(id: id, name: AgentName.friendly(name))
        // Initial identity precedes persistence. Discovery starts with the
        // regular authenticated refresh after the account has been stored.
        let transport = MeteredAgentTransport(base: makeTransport(value), metrics: meter(id))
        do { account = try await AgentIdentity.refresh(account, transport: transport, token: value.deviceToken) }
        catch PairingError.revoked { await transport.close(); throw PairingError.revoked }
        catch { }
        await transport.close()
        try Task.checkCancellation()
        // Re-reading the same completed handshake must not roll back a newer
        // discovered route or retire clients. Keep the old lifetime untouched
        // if identity validation or secure persistence fails.
        await stop(id)
        let savedCredentials = credentials[id] ?? value
        do { try await storage.add(account, credentials: savedCredentials) }
        catch { startConnections(); throw error }
        credentials[id] = savedCredentials
        accounts.removeAll { $0.id == id }; accounts.append(account); activeID = id
        for (otherID, engine) in engines where otherID != id { await engine.pause() }
        onChange?(); startConnections()
        return account
    }

    /// Adds the team server signed in to at `origin`, or signs an account
    /// already there in again: same origin and person, same account, its
    /// grant replaced and its revocation lifted. `access` is the token the
    /// sign-in just got, so nothing is refreshed straight away.
    public func addServer(_ origin: AgentOrigin, signIn: ServerSignInRecord, access: OAuthAccess, name: String) async throws -> AgentConnection {
        if !loaded { try await restore() }
        let value = AgentConnectionCredentials.server(origin, signIn: signIn)
        let id = credentials.first { $0.value.signIn != nil && $0.value.publicUrl == origin.value && $0.value.signIn?.userId == signIn.userId }?.key ?? "server-\(UUID().uuidString.lowercased())"
        var account = accounts.first { $0.id == id } ?? AgentConnection(id: id, name: AgentName.friendly(name))
        account.server = origin.value
        account.revoked = false
        account.status = .connecting
        await stop(id)
        try await storage.add(account, credentials: value)
        credentials[id] = value
        if let existing = authorizations[id] { await existing.replace(access: access, grant: signIn.grant) }
        else { _ = authorization(value, for: id, access: access) }
        accounts.removeAll { $0.id == id }; accounts.append(account); activeID = id
        // Every engine pauses; `select` starts this one again, an engine
        // that gave up when the old sign-in ended included.
        for engine in engines.values { await engine.pause() }
        onChange?(); startConnections()
        return account
    }

    public func select(_ id: String?) async throws {
        if !loaded { try await restore() }
        if let id, !accounts.contains(where: { $0.id == id }) { throw AccountSwitchError.unknownAccount }
        try await storage.select(id)
        activeID = id; onChange?()
        for (accountID, engine) in engines {
            if foreground && accountID == id { await engine.start() }
            else { await engine.pause() }
        }
    }

    /// Renames the computer (`PATCH /v0/config` `node.name`). The name shows
    /// here at once; the identity loop starts again from it, so a retry
    /// never puts the old one back.
    public func rename(_ id: String, to name: String) async throws {
        guard let credential = credentials[id] else { throw AccountSwitchError.unknownAccount }
        let body = try JSONSerialization.data(withJSONObject: ["node": ["name": name]])
        let transport = transport(credential, for: id)
        defer { Task { await transport.close() } }
        // The transport names the body's type itself.
        let response = try await transport.request(method: "PATCH", path: "/v0/config", credential: credential.deviceToken, body: body, headers: [:])
        if response.status == 401 { throw PairingError.revoked }
        guard response.status == 200 else {
            // The daemon's own words (an owner-only rename, a name it refuses).
            struct Failure: Decodable { let error: String?; let code: String? }
            let failure = try? JSONDecoder().decode(Failure.self, from: response.body)
            throw AgentClientError.status(response.status, code: failure?.code, message: failure?.error)
        }
        await stop(id)
        // Looked up after the wait: the list may have changed meanwhile.
        guard let index = accounts.firstIndex(where: { $0.id == id }) else { return }
        accounts[index].name = name
        onChange?()
        try? await storage.update(accounts[index])
        startConnections()
    }

    public func remove(_ id: String) async throws {
        // Await teardown before deleting credentials. The loop can no longer
        // publish or save an old identity after removal completes.
        await stop(id)
        await endpoints.removeValue(forKey: id)?.retire()
        if let authorization = authorizations.removeValue(forKey: id) { await authorization.signInRequired() }
        if let engine = engines[id] {
            await engine.stop()
            if engines[id] === engine { engines.removeValue(forKey: id) }
        }
        do { try await storage.remove(id) }
        catch { startConnections(); throw error }
        credentials.removeValue(forKey: id); accounts.removeAll { $0.id == id }; meters.removeValue(forKey: id)
        // What V2 kept to open on it offline goes with it.
        OfflineFile.remove(id)
        if activeID == id { activeID = nil }
        onChange?()
    }

    /// What `forget` took away, for its owner to stop off screen.
    public struct Teardown: Sendable {
        let id: String
        let job: Task<Void, Never>?
        let engine: SyncEngine?
    }

    /// Takes the agent off the list at once: no identity loop or engine of
    /// it says anything again, and it is no longer the one open. Nothing is
    /// awaited; `finishRemoval` stops what it ran and forgets what it kept.
    public func forget(_ id: String) -> Teardown? {
        guard accounts.contains(where: { $0.id == id }) else { return nil }
        let job = jobs.removeValue(forKey: id)
        job?.cancel()
        let engine = engines.removeValue(forKey: id)
        credentials.removeValue(forKey: id)
        if let endpoint = endpoints.removeValue(forKey: id) { Task { await endpoint.retire() } }
        if let authorization = authorizations.removeValue(forKey: id) { Task { await authorization.signInRequired() } }
        meters.removeValue(forKey: id)
        accounts.removeAll { $0.id == id }
        if activeID == id { activeID = nil }
        onChange?()
        return Teardown(id: id, job: job, engine: engine)
    }

    /// After `forget`, off screen: its credentials go first (`forget` made
    /// sure its loop can no longer publish or save anything of it); then
    /// the engine closes its database, waited for only so long when it is
    /// stuck on the network; then the folder, whose gate refuses any write
    /// still on its way. Also finishes one a kill interrupted, with nothing
    /// running.
    func finishRemoval(_ teardown: Teardown, limit: Duration = .seconds(10)) async throws {
        try await storage.remove(teardown.id)
        let job = teardown.job, engine = teardown.engine
        if job != nil || engine != nil {
            await waitAtMost(limit) {
                await job?.value
                await engine?.stop()
            }
        }
        let id = teardown.id
        await Task.detached(priority: .utility) { OfflineFile.remove(id) }.value
    }

    /// Opens `id` at once; the choice is saved and the engines started or
    /// paused after.
    func open(_ id: String?) {
        guard id.map({ id in accounts.contains { $0.id == id } }) ?? true else { return }
        activeID = id
        onChange?()
        selecting = Task { [previous = selecting] in
            await previous?.value
            try? await self.storage.select(id)
            guard self.activeID == id else { return }
            for (accountID, engine) in self.engines {
                if self.foreground && accountID == id { await engine.start() }
                else { await engine.pause() }
            }
        }
    }

    public func setForeground(_ active: Bool) async {
        foreground = active; generation &+= 1
        let pending = jobs; jobs.removeAll()
        pending.values.forEach { $0.cancel() }
        for job in pending.values { await job.value }
        guard foreground == active else { return }
        for (id, engine) in engines {
            guard foreground == active else { return }
            if active && id == activeID { await engine.start() }
            else { await engine.pause() }
        }
        guard foreground == active else { return }
        if active { startConnections() }
        else {
            for index in accounts.indices where !accounts[index].revoked { accounts[index].status = .paused }
            onChange?()
        }
    }

    private func stop(_ id: String) async {
        let job = jobs.removeValue(forKey: id)
        job?.cancel(); await job?.value
    }

    private func startConnections() {
        guard foreground else { return }
        for account in accounts where jobs[account.id] == nil && !account.revoked {
            guard let credential = credentials[account.id] else { continue }
            let make = maker(credential, for: account.id), meter = meter(account.id), endpoint = endpoint(credential, for: account.id); let generation = generation; let interval = refreshInterval
            jobs[account.id] = Task.detached { [weak self] in
                var current = account
                var attempt = 0
                while !Task.isCancelled {
                    let transport = AgentEndpointTransport(endpoint: endpoint, metrics: meter, make: make)
                    do {
                        current.status = attempt == 0 ? .connecting : .retrying
                        await self?.apply(current, generation: generation)
                        while !Task.isCancelled {
                            current = try await AgentIdentity.refresh(current, transport: transport, token: credential.deviceToken)
                            try Task.checkCancellation()
                            await self?.apply(current, generation: generation)
                            attempt = 0
                            try await Task.sleep(for: interval)
                        }
                    } catch PairingError.revoked {
                        current.revoked = true; current.status = .revoked
                        if !Task.isCancelled { await self?.apply(current, generation: generation) }
                        await transport.close()
                        return
                    } catch { }
                    await transport.close()
                    if Task.isCancelled { return }
                    current.status = .retrying
                    await self?.apply(current, generation: generation)
                    let delay = Self.retryDelay(attempt)
                    attempt = min(attempt + 1, 5)
                    do { try await Task.sleep(for: .seconds(delay)) } catch { return }
                }
            }
        }
    }

    nonisolated static func retryDelay(_ attempt: Int) -> Int { min(30, 1 << max(0, min(5, attempt))) }

    private func apply(_ account: AgentConnection, generation: UInt64) async {
        guard !Task.isCancelled, self.generation == generation,
              let index = accounts.firstIndex(where: { $0.id == account.id }) else { return }
        let previous = accounts[index]
        guard previous != account else { return }
        accounts[index] = account
        onChange?()
        // Status is transient. Persist identity and permanent revocation only.
        if previous.name != account.name || previous.avatar != account.avatar || previous.avatarETag != account.avatarETag || previous.thumbhash != account.thumbhash || previous.revoked != account.revoked {
            try? await storage.update(account)
        }
    }
}