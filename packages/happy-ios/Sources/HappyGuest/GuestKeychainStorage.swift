#if canImport(Security)
import Foundation
import Security

public struct GuestKeychainStorage: GuestSecretStorage {
    public init() {}

    public struct Failure: Error { public let status: OSStatus }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "happy-ios:bot-guest",
         kSecAttrAccount as String: "scoped-sessions"]
    }

    public func read() throws -> Data? {
        var query = self.query
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        let result = SecItemCopyMatching(query as CFDictionary, &value)
        if result == errSecItemNotFound { return nil }
        guard result == errSecSuccess else { throw Failure(status: result) }
        guard let data = value as? Data else { throw Failure(status: errSecDecode) }
        return data
    }

    public func write(_ data: Data) throws {
        let values: [String: Any] = [kSecValueData as String: data,
                                     kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var result = SecItemUpdate(query as CFDictionary, values as CFDictionary)
        if result == errSecItemNotFound {
            result = SecItemAdd(query.merging(values) { _, value in value } as CFDictionary, nil)
        }
        guard result == errSecSuccess else { throw Failure(status: result) }
    }

    public func delete() throws {
        let result = SecItemDelete(query as CFDictionary)
        guard result == errSecSuccess || result == errSecItemNotFound else { throw Failure(status: result) }
    }
}
#endif