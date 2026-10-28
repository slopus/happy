import Foundation

/// Platform boundary shared by the UIKit and AppKit entry points. UI lifecycle
/// callbacks are injected; networking, Keychain policy and account storage are
/// composed here, without importing either UI framework.
@MainActor
public enum NativeAccountFactory {
    public static func make(
        version: String,
        directory: URL?,
        backend: any AccountKeychainBackend,
        defaultsNamespace: String? = nil,
        importLegacyServer: @escaping @Sendable () -> ImportedAccountServer = { RNServerConfigImporter.readFromDocuments() },
        appState: @escaping @Sendable () async -> String = AccountSession.Dependencies.alwaysActive,
        deliveryActivity: @escaping @Sendable (Bool) async -> Void = AccountSession.Dependencies.noDeliveryActivity
    ) -> AccountController {
        func suite(_ name: String) -> String { defaultsNamespace.map { "\($0).\(name)" } ?? name }
        return AccountController(
            serverConfig: ServerConfig(storage: UserDefaultsStore(suiteName: suite(ServerConfig.storageSuite))),
            clientID: HappyClientID.make(version: version),
            credentialStore: SecureStoreCredentialStore(backend: backend),
            storeDirectory: directory,
            localSettings: UserDefaultsStore(suiteName: suite(LocalSettings.storageSuite)),
            accountCredentialStore: KeychainAccountCredentialStore(backend: backend),
            directCredentialStore: KeychainDirectCredentialStore(backend: backend),
            rnServerImport: importLegacyServer,
            localSettingsFactory: { UserDefaultsStore(suiteName: suite(LocalSettings.storageSuite(accountID: $0))) },
            appState: appState,
            deliveryActivity: deliveryActivity
        )
    }
}

/// Native macOS uses an isolated service namespace, not the iPhone's Expo
/// item or another Happy desktop variant's credentials. The underlying
/// backend still performs exactly the existing, tested Keychain operations.
public struct NamespacedKeychainBackend: AccountKeychainBackend {
    private let base: any AccountKeychainBackend
    private let namespace: String

    public init(base: any AccountKeychainBackend, namespace: String) {
        self.base = base
        self.namespace = namespace
    }

    private func query(_ query: KeychainItemQuery) -> KeychainItemQuery {
        var result = query
        result.service = "\(namespace):\(query.service)"
        return result
    }
    public func copyData(_ query: KeychainItemQuery) throws -> Data? { try base.copyData(self.query(query)) }
    public func add(_ query: KeychainItemQuery, data: Data, accessibility: KeychainAccessibility) throws -> KeychainAddResult {
        try base.add(self.query(query), data: data, accessibility: accessibility)
    }
    public func update(_ query: KeychainItemQuery, data: Data) throws { try base.update(self.query(query), data: data) }
    public func delete(_ query: KeychainItemQuery) { base.delete(self.query(query)) }
    public func accounts(service: String) throws -> [String] { try base.accounts(service: "\(namespace):\(service)") }
    public func removeAccount(_ query: KeychainItemQuery) throws { try base.removeAccount(self.query(query)) }
}