#if canImport(UIKit)
import Foundation
import HappyCore
import HappyUI
import UIKit

/// Builds the real dependencies: credentials in expo-secure-store's Keychain
/// item, the server setting and the account's local settings in their own
/// defaults suites, and account stores in Application Support.
@MainActor
enum CompositionRoot {
    static func makeContext(bundle: Bundle = .main) -> AppContext {
        let variant = AppVariant.current(bundle: bundle)
        let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
        let account = AccountController(
            serverConfig: ServerConfig(storage: UserDefaultsStore(suiteName: ServerConfig.storageSuite)),
            clientID: HappyClientID.make(version: version),
            // The RN app's own Keychain item, so upgrades stay signed in.
            credentialStore: SecureStoreCredentialStore(backend: SecurityKeychainBackend()),
            storeDirectory: storeDirectory(),
            localSettings: UserDefaultsStore(suiteName: LocalSettings.storageSuite),
            appState: {
                await MainActor.run {
                    UIApplication.shared.applicationState == .background ? "background" : "active"
                }
            }
        )
        return AppContext(account: account, variant: variant, version: version)
    }

    /// Application Support/Happy, excluded from backups: everything in it
    /// can be pulled again from the server, and the keys to read it are
    /// device-only anyway.
    private static func storeDirectory() -> URL? {
        let fileManager = FileManager.default
        guard let base = try? fileManager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true) else {
            return nil
        }
        var directory = base.appendingPathComponent("Happy", isDirectory: true)
        do {
            try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try directory.setResourceValues(values)
        } catch {
            return nil
        }
        return directory
    }
}
#endif
