import Foundation

// Credentials live in the very Keychain item the RN app's expo-secure-store
// uses, so an in-place upgrade (same bundle id) stays signed in and rolling
// back to an RN build still finds them. Everything here mirrors
// expo-secure-store 55.0.9, ios/SecureStoreModule.swift, with the options
// happy-app passes (none): service "app", requireAuthentication false,
// keychainAccessible WHEN_UNLOCKED, no access group.

/// The attributes that identify one generic-password item.
public struct KeychainItemQuery: Equatable, Hashable, Sendable {
    public var service: String
    /// expo stores the key's UTF-8 bytes in both account and generic.
    public var account: Data
    public var generic: Data

    public init(service: String, account: Data, generic: Data) {
        self.service = service
        self.account = account
        self.generic = generic
    }
}

public enum KeychainAccessibility: Equatable, Sendable {
    /// kSecAttrAccessibleWhenUnlocked, expo's default.
    case whenUnlocked
    /// kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, expo-notifications'
    /// installation id (`ExpoInstallationID`).
    case afterFirstUnlockThisDeviceOnly
}

public enum KeychainAddResult: Equatable, Sendable {
    case added
    case duplicate
}

public struct KeychainStatusError: Error, Equatable, Sendable {
    public var status: Int32

    public init(_ status: Int32) {
        self.status = status
    }
}

/// The four SecItem calls expo makes, behind a protocol so the item logic is
/// tested on Linux. Every query is a generic password with exactly the
/// query's service, account and generic, and no access group.
public protocol KeychainBackend: Sendable {
    /// SecItemCopyMatching with kSecReturnData and kSecMatchLimitOne. Nil
    /// when not found.
    func copyData(_ query: KeychainItemQuery) throws -> Data?
    /// SecItemAdd with kSecValueData and kSecAttrAccessible.
    func add(_ query: KeychainItemQuery, data: Data, accessibility: KeychainAccessibility) throws -> KeychainAddResult
    /// SecItemUpdate of kSecValueData only.
    func update(_ query: KeychainItemQuery, data: Data) throws
    /// SecItemDelete, ignoring the result, as expo does.
    func delete(_ query: KeychainItemQuery)
}

/// One expo-secure-store key: where it is read from, written to and
/// deleted from.
public struct SecureStoreItem: Equatable, Sendable {
    public static let defaultKeychainService = "app"

    public let key: String
    public let keychainService: String

    public init(key: String, keychainService: String = SecureStoreItem.defaultKeychainService) {
        self.key = key
        self.keychainService = keychainService
    }

    /// expo's `query(with:options:requireAuthentication:)`: the service
    /// gets ":auth" or ":no-auth", or nothing for items from before expo
    /// split them.
    public func query(requireAuthentication: Bool?) -> KeychainItemQuery {
        var service = keychainService
        if let requireAuthentication {
            service += requireAuthentication ? ":auth" : ":no-auth"
        }
        let encodedKey = Data(key.utf8)
        return KeychainItemQuery(service: service, account: encodedKey, generic: encodedKey)
    }

    /// `get`: no-auth, then auth, then legacy; the first found wins.
    public var readOrder: [KeychainItemQuery] {
        [query(requireAuthentication: false), query(requireAuthentication: true), query(requireAuthentication: nil)]
    }

    /// `set` with requireAuthentication false adds here.
    public var writeTarget: KeychainItemQuery {
        query(requireAuthentication: false)
    }

    /// After a successful add, `set` deletes the legacy and auth items so
    /// reads can't find a stale value first.
    public var supersededByWrite: [KeychainItemQuery] {
        [query(requireAuthentication: nil), query(requireAuthentication: true)]
    }

    /// `deleteValueWithKeyAsync`: legacy, auth, no-auth.
    public var deleteOrder: [KeychainItemQuery] {
        [query(requireAuthentication: nil), query(requireAuthentication: true), query(requireAuthentication: false)]
    }

    /// The stored string, or nil. Like expo, bytes that aren't UTF-8 read
    /// as nil, and any Keychain error other than not-found is thrown.
    public func read(from backend: KeychainBackend) throws -> String? {
        for query in readOrder {
            if let data = try backend.copyData(query) {
                return String(data: data, encoding: .utf8)
            }
        }
        return nil
    }

    public func write(_ value: String, to backend: KeychainBackend) throws {
        let data = Data(value.utf8)
        switch try backend.add(writeTarget, data: data, accessibility: .whenUnlocked) {
        case .added:
            supersededByWrite.forEach(backend.delete)
        case .duplicate:
            try backend.update(writeTarget, data: data)
        }
    }

