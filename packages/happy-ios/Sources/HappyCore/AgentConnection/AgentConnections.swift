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

    public init(credentials: any AgentConnectionCredentialStore, directory: URL?, makeTransport: @escaping @Sendable (AgentConnectionCredentials) -> any AgentTransport = { TailcatHTTPTransport(address: $0.address, port: $0.port) }) {
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
        MeteredAgentTransport(base: makeTransport(credential), metrics: meter(id))
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
    public func placeholderSeed(for id: String) -> String? { credentials[id].map { "agent:\($0.address)" } }
    func configureStorage(_ directory: URL?) async { await storage.configureDirectory(directory) }

    public func restore() async throws {
        guard !loaded else { return }
        let saved = try await storage.load(hiding: hidden)
        accounts = saved.accounts; activeID = saved.activeID; credentials = saved.credentials; loaded = true
        onChange?(); startConnections()
    }

    public func add(_ value: AgentConnectionCredentials, name: String) async throws -> AgentConnection {
        if !loaded { try await restore() }
        // Re-pairing the same device updates its existing entry; a newly
        // paired device receives its own ID even on the same installation.
        let id = credentials.first { $0.value.address == value.address && $0.value.deviceID == value.deviceID }?.key ?? "direct-\(UUID().uuidString.lowercased())"
        await stop(id)
        if let engine = engines[id] {
            await engine.stop()
            if engines[id] === engine { engines.removeValue(forKey: id) }
        }
        var account = AgentConnection(id: id, name: AgentName.friendly(name))
        let transport = transport(value, for: id)
        do { account = try await AgentIdentity.refresh(account, transport: transport, token: value.deviceToken) }
        catch PairingError.revoked { await transport.close(); throw PairingError.revoked }
        catch { }
        await transport.close()
        try Task.checkCancellation()
        try await storage.add(account, credentials: value)
        credentials[id] = value
        accounts.removeAll { $0.id == id }; accounts.append(account); activeID = id
        for (otherID, engine) in engines where otherID != id { await engine.pause() }
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
            let make = makeTransport, meter = meter(account.id); let generation = generation; let interval = refreshInterval
            jobs[account.id] = Task.detached { [weak self] in
                var current = account
                var attempt = 0
                while !Task.isCancelled {
                    let transport = MeteredAgentTransport(base: make(credential), metrics: meter)
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