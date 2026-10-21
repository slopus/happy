import Foundation
import HappyCrypto

/// What a signed-in device holds: a server token and the account secret.
/// Stored exactly as the RN app's TokenStorage stores it; see
/// `SecureStoreCredentialStore`.
public struct Credentials: Codable, Equatable, Sendable {
    public var token: String
    /// The 32-byte account secret. happy-app writes base64url without
    /// padding, but a key pasted on its manual restore screen is stored as
    /// typed, so reads accept padded and standard base64 too.
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

/// Where the signed-in account's credentials live. The app uses
/// `SecureStoreCredentialStore`; tests use `InMemoryCredentialStore`.
public protocol CredentialStore: Sendable {
    func load() throws -> Credentials?
    /// Distinguishes an empty slot from an occupied item that this version
    /// cannot parse. Keychain stores inspect raw presence for this check.
    func isEmpty() throws -> Bool
    func save(_ credentials: Credentials) throws
    func clear() throws
}

public extension CredentialStore {
    func isEmpty() throws -> Bool { try load() == nil }
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
