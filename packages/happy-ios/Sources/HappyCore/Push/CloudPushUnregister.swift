import Foundation

/// A registration still to be taken off a computer the phone has
/// unpaired, with what the request needs once the pairing itself is gone:
/// the way to the computer and the pairing's device token. Unpairing on
/// the phone revokes nothing on the computer, so the token still names
/// this phone there until the computer's own device list drops it.
public struct PendingCloudPushUnregister: Codable, Equatable, Sendable {
    /// The pairing's, kept only until the computer answers.
    public var credentials: AgentConnectionCredentials
    public var registration: String
    public var version: String
    public var queuedAt: Date

    public init(credentials: AgentConnectionCredentials, registration: String, version: String, queuedAt: Date = Date()) {
        self.credentials = credentials
        self.registration = registration
        self.version = version
        self.queuedAt = queuedAt
    }
}

/// Where they wait across launches. Each holds a device token, so on a
/// phone it is a Keychain item of its own, never listed as a pairing.
public protocol CloudPushUnregisterStore: Sendable {
    func all() throws -> [String: PendingCloudPushUnregister]
    func save(_ value: PendingCloudPushUnregister, id: String) throws
    func remove(id: String) throws
}

/// Service `happy-ios:cloud-push-unregister`, account = the connection's
/// id. Readable while the phone is unlocked, as the pairing's own item is.
public struct KeychainCloudPushUnregisterStore: CloudPushUnregisterStore {
    public static let service = "happy-ios:cloud-push-unregister"
    private let backend: any AccountKeychainBackend
    public init(backend: any AccountKeychainBackend) { self.backend = backend }
    private func query(_ id: String) -> KeychainItemQuery {
        let data = Data(id.utf8)
        return KeychainItemQuery(service: Self.service, account: data, generic: data)
    }
    public func all() throws -> [String: PendingCloudPushUnregister] {
        var result: [String: PendingCloudPushUnregister] = [:]
        for id in try backend.accounts(service: Self.service) {
            guard let data = try backend.copyData(query(id)),
                  let value = try? JSONDecoder().decode(PendingCloudPushUnregister.self, from: data) else { continue }
            result[id] = value
        }
        return result
    }
    public func save(_ value: PendingCloudPushUnregister, id: String) throws {
        let data = try JSONEncoder().encode(value)
        if try backend.add(query(id), data: data, accessibility: .whenUnlocked) == .duplicate { try backend.update(query(id), data: data) }
    }
    public func remove(id: String) throws { try backend.removeAccount(query(id)) }
}

public final class InMemoryCloudPushUnregisterStore: CloudPushUnregisterStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: PendingCloudPushUnregister] = [:]
    public init() {}
    public func all() throws -> [String: PendingCloudPushUnregister] { lock.withLock { values } }
    public func save(_ value: PendingCloudPushUnregister, id: String) throws { lock.withLock { values[id] = value } }
    public func remove(id: String) throws { _ = lock.withLock { values.removeValue(forKey: id) } }
}