    public func delete(from backend: KeychainBackend) {
        deleteOrder.forEach(backend.delete)
    }
}

/// TokenStorage's JSON: what `JSON.stringify({ token, secret })` produces,
/// byte for byte. Keys in that order, no whitespace, and `/` left alone,
/// which JSONEncoder would escape.
public enum CredentialsJSON {
    public static func encode(_ credentials: Credentials) -> String {
        "{\"token\":\(quote(credentials.token)),\"secret\":\(quote(credentials.secret))}"
    }

    /// Nil for anything TokenStorage would fail to parse into credentials.
    public static func decode(_ string: String) -> Credentials? {
        try? JSONDecoder().decode(Credentials.self, from: Data(string.utf8))
    }

    /// JSON.stringify's string quoting (ES2019): the short escapes, \u00XX
    /// in lowercase hex for other control characters, everything else as is.
    static func quote(_ string: String) -> String {
        var out = "\""
        for scalar in string.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case let control where control.value < 0x20:
                let hex = String(control.value, radix: 16)
                out += "\\u" + String(repeating: "0", count: 4 - hex.count) + hex
            default:
                out.unicodeScalars.append(scalar)
            }
        }
        return out + "\""
    }
}

/// The app's credential store: happy-app's `auth_credentials` item in
/// expo-secure-store's layout.
public struct SecureStoreCredentialStore: CredentialStore {
    /// TokenStorage's AUTH_KEY.
    public static let item = SecureStoreItem(key: "auth_credentials")

    private let backend: KeychainBackend

    public init(backend: KeychainBackend) {
        self.backend = backend
    }

    public func load() throws -> Credentials? {
        guard let json = try Self.item.read(from: backend) else { return nil }
        return CredentialsJSON.decode(json)
    }

    public func isEmpty() throws -> Bool {
        for query in Self.item.readOrder {
            if try backend.copyData(query) != nil { return false }
        }
        return true
    }

    public func save(_ credentials: Credentials) throws {
        try Self.item.write(CredentialsJSON.encode(credentials), to: backend)
    }

    public func clear() throws {
        Self.item.delete(from: backend)
    }
}

#if canImport(Security)
import Security

/// The real Keychain. Queries carry no access group, so they resolve to the
/// app's default group (team id + bundle id), the same one the RN build used.
public struct SecurityKeychainBackend: AccountKeychainBackend {
    public init() {}

    public func accounts(service: String) throws -> [String] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecMatchLimit as String: kSecMatchLimitAll,
            kSecReturnAttributes as String: kCFBooleanTrue,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess else { throw KeychainStatusError(status) }
        let items = result as? [[String: Any]] ?? []
        return items.compactMap { item in
            if let string = item[kSecAttrAccount as String] as? String { return string }
            if let data = item[kSecAttrAccount as String] as? Data { return String(data: data, encoding: .utf8) }
            return nil
        }
    }

    public func removeAccount(_ query: KeychainItemQuery) throws {
        let status = SecItemDelete(Self.attributes(query) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainStatusError(status) }
    }

    public func copyData(_ query: KeychainItemQuery) throws -> Data? {
        var attributes = Self.attributes(query)
        attributes[kSecMatchLimit as String] = kSecMatchLimitOne
        attributes[kSecReturnData as String] = kCFBooleanTrue
        var item: CFTypeRef?
        let status = SecItemCopyMatching(attributes as CFDictionary, &item)
        switch status {
        case errSecSuccess: return item as? Data
        case errSecItemNotFound: return nil
        default: throw KeychainStatusError(status)
        }
    }

    public func add(_ query: KeychainItemQuery, data: Data, accessibility: KeychainAccessibility) throws -> KeychainAddResult {
        var attributes = Self.attributes(query)
        attributes[kSecValueData as String] = data
        switch accessibility {
        case .whenUnlocked: attributes[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlocked
        case .afterFirstUnlockThisDeviceOnly: attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        }
        let status = SecItemAdd(attributes as CFDictionary, nil)
        switch status {
        case errSecSuccess: return .added
        case errSecDuplicateItem: return .duplicate
        default: throw KeychainStatusError(status)
        }
    }

    public func update(_ query: KeychainItemQuery, data: Data) throws {
        let status = SecItemUpdate(Self.attributes(query) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        guard status == errSecSuccess else { throw KeychainStatusError(status) }
    }

    public func delete(_ query: KeychainItemQuery) {
        SecItemDelete(Self.attributes(query) as CFDictionary)
    }

    static func attributes(_ query: KeychainItemQuery) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: query.service,
            kSecAttrGeneric as String: query.generic,
            kSecAttrAccount as String: query.account,
        ]
    }
}
#endif
