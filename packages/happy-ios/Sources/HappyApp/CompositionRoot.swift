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
        let account = NativeAccountFactory.make(
            version: version,
            directory: storeDirectory(),
            // No namespace on iOS: retain the exact RN-compatible items.
            backend: SecurityKeychainBackend(),
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

    /// Application Support/Happy, as a path only: nothing touches the disk
    /// on the main thread at launch. The accounts code creates it, and marks
    /// it excluded from backups, off the main thread when it first reads or
    /// writes there (everything in it can be pulled again from the server,
    /// and the keys to read it are device-only anyway).
    private static func storeDirectory() -> URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("Happy", isDirectory: true)
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
