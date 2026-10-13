import Foundation
import HappyCrypto
import HappyWire

/// JSON values sealed with a record's data encryption key (AES-256-GCM).
/// Session metadata, agent state, messages, machine metadata and daemon
/// state all use this, each with its own record's key.
public struct RecordCipher: Sendable {
    private let key: Data

    public init(key: Data) {
        self.key = key
    }

    public func decrypt(base64: String) -> JSONValue? {
        guard let bundle = Base64.decode(base64), let plaintext = AESGCMBundle.open(bundle, key: key) else { return nil }
        return try? JSONValue.decode(plaintext)
    }

    public func encrypt(_ value: JSONValue, random: RandomSource = SystemRandom()) throws -> String {
        Base64.encode(try AESGCMBundle.seal(value.encoded(), key: key, random: random))
    }

    public func encrypt(bytes: Data, random: RandomSource = SystemRandom()) throws -> String {
        Base64.encode(try AESGCMBundle.seal(bytes, key: key, random: random))
    }
}

/// Account-level JSON (settings), sealed with secretbox under the account
/// secret, as `encryptRaw`/`decryptRaw` in happy-app do. This belongs to the
/// account, not to a record, so it is not the legacy record path.
public struct AccountCipher: Sendable {
    private let secret: Data

    public init(secret: Data) {
        self.secret = secret
    }

    public func decrypt(base64: String) -> JSONValue? {
        guard let bundle = Base64.decode(base64), let plaintext = SecretBox.openBundle(bundle, key: secret) else { return nil }
        return try? JSONValue.decode(plaintext)
    }

    public func encrypt(_ value: JSONValue, random: RandomSource = SystemRandom()) throws -> String {
        Base64.encode(try SecretBox.sealBundle(value.encoded(), key: secret, random: random))
    }
}

/// Unwrapped data keys, kept in memory only. Keyed by the wrapped key as the
/// server stores it, so the same key is opened once per launch.
public final class KeyRing: @unchecked Sendable {
    private let keys: AccountKeys
    private var ciphers: [String: RecordCipher] = [:]
    private var failures: Set<String> = []
    private let lock = NSLock()

    public init(keys: AccountKeys) {
        self.keys = keys
    }

    public func blobKey(wrappedKey: String?) -> Data? {
        guard let wrappedKey, let dataKey = keys.unwrapDataKey(base64: wrappedKey) else { return nil }
        return BlobCipher.sessionKey(dataKey: dataKey)
    }

    /// Opens only a wrapped record data key; never returns the account secret.
    public func dataKey(wrappedKey: String?) -> Data? {
        guard let wrappedKey else { return nil }
        return keys.unwrapDataKey(base64: wrappedKey)
    }

    /// Nil when there is no key (a legacy record) or it does not open.
    public func cipher(wrappedKey: String?) -> RecordCipher? {
        guard let wrappedKey else { return nil }
        lock.lock()
        defer { lock.unlock() }
        if let cipher = ciphers[wrappedKey] { return cipher }
        if failures.contains(wrappedKey) { return nil }
        guard let key = keys.unwrapDataKey(base64: wrappedKey) else {
            failures.insert(wrappedKey)
            return nil
        }
        let cipher = RecordCipher(key: key)
        ciphers[wrappedKey] = cipher
        return cipher
    }
}
