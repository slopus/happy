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
            accountCredentialStore: KeychainAccountCredentialStore(backend: SecurityKeychainBackend()),
            localSettingsFactory: { UserDefaultsStore(suiteName: LocalSettings.storageSuite(accountID: $0)) },
            appState: {
                await MainActor.run {
                    UIApplication.shared.applicationState == .background ? "background" : "active"
                }
            },
            deliveryActivity: { active in
                await MainActor.run {
                    if active { DeliveryLease.shared.acquire() } else { DeliveryLease.shared.release() }
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
/// One background task for however many sends are in flight, so a send
/// that started in the foreground can finish after the app is backgrounded.
/// New sends don't start while backgrounded (`SyncEngine.setBackgrounded`).
@MainActor
final class DeliveryLease {
    static let shared = DeliveryLease()
    private var count = 0
    private var task: UIBackgroundTaskIdentifier = .invalid

    func acquire() {
        count += 1
        guard task == .invalid else { return }
        task = UIApplication.shared.beginBackgroundTask(withName: "happy.delivery") { [weak self] in
            // Out of time: iOS ends the task; the outbox retries the send
            // on the next launch or foreground.
            self?.end()
        }
    }

    func release() {
        count = max(0, count - 1)
        if count == 0 { end() }
    }

    private func end() {
        guard task != .invalid else { return }
        UIApplication.shared.endBackgroundTask(task)
        task = .invalid
    }
}
#endif
