#if canImport(UIKit)
import HappyCore
import HappyCrypto
import HappyLayout
import HappyStore
import UIKit

/// Settings (components/SettingsView.tsx): the profile or logo header,
/// connecting a terminal, connected accounts, the feature pages and About.
/// Usage and the Developer row are not ported (see
/// docs/FEATURES.md); logout and the push rows live on the Account page, as
/// they do in happy-app.
public final class SettingsViewController: UIViewController {
    private let context: AppContext
    private let list = GroupedListView()
    private var observation: StoreObservation?
    private var snapshot = SettingsSnapshot()
    private var versionClicks = MultiClickCounter()
    private var profileHeader: SettingsProfileHeaderView?
    private var connectingTerminal = false
    private var claudeBusy = false
    private var githubBusy = false

    public init(context: AppContext) {
        self.context = context
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
        title = Strings.Settings.title
        // createPlainHeader: Header.tsx's own title, which scales, where the
        // pages under Settings get UIKit's, which doesn't.
        let titleView = NavigationTitleView(title: Strings.Settings.title)
        titleView.sizeToFit()
        setScaledTitleView(titleView)
        showsBackTitle()
        dropsBackButtonOnTablet() // Tablet (HappyUI/Tablet): navigation/Header.tsx
        observation = context.account.session?.store.observeSettings { [weak self] snapshot in
            self?.snapshot = snapshot
            self?.rebuild()
        }
    }

