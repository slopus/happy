import Foundation
import HappyCrypto
#if canImport(Security)
import Security
#endif

/// What a signed-in device holds: a server token and the account secret.
/// Encoded the same way the RN app's TokenStorage writes it, so the JSON is
/// interchangeable: `{"token": "...", "secret": "<base64url>"}`.
public struct Credentials: Codable, Equatable, Sendable {
    public var token: String
    /// The 32-byte account secret, base64url without padding.
    public var secret: String

    public init(token: String, secret: String) {
        self.token = token
        self.secret = secret
    }

    public init(token: String, secret: Data) {
        self.init(token: token, secret: Base64.encodeURL(secret))
    }

    public var secretData: Data? {
        guard let data = Base64.decodeURL(secret), data.count == 32 else { return nil }
        return data
    }
}

public protocol CredentialStore: Sendable {
    func load() throws -> Credentials?
    func save(_ credentials: Credentials) throws
    func clear() throws
}

public final class InMemoryCredentialStore: CredentialStore, @unchecked Sendable {
    private var credentials: Credentials?
    private let lock = NSLock()

    public init(_ credentials: Credentials? = nil) {
        self.credentials = credentials
    }

    public func load() throws -> Credentials? {
        lock.lock()
        defer { lock.unlock() }
        return credentials
    }

    public func save(_ credentials: Credentials) throws {
        lock.lock()
        defer { lock.unlock() }
        self.credentials = credentials
    }

    public func clear() throws {
        lock.lock()
        defer { lock.unlock() }
        credentials = nil
    }
}

#if canImport(Security)
public enum KeychainError: Error, Equatable, Sendable {
    case status(Int32)
}

/// Credentials in the Keychain, readable after the first unlock so sync can
/// run in the background, and never synced to other devices: the account
/// secret only moves between devices through explicit device linking.
public struct KeychainCredentialStore: CredentialStore {
    /// Same key name as the RN app's TokenStorage. Reading the RN app's
    /// item on an in-place upgrade also needs expo-secure-store's service
    /// naming, which is not matched yet (see AGENTS.md, open questions).
    public static let account = "auth_credentials"

    private let service: String

    public init(service: String) {
        self.service = service
    }

    public func load() throws -> Credentials? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else { throw KeychainError.status(status) }
        return try JSONDecoder().decode(Credentials.self, from: data)
    }

    public func save(_ credentials: Credentials) throws {
        let data = try JSONEncoder().encode(credentials)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(baseQuery() as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var query = baseQuery()
            query.merge(attributes) { _, new in new }
            let addStatus = SecItemAdd(query as CFDictionary, nil)
            guard addStatus == errSecSuccess else { throw KeychainError.status(addStatus) }
        } else if status != errSecSuccess {
            throw KeychainError.status(status)
        }
    }

    public func clear() throws {
        let status = SecItemDelete(baseQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError.status(status) }
    }

    private func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: Self.account,
        ]
    }
}
#endif
