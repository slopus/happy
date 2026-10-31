#if canImport(UIKit)
import HappyCore
import HappyCrypto
import HappyLayout
import HappyStore
import HappyWire
import UIKit
import UserNotifications

/// A Happy account's Account page in Settings, in settings' cards: who the
/// account is (its name, IDs and server, an ID copied by a tap), whether
/// it shares usage data, and this phone's push notifications with every
/// token registered on the account. What the old Settings › Account had
/// and isn't here moved: switching, adding and signing out to the
/// accounts card and Sign out, the key and Link New Device to
/// `BackupSettingsViewController`; connected services are gone.
final class AccountSettingsViewController: SettingsPageViewController {
    private let context: AppContext
    private let session: AccountSession
    private var observation: StoreObservation?
    private var snapshot = SettingsSnapshot()
    private var pushTokens: [PushToken] = []
    private var pushPermission: PushPermission?
    private var currentPushToken: String?
    private var loadingPush = false
    private var busy = false
    /// Tests stand in for the system's prompt and the server.
    var loadsPush = true

    init(context: AppContext, session: AccountSession) {
        self.context = context
        self.session = session
        super.init(title: Strings.Settings.account)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        observation = session.store.observeSettings { [weak self] snapshot in
            guard let self, self.snapshot != snapshot else { return }
            self.snapshot = snapshot
            reload()
        }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // As account.tsx's focus effect: read again every time it shows.
        if loadsPush { loadPush() }
    }

    override func makeRows() -> [[SettingsRow]] {
        typealias Row = SettingsRow
        typealias Text = Strings.SettingsAccount
        let anonID = session.keys.anonID
        let serverID = session.serverID
        var info: [Row] = []
        if let name = snapshot.profile?.displayName {
            info.append(Row(id: "account-name", title: Text.name, value: name, accessory: .none))
        }
        if let username = context.account.accounts.first(where: { $0.id == anonID })?.username {
            info.append(Row(id: "account-username", title: Strings.BackupRestore.username, value: "@\(username)", accessory: .none))
        }
        info += [
            Row(id: "analytics-id", title: Text.anonymousId, value: anonID, accessory: .none, action: { [weak self] in self?.copy(anonID, label: Text.anonymousId) }),
            Row(id: "public-id", title: Text.publicId, value: serverID ?? Text.notAvailable, accessory: .none, action: serverID.map { id in { [weak self] in self?.copy(id, label: Text.publicId) } }),
            Row(id: "server", title: Strings.BackupRestore.server, value: activeServerHost(context) ?? Strings.BackupRestore.defaultServer, accessory: .none, footer: Strings.BackupRestore.copyID),
        ]
        let optOut = AccountSettings(snapshot).analyticsOptOut
        let privacy = [Row(id: "analytics", title: Text.analytics, icon: ("analytics-outline", .blue), accessory: .toggle, isOn: !optOut, toggled: { [weak self] on in
            self?.session.updateSettings(["analyticsOptOut": .bool(!on)])
        }, footer: Text.privacyDescription)]
        return [info, privacy] + pushCards()
    }

    // MARK: Push notifications

