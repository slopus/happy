import Foundation
import HappyCrypto

/// The one RN-compatible shared slot, or an account's secondary item.
public enum CredentialLocation: String, Codable, Sendable {
    case shared, own
}

/// Secondary items retain their server for registry recovery. This envelope
/// is never written to the RN item, whose byte layout stays unchanged.
public struct StoredAccountCredentials: Codable, Sendable {
    public var credentials: Credentials
    public var serverURL: URL

    public init(credentials: Credentials, serverURL: URL) {
        self.credentials = credentials
        self.serverURL = serverURL
    }
}

/// Enumerates and mutates credentials without copying the shared item.
/// A Keychain access failure throws instead of reporting an item as absent.
public protocol AccountCredentialStore: Sendable {
    func shared() throws -> Credentials?
    func sharedIsEmpty() throws -> Bool
    func ownAccounts() throws -> [String: StoredAccountCredentials]
    func save(_ value: StoredAccountCredentials, id: String, location: CredentialLocation) throws
    func remove(id: String, location: CredentialLocation) throws
}

/// Errors (such as a locked Keychain) must throw, never masquerade as missing accounts.
public protocol AccountKeychainBackend: KeychainBackend {
    func accounts(service: String) throws -> [String]
    func removeAccount(_ query: KeychainItemQuery) throws
}

/// RN credentials retain expo's layout; secondary credentials use the
/// happy-ios:account service with the anonymous id as their account key.
public struct KeychainAccountCredentialStore: AccountCredentialStore {
    public static let service = "happy-ios:account"
    private let backend: AccountKeychainBackend
    private let sharedStore: SecureStoreCredentialStore

    public init(backend: AccountKeychainBackend) {
        self.backend = backend
        sharedStore = SecureStoreCredentialStore(backend: backend)
    }

    public static func query(id: String) -> KeychainItemQuery {
        let bytes = Data(id.utf8)
        return KeychainItemQuery(service: service, account: bytes, generic: bytes)
    }

    public func shared() throws -> Credentials? { try sharedStore.load() }

    public func sharedIsEmpty() throws -> Bool {
        try sharedStore.isEmpty()
    }

    public func ownAccounts() throws -> [String: StoredAccountCredentials] {
        var values: [String: StoredAccountCredentials] = [:]
        for id in try backend.accounts(service: Self.service) {
            guard let data = try backend.copyData(Self.query(id: id)),
                  let value = try? JSONDecoder().decode(StoredAccountCredentials.self, from: data),
                  (try? accountID(value.credentials)) == id,
                  (try? ServerConfig.validate(value.serverURL.absoluteString)) != nil else { continue }
            values[id] = value
        }
        return values
    }

    public func save(_ value: StoredAccountCredentials, id: String, location: CredentialLocation) throws {
        guard try accountID(value.credentials) == id else { throw AccountSwitchError.unknownAccount }
        switch location {
        case .shared:
            if try !sharedIsEmpty(), (try shared()).flatMap({ try? accountID($0) }) != id {
                throw AccountSwitchError.sharedItemOccupied
            }
            try sharedStore.save(value.credentials)
        case .own:
            let query = Self.query(id: id)
            let data = try JSONEncoder().encode(value)
            if try backend.add(query, data: data, accessibility: .whenUnlocked) == .duplicate {
                try backend.update(query, data: data)
            }
        }
    }

    public func remove(id: String, location: CredentialLocation) throws {
        switch location {
        case .shared:
            guard (try shared()).flatMap({ try? accountID($0) }) == id else { return }
            try sharedStore.clear()
        case .own: try backend.removeAccount(Self.query(id: id))
        }
    }
}

func accountID(_ credentials: Credentials) throws -> String {
    guard let secret = credentials.secretData else { throw CryptoError.invalidInput("credentials secret") }
    return try AccountKeys(secret: secret).anonID
}

/// Compatibility for injected single-item stores; secondary values are held
/// in memory. Production always injects KeychainAccountCredentialStore.
public final class InMemoryAccountCredentialStore: AccountCredentialStore, @unchecked Sendable {
    private let sharedStore: CredentialStore
    private let lock = NSLock()
    private var values: [String: StoredAccountCredentials] = [:]

    public init(sharedStore: CredentialStore = InMemoryCredentialStore()) {
        self.sharedStore = sharedStore
    }

    public func shared() throws -> Credentials? {
        try sharedStore.load()
    }

    public func sharedIsEmpty() throws -> Bool {
        try sharedStore.isEmpty()
    }

    public func ownAccounts() throws -> [String: StoredAccountCredentials] {
        lock.withLock { values }
    }

    public func save(_ value: StoredAccountCredentials, id: String, location: CredentialLocation) throws {
        if location == .shared {
            if let existing = try shared(), (try? accountID(existing)) != id {
                throw AccountSwitchError.sharedItemOccupied
            }
            if try shared() == nil, try !sharedStore.isEmpty() {
                throw AccountSwitchError.sharedItemOccupied
            }
            try sharedStore.save(value.credentials)
        } else {
            lock.withLock { values[id] = value }
        }
    }

    public func remove(id: String, location: CredentialLocation) throws {
        if location == .shared {
            guard let existing = try shared(), (try? accountID(existing)) == id else { return }
            try sharedStore.clear()
        } else {
            _ = lock.withLock { values.removeValue(forKey: id) }
        }
    }
}