    public override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        rebuild()
    }

    private func rebuild() {
        guard context.account.session != nil else {
            list.sections = []
            return
        }
        let model = SettingsIndexModel(profile: snapshot.profile)
        let settings = AccountSettings(snapshot)
        let blue = Palette.iconBlue
        var sections: [UIView] = [header(model.header, settings: settings)]

        let scan = ItemRowView(title: Strings.Settings.scanQrCodeToAuthenticate, icon: ItemIcon(.ionicons("qr-code-outline"), tint: blue)) { [weak self] in
            self?.scanTerminal()
        }
        scan.showsChevron = false
        scan.isLoading = connectingTerminal
        let enterURL = ItemRowView(title: Strings.Connect.enterUrlManually, icon: ItemIcon(.ionicons("link-outline"), tint: blue)) { [weak self] in
            self?.enterTerminalURL()
        }
        enterURL.showsChevron = false
        sections.append(ItemGroupView(rows: [scan, enterURL]))

        sections.append(ItemGroupView(rows: [
            ItemRowView(title: Strings.SupportUs.title, subtitle: Strings.SupportUs.subtitle,
                        icon: ItemIcon(.ionicons("heart-outline"), tint: Palette.iconRed)) { [weak self] in
                self?.open(.supportUs)
            },
        ]))

        let claude = ItemRowView(
            title: Strings.Settings.claudeCode,
            subtitle: model.claudeConnected ? Strings.SettingsAccount.statusActive : Strings.Settings.connectAccount,
            icon: ItemIcon(.bundled("icon-claude"))
        ) { [weak self] in
            if model.claudeConnected { self?.disconnectClaude() } else { self?.connectClaude() }
        }
        claude.showsChevron = false
        claude.isLoading = claudeBusy
        let github = ItemRowView(
            title: Strings.Settings.github,
            subtitle: model.githubLogin.map(Strings.Settings.githubConnected(login:)) ?? Strings.Settings.connectGithubAccount,
            icon: ItemIcon(.ionicons("logo-github"), tint: model.githubLogin == nil ? Palette.textSecondary : Palette.statusConnected)
        ) { [weak self] in
            if model.githubLogin == nil { self?.connectGitHub() } else { self?.disconnectGitHub() }
        }
        github.showsChevron = false
        github.isLoading = githubBusy
        sections.append(ItemGroupView(title: Strings.Settings.connectedAccounts, rows: [claude, github]))

        let agents = ItemRowView(
            title: Strings.Settings.agents,
            subtitle: Strings.Settings.agentsSubtitle,
            icon: ItemIcon(.ionicons("options-outline"), tint: Palette.iconTeal)
        ) { [weak self] in
            self?.open(.settingsAgents)
        }
        sections.append(ItemGroupView(title: Strings.Settings.features, rows: [
            ItemRowView(
                title: Strings.Settings.account,
                subtitle: Strings.Settings.accountSubtitle,
                icon: ItemIcon(.ionicons("person-circle-outline"), tint: blue)
            ) { [weak self] in
                self?.open(.settingsAccount)
            },
            ItemRowView(
                title: Strings.Settings.appearance,
                subtitle: Strings.Settings.appearanceSubtitle,
                icon: ItemIcon(.ionicons("color-palette-outline"), tint: Palette.iconPurple)
            ) { [weak self] in
                self?.open(.settingsAppearance)
            },
            agents,
            ItemRowView(title: Strings.Voice.title, subtitle: Strings.Voice.subtitle,
                        icon: ItemIcon(.ionicons("mic-outline"), tint: blue)) { [weak self] in
                self?.open(.settingsVoice)
            },
        ]))
        // ItemGroup counts the `{experiments && …}` slot after Agents even
        // when it is empty, so Agents keeps its divider in happy-app.
        agents.showsDivider = true

        let version = ItemRowView(
            title: Strings.Common.version,
            detail: SettingsIndexModel.versionDetail(version: context.version, variant: context.variant),
            icon: ItemIcon(.ionicons("information-circle-outline"), tint: Palette.textSecondary)
        ) { [weak self] in
            self?.versionTapped()
        }
        version.showsChevron = false
        sections.append(ItemGroupView(title: Strings.Settings.about, footer: Strings.Settings.aboutFooter, rows: [
            ItemRowView(
                title: Strings.Settings.whatsNew,
                subtitle: Strings.Settings.whatsNewSubtitle,
                icon: ItemIcon(.ionicons("sparkles-outline"), tint: Palette.iconOrange)
            ) { [weak self] in
                self?.open(.changelog)
            },
            ItemRowView(
                title: Strings.Settings.github,
                detail: Strings.Links.githubDetail,
                icon: ItemIcon(.ionicons("logo-github"), tint: Palette.text)
            ) {
                UIApplication.shared.open(Strings.Links.github)
            },
            ItemRowView(title: Strings.Settings.reportIssue, icon: ItemIcon(.ionicons("bug-outline"), tint: Palette.iconRed)) {
                UIApplication.shared.open(Strings.Links.issues)
            },
            ItemRowView(title: Strings.Settings.privacyPolicy, icon: ItemIcon(.ionicons("shield-checkmark-outline"), tint: blue)) {
                UIApplication.shared.open(Strings.Links.privacy)
            },
            ItemRowView(title: Strings.Settings.termsOfService, icon: ItemIcon(.ionicons("document-text-outline"), tint: blue)) {
                UIApplication.shared.open(Strings.Links.terms)
            },
            ItemRowView(title: Strings.Settings.eula, icon: ItemIcon(.ionicons("document-text-outline"), tint: blue)) {
                UIApplication.shared.open(Strings.Links.eula)
            },
            version,
        ]))
        list.sections = sections
    }

    private func header(_ header: SettingsIndexModel.Header, settings: AccountSettings) -> UIView {
        switch header {
        case .logo:
            profileHeader = nil
            return SettingsHeaderView()
        case .profile(let id, let name, let bio, let avatarURL, let thumbhash):
            let content = SettingsProfileHeaderView.Content(
                id: id,
                name: name,
                bio: bio,
                avatarURL: avatarURL.flatMap(URL.init(string:)),
                thumbhash: thumbhash,
                style: settings.avatarStyle,
                monochrome: settings.avatarMonochrome
            )
            // This account's own pictures, never another's.
            let pictures = context.account.session.flatMap { context.account.pictures(for: $0.keys.anonID) }
            if let profileHeader {
                profileHeader.content = content
                profileHeader.pictures = pictures
                return profileHeader
            }
            let view = SettingsProfileHeaderView(content: content, pictures: pictures)
            profileHeader = view
            return view
        }
    }

    private func open(_ route: Route) {
        push(route, context: context)
    }

    // MARK: Connect a terminal (useConnectTerminal.ts)

    private func scanTerminal() {
        Task { @MainActor in
            guard let text = await PairingFlow.scan(.terminal, from: self) else { return }
            await approve(text)
        }
    }

    private func enterTerminalURL() {
        Task { @MainActor in
            let text = await Alerts.prompt(
                Strings.Modals.authenticateTerminal,
                Strings.Modals.pasteUrlFromTerminal,
                placeholder: "happy://terminal?...",
                confirmTitle: Strings.Common.authenticate,
                on: self
            )
            guard let url = text?.trimmingCharacters(in: .whitespacesAndNewlines), !url.isEmpty else { return }
            await approve(url)
        }
    }

    private func approve(_ text: String) async {
        guard let session = context.account.session, !connectingTerminal else { return }
        connectingTerminal = true
        rebuild()
        let outcome = await PairingFlow.approve(text, expecting: .terminal, session: session)
        connectingTerminal = false
        rebuild()
        PairingFlow.report(outcome, kind: .terminal, on: self)
    }

    // MARK: Connected accounts

    private func connectClaude() {
        open(.settingsConnectClaude)
    }

    private func disconnectClaude() {
        guard !claudeBusy, let session = context.account.session else { return }
        claudeBusy = true
        rebuild()
        Task { @MainActor in
            defer {
                claudeBusy = false
                rebuild()
            }
            let service = "Claude"
            let confirmed = await Alerts.confirm(
                Strings.Modals.disconnectService(service),
                Strings.Modals.disconnectServiceConfirm(service),
                confirmTitle: Strings.Modals.disconnect,
                destructive: true,
                on: self
            )
            guard confirmed else { return }
            do {
                try await session.api.disconnectService("anthropic")
                await session.sync.invalidate(.profile)
            } catch {
                SettingsAlerts.unknownError(on: self)
            }
        }
    }

    private func connectGitHub() {
        guard !githubBusy, let session = context.account.session else { return }
        githubBusy = true
        rebuild()
        Task { @MainActor in
            defer {
                githubBusy = false
                rebuild()
            }
            do {
                let params = try await session.api.githubOAuthParams()
                guard let url = URL(string: params.url) else { throw APIError.decoding("GitHub OAuth URL") }
                await UIApplication.shared.open(url)
            } catch {
                SettingsAlerts.unknownError(on: self)
            }
        }
    }

    private func disconnectGitHub() {
        guard !githubBusy, let session = context.account.session else { return }
        githubBusy = true
        rebuild()
        Task { @MainActor in
            defer {
                githubBusy = false
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
                // The server also sends an account update; pulling the
                // profile covers a socket that is down.
                await session.sync.invalidate(.profile)
            } catch {
                SettingsAlerts.unknownError(on: self)
            }
        }
    }

    // MARK: About

    /// Ten taps toggle developer mode. The Developer row it reveals is not
    /// ported, but the switch is kept so it means the same in both apps.
    private func versionTapped() {
        guard versionClicks.click(at: Date()) else { return }
        let enabled = !context.account.localSettings.devModeEnabled
        context.account.localSettings.devModeEnabled = enabled
        Alerts.show(
            Strings.Modals.developerMode,
            enabled ? Strings.Modals.developerModeEnabled : Strings.Modals.developerModeDisabled,
            on: self
        )
    }
}

