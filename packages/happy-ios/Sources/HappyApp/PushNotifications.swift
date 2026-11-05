#if canImport(UIKit)
import Foundation
import HappyCore
import HappyUI
import UIKit
import UserNotifications

/// Push notifications as happy-app has them on an iPhone: the active
/// account registers this device's Expo token when its session starts and
/// whenever the app becomes active, a push in the foreground only badges
/// and lists, and a tap opens its session. Switching accounts never
/// unregisters, so every signed-in account keeps notifying; sign-out
/// unregisters that account (`AccountController.signOut(accountID:)`).
@MainActor
final class PushNotifications: NSObject {
    static let shared = PushNotifications()

    /// Fed by AppDelegate's registration callbacks.
    let apns = APNsTokenSource {
        await MainActor.run { UIApplication.shared.registerForRemoteNotifications() }
    }
    private var context: AppContext?
    private weak var coordinator: AppCoordinator?
    private var accountsObservation: AccountsObservation?
    /// The active session and its registration, rebuilt on every account
    /// change so the token cache is that account's `LocalSettings`.
    private var active: (session: AccountSession, registration: TokenPushRegistration)?
    private var filter = NotificationResponseFilter()
    /// A tap delivered before the scene's coordinator exists.
    private var pendingSessionID: String?

    private lazy var source: ExpoDevicePushTokenSource = {
        let bundle = Bundle.main
        let bundleID = bundle.bundleIdentifier ?? ""
        let profile = bundle.url(forResource: "embedded", withExtension: "mobileprovision").flatMap { try? Data(contentsOf: $0) }
        let apns = self.apns
        return ExpoDevicePushTokenSource(
            transport: URLSessionTransport(),
            installationID: ExpoInstallationID(backend: SecurityKeychainBackend(), legacyDefaults: StandardDefaults(), bundleIdentifier: bundleID),
            development: ProvisioningProfile.usesDevelopmentAPNs(profile),
            appId: bundleID,
            deviceToken: { try await apns.token() }
        )
    }()

    private lazy var sync = PushTokenSync(
        permissions: .init(current: { await Self.permission() }, request: { await Self.requestPermission() }),
        target: { [weak self] in await MainActor.run { self?.target } }
    )

    /// From `application(_:didFinishLaunchingWithOptions:)`: UIKit delivers
    /// the launching tap only to a delegate set before launch finishes.
    func install() {
        UNUserNotificationCenter.current().delegate = self
    }

    /// From the scene, once its coordinator has started.
    func attach(context: AppContext, coordinator: AppCoordinator) {
        self.context = context
        self.coordinator = coordinator
        accountsObservation = context.account.observeAccounts { [weak self] _ in
            self?.accountsChanged()
        }
        if let sessionId = pendingSessionID {
            pendingSessionID = nil
            coordinator.openSession(fromNotification: sessionId)
        }
    }

    /// sync.ts: every app-became-active invalidates `pushTokenSync`.
    func appBecameActive() {
        let sync = self.sync
        Task { await sync.invalidate() }
    }

    func didRegister(_ deviceToken: Data) {
        let apns = self.apns
        Task { await apns.didRegister(deviceToken) }
    }

    func didFail(_ error: any Error) {
        let apns = self.apns
        Task { await apns.didFail(error) }
    }

    /// A response from the delegate or from the scene's launch options;
    /// the filter drops the second delivery of the same request.
    func handle(_ response: UNNotificationResponse) {
        let tap = Self.tap(response)
        route(tap)
    }

    private func route(_ tap: Tap) {
        guard filter.shouldRoute(requestIdentifier: tap.identifier, isDefaultAction: tap.isDefaultAction),
              let sessionId = tap.sessionId else { return }
        if let coordinator {
            coordinator.openSession(fromNotification: sessionId)
        } else {
            pendingSessionID = sessionId
        }
    }

    /// The account's session started: a sign-in, a restore, a switch, or
    /// the next account taking over after a sign-out. Profile updates of
    /// the same session change nothing.
    private func accountsChanged() {
        let session = context?.account.session
        guard session !== active?.session else { return }
        if let context, let session {
            active = (session, TokenPushRegistration(source: source, cache: context.account.localSettings))
        } else {
            active = nil
        }
        SettingsHooks.pushRegistration = active?.registration
        if active != nil {
            let sync = self.sync
            Task { await sync.invalidate() }
        }
    }

    private var target: PushTokenSync.Target? {
        active.map { PushTokenSync.Target(registration: $0.registration, api: $0.session.api) }
    }

    // MARK: Permission

    /// expo-notifications `getPermissionsAsync`, normalized as
    /// pushRegistration.ts does.
    nonisolated private static func permission() async -> PushPermission {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .denied: return PushPermission(system: .denied)
        case .authorized: return PushPermission(system: .authorized)
        case .provisional: return PushPermission(system: .provisional)
        case .ephemeral: return PushPermission(system: .ephemeral)
        case .notDetermined: return PushPermission(system: .notDetermined)
        @unknown default: return PushPermission(system: .notDetermined)
        }
    }

    /// `requestPermissionsAsync()` with expo's default options.
    nonisolated private static func requestPermission() async -> PushPermission {
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
        return await permission()
    }

    // MARK: Responses

    /// What routing needs from a response, read where it arrives.
    struct Tap: Sendable {
        var identifier: String
        var isDefaultAction: Bool
        var sessionId: String?
    }

    nonisolated static func tap(_ response: UNNotificationResponse) -> Tap {
        let request = response.notification.request
        let data = NotificationRouting.data(userInfo: request.content.userInfo, isRemote: request.trigger is UNPushNotificationTrigger)
        return Tap(
            identifier: request.identifier,
            isDefaultAction: response.actionIdentifier == UNNotificationDefaultActionIdentifier,
            sessionId: NotificationRouting.sessionId(fromData: data)
        )
    }

    nonisolated static func options(_ presentation: NotificationPresentation) -> UNNotificationPresentationOptions {
        var options: UNNotificationPresentationOptions = []
        if presentation.banner { options.insert(.banner) }
        if presentation.list { options.insert(.list) }
        if presentation.sound { options.insert(.sound) }
        if presentation.badge { options.insert(.badge) }
        return options
    }
}

extension PushNotifications: UNUserNotificationCenterDelegate {
    /// `setNotificationHandler`: quiet in the foreground, in full otherwise.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        let active = await MainActor.run { UIApplication.shared.applicationState == .active }
        return Self.options(NotificationPresentation.forApp(active: active))
    }

    /// `addNotificationResponseReceivedListener`, and on a cold launch the
    /// response `getLastNotificationResponseAsync` returns.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let tap = Self.tap(response)
        await MainActor.run { self.route(tap) }
    }
}

/// `UserDefaults.standard`, where older Expo builds kept the installation id.
private struct StandardDefaults: KeyValueStore {
    func string(forKey key: String) -> String? {
        UserDefaults.standard.string(forKey: key)
    }

    func set(_ value: String?, forKey key: String) {
        if let value {
            UserDefaults.standard.set(value, forKey: key)
        } else {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }
}
#endif
