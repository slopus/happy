#if canImport(UIKit)
import HappyCore
import HappyCrypto
import HappyLayout
import UIKit

/// Settings, trimmed to what this app does so far: connect a terminal, the
/// account and its backup key, the server, about and logout. Rows follow
/// components/SettingsView.tsx and app/(app)/settings/account.tsx.
public final class SettingsViewController: UIViewController {
    private let context: AppContext
    private let list = GroupedListView()
    private var revealsSecret = false
    private var copiedRecently = false

    public init(context: AppContext) {
        self.context = context
        super.init(nibName: nil, bundle: nil)
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
        title = Strings.Settings.title
        navigationItem.backButtonDisplayMode = .minimal
    }

    public override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        rebuild()
    }

    private func rebuild() {
        guard let session = context.account.session else {
            list.sections = []
            return
        }
        let blue = Palette.iconBlue
        var sections: [UIView] = [SettingsHeaderView()]

        sections.append(ItemGroupView(rows: [
            ItemRowView(title: Strings.Settings.scanQrCodeToAuthenticate, icon: ItemIcon("qrcode", tint: blue)) { [weak self] in
                self?.scanTerminal()
            },
            ItemRowView(title: Strings.Connect.enterUrlManually, icon: ItemIcon("link", tint: blue)) { [weak self] in
                self?.enterTerminalURL()
            },
        ]))

        sections.append(ItemGroupView(title: Strings.Settings.account, rows: [
            ItemRowView(title: Strings.SettingsAccount.status, detail: Strings.SettingsAccount.statusActive),
            ItemRowView(title: Strings.SettingsAccount.anonymousId, detail: session.keys.anonID),
            ItemRowView(
                title: Strings.SettingsAccount.linkNewDevice,
                subtitle: Strings.SettingsAccount.linkNewDeviceSubtitle,
                icon: ItemIcon("qrcode", tint: blue)
            ) { [weak self] in
                self?.linkDevice()
            },
        ]))

        let secretRow = ItemRowView(
            title: Strings.SettingsAccount.secretKey,
            subtitle: revealsSecret ? Strings.SettingsAccount.tapToHide : Strings.SettingsAccount.tapToReveal,
            icon: ItemIcon(revealsSecret ? "eye.slash" : "eye", tint: Palette.iconOrange)
        ) { [weak self] in
            self?.toggleSecret()
        }
        secretRow.showsChevron = false
        sections.append(ItemGroupView(title: Strings.SettingsAccount.backup, footer: Strings.SettingsAccount.backupDescription, rows: [secretRow]))
        if revealsSecret {
            let card = SecretKeyCardView(formattedKey: SecretKeyBackup.format(secret: session.keys.secret))
            card.copiedRecently = copiedRecently
            card.onCopy = { [weak self] in self?.copySecret() }
            sections.append(ItemGroupView(rows: [card]))
        }

        sections.append(ItemGroupView(rows: [
            ItemRowView(
                title: Strings.SettingsAccount.server,
                detail: context.customServerHost ?? Strings.Server.defaultServer,
                icon: ItemIcon("server.rack", tint: Palette.iconPurple)
            ) { [weak self] in
                self?.openServer()
            },
        ]))

        sections.append(ItemGroupView(title: Strings.Settings.about, footer: Strings.Settings.aboutFooter, rows: [
            ItemRowView(
                title: Strings.Common.version,
                detail: context.variant == .production ? context.version : "\(context.version) (\(context.variant.rawValue))",
                icon: ItemIcon("info.circle", tint: Palette.textSecondary)
            ),
        ]))

        sections.append(ItemGroupView(rows: [
            ItemRowView(
                title: Strings.SettingsAccount.logout,
                subtitle: Strings.SettingsAccount.logoutSubtitle,
                icon: ItemIcon("rectangle.portrait.and.arrow.right", tint: Palette.iconRed),
                isDestructive: true
            ) { [weak self] in
                self?.logout()
            },
        ]))
        list.sections = sections
    }

    private func scanTerminal() {
        Task { @MainActor in
            guard let text = await PairingFlow.scan(from: self) else { return }
            await approve(text, kind: .terminal)
        }
    }

    private func enterTerminalURL() {
        Task { @MainActor in
            guard let text = await Alerts.prompt(
                Strings.Modals.authenticateTerminal,
                Strings.Modals.pasteUrlFromTerminal,
                placeholder: "happy://terminal?...",
                confirmTitle: Strings.Common.continueAction,
                on: self
            ) else { return }
            await approve(text, kind: .terminal)
        }
    }

    private func linkDevice() {
        Task { @MainActor in
            guard let text = await PairingFlow.scan(from: self) else { return }
            await approve(text, kind: .account)
        }
    }

    private func approve(_ text: String, kind: PairingFlow.Kind) async {
        guard let session = context.account.session else { return }
        let result = await PairingFlow.approve(text, expecting: kind, session: session)
        Alerts.show(result.succeeded ? Strings.Common.success : Strings.Common.error, result.message, on: self)
    }

    private func toggleSecret() {
        revealsSecret.toggle()
        copiedRecently = false
        rebuild()
    }

    private func copySecret() {
        guard let session = context.account.session else { return }
        UIPasteboard.general.string = SecretKeyBackup.format(secret: session.keys.secret)
        copiedRecently = true
        rebuild()
        Alerts.show(Strings.Common.success, Strings.SettingsAccount.secretKeyCopied, on: self)
    }

    private func openServer() {
        navigationController?.pushViewController(ServerConfigViewController(context: context), animated: true)
    }

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

