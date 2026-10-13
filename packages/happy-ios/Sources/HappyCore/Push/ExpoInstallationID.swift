import Foundation

/// This installation's id, the Expo exchange's `deviceId`, in the Keychain
/// item expo-notifications keeps it in (`ServerRegistrationModule.swift`,
/// `getInstallationId`). The RN build created that item, so an upgrade
/// reads the same id and Expo keeps mapping this device to the same token.
/// An existing id is never replaced.
public struct ExpoInstallationID: Sendable {
    /// Both the Keychain account/generic key and the legacy defaults key.
    public static let key = ExpoPushTokenExchange.installationIdKey
    /// `kSecAttrAccessible` of the item Expo writes.
    public static let accessibility = KeychainAccessibility.afterFirstUnlockThisDeviceOnly

    private let backend: KeychainBackend
    private let legacyDefaults: KeyValueStore
    private let bundleIdentifier: String
    private let makeID: @Sendable () -> String

    /// `legacyDefaults` is `UserDefaults.standard`, where older Expo builds
    /// kept the id; `bundleIdentifier` is `Bundle.main.bundleIdentifier`.
    public init(backend: KeychainBackend, legacyDefaults: KeyValueStore, bundleIdentifier: String,
                makeID: @escaping @Sendable () -> String = { UUID().uuidString }) {
        self.backend = backend
        self.legacyDefaults = legacyDefaults
        self.bundleIdentifier = bundleIdentifier
        self.makeID = makeID
    }

    /// `keychainSearchQueryFor`: service is the bundle id, account and
    /// generic the key's UTF-8, no access group.
    public var query: KeychainItemQuery {
        let encodedKey = Data(Self.key.utf8)
        return KeychainItemQuery(service: bundleIdentifier, account: encodedKey, generic: encodedKey)
    }

    /// The stored id; otherwise the legacy default, moved into the Keychain
    /// and removed from defaults once saved; otherwise a new UUID, saved.
    /// Keychain errors are thrown, so a token exchange fails rather than
    /// sending an id that won't survive.
    public func read() throws -> String {
        // fetchStringWithQuery: bytes that aren't UTF-8 count as no item.
        if let data = try backend.copyData(query), let id = String(data: data, encoding: .utf8) {
            return id
        }
        if let legacy = legacyDefaults.string(forKey: Self.key) {
            try store(legacy)
            legacyDefaults.set(nil, forKey: Self.key)
            return legacy
        }
        let id = makeID()
        try store(id)
        return id
    }

    /// `storeStringWithQueries`: delete, then add; anything but a clean add
    /// fails.
    private func store(_ id: String) throws {
        backend.delete(query)
        guard try backend.add(query, data: Data(id.utf8), accessibility: Self.accessibility) == .added else {
            throw KeychainStatusError(-25299) // errSecDuplicateItem
        }
    }
}
