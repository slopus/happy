#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyStore
import UIKit

/// V2 settings, pushed from the picture in either home's header,
/// laid out as Telegram's settings are (its techniques, none of its code):
/// the navigation bar with back at the left, search (the bar's own
/// integrated search) and the QR button at the right; every computer and account as story circles, the chosen one
/// centred and ringed, its name and line under it; then every setting the
/// chosen profile has, in grouped cards, with Appearance and About each a
/// page of their own, as Happy's settings have them.
/// Swiping a profile to the middle makes it the active one and turns the
/// page to it, while home changes underneath (`AppCoordinator.install`
/// keeps this page on top); tapping its circle makes it the active one and
/// goes back to its home. "+" adds a computer in the link sheet.
///
/// A computer's page: the agent's own picture over its name, whose menu
/// asks it to change its picture or name (`AgentEditButton`,
/// `ChiefOfStaffAsk`; nothing renamed here); the person's own Profile
/// there (`ProfileViewController`); Appearance (the theme, which
/// each profile keeps on this phone, and Hide projects); adding a computer
/// or a Happy account; About; Disconnect. A Happy account's: its own pages
/// (Account, Appearance, Language, Voice, Agents), its connected services,
/// connecting a terminal, Support us, adding; About; Sign out. Those pages
/// write to that account's synced settings, so they are on its page alone.
final class SettingsViewController: UIViewController, UIScrollViewDelegate, UISearchResultsUpdating, UISearchControllerDelegate {
    /// Pushes settings over `controller`, on `computer`'s page (the active
    /// profile's when nil), showing the row `reveal` names if there is one.
    /// Once: a second tap meanwhile does nothing. The agent's two asks,
    /// found by home's search, run as its picture's menu runs them: Happy's
    /// conversation opens over home with the words typed in.
    static func open(context: AppContext, computer: String?, reveal: String? = nil, from controller: UIViewController) {
        guard let navigation = controller.navigationController, navigation.topViewController === controller else { return }
        let asks = [SettingsIndex.changeAgentName.id: ChatPrefill.agentName, SettingsIndex.changeAgentAvatar.id: ChatPrefill.agentAvatar]
        if let ask = reveal.flatMap({ asks[$0] }), let computer, let session = Session.session(for: computer, context: context) {
            return ChiefOfStaffAsk.open(ask, session: session, from: controller)
        }
        let settings = SettingsViewController(context: context, computer: computer)
        settings.reveal = reveal
        navigation.pushViewController(settings, animated: true)
    }

    private struct Profile: Equatable {
        var id: String
        var name: String
        var subtitle: String
        var isAgentConnection: Bool
        var isActive: Bool
    }

    private let context: AppContext
    private var shownID: String?
    private var profiles: [Profile] = []
    private let scroll = UIScrollView()
    private let name = UILabel()
    private let subtitle = UILabel()
    private var cards: [SettingsCardView] = []
    private var rows: [[SettingsRow]] = []
    /// What the page shows now, card by card, and where the profiles'
    /// strip is: for the tests, which read the page rather than the screen.
    var shownRowIDs: [[String]] { rows.map { $0.map(\.id) } }
    var stripFrame: CGRect { settingsLayout.strip }
    /// The ids of the rows drawn with a tick.
    var tickedRowIDs: [String] { rows.joined().filter { $0.value == "✓" }.map(\.id) }
    /// The profile the page is showing, which its heading names.
    var shownProfileID: String? { shownID }