/// The custom server screen. app/(app)/server.tsx without the voice
/// section.
public final class ServerConfigViewController: UIViewController, UITextFieldDelegate {
    private let context: AppContext
    private let list = GroupedListView()
    private let form = ServerFormView()

    public init(context: AppContext) {
        self.context = context
        super.init(nibName: nil, bundle: nil)
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
        title = Strings.Server.title
        list.sections = [ItemGroupView(footer: Strings.Server.selfHostFooter, rows: [form])]
        let config = context.account.serverConfig
        form.field.text = config.isCustomServer ? config.serverURL.absoluteString : ""
        form.isCustomServer = config.isCustomServer
        form.field.delegate = self
        form.field.addTarget(self, action: #selector(edited), for: .editingChanged)
        form.save.action = { [weak self] in await self?.save() }
        form.reset.onTap = { [weak self] in self?.reset() }
    }

    public func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        textField.resignFirstResponder()
        return true
    }

    @objc private func edited() {
        form.error = nil
    }

    private func save() async {
        let input = form.field.text ?? ""
        guard !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            Alerts.show(Strings.Common.error, Strings.Server.enterServerUrl, on: self)
            return
        }
        let url: URL
        do {
            url = try ServerConfig.validate(input)
        } catch {
            form.error = Strings.Server.invalidFormat
            return
        }
        form.error = nil
        form.isValidating = true
        let result = await context.account.checkServer(url)
        form.isValidating = false
        switch result {
        case .ok:
            break
        case .serverError:
            form.error = Strings.Server.serverReturnedError
            return
        case .notHappyServer:
            form.error = Strings.Server.notValidHappyServer
            return
        case .unreachable:
            form.error = Strings.Server.failedToConnectToServer
            return
        }
        let confirmed = await Alerts.confirm(
            Strings.Server.changeServer,
            Strings.Server.continueWithServer,
            confirmTitle: Strings.Common.continueAction,
            destructive: true,
            on: self
        )
        guard confirmed else { return }
        do {
            try context.account.serverConfig.setCustomServerURL(url.absoluteString)
        } catch {
            form.error = Strings.Server.invalidFormat
            return
        }
        form.isCustomServer = context.account.serverConfig.isCustomServer
    }

    private func reset() {
        Task { @MainActor in
            let confirmed = await Alerts.confirm(
                Strings.Server.resetToDefault,
                Strings.Server.resetServerDefault,
                confirmTitle: Strings.Common.reset,
                destructive: true,
                on: self
            )
            guard confirmed else { return }
            try? context.account.serverConfig.setCustomServerURL(nil)
            form.field.text = ""
            form.error = nil
            form.isCustomServer = false
        }
    }
}
#endif
