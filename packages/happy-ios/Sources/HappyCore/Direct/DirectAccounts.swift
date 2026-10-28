import Foundation
import HappyWire

/// Owns independent direct connections. Relay LocalStore, HappyAPI and
/// SyncEngine are never created for a direct device.
@MainActor
public final class DirectAccounts {
    public private(set) var accounts: [DirectAccount] = []
    public private(set) var activeID: String?
    public var onChange: (() -> Void)?
    private let storage: DirectAccountStorage
    private var credentials: [String: DirectDeviceCredentials] = [:]
    private var jobs: [String: Task<Void, Never>] = [:]
    private var generation: UInt64 = 0
    private var foreground = true
    private var loaded = false
    private var engines: [String: DirectSyncEngine] = [:]
    let makeTransport: @Sendable (DirectDeviceCredentials) -> any DirectTransport
    var refreshInterval: Duration = .seconds(60)

    public init(credentials: any DirectCredentialStore, directory: URL?, makeTransport: @escaping @Sendable (DirectDeviceCredentials) -> any DirectTransport = { TailcatHTTPTransport(address: $0.address, port: $0.port) }) {
        storage = DirectAccountStorage(credentials: credentials, directory: directory)
        self.makeTransport = makeTransport
    }

    public var active: DirectAccount? { accounts.first { $0.id == activeID } }

    /// A stable account lifetime, shared by Home, Settings and conversations.
    /// Construction performs no I/O; the actor opens SQLite off-main on start.
    public func syncEngine(for id: String) -> DirectSyncEngine? {
        if let engine = engines[id] { return engine }
        guard let client = agentClient(for: id) else { return nil }
        let engine = DirectSyncEngine(client: client, directory: StemCellsOfflineFile.directory(for: id))
        engines[id] = engine
        if foreground && activeID == id { Task { await engine.start() } }
        return engine
    }
    func credential(for id: String) -> DirectDeviceCredentials? { credentials[id] }
    func configureStorage(_ directory: URL?) async { await storage.configureDirectory(directory) }

    public func restore() async throws {
        guard !loaded else { return }
        let saved = try await storage.load()
        accounts = saved.accounts; activeID = saved.activeID; credentials = saved.credentials; loaded = true
        onChange?(); startConnections()
    }

    public func add(_ value: DirectDeviceCredentials, name: String) async throws -> DirectAccount {
        if !loaded { try await restore() }
        // Re-pairing the same device updates its existing entry; a newly
        // paired device receives its own ID even on the same installation.
        let id = credentials.first { $0.value.address == value.address && $0.value.deviceID == value.deviceID }?.key ?? "direct-\(UUID().uuidString.lowercased())"
        await stop(id)
        if let engine = engines.removeValue(forKey: id) { await engine.stop() }
        var account = DirectAccount(id: id, name: "Happy Agent")
        let transport = makeTransport(value)
        do { account = try await DirectIdentity.refresh(account, transport: transport, token: value.deviceToken) }
        catch DirectPairingError.revoked { await transport.close(); throw DirectPairingError.revoked }
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
        let transport = makeTransport(credential)
        defer { Task { await transport.close() } }
        // The transport names the body's type itself.
        let response = try await transport.request(method: "PATCH", path: "/v0/config", credential: credential.deviceToken, body: body, headers: [:])
        if response.status == 401 { throw DirectPairingError.revoked }
        guard response.status == 200 else {
            // The daemon's own words (an owner-only rename, a name it refuses).
            struct Failure: Decodable { let error: String?; let code: String? }
            let failure = try? JSONDecoder().decode(Failure.self, from: response.body)
            throw DirectAgentError.status(response.status, code: failure?.code, message: failure?.error)
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
        if let engine = engines.removeValue(forKey: id) { await engine.stop() }
        do { try await storage.remove(id) }
        catch { startConnections(); throw error }
        credentials.removeValue(forKey: id); accounts.removeAll { $0.id == id }
        // What Stem Cells kept to open on it offline goes with it.
        StemCellsOfflineFile.remove(id)
        if activeID == id { activeID = nil }
        onChange?()
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
            let make = makeTransport; let generation = generation; let interval = refreshInterval
            jobs[account.id] = Task.detached { [weak self] in
                var current = account
                var attempt = 0
                while !Task.isCancelled {
                    let transport = make(credential)
                    do {
                        current.status = attempt == 0 ? .connecting : .retrying
                        await self?.apply(current, generation: generation)
                        while !Task.isCancelled {
                            current = try await DirectIdentity.refresh(current, transport: transport, token: credential.deviceToken)
                            try Task.checkCancellation()
                            await self?.apply(current, generation: generation)
                            attempt = 0
                            try await Task.sleep(for: interval)
                        }
                    } catch DirectPairingError.revoked {
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

    private func apply(_ account: DirectAccount, generation: UInt64) async {
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