    /// Runs the row `id`'s action, as a finger on it would.
    func tapRow(_ id: String) {
        rows.joined().first { $0.id == id }?.action?()
    }
    /// The row `id` as the page shows it.
    func shownRow(_ id: String) -> SettingsRow? { rows.joined().first { $0.id == id } }
    /// The frames last applied.
    private var settingsLayout = SettingsLayout(width: 0, nameHeight: 0, subtitleHeight: 0, cards: [])
    private lazy var searchController = UISearchController(searchResultsController: nil)
    private var query: String?
    private let empty = UILabel()
    private var observation: AccountsObservation?
    private var prioritizingWatch: Watch?
    private var prioritizing: Bool?
    private var connectionSettingsWatch: Task<Void, Never>?
    private var projectsHidden = false
    /// The person's own profile on the computer shown, for its row.
    private var profileWatch: (id: String, watch: Watch)?
    private var profileName = ""
    private var profilePhoto: UIImage?
    private var appeared = false
    /// The agent's own picture over its name, on a connection's page.
    let agentButton = AgentEditButton()
    /// The nested page open over this one, drawn again with it.
    private weak var page: SettingsPageViewController?
    /// The Happy account's own settings, while its page shows.
    private var settingsObservation: StoreObservation?
    private var snapshot = SettingsSnapshot()
    private var images: [String: UIImage] = [:]
    private var imageKeys: [String: String] = [:]
    private var imageJobs: [String: Task<Void, Never>] = [:]
    private var busy = false
    private var connecting = false
    private var versionClicks = MultiClickCounter()
    private var switching: Task<Void, Never>?
    /// The profile last chosen, which the switches in line end on.
    private var wanted: String?
    /// The row home's search found, shown once the page is on screen
    /// and has it (a row that waits on the computer comes a moment later).
    private var reveal: String?

