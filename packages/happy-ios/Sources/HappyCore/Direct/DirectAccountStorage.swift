import Foundation
import HappyWire

public enum DirectConnectionStatus: String, Codable, Sendable {
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

public struct DirectAccount: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public var name: String
    public var avatar: Data?
    public var avatarETag: String?
    public var thumbhash: String?
    public var revoked: Bool = false
    public var status: DirectConnectionStatus = .paused
    public var addedAt: Date

    public init(id: String, name: String, addedAt: Date = Date()) {
        self.id = id; self.name = name; self.addedAt = addedAt
    }
}

public protocol DirectCredentialStore: Sendable {
    func all() throws -> [String: DirectDeviceCredentials]
    func save(_ credentials: DirectDeviceCredentials, id: String) throws
    func remove(id: String) throws
}

public struct KeychainDirectCredentialStore: DirectCredentialStore {
    public static let service = "happy-ios:direct-device"
    private let backend: any AccountKeychainBackend
    public init(backend: any AccountKeychainBackend) { self.backend = backend }
    private func query(_ id: String) -> KeychainItemQuery {
        let data = Data(id.utf8)
        return KeychainItemQuery(service: Self.service, account: data, generic: data)
    }
    public func all() throws -> [String: DirectDeviceCredentials] {
        var result: [String: DirectDeviceCredentials] = [:]
        for id in try backend.accounts(service: Self.service) {
            guard let data = try backend.copyData(query(id)),
                  let value = try? JSONDecoder().decode(DirectDeviceCredentials.self, from: data),
                  value.port > 0, !value.address.isEmpty, !value.deviceID.isEmpty,
                  CanonicalBase64URL.decode(value.deviceToken)?.count == 32 else { continue }
            result[id] = value
        }
        return result
    }
    public func save(_ credentials: DirectDeviceCredentials, id: String) throws {
        let data = try JSONEncoder().encode(credentials)
        if try backend.add(query(id), data: data, accessibility: .whenUnlocked) == .duplicate { try backend.update(query(id), data: data) }
    }
    public func remove(id: String) throws { try backend.removeAccount(query(id)) }
}

/// No direct secret is written to disk or to the RN-compatible item. Reading
/// all Keychain items must succeed before missing accounts are reconciled.
actor DirectAccountStorage {
    struct Registry: Codable { var accounts: [DirectAccount] = []; var activeID: String? }
    private let credentials: any DirectCredentialStore
    private var file: URL?
    private var registry = Registry()
    init(credentials: any DirectCredentialStore, directory: URL?) {
        self.credentials = credentials
        file = directory?.appendingPathComponent("direct-accounts.json")
    }
    func configureDirectory(_ directory: URL?) { file = directory?.appendingPathComponent("direct-accounts.json") }
    func load() throws -> (accounts: [DirectAccount], activeID: String?, credentials: [String: DirectDeviceCredentials]) {
        let values = try credentials.all()
        if let file, let data = try? Data(contentsOf: file), let saved = try? JSONDecoder().decode(Registry.self, from: data) { registry = saved }
        registry.accounts.removeAll { values[$0.id] == nil }
        for id in values.keys.sorted() where !registry.accounts.contains(where: { $0.id == id }) { registry.accounts.append(DirectAccount(id: id, name: "Happy Agent")) }
        if !registry.accounts.contains(where: { $0.id == registry.activeID }) { registry.activeID = nil }
        for index in registry.accounts.indices { registry.accounts[index].status = registry.accounts[index].revoked ? .revoked : .paused }
        try persist()
        return (registry.accounts, registry.activeID, values)
    }
    func add(_ account: DirectAccount, credentials value: DirectDeviceCredentials) throws {
        try credentials.save(value, id: account.id)
        registry.accounts.removeAll { $0.id == account.id }; registry.accounts.append(account)
        registry.activeID = account.id
        try persist()
    }
    func update(_ account: DirectAccount) throws {
        guard let index = registry.accounts.firstIndex(where: { $0.id == account.id }) else { return }
        registry.accounts[index] = account; try persist()
    }
    func select(_ id: String?) throws { registry.activeID = id; try persist() }
    func remove(_ id: String) throws {
        try credentials.remove(id: id)
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

public final class InMemoryDirectCredentialStore: DirectCredentialStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: DirectDeviceCredentials] = [:]
    public init() {}
    public func all() throws -> [String: DirectDeviceCredentials] { lock.withLock { values } }
    public func save(_ credentials: DirectDeviceCredentials, id: String) throws { lock.withLock { values[id] = credentials } }
    public func remove(id: String) throws { _ = lock.withLock { values.removeValue(forKey: id) } }
}