    private func pushCards() -> [[SettingsRow]] {
        typealias Row = SettingsRow
        let permission = [
            Row(id: "push-permission", title: Strings.Push.permission, icon: ("notifications-outline", .red), value: PushPermissionText.label(loadingPush ? nil : pushPermission), accessory: .none),
            Row(id: "push-request", title: Strings.Push.requestAgain, icon: ("shield-checkmark-outline", .green), accessory: .none, action: pushPermission?.status == .unsupported ? nil : { [weak self] in self?.requestPermission() }),
            Row(id: "push-reregister", title: Strings.PushDevice.reregister, icon: ("refresh-outline", .orange), accessory: .none, action: { [weak self] in self?.refreshToken() },
                footer: "\(PushPermissionText.subtitle(pushPermission)) \(Strings.Push.footer)"),
        ]
        var tokens: [Row] = pushTokens.map { token in
            let isCurrent = currentPushToken == token.token
            let fingerprint = PushTokenText.fingerprint(token.token)
            return Row(id: "push-token:\(token.id)", title: fingerprint, icon: (isCurrent ? "phone-portrait-outline" : "trash-outline", isCurrent ? .gray : .red),
                       value: isCurrent ? Strings.PushDevice.thisDevice : Self.date(token.updatedAt), accessory: .none, action: { [weak self] in
                if isCurrent { self?.copy(token.token, label: fingerprint) } else { self?.delete(token) }
            })
        }
        if tokens.isEmpty { tokens = [Row(id: "push-none", title: Strings.Push.noTokens, accessory: .none, dimmed: true)] }
        tokens[tokens.count - 1].footer = "\(Strings.Push.registeredTokens(pushTokens.count)). \(Strings.Push.tokensFooter)"
        return [permission, tokens]
    }

    private static func date(_ milliseconds: Int64) -> String {
        Date(timeIntervalSince1970: TimeInterval(milliseconds) / 1000).formatted(date: .abbreviated, time: .omitted)
    }

    private func loadPush(showError: Bool = false) {
        loadingPush = true
        reload()
        let api = session.api
        let registration = SettingsHooks.pushRegistration
        Task { @MainActor [weak self] in
            do {
                let tokens = try await api.pushTokens()
                let permission = await Self.systemPermission()
                let current = await registration?.currentToken()
                self?.pushTokens = tokens
                self?.pushPermission = permission
                self?.currentPushToken = current
            } catch {
                if showError, let self { Alerts.show(Strings.Common.error, Strings.Push.loadFailed, on: self) }
            }
            self?.loadingPush = false
            self?.reload()
        }
    }

    nonisolated private static func systemPermission() async -> PushPermission {
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

    /// The prompt while iOS still shows it, the Settings app once it doesn't.
    private func requestPermission() {
        guard !busy else { return }
        busy = true
        let registration = SettingsHooks.pushRegistration
        Task { @MainActor in
            defer { busy = false }
            var permission = await Self.systemPermission()
            var openedSettings = false
            if !permission.granted {
                if permission.canAskAgain {
                    _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
                    permission = await Self.systemPermission()
                } else if let url = URL(string: UIApplication.openNotificationSettingsURLString) {
                    await UIApplication.shared.open(url)
                    openedSettings = true
                }
            }
            pushPermission = permission
            if permission.granted {
                do {
                    _ = try await registration?.register(api: session.api)
                } catch {
                    return Alerts.show(Strings.Common.error, Strings.Push.requestFailed, on: self)
                }
                loadPush()
                return Alerts.show(Strings.Common.success, Strings.Push.enabled, on: self)
            }
            loadPush()
            if openedSettings {
                Alerts.show(Strings.Push.openSettingsTitle, Strings.Push.openedSettings, on: self)
            } else {
                Alerts.show(Strings.Common.error, Strings.Push.notGranted, on: self)
            }
        }
    }

    /// Asks while it may, then registers this phone's token again.
    private func refreshToken() {
        guard !busy else { return }
        busy = true
        let registration = SettingsHooks.pushRegistration
        Task { @MainActor in
            defer { busy = false }
            var permission = await Self.systemPermission()
            if !permission.granted, permission.canAskAgain {
                _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
                permission = await Self.systemPermission()
            }
            pushPermission = permission
            guard permission.granted else {
                loadPush()
                return Alerts.show(Strings.Common.error, Strings.PushDevice.notEnabledYet, on: self)
            }
            do {
                guard let registration, try await registration.register(api: session.api) != nil else { throw APIError.unauthenticated }
                loadPush()
                Alerts.show(Strings.Common.success, Strings.PushDevice.refreshed, on: self)
            } catch {
                loadPush()
                Alerts.show(Strings.Common.error, Strings.PushDevice.refreshFailed, on: self)
            }
        }
    }

    private func delete(_ token: PushToken) {
        guard !busy else { return }
        Task { @MainActor in
            let fingerprint = PushTokenText.fingerprint(token.token)
            guard await Alerts.confirm(Strings.Push.deleteTitle, Strings.Push.deleteMessage(fingerprint), confirmTitle: Strings.Common.delete, destructive: true, on: self), !busy else { return }
            busy = true
            defer { busy = false }
            do {
                try await session.api.deletePushToken(token.token)
            } catch {
                Alerts.show(Strings.Common.error, Strings.Push.deleteFailed, on: self)
            }
            loadPush()
        }
    }

    private func copy(_ value: String, label: String) {
        UIPasteboard.general.string = value
        Alerts.show(Strings.Common.copied, Strings.Items.copiedToClipboard(label: label), on: self)
    }
}

/// A Happy account's Backup & Restore: its secret key, shown on a tap and
/// copied, with the warning that it is the account; Link New Device, which
/// signs another phone in by its Restore code; and Restore, which brings
/// another account here by its key or its code (as Add's ⋯ does). An
/// account made for a computer has no key here and links no device: it
/// lives on the computer (`AccountSummary.isLegacy`).
final class BackupSettingsViewController: SettingsPageViewController {
    private let context: AppContext
    private let session: AccountSession
    private var revealed = false
    private var linking = false