    init(context: AppContext, computer: String?) {
        self.context = context
        shownID = computer
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.settingsGround)
        view.accessibilityIdentifier = "settings"
        scroll.alwaysBounceVertical = true
        scroll.keyboardDismissMode = .interactive
        scroll.delegate = self
        view.addSubview(scroll)
        name.font = Fonts.ui(.medium, size: 28)
        name.textColor = UIColor(Palette.settingsText)
        name.textAlignment = .center
        name.accessibilityIdentifier = "settings-name"
        subtitle.font = Fonts.ui(.regular, size: 17)
        subtitle.textColor = UIColor(Palette.settingsSecondary)
        subtitle.textAlignment = .center
        agentButton.ask = { [weak self] in self?.ask($0) }
        agentButton.isHidden = true
        scroll.addSubview(agentButton)
        scroll.addSubview(name)
        scroll.addSubview(subtitle)
        empty.text = Strings.nothingFound
        empty.font = Fonts.ui(.regular, size: 17)
        empty.textColor = UIColor(Palette.settingsSecondary)
        empty.textAlignment = .center
        empty.isHidden = true
        scroll.addSubview(empty)
        setUpBar()
        observation = context.account.observeAccounts { [weak self] _ in self?.reload() }
        reload()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // Back from Welcome without signing in: no account is being added.
        if context.account.isAddingAccount, presentedViewController == nil { context.account.cancelAddingAccount() }
        // Back from a page over this one: the Profile row reads its profile again.
        if appeared, let id = profileWatch?.id { Session.session(for: id, context: context)?.profile.refresh() }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        appeared = true
        guard reveal != nil else { return }
        showRevealed()
        // A row that hasn't come by now isn't coming.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.reveal = nil }
    }

    /// The row search found: scrolled to the middle and flashed, for the
    /// person to change or open; nothing runs on its own (a link would
    /// leave the app, an ask would open a conversation).
    private func showRevealed() {
        guard let id = reveal, query == nil, view.window != nil else { return }
        if !rows.joined().contains(where: { $0.id == id }), let page = page(holding: id) {
            reveal = nil
            return open(page, reveal: id)
        }
        guard let card = rows.firstIndex(where: { $0.contains { $0.id == id } }),
              let index = rows[card].firstIndex(where: { $0.id == id }), cards.indices.contains(card) else { return }
        reveal = nil
        view.layoutIfNeeded()
        if let y = settingsLayout.revealOffset(card: card, row: index, viewport: scroll.bounds.height, insets: LayoutInsets(scroll.adjustedContentInset)) {
            scroll.setContentOffset(CGPoint(x: 0, y: y), animated: true)
        }
        cards[card].flash(index)
    }

    override func didMove(toParent parent: UIViewController?) {
        super.didMove(toParent: parent)
        guard parent == nil else { return }
        // Gone with Welcome over it, its account was never added.
        if context.account.isAddingAccount { context.account.cancelAddingAccount() }
    }

    // MARK: Bar

    /// The system's back, the title, and the bar's own search, which grows
    /// into a field in the bar. No QR button: scanning is Add's.
    private func setUpBar() {
        title = Strings.Settings.title
        navigationItem.largeTitleDisplayMode = .never
        HeaderBar.edge(scroll, in: self)
        searchController.searchResultsUpdater = self
        searchController.delegate = self
        searchController.obscuresBackgroundDuringPresentation = false
        searchController.searchBar.placeholder = Strings.searchSettings
        searchController.searchBar.searchTextField.accessibilityIdentifier = "settings-search-field"
        navigationItem.searchController = searchController
        navigationItem.hidesSearchBarWhenScrolling = false
        navigationItem.preferredSearchBarPlacement = .integratedButton
        // In the bar at the top, not iOS 26's toolbar at the bottom.
        if #available(iOS 26.0, *) { navigationItem.searchBarPlacementAllowsToolbarIntegration = false }
        definesPresentationContext = true
    }

    // MARK: Profiles

    private var shown: Profile? { profiles.first { $0.id == shownID } }

    /// Computers first, then Happy accounts, each in the order added.
    private func reload() {
        let accounts = context.account.accounts
        let direct = context.account.agentConnections.accounts
        profiles = (accounts.filter(\.isAgentConnection) + accounts.filter { !$0.isAgentConnection }).map { account in
            if account.isAgentConnection, let computer = direct.first(where: { $0.id == account.id }) {
                return Profile(id: account.id, name: computer.name, subtitle: computer.status.title, isAgentConnection: true, isActive: account.isActive)
            }
            let name = account.name ?? account.username ?? Strings.happyAccount
            return Profile(id: account.id, name: name, subtitle: account.username.map { "@\($0)" } ?? Strings.happyAccount, isAgentConnection: false, isActive: account.isActive)
        }
        // With none left, the window's root is the link screen and this
        // page goes with the old one (`AppCoordinator.install`).
        guard !profiles.isEmpty else { return }
        if shown == nil { shownID = (profiles.first(where: \.isActive) ?? profiles[0]).id }
        for account in accounts { loadImage(account) }
        watchShown()
        rebuild(animated: false)
    }

    private func loadImage(_ account: AccountSummary) {
        let key = ProfilePictures.key(account, context: context)
        guard imageKeys[account.id] != key else { return }
        imageKeys[account.id] = key
        imageJobs[account.id]?.cancel()
        imageJobs[account.id] = Task { [weak self] in
            guard let self else { return }
            let image = await ProfilePictures.load(account, context: context)
            guard !Task.isCancelled, imageKeys[account.id] == key else { return }
            images[account.id] = image
            rebuild(animated: false)
        }
    }

    /// The circle that came to rest, or was tapped: the page turns to it
    /// and it becomes the active profile, home changing under this page.
    /// `closing` (a tap) then goes back to that home, once it is there.
    private func choose(_ index: Int, closing: Bool = false) {
        guard profiles.indices.contains(index) else { return }
        let profile = profiles[index]
        if shownID != profile.id {
            shownID = profile.id
            watchShown()
            rebuild(animated: true)
        }
        // One switch at a time, and only the last choice still wanted (one
        // back to the active profile too, behind a switch away from it); a
        // failed one turns the page back to the profile that is active.
        let previous = switching
        let account = context.account
        wanted = profile.id
        // The home under this page now: unless it is already the profile's,
        // back waits for the one that replaces it, even when a switch in
        // line before this one is what makes the profile active.
        let home = account.accounts.first(where: { $0.id == profile.id })?.isActive == true ? nil : navigationController?.viewControllers.first
        switching = Task { [weak self] in
            await previous?.value
            guard self?.wanted ?? profile.id == profile.id else { return }
            if account.accounts.first(where: { $0.id == profile.id })?.isActive == false {
                do {
                    try await account.switchAccount(to: profile.id)
                } catch {
                    guard let self, view.window != nil, shownID == profile.id else { return }
                    shownID = account.accounts.first(where: \.isActive)?.id
                    reload()
                    Alerts.show(Strings.couldNotSwitch, error.localizedDescription, on: self)
                    return
                }
            }
            // The new home is built in its language first: back goes to it.
            for _ in 0..<60 where closing && home != nil && self?.navigationController?.viewControllers.first === home {
                try? await Task.sleep(for: .milliseconds(50))
            }
            guard closing, let self, wanted == profile.id, navigationController?.topViewController === self else { return }
            navigationController?.popViewController(animated: true)
        }
    }

    /// Telegram's "Add Account": the one Add flow (`AccountAdding`).
    private func connectAgent() {
        AccountAdding.begin(context: context, from: self)
    }

    /// Another Happy account, beside the profiles there are.
    private func addHappyAccount() {
        guard isTop else { return }
        AccountAdding.begin(context: context, from: self)
    }

    private func watchShown() {
        watchProfile()
        connectionSettingsWatch?.cancel(); connectionSettingsWatch = nil
        projectsHidden = false
        prioritizingWatch?.invalidate()
        prioritizingWatch = nil
        prioritizing = nil
        settingsObservation = nil
        snapshot = SettingsSnapshot()
        guard let profile = shown else { return }
        if !profile.isAgentConnection {
            // Only the active account has a session to read.
            guard let session = context.account.session, session.keys.anonID == profile.id else { return }
            settingsObservation = session.store.observeSettings { [weak self] snapshot in
                guard let self, self.snapshot != snapshot else { return }
                self.snapshot = snapshot
                rebuild(animated: false)
            }
            return
        }
        guard let session = Session.session(for: profile.id, context: context) else { return }
        connectionSettingsWatch = Task { [weak self, engine = session.engine] in
            for await snapshot in await engine.snapshots() {
                guard !Task.isCancelled, let self else { return }
                let hidden = DesktopSettingKeys.projectsHidden(snapshot.settings)
                guard hidden != projectsHidden else { continue }
                projectsHidden = hidden
                rebuild(animated: false)
            }
        }
        prioritizingWatch = session.watch { [weak self] snapshot in
            guard let self, prioritizing != snapshot.prioritizing else { return }
            prioritizing = snapshot.prioritizing
            rebuild(animated: false)
        }
    }

    /// The Profile row follows the shown computer's profile: read once
    /// when the computer is shown, then as it changes.
    private func watchProfile() {
        let id = shown.flatMap { $0.isAgentConnection ? $0.id : nil }
        guard profileWatch?.id != id else { return }
        profileWatch?.watch.invalidate()
        profileWatch = nil
        profileName = ""
        profilePhoto = nil
        guard let id, let session = Session.session(for: id, context: context) else { return }
        let source = session.profile
        profileWatch = (id, source.watch { [weak self, weak source] in
            guard let self, let source, profileName != source.state.name || profilePhoto !== source.photo else { return }
            profileName = source.state.name
            profilePhoto = source.photo
            rebuild(animated: false)
        })
        source.refresh()
    }

    // MARK: Rows

    /// Every account and agent connection this phone has, in one card, the
    /// active one ticked, with Connect Agent under them. Tapping one makes
    /// it the active one, as its circle used to; there is no selector, no
    /// selector and no second Add anywhere on the page.
    private func accountRows() -> [SettingsRow] {
        typealias Row = SettingsRow
        // A signed-in Happy account and an open agent connection both
        // call themselves active, so more than one row would be ticked.
        // The one being looked at is the first in the order shown, which
        // is the connection where there is one: the same one the
        // switcher names.
        let active = profiles.first(where: \.isActive)?.id
        var rows: [SettingsRow] = profiles.enumerated().map { index, profile in
            Row(
                id: "account:\(profile.id)",
                title: profile.name,
                icon: (profile.isAgentConnection ? "desktop-outline" : "person-circle-outline", profile.isAgentConnection ? .blue : .gray),
                image: images[profile.id],
                // An account with no username is named "Happy account" and
                // its line says the same: the row would say it twice.
                value: profile.id == active ? "✓" : (profile.subtitle == profile.name ? nil : profile.subtitle),
                accessory: .none,
                action: { [weak self] in self?.choose(index, closing: true) }
            )
        }
        rows.append(Row(SettingsIndex.connectAgent, accessory: .none, action: { [weak self] in self?.connectAgent() }))
        return rows
    }

    private func rowsFor(_ profile: Profile) -> [[SettingsRow]] {
        typealias Row = SettingsRow
        let id = profile.id
        if profile.isAgentConnection {
            typealias Index = SettingsIndex
            return [
                accountRows(),
                [Row(Index.profile, image: profilePhoto, value: profileName.isEmpty ? nil : profileName, action: { [weak self] in self?.openProfile() })],
                [Row(Index.appearance, action: { [weak self] in self?.open(.appearance) })],
                aboutRows(),
                [Row(id: "disconnect", title: Strings.disconnect, accessory: .none, destructive: true, action: { [weak self] in self?.remove(id, direct: true) })],
            ]
        }
        let model = SettingsIndexModel(profile: snapshot.profile)
        return [
            accountRows(),
            [
                Row(id: "account", title: Strings.Settings.account, icon: ("person-circle-outline", .blue), action: { [weak self] in self?.push(.settingsAccount, for: id) }),
                Row(id: "appearance", title: Strings.Settings.appearance, icon: ("color-palette-outline", .purple), action: { [weak self] in self?.push(.settingsAppearance, for: id) }),
                Row(id: "language", title: Strings.language, icon: ("language-outline", .green), action: { [weak self] in self?.push(.settingsLanguage, for: id) }),
                Row(id: "voice", title: Strings.voice, icon: ("mic-outline", .orange), action: { [weak self] in self?.push(.settingsVoice, for: id) }),
                Row(id: "agents", title: Strings.Settings.agents, icon: ("options-outline", .teal), action: { [weak self] in self?.push(.settingsAgents, for: id) }),
            ],
            [
                Row(id: "claude", title: Strings.Settings.claudeCode, icon: ("code-slash-outline", .orange), value: model.claudeConnected ? Strings.connected : Strings.connect, accessory: .none, action: { [weak self] in self?.claude(connected: model.claudeConnected) }),
                Row(id: "github", title: Strings.Settings.github, icon: ("logo-github", .gray), value: model.githubLogin.map { "@\($0)" } ?? Strings.connect, accessory: .none, action: { [weak self] in self?.github(connected: model.githubLogin != nil) }),
            ],
            [
                Row(id: "scan-terminal", title: Strings.connectTerminal, icon: ("qr-code-outline", .indigo), accessory: .none, action: { [weak self] in self?.connectTerminal(scanning: true) }),
                Row(id: "enter-terminal", title: Strings.enterTerminalURL, icon: ("link-outline", .indigo), accessory: .none, action: { [weak self] in self?.connectTerminal(scanning: false) }),
            ],
            [Row(id: "support-us", title: Strings.SupportUs.title, icon: ("heart-outline", .red), action: { [weak self] in self?.show(SupportUsViewController()) })],
            aboutRows(),
            [Row(id: "sign-out", title: Strings.signOut, accessory: .none, destructive: true, action: { [weak self] in self?.remove(id, direct: false) })],
        ]
    }

    /// The pages a row opens.
    enum Page: CaseIterable {
        case appearance
    }

    private func title(_ page: Page) -> String {
        switch page {
        case .appearance: SettingsIndex.appearance.title
        }
    }

    private func rows(_ page: Page) -> [[SettingsRow]] {
        switch page {
        case .appearance: appearanceRows()
        }
    }

    /// The page that holds the row `id`, if a page does.
    private func page(holding id: String) -> Page? {
        guard let profile = shown else { return nil }
        return Page.allCases.first { page in
            (page != .appearance || profile.isAgentConnection) && rows(page).joined().contains { $0.id == id }
        }
    }

    private func open(_ page: Page, reveal: String? = nil) {
        guard isTop else { return }
        let controller = SettingsPageViewController(title: title(page)) { [weak self] in self?.rows(page) ?? [] }
        controller.reveal = reveal
        self.page = controller
        navigationController?.pushViewController(controller, animated: true)
    }

    /// A computer's look on this phone: the theme, and whether home shows
    /// projects (desktop's account setting, which home follows; there is
    /// deliberately no renderer or layout choice here).
    private func appearanceRows() -> [[SettingsRow]] {
        typealias Row = SettingsRow
        guard let id = shown?.id else { return [] }
        let current = context.account.localSettings.themePreference
        let themes: [ThemePreference] = [.adaptive, .light, .dark]
        return [
            themes.map { theme in
                Row(id: "theme-\(theme)", title: Self.themeName(theme), value: theme == current ? "✓" : nil, accessory: .none, action: { [weak self] in self?.setTheme(theme) })
            },
            [Row(SettingsIndex.hideProjects, accessory: .toggle, isOn: projectsHidden, toggled: { [weak self] on in
                guard let self, let engine = context.account.agentConnections.syncEngine(for: id) else { return }
                projectsHidden = on
                Task { try? await engine.setProjectsHidden(on) }
            })],
        ]
    }

    private func aboutRows() -> [SettingsRow] {
        typealias Row = SettingsRow
        typealias Index = SettingsIndex
        return [
            Row(Index.whatsNew, action: { [weak self] in self?.show(ChangelogViewController()) }),
            Row(Index.githubRepo, value: Strings.Links.githubDetail, action: { UIApplication.shared.open(Strings.Links.github) }),
            Row(Index.reportIssue, action: { UIApplication.shared.open(Strings.Links.issues) }),
            Row(Index.privacy, action: { UIApplication.shared.open(Strings.Links.privacy) }),
            Row(Index.terms, action: { UIApplication.shared.open(Strings.Links.terms) }),
            Row(Index.eula, action: { UIApplication.shared.open(Strings.Links.eula) }),
            Row(Index.version, value: SettingsIndexModel.versionDetail(version: context.version, variant: context.variant), accessory: .none, action: { [weak self] in self?.versionTapped() }),
        ]
    }

    /// What search looks through: the page's rows and the profiles.
    private func searchRows(_ query: String) -> [SettingsRow] {
        var found: [SettingsRow] = []
        for (index, profile) in profiles.enumerated() where profile.name.localizedCaseInsensitiveContains(query) {
            found.append(SettingsRow(id: "profile:\(profile.id)", title: profile.name, icon: (profile.isAgentConnection ? "desktop-outline" : "person-outline", .blue), value: profile.isAgentConnection ? Strings.agentConnection : Strings.happyAccount, action: { [weak self] in
                self?.endSearch()
                self?.choose(index)
            }))
        }
        // The agent's two asks live in its picture's menu; found here, they run.
        if let profile = shown, profile.isAgentConnection {
            for (entry, ask) in [(SettingsIndex.changeAgentName, ChatPrefill.agentName), (SettingsIndex.changeAgentAvatar, ChatPrefill.agentAvatar)] where entry.title.localizedCaseInsensitiveContains(query) {
                found.append(SettingsRow(entry, accessory: .none, action: { [weak self] in
                    self?.endSearch()
                    self?.ask(ask)
                }))
            }
        }
        if let profile = shown {
            let pages = Page.allCases.filter { $0 != .appearance || profile.isAgentConnection }.flatMap { rows($0).joined() }
            found += (rowsFor(profile).joined() + pages).filter { $0.title.localizedCaseInsensitiveContains(query) && !$0.destructive }
        }
        return found
    }

    private func rebuild(animated: Bool) {
        guard isViewLoaded, let profile = shown else { return }
        if let query, !query.isEmpty {
            let found = searchRows(query)
            rows = found.isEmpty ? [] : [found]
        } else if query != nil {
            rows = []
        } else {
            rows = rowsFor(profile)
        }
        page?.reload()
        let searching = query != nil
        name.isHidden = searching
        subtitle.isHidden = searching
        // A connection's page has the agent's picture over its name, the
        // one the accounts card shows; a Happy account's has none.
        agentButton.isHidden = searching || !profile.isAgentConnection
        if profile.isAgentConnection { agentButton.picture = images[profile.id] }
        empty.isHidden = !(searching && !(query ?? "").isEmpty && rows.isEmpty)
        for (label, value) in [(name, profile.name), (subtitle, profile.subtitle)] where label.text != value {
            if animated {
                UIView.transition(with: label, duration: 0.2, options: [.transitionCrossDissolve, .beginFromCurrentState], animations: { label.text = value })
            } else {
                label.text = value
            }
        }
        while cards.count < rows.count { let card = SettingsCardView(); scroll.addSubview(card); cards.append(card) }
        while cards.count > rows.count { cards.removeLast().removeFromSuperview() }
        view.setNeedsLayout()
        // A row search found that only came now (one waiting on the computer).
        if reveal != nil, view.window != nil { DispatchQueue.main.async { [weak self] in self?.showRevealed() } }
        if animated {
            for card in cards { card.alpha = 0 }
            view.layoutIfNeeded()
            UIView.animate(withDuration: 0.2) { for card in self.cards { card.alpha = 1 } }
        }
    }

    // MARK: Layout

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let width = view.bounds.width
        let searching = query != nil
        // Under the bar, whose row is in the safe area: the cards scroll under it.
        scroll.frame = view.bounds
        let specs = rows.map { card in
            card.map { SettingsLayout.RowSpec(hasIcon: $0.icon != nil, valueWidth: SettingsCardView.valueWidth($0.value), accessory: $0.accessory) }
        }
        let picture = shown?.isAgentConnection == true ? agentButton.intrinsicContentSize.width : nil
        let layout = SettingsLayout(width: width, nameHeight: ceil(name.font.lineHeight), subtitleHeight: ceil(subtitle.font.lineHeight), cards: specs, searching: searching, showsStrip: false, picture: picture)
        settingsLayout = layout
        agentButton.frame = layout.picture
        name.frame = layout.name
        subtitle.frame = layout.subtitle
        empty.frame = layout.empty
        for (index, card) in cards.enumerated() where layout.cards.indices.contains(index) {
            let frame = layout.cards[index]
            card.frame = frame.frame
            card.show(rows[index], layout: frame)
        }
        scroll.contentSize = CGSize(width: width, height: layout.contentHeight)
    }

    // MARK: Search

    /// The bar's search field opened: the page narrows as it is typed in.
    func willPresentSearchController(_ searchController: UISearchController) {
        query = ""
        rebuild(animated: false)
    }

    func updateSearchResults(for searchController: UISearchController) {
        guard query != nil else { return }
        query = searchController.searchBar.text ?? ""
        rebuild(animated: false)
    }

    func willDismissSearchController(_ searchController: UISearchController) {
        guard query != nil else { return }
        query = nil
        rebuild(animated: false)
    }

    private func endSearch() {
        searchController.isActive = false
    }

    // MARK: Actions

    /// The person's own name and picture on the computer shown.
    private func openProfile() {
        guard isTop, let id = profileWatch?.id, let session = Session.session(for: id, context: context) else { return }
        show(ProfileViewController(source: session.profile))
    }

    /// "Change agent name" and "Change agent avatar" change nothing here:
    /// they open Happy's conversation on the computer shown with the ask
    /// typed in, unsent, for the person to finish (`ChiefOfStaffAsk`).
    private func ask(_ prefill: ChatPrefill) {
        guard isTop, let profile = shown, profile.isAgentConnection, let session = Session.session(for: profile.id, context: context) else { return }
        ChiefOfStaffAsk.open(prefill, session: session, from: self)
    }

    private func setPrioritizing(_ on: Bool) {
        guard let profile = shown, let session = Session.session(for: profile.id, context: context) else { return }
        prioritizing = on
        let store = session.store
        Task { await store.setPrioritizing(on) }
    }

    private func setTheme(_ theme: ThemePreference) {
        ThemeController.set(theme, in: context)
        rebuild(animated: false)
    }

    private static func themeName(_ theme: ThemePreference) -> String {
        switch theme {
        case .adaptive: Strings.SettingsAppearance.themeAdaptive
        case .light: Strings.SettingsAppearance.themeLight
        case .dark: Strings.SettingsAppearance.themeDark
        }
    }

    /// Ten taps toggle developer mode, as on Happy's settings.
    private func versionTapped() {
        guard versionClicks.click(at: Date()) else { return }
        let enabled = !context.account.localSettings.devModeEnabled
        context.account.localSettings.devModeEnabled = enabled
        Alerts.show(Strings.Modals.developerMode, enabled ? Strings.Modals.developerModeEnabled : Strings.Modals.developerModeDisabled, on: self)
    }

    /// A Happy account's page, once that account is the active one.
    private func push(_ route: Route, for id: String) {
        guard isTop, let session = context.account.session, session.keys.anonID == id else { return }
        show(Screens.make(route, context: context, session: session))
    }

    private func show(_ controller: UIViewController) {
        guard isTop else { return }
        navigationController?.pushViewController(controller, animated: true)
    }

    /// Nothing pushed or on its way: a second tap meanwhile opens nothing.
    private var isTop: Bool {
        navigationController?.topViewController === self && navigationController?.transitionCoordinator == nil && (presentedViewController == nil || presentedViewController === searchController)
    }

    private var activeSession: AccountSession? {
        guard let session = context.account.session, session.keys.anonID == shownID else { return nil }
        return session
    }

    private func claude(connected: Bool) {
        guard !connecting, let session = activeSession else { return }
        guard connected else { return push(.settingsConnectClaude, for: session.keys.anonID) }
        connecting = true
        Task { @MainActor in
            await SettingsConnections.disconnectClaude(session: session, on: self)
            connecting = false
        }
    }

    private func github(connected: Bool) {
        guard !connecting, let session = activeSession else { return }
        connecting = true
        Task { @MainActor in
            if connected {
                await SettingsConnections.disconnectGitHub(session: session, on: self)
            } else {
                await SettingsConnections.connectGitHub(session: session, on: self)
            }
            connecting = false
        }
    }

    private func connectTerminal(scanning: Bool) {
        guard !connecting, activeSession != nil else { return }
        connecting = true
        Task { @MainActor in
            defer { connecting = false }
            let text = scanning ? await SettingsConnections.scanTerminal(on: self) : await SettingsConnections.promptTerminalURL(on: self)
            guard let text else { return }
            await SettingsConnections.approveTerminal(text, context: context, on: self)
        }
    }

    private func remove(_ id: String, direct: Bool) {
        guard !busy else { return }
        busy = true
        Task { [weak self] in
            guard let self else { return }
            defer { busy = false }
            guard await Alerts.confirm(direct ? Strings.disconnectTitle : Strings.signOutTitle, Strings.removeDetail, confirmTitle: direct ? Strings.disconnect : Strings.signOut, destructive: true, on: self) else { return }
            do {
                try await context.account.signOut(accountID: id)
                if direct { Session.forget(id) }
                Haptics.play(.putAway)
                shownID = nil
                reload()
            } catch {
                Alerts.show(Strings.couldNotRemove, error.localizedDescription, on: self)
            }
        }
    }
}
#endif
