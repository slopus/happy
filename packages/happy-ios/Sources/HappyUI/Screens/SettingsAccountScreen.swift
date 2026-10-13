#if canImport(UIKit)
import HappyCore
import HappyCrypto
import HappyLayout
import HappyStore
import HappyWire
import UIKit
import UserNotifications

/// Settings › Account (app/(app)/settings/account.tsx), headed by the
/// account switcher.
///
/// The switcher is this app's own: happy-app has one account per install.
/// It sits at the top of the Account page, where iOS puts the accounts of an
/// app that has several (Mail, Settings › Apps): every signed-in account as
/// a row with its picture, the active one checked; a tap switches, touch and
/// hold offers Sign Out, and Add Account starts a sign-in that keeps the
/// current account.
public final class SettingsAccountViewController: UIViewController, UIContextMenuInteractionDelegate,
    UIAdaptivePresentationControllerDelegate {
    private let context: AppContext
    private let session: AccountSession
    private let list = GroupedListView()
    private let toggles = SettingsToggleRows()
    private var observation: StoreObservation?
    private var snapshot = SettingsSnapshot()

    private var accountsObservation: AccountsObservation?
    private var accounts: [AccountSummary] = []
    /// The account being switched to or signed out of.
    private var busyAccount: String?
    private var accountEntries: [ObjectIdentifier: AccountSwitcherEntry] = [:]
    /// Pictures on their way, by account and URL or thumbhash; the page is
    /// rebuilt when one arrives.
    private var loadingPictures: Set<String> = []

    private var revealsSecret = false
    private var copiedRecently = false
    private var copiedReset: Task<Void, Never>?
    private var linkingDevice = false
    private var disconnectingGitHub = false
    private var disconnectingService: String?

    private var pushTokens: [PushToken] = []
    private var pushPermission: PushPermission?
    private var currentPushToken: String?
    private var loadingPush = false
    private var requestingPermission = false
    private var refreshingToken = false
    private var deletingToken: String?
    private let pushDevice: PushTokenText.Device

    public init(context: AppContext, session: AccountSession) {
        self.context = context
        self.session = session
        let device = UIDevice.current
        #if targetEnvironment(simulator)
        let isSimulator = true
        #else
        let isSimulator = false
        #endif
        pushDevice = PushTokenText.Device(
            name: device.name,
            model: device.model,
            systemName: device.systemName,
            systemVersion: device.systemVersion,
            appVersion: context.version,
            build: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String,
            isSimulator: isSimulator
        )
        super.init(nibName: nil, bundle: nil)
        followsTextSize()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public override func loadView() {
        view = list
    }

    public override func viewDidLoad() {
        super.viewDidLoad()
        title = Strings.Settings.account
        showsBackTitle()
        // Before the settings, whose first snapshot draws the page.
        accountsObservation = context.account.observeAccounts { [weak self] accounts in
            guard let self, accounts != self.accounts else { return }
            self.accounts = accounts
            self.rebuild()
        }
        observation = session.store.observeSettings { [weak self] snapshot in
            self?.snapshot = snapshot
            self?.rebuild()
        }
    }

    public override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        rebuild()
        // useFocusEffect: the push rows are fetched every time the page shows.
        loadPushSettings()
    }

    // MARK: Rows

    private func rebuild() {
        let page = AccountPageModel(profile: snapshot.profile)
        let blue = Palette.iconBlue
        var sections: [UIView] = [accountSwitcher()]

        let anonID = session.keys.anonID
        let serverID = session.serverID
        let analyticsID = ItemRowView(title: Strings.SettingsAccount.anonymousId, detail: anonID)
        analyticsID.onLongPress = { [weak self] in self?.copy(anonID, label: Strings.SettingsAccount.anonymousId) }
        analyticsID.showsChevron = false
        let publicID = ItemRowView(title: Strings.SettingsAccount.publicId, detail: serverID ?? Strings.SettingsAccount.notAvailable)
        if let serverID {
            publicID.onLongPress = { [weak self] in self?.copy(serverID, label: Strings.SettingsAccount.publicId) }
        }
        publicID.showsChevron = false
        let link = ItemRowView(
            title: Strings.SettingsAccount.linkNewDevice,
            subtitle: linkingDevice ? Strings.Common.scanning : Strings.SettingsAccount.linkNewDeviceSubtitle,
            icon: ItemIcon(.ionicons("qr-code-outline"), tint: blue)
        ) { [weak self] in
            self?.linkDevice()
        }
        link.showsChevron = false
        sections.append(ItemGroupView(title: Strings.SettingsAccount.accountInformation, rows: [
            ItemRowView(title: Strings.SettingsAccount.status, detail: Strings.SettingsAccount.statusActive),
            analyticsID,
            publicID,
            disabled(link, linkingDevice),
        ]))

        if page.showsProfile {
            var rows: [UIView] = []
            if let name = page.displayName {
                let row = ItemRowView(title: Strings.SettingsAccount.name, detail: name)
                rows.append(row)
            }
            if let login = page.githubLogin {
                let row = ItemRowView(
                    title: Strings.SettingsAccount.github,
                    subtitle: Strings.SettingsAccount.tapToDisconnect,
                    detail: "@\(login)",
                    icon: githubIcon(page.avatarURL, thumbhash: page.avatarThumbhash, of: session.keys.anonID)
                ) { [weak self] in
                    self?.disconnectGitHub()
                }
                row.showsChevron = false
                row.isLoading = disconnectingGitHub
                rows.append(row)
            }
            if !rows.isEmpty {
                let group = ItemGroupView(title: Strings.SettingsAccount.profile, rows: rows)
                // ItemGroup counts the GitHub slot even when it is empty, so
                // the Name row always has its divider in happy-app.
                (rows.first as? ItemRowView)?.showsDivider = page.displayName != nil
                sections.append(group)
            } else {
                // Only a picture: happy-app shows the header over nothing.
                sections.append(ItemGroupView(title: Strings.SettingsAccount.profile, rows: []))
            }
        }

        if !page.services.isEmpty {
            sections.append(ItemGroupView(title: Strings.Settings.connectedAccounts, rows: page.services.map { service in
                let busy = disconnectingService == service.rawValue
                let row = ItemRowView(
                    title: service.name,
                    subtitle: Strings.SettingsAccount.tapToDisconnect,
                    detail: Strings.SettingsAccount.statusActive,
                    icon: ItemIcon(.bundled(service.imageName), tint: service.tintsWithText ? Palette.text : nil)
                ) { [weak self] in
                    self?.disconnect(service)
                }
                row.showsChevron = false
                row.isLoading = busy
                return disabled(row, busy)
            }))
        }

        let secret = ItemRowView(
            title: Strings.SettingsAccount.secretKey,
            subtitle: revealsSecret ? Strings.SettingsAccount.tapToHide : Strings.SettingsAccount.tapToReveal,
            icon: ItemIcon(.ionicons(revealsSecret ? "eye-off-outline" : "eye-outline"), tint: Palette.iconOrange)
        ) { [weak self] in
            self?.toggleSecret()
        }
        secret.showsChevron = false
        sections.append(ItemGroupView(title: Strings.SettingsAccount.backup, footer: Strings.SettingsAccount.backupDescription, rows: [secret]))
        if revealsSecret {
            let card = SecretKeyCardView(formattedKey: SecretKeyBackup.format(secret: session.keys.secret))
            card.copiedRecently = copiedRecently
            card.onCopy = { [weak self] in self?.copySecret() }
            sections.append(ItemGroupView(rows: [card]))
        }

        let optOut = AccountSettings(snapshot).analyticsOptOut
        sections.append(ItemGroupView(title: Strings.SettingsAccount.privacy, footer: Strings.SettingsAccount.privacyDescription, rows: [
            toggles.row(
                "analyticsOptOut",
                title: Strings.SettingsAccount.analytics,
                subtitle: optOut ? Strings.SettingsAccount.analyticsDisabled : Strings.SettingsAccount.analyticsEnabled,
                isOn: !optOut
            ) { [weak self] on in
                self?.session.updateSettings(["analyticsOptOut": .bool(!on)])
            },
        ]))

        sections += pushSections()

        sections.append(ItemGroupView(title: Strings.SettingsAccount.dangerZone, rows: [
            ItemRowView(
                title: Strings.SettingsAccount.logout,
                subtitle: Strings.SettingsAccount.logoutSubtitle,
                icon: ItemIcon(.ionicons("log-out-outline"), tint: Palette.iconRed),
                isDestructive: true
            ) { [weak self] in
                self?.logout()
            },
        ]))
        list.sections = sections
    }

    /// Item.tsx's `disabled`: half opacity and no taps.
    private func disabled(_ row: ItemRowView, _ isDisabled: Bool) -> ItemRowView {
        if isDisabled {
            row.isEnabled = false
            row.alpha = 0.5
        }
        return row
    }

    private func githubIcon(_ avatarURL: String?, thumbhash: String?, of owner: AccountSummary.ID) -> ItemIcon {
        guard let url = avatarURL.flatMap(URL.init(string:)) else {
            return ItemIcon(.ionicons("logo-github"), tint: Palette.textSecondary)
        }
        // The thumbhash until the picture arrives, as expo-image shows it.
        let picture = image(url, of: owner) ?? placeholder(thumbhash, of: owner)
        return ItemIcon(.image(picture ?? UIImage()), round: true)
    }

    /// `owner`'s picture at `url` if it is decoded, else nil while it is
    /// fetched from that account's own cache.
    private func image(_ url: URL, of owner: AccountSummary.ID) -> UIImage? {
        guard let pictures = context.account.pictures(for: owner) else { return nil }
        if let image = pictures.cachedImage(url) { return image }
        rebuildWhenLoaded("\(owner) \(url.absoluteString)") {
            _ = await pictures.image(url)
            return pictures.cachedImage(url) != nil
        }
        return nil
    }

    /// `owner`'s thumbhash as a picture if it is decoded, else nil while it
    /// is decoded off the main thread.
    private func placeholder(_ thumbhash: String?, of owner: AccountSummary.ID) -> UIImage? {
        guard let thumbhash, let pictures = context.account.pictures(for: owner) else { return nil }
        if let image = pictures.cachedPlaceholderImage(thumbhash) { return image }
        rebuildWhenLoaded("\(owner) #\(thumbhash)") {
            _ = await pictures.placeholderImage(thumbhash)
            return pictures.cachedPlaceholderImage(thumbhash) != nil
        }
        return nil
    }

    /// Runs `load` once at a time per key, and rebuilds the page if it
    /// left something to draw.
    private func rebuildWhenLoaded(_ key: String, _ load: @escaping @MainActor () async -> Bool) {
        guard loadingPictures.insert(key).inserted else { return }
        Task { @MainActor [weak self] in
            let loaded = await load()
            guard let self else { return }
            self.loadingPictures.remove(key)
            if loaded { self.rebuild() }
        }
    }

    // MARK: Account switcher

    private func accountSwitcher() -> UIView {
        let settings = AccountSettings(snapshot)
        let entries = AccountSwitcherEntry.entries(
            accounts,
            activeProfile: snapshot.profile,
            defaultServer: ServerConfig.defaultServerURL,
            fallbackTitle: Strings.AccountSwitcher.fallbackTitle
        )
        accountEntries = [:]
        var rows: [UIView] = entries.map { entry in
            let icon: ItemIcon
            // Each account's picture from its own cache, active or not.
            if let url = entry.avatarURL, let picture = image(url, of: entry.id) ?? placeholder(entry.avatarThumbhash, of: entry.id) {
                icon = ItemIcon(.image(picture), round: true)
            } else {
                let content = AvatarView.Content(avatar: SessionAvatar(seed: entry.id), style: settings.avatarStyle, monochrome: settings.avatarMonochrome)
                icon = ItemIcon(.image(AvatarSnapshot.image(content, size: ItemRowLayout.Metrics.iconSize, traits: traitCollection)))
            }
            let row = ItemRowView(title: entry.title, subtitle: entry.subtitle, icon: icon)
            if !entry.isActive {
                row.onTap = { [weak self] in self?.switchAccount(to: entry) }
            }
            row.showsChevron = false
            if entry.isActive {
                row.trailingView = SettingsCheckmark.view(tint: Palette.iconBlue)
            }
            row.isLoading = busyAccount == entry.id
            row.addInteraction(UIContextMenuInteraction(delegate: self))
            accountEntries[ObjectIdentifier(row)] = entry
            return row
        }
        let add = ItemRowView(title: Strings.AccountSwitcher.addAccount, icon: ItemIcon(.ionicons("add-circle-outline"), tint: Palette.iconBlue)) { [weak self] in
            self?.addAccount()
        }
        add.showsChevron = false
        rows.append(add)
        return ItemGroupView(title: Strings.AccountSwitcher.title, footer: Strings.AccountSwitcher.footer, rows: rows)
    }

    private func switchAccount(to entry: AccountSwitcherEntry) {
        guard busyAccount == nil else { return }
        busyAccount = entry.id
        rebuild()
        Task { @MainActor in
            do {
                // On success the coordinator replaces the whole stack with
                // the other account's home.
                try await context.account.switchAccount(to: entry.id)
            } catch {
                Alerts.show(Strings.Common.error, Strings.AccountSwitcher.switchFailed, on: self)
            }
            busyAccount = nil
            rebuild()
        }
    }

    /// The sign-in screens in a sheet, over an account that stays signed in.
    /// A sign-in there adds the account and makes it active, and the
    /// coordinator swaps the whole stack (closing this sheet) to its home.
    private func addAccount() {
        guard presentedViewController == nil else { return }
        context.account.beginAddingAccount()
        let welcome = WelcomeViewController(context: context)
        welcome.navigationItem.leftBarButtonItem = UIBarButtonItem(
            title: Strings.Common.cancel,
            primaryAction: UIAction { [weak self] _ in self?.cancelAddingAccount() }
        )
        let navigation = UINavigationController(rootViewController: welcome)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        navigation.presentationController?.delegate = self
        present(navigation, animated: true)
    }

    private func cancelAddingAccount() {
        context.account.cancelAddingAccount()
        presentedViewController?.dismiss(animated: true)
    }

    /// Swiping the sheet away cancels too.
    public func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        context.account.cancelAddingAccount()
    }

    private func signOut(_ entry: AccountSwitcherEntry) {
        if entry.isActive {
            logout()
            return
        }
        Task { @MainActor in
            let confirmed = await Alerts.confirm(
                Strings.AccountSwitcher.signOut,
                Strings.AccountSwitcher.signOutConfirm(entry.title),
                confirmTitle: Strings.AccountSwitcher.signOut,
                destructive: true,
                on: self
            )
            guard confirmed, busyAccount == nil else { return }
            busyAccount = entry.id
            rebuild()
            do {
                // Removes that account's credentials and cache; the active
                // account is untouched, and the list redraws without it.
                try await context.account.signOut(accountID: entry.id)
            } catch {
                Alerts.show(Strings.Common.error, Strings.AccountSwitcher.signOutFailed, on: self)
            }
            busyAccount = nil
            rebuild()
        }
    }

    public func contextMenuInteraction(
        _ interaction: UIContextMenuInteraction,
        configurationForMenuAtLocation location: CGPoint
    ) -> UIContextMenuConfiguration? {
        guard let row = interaction.view, let entry = accountEntries[ObjectIdentifier(row)] else { return nil }
        return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
            UIMenu(children: [
                UIAction(
                    title: Strings.AccountSwitcher.signOut,
                    image: .icon(.ionicons("log-out-outline"), size: 22),
                    attributes: .destructive
                ) { _ in
                    self?.signOut(entry)
                },
            ])
        }
    }

    // MARK: Account information and profile

    private func copy(_ value: String, label: String) {
        UIPasteboard.general.string = value
        Alerts.show(Strings.Common.copied, Strings.Items.copiedToClipboard(label: label), on: self)
    }

    private func linkDevice() {
        guard !linkingDevice else { return }
        Task { @MainActor in
            guard let text = await PairingFlow.scan(.account, from: self) else { return }
            linkingDevice = true
            rebuild()
            let outcome = await PairingFlow.approve(text, expecting: .account, session: session)
            linkingDevice = false
            rebuild()
            PairingFlow.report(outcome, kind: .account, on: self)
        }
    }

    private func disconnectGitHub() {
        guard !disconnectingGitHub else { return }
        disconnectingGitHub = true
        rebuild()
        Task { @MainActor in
            defer {
                disconnectingGitHub = false
                rebuild()
            }
            let confirmed = await Alerts.confirm(
                Strings.Modals.disconnectGithub,
                Strings.Modals.disconnectGithubConfirm,
                confirmTitle: Strings.Modals.disconnect,
                destructive: true,
                on: self
            )
            guard confirmed else { return }
            do {
                try await session.api.disconnectGitHub()
                await session.sync.invalidate(.profile)
            } catch {
                SettingsAlerts.unknownError(on: self)
            }
        }
    }

    private func disconnect(_ service: AccountPageModel.Service) {
        guard disconnectingService == nil else { return }
        Task { @MainActor in
            let confirmed = await Alerts.confirm(
                Strings.Modals.disconnectService(service.name),
                Strings.Modals.disconnectServiceConfirm(service.name),
                confirmTitle: Strings.Modals.disconnect,
                destructive: true,
                on: self
            )
            guard confirmed else { return }
            disconnectingService = service.rawValue
            rebuild()
            do {
                try await session.api.disconnectService(service.rawValue)
                await session.sync.invalidate(.profile)
            } catch {
                Alerts.show(Strings.Common.error, Strings.Errors.disconnectServiceFailed(service.name), on: self)
            }
            disconnectingService = nil
            rebuild()
        }
    }

    // MARK: Backup

    private func toggleSecret() {
        revealsSecret.toggle()
        rebuild()
    }

    private func copySecret() {
        UIPasteboard.general.string = SecretKeyBackup.format(secret: session.keys.secret)
        copiedRecently = true
        rebuild()
        copiedReset?.cancel()
        copiedReset = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled, let self else { return }
            self.copiedRecently = false
            self.rebuild()
        }
        Alerts.show(Strings.Common.success, Strings.SettingsAccount.secretKeyCopied, on: self)
    }

    // MARK: Push notifications

    private func pushSections() -> [UIView] {
        let permission = ItemRowView(
            title: Strings.Push.permission,
            subtitle: PushPermissionText.subtitle(pushPermission),
            detail: PushPermissionText.label(pushPermission),
            icon: ItemIcon(.ionicons("notifications-outline"), tint: Palette.iconBlue)
        )
        permission.isLoading = loadingPush
        let request = ItemRowView(
            title: Strings.Push.requestAgain,
            subtitle: PushPermissionText.requestSubtitle(pushPermission),
            icon: ItemIcon(.ionicons("shield-checkmark-outline"), tint: Palette.iconGreen)
        ) { [weak self] in
            self?.requestPermission()
        }
        request.showsChevron = false
        request.isLoading = requestingPermission
        let reregister = ItemRowView(
            title: Strings.PushDevice.reregister,
            subtitle: PushPermissionText.reregisterSubtitle(currentToken: currentPushToken),
            icon: ItemIcon(.ionicons("refresh-outline"), tint: Palette.iconOrange)
        ) { [weak self] in
            self?.refreshToken()
        }
        reregister.showsChevron = false
        reregister.isLoading = refreshingToken
        let push = ItemGroupView(title: Strings.Push.title, footer: Strings.Push.footer, rows: [
            permission,
            disabled(request, requestingPermission || loadingPush || pushPermission?.status == .unsupported),
            disabled(reregister, refreshingToken || loadingPush),
        ])

        let tokenRows: [ItemRowView]
        if pushTokens.isEmpty {
            tokenRows = [ItemRowView(title: Strings.Push.noTokens, subtitle: Strings.Push.noTokensSubtitle)]
        } else {
            tokenRows = pushTokens.map { token in
                let isCurrent = currentPushToken == token.token
                let row = ItemRowView(
                    title: PushTokenText.fingerprint(token.token),
                    subtitle: PushTokenText.subtitle(token, current: isCurrent ? pushDevice : nil, format: Self.formatTimestamp),
                    detail: isCurrent ? Strings.PushDevice.thisDevice : nil,
                    icon: ItemIcon(
                        .ionicons(isCurrent ? "phone-portrait-outline" : "trash-outline"),
                        tint: isCurrent ? Palette.textSecondary : Palette.iconRed
                    )
                )
                if isCurrent {
                    let fingerprint = PushTokenText.fingerprint(token.token)
                    row.onLongPress = { [weak self] in self?.copy(token.token, label: fingerprint) }
                } else {
                    row.onTap = { [weak self] in self?.delete(token) }
                }
                row.showsChevron = false
                row.isLoading = deletingToken == token.token
                return disabled(row, deletingToken != nil)
            }
        }
        let tokens = ItemGroupView(title: Strings.Push.registeredTokens(pushTokens.count), footer: Strings.Push.tokensFooter, rows: tokenRows)
        if !pushTokens.isEmpty {
            // The token rows sit in a Fragment, which ItemGroup leaves alone,
            // so every one keeps Item's default divider, the last included.
            for row in tokenRows { row.showsDivider = true }
        }
        return [push, tokens]
    }

    /// `new Date(timestamp).toLocaleString()`.
    private static func formatTimestamp(_ milliseconds: Int64) -> String {
        let formatter = DateFormatter()
        formatter.locale = .autoupdatingCurrent
        formatter.setLocalizedDateFormatFromTemplate("yMdjms")
        return formatter.string(from: Date(timeIntervalSince1970: TimeInterval(milliseconds) / 1000))
    }

    private func loadPushSettings(showError: Bool = false) {
        loadingPush = true
        rebuild()
        let api = session.api
        let registration = SettingsHooks.pushRegistration
        Task { @MainActor in
            do {
                let tokens = try await api.pushTokens()
                let permission = await Self.systemPermission()
                let current = await registration?.currentToken()
                pushTokens = tokens
                pushPermission = permission
                currentPushToken = current
            } catch {
                if showError {
                    Alerts.show(Strings.Common.error, Strings.Push.loadFailed, on: self)
                }
            }
            loadingPush = false
            rebuild()
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

    /// `requestPushPermissionOrOpenSettings`: the prompt while iOS still
    /// shows it, the Settings app once it doesn't.
    private func askForPermission() async -> (permission: PushPermission, openedSettings: Bool) {
        let existing = await Self.systemPermission()
        if existing.granted { return (existing, false) }
        if existing.canAskAgain {
            _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
            return (await Self.systemPermission(), false)
        }
        if let url = URL(string: UIApplication.openNotificationSettingsURLString) {
            await UIApplication.shared.open(url)
        }
        return (existing, true)
    }

    private func requestPermission() {
        guard !requestingPermission else { return }
        requestingPermission = true
        rebuild()
        let registration = SettingsHooks.pushRegistration
        Task { @MainActor in
            defer {
                requestingPermission = false
                rebuild()
            }
            let result = await askForPermission()
            pushPermission = result.permission
            if result.permission.granted {
                do {
                    _ = try await registration?.register(api: session.api)
                } catch {
                    Alerts.show(Strings.Common.error, Strings.Push.requestFailed, on: self)
                    return
                }
                loadPushSettings()
                Alerts.show(Strings.Common.success, Strings.Push.enabled, on: self)
                return
            }
            loadPushSettings()
            if result.openedSettings {
                Alerts.show(Strings.Push.openSettingsTitle, Strings.Push.openedSettings, on: self)
            } else {
                Alerts.show(Strings.Common.error, Strings.Push.notGranted, on: self)
            }
        }
    }

    /// `syncCurrentPushToken`: asks while it may, then registers this
    /// device's token again.
    private func refreshToken() {
        guard !refreshingToken else { return }
        refreshingToken = true
        rebuild()
        let registration = SettingsHooks.pushRegistration
        Task { @MainActor in
            defer {
                refreshingToken = false
                rebuild()
            }
            var permission = await Self.systemPermission()
            if !permission.granted, permission.canAskAgain {
                _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
                permission = await Self.systemPermission()
            }
            pushPermission = permission
            guard permission.granted else {
                loadPushSettings()
                Alerts.show(Strings.Common.error, Strings.PushDevice.notEnabledYet, on: self)
                return
            }
            do {
                // No registration yet means no token of this device's own to
                // send, which is a failure here rather than happy-app's
                // silent success.
                guard let registration, try await registration.register(api: session.api) != nil else {
                    throw APIError.unauthenticated
                }
                loadPushSettings()
                Alerts.show(Strings.Common.success, Strings.PushDevice.refreshed, on: self)
            } catch {
                loadPushSettings()
                Alerts.show(Strings.Common.error, Strings.PushDevice.refreshFailed, on: self)
            }
        }
    }

    private func delete(_ token: PushToken) {
        guard deletingToken == nil else { return }
        Task { @MainActor in
            let fingerprint = PushTokenText.fingerprint(token.token)
            let confirmed = await Alerts.confirm(
                Strings.Push.deleteTitle,
                Strings.Push.deleteMessage(fingerprint),
                confirmTitle: Strings.Common.delete,
                destructive: true,
                on: self
            )
            guard confirmed else { return }
            deletingToken = token.token
            rebuild()
            do {
                try await session.api.deletePushToken(token.token)
            } catch {
                Alerts.show(Strings.Common.error, Strings.Push.deleteFailed, on: self)
            }
            deletingToken = nil
            loadPushSettings()
        }
    }

    // MARK: Danger zone

    private func logout() {
        Task { @MainActor in
            let confirmed = await Alerts.confirm(
                Strings.Common.logout,
                Strings.SettingsAccount.logoutConfirm,
                confirmTitle: Strings.Common.logout,
                destructive: true,
                on: self
            )
            guard confirmed else { return }
            await context.account.signOut()
        }
    }
}

/// The checkmark Settings uses in a row's trailing slot (Ionicons
/// `checkmark`, 20).
@MainActor
enum SettingsCheckmark {
    static func view(tint: ColorToken) -> UIImageView {
        let check = UIImageView(image: .icon(.ionicons("checkmark"), size: 20))
        check.tintColor = UIColor(tint)
        check.contentMode = .center
        check.accessibilityLabel = "selected"
        return check
    }
}
#endif