    init(context: AppContext, session: AccountSession) {
        self.context = context
        self.session = session
        super.init(title: Strings.BackupRestore.title)
    }

    /// Only a legacy account's key is shown and handed to another phone.
    var isLegacy: Bool {
        context.account.accounts.first { $0.id == session.keys.anonID }?.isLegacy ?? true
    }

    /// The key as the page shows it and copies it.
    var formattedKey: String { SecretKeyBackup.format(secret: session.keys.secret) }

    override func makeRows() -> [[SettingsRow]] {
        typealias Row = SettingsRow
        typealias Text = Strings.BackupRestore
        let restore = [Row(id: "restore", title: Text.restore, icon: ("key-outline", .blue), action: { [weak self] in
            guard let self else { return }
            AccountAdding.restore(context: context, from: self)
        }, footer: Text.restoreFooter)]
        guard isLegacy else {
            return [[Row(id: "no-key", title: Strings.SettingsAccount.secretKey, value: Strings.SettingsAccount.notAvailable, accessory: .none, footer: Text.madeForComputer, dimmed: true)], restore]
        }
        var key = [Row(id: "secret-key", title: revealed ? Text.hideKey : Text.showKey, icon: (revealed ? "eye-off-outline" : "eye-outline", .orange), accessory: .none, action: { [weak self] in
            self?.revealed.toggle()
            self?.reload()
        })]
        if revealed {
            key.append(Row(id: "secret-key-text", title: formattedKey, accessory: .none, action: { [weak self] in self?.copyKey() }, isCode: true))
            key.append(Row(id: "copy-secret-key", title: Text.copyKey, icon: ("copy-outline", .action), accessory: .none, action: { [weak self] in self?.copyKey() }))
        }
        key[key.count - 1].footer = Strings.SettingsAccount.backupDescription
        let link = [Row(id: "link-device", title: Strings.SettingsAccount.linkNewDevice, icon: ("qr-code-outline", .indigo), value: linking ? Strings.Common.scanning : nil, accessory: .none, action: { [weak self] in self?.linkDevice() }, footer: Text.linkFooter)]
        return [key, link, restore]
    }

    private func copyKey() {
        UIPasteboard.general.string = formattedKey
        Alerts.show(Strings.Common.success, Strings.SettingsAccount.secretKeyCopied, on: self)
    }

    /// Any Happy code: another phone's Restore code links it, a computer's
    /// connects it, anything else says what it is.
    private func linkDevice() {
        guard !linking else { return }
        Task { @MainActor in
            await HappyScan.scan(intent: .connect, context: context, on: self) { [weak self] busy in
                self?.linking = busy
                self?.reload()
            }
        }
    }
}
#endif