/// useHappyAction.ts's catch-all: any failure reads "Unknown error".
@MainActor
enum SettingsAlerts {
    static func unknownError(on controller: UIViewController) {
        Alerts.show(Strings.SettingsActions.error, Strings.SettingsActions.unknownError, on: controller)
    }
}

/// The active account's server host, for rows that name it; nil on the
/// default server. Each account has its own server, so this reads the
/// session, not the server the sign-in screens would pick.
@MainActor
func activeServerHost(_ context: AppContext) -> String? {
    guard let url = context.account.session?.api.serverURL, url != ServerConfig.defaultServerURL else { return nil }
    guard let host = url.host else { return url.absoluteString }
    return url.port.map { "\(host):\($0)" } ?? host
}

/// The gear on Link Your Computer, app/(app)/onboarding/settings.tsx. Two
/// things a person may need before a computer is linked: another server, or
/// throwing the new account away. Nothing is linked yet, so logging out
/// loses nothing.
public final class OnboardingSettingsViewController: UIViewController {
    private let context: AppContext
    private let list = GroupedListView()

    public init(context: AppContext) {
        self.context = context
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
        title = Strings.Onboarding.settingsTitle
        showsBackTitle()
    }

    public override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // Rebuilt on every return, so a changed server shows.
        rebuild()
    }

    private func rebuild() {
        let server = ItemRowView(
            title: Strings.Onboarding.settingsServer,
            detail: activeServerHost(context) ?? Strings.Onboarding.settingsServerDefault,
            icon: ItemIcon(.ionicons("server-outline"), tint: Palette.textSecondary, size: 28)
        ) { [weak self] in
            self?.openServer()
        }
        let logout = ItemRowView(
            title: Strings.Onboarding.logoutStartOver,
            icon: ItemIcon(.ionicons("log-out-outline"), tint: Palette.textDestructive, size: 28),
            isDestructive: true
        ) { [weak self] in
            self?.logout()
        }
        logout.showsChevron = false
        list.sections = [
            ItemGroupView(rows: [server]),
            ItemGroupView(footer: Strings.Onboarding.logoutFooter, rows: [logout]),
        ]
    }

    private func openServer() {
        navigationController?.pushViewController(ServerConfigViewController(context: context), animated: true)
    }

    private func logout() {
        Task { @MainActor in
            let confirmed = await Alerts.confirm(
                Strings.Onboarding.logoutConfirmTitle,
                Strings.Onboarding.logoutConfirmBody,
                confirmTitle: Strings.Common.logout,
                destructive: true,
                on: self
            )
            guard confirmed else { return }
            // The coordinator swaps back to Welcome.
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
