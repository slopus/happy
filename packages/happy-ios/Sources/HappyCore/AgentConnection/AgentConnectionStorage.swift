import Foundation
import HappyWire

public enum ConnectionStatus: String, Codable, Sendable {
    case connecting, connected, retrying, paused, revoked
    public var title: String {
        switch self {
        case .connecting: "Connecting"
        case .connected: "Connected"
        case .retrying: "Reconnecting"
        case .paused: "Paused"
        case .revoked: "Pair again"
        }
    }
}

public struct AgentConnection: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public var name: String
    public var avatar: Data?
    public var avatarETag: String?
    public var thumbhash: String?
    public var revoked: Bool = false
    public var status: ConnectionStatus = .paused
    public var addedAt: Date
    /// The team server's origin when this is a sign-in, not a pairing. A
    /// revoked one needs signing in again rather than pairing.
    public var server: String? = nil
    /// The installation's health `instanceId`, once read: what an instance
    /// link (`happy://<instanceId>/…`) must name to open here. Older
    /// daemons have none.
    public var instanceId: String? = nil

    public init(id: String, name: String, addedAt: Date = Date()) {
        self.id = id; self.name = name; self.addedAt = addedAt
    }
}

public protocol AgentConnectionCredentialStore: Sendable {
    func all() throws -> [String: AgentConnectionCredentials]
    func save(_ credentials: AgentConnectionCredentials, id: String) throws
    func remove(id: String) throws
}

public struct KeychainAgentConnectionCredentialStore: AgentConnectionCredentialStore {
    public static let service = "happy-ios:direct-device"
    private let backend: any AccountKeychainBackend
    public init(backend: any AccountKeychainBackend) { self.backend = backend }
    private func query(_ id: String) -> KeychainItemQuery {
        let data = Data(id.utf8)
        return KeychainItemQuery(service: Self.service, account: data, generic: data)
    }
    public func all() throws -> [String: AgentConnectionCredentials] {
        var result: [String: AgentConnectionCredentials] = [:]
        for id in try backend.accounts(service: Self.service) {
            guard let data = try backend.copyData(query(id)),
                  let value = try? JSONDecoder().decode(AgentConnectionCredentials.self, from: data) else { continue }
            if value.signIn != nil {
                guard let url = value.publicUrl, (try? AgentOrigin(url)) != nil else { continue }
            } else {
                guard value.port > 0, !value.address.isEmpty, !value.deviceID.isEmpty,
                      CanonicalBase64URL.decode(value.deviceToken)?.count == 32 else { continue }
            }
            result[id] = value
        }
        return result
    }
    /// A team server's refresh token stays on this device and in this app:
    /// readable after the first unlock (so a refresh works in the
    /// background), never synced to iCloud Keychain, never restored to or
    /// migrated onto another device, and rewritten that way when an older
    /// item had looser protection.
    public func save(_ credentials: AgentConnectionCredentials, id: String) throws {
        let data = try JSONEncoder().encode(credentials)
        if credentials.signIn != nil {
            if try backend.add(query(id), data: data, accessibility: .afterFirstUnlockThisDeviceOnly) == .duplicate {
                try backend.update(query(id), data: data, accessibility: .afterFirstUnlockThisDeviceOnly)
            }
            return
        }
        if try backend.add(query(id), data: data, accessibility: .whenUnlocked) == .duplicate { try backend.update(query(id), data: data) }
    }
    public func remove(id: String) throws { try backend.removeAccount(query(id)) }
}

/// No direct secret is written to disk or to the RN-compatible item. Reading
/// all Keychain items must succeed before missing accounts are reconciled.
actor AgentConnectionStorage {
    struct Registry: Codable { var accounts: [AgentConnection] = []; var activeID: String? }
    private let credentials: any AgentConnectionCredentialStore
    private var file: URL?
    private var registry = Registry()
    private var read = false
    init(credentials: any AgentConnectionCredentialStore, directory: URL?) {
        self.credentials = credentials
        file = directory?.appendingPathComponent("direct-accounts.json")
    }
    func configureDirectory(_ directory: URL?) { file = directory?.appendingPathComponent("direct-accounts.json") }
    func load(hiding: Set<String> = []) throws -> (accounts: [AgentConnection], activeID: String?, credentials: [String: AgentConnectionCredentials]) {
        var values = try credentials.all().filter { !hiding.contains($0.key) }
        // The Keychain outlives the app; the registry beside it doesn't. A
        // credential with no registry is from an install since deleted,
        // whose computer may be long gone: a fresh install starts with
        // nothing paired, so it opens on linking a computer, not on one
        // that never answers.
        if let file, !values.isEmpty, !FileManager.default.fileExists(atPath: file.path) {
            for id in values.keys { try credentials.remove(id: id) }
            values = [:]
        }
        if let file, let data = try? Data(contentsOf: file), let saved = try? JSONDecoder().decode(Registry.self, from: data) { registry = saved }
        read = true
        registry.accounts.removeAll { values[$0.id] == nil }
        for id in values.keys.sorted() where !registry.accounts.contains(where: { $0.id == id }) { registry.accounts.append(AgentConnection(id: id, name: AgentName.fallback)) }
        if !registry.accounts.contains(where: { $0.id == registry.activeID }) { registry.activeID = nil }
        for index in registry.accounts.indices { registry.accounts[index].status = registry.accounts[index].revoked ? .revoked : .paused }
        try persist()
        return (registry.accounts, registry.activeID, values)
    }
    func add(_ account: AgentConnection, credentials value: AgentConnectionCredentials) throws {
        try credentials.save(value, id: account.id)
        registry.accounts.removeAll { $0.id == account.id }; registry.accounts.append(account)
        registry.activeID = account.id
        try persist()
    }
    func update(_ account: AgentConnection) throws {
        guard let index = registry.accounts.firstIndex(where: { $0.id == account.id }) else { return }
        registry.accounts[index] = account; try persist()
    }
    func updateCredentials(_ value: AgentConnectionCredentials, id: String) throws {
        guard registry.accounts.contains(where: { $0.id == id }) else { throw CancellationError() }
        try credentials.save(value, id: id)
    }
    func select(_ id: String?) throws { registry.activeID = id; try persist() }
    /// `id`'s saved credentials, nil without them.
    func saved(_ id: String) -> AgentConnectionCredentials? { try? credentials.all()[id] }

    func remove(_ id: String) throws {
        try credentials.remove(id: id)
        // A removal finished at launch can come before `load`: the saved
        // list is read first, so writing it back drops only this one.
        if !read, let file, let data = try? Data(contentsOf: file), let saved = try? JSONDecoder().decode(Registry.self, from: data) { registry = saved }
        read = true
        registry.accounts.removeAll { $0.id == id }
        if registry.activeID == id { registry.activeID = nil }
        // The Keychain deletion is authoritative; a later metadata write
        // failure cannot make the removed credential reappear at recovery.
        try? persist()
    }
    private func persist() throws {
        guard let file else { return }
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(registry).write(to: file, options: .atomic)
    }
}

public final class InMemoryAgentConnectionCredentialStore: AgentConnectionCredentialStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: AgentConnectionCredentials] = [:]
    public init() {}
    public func all() throws -> [String: AgentConnectionCredentials] { lock.withLock { values } }
    public func save(_ credentials: AgentConnectionCredentials, id: String) throws { lock.withLock { values[id] = credentials } }
    public func remove(id: String) throws { _ = lock.withLock { values.removeValue(forKey: id) } }
}