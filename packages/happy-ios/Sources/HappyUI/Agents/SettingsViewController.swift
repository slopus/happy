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
/// Tapping a profile in the accounts card makes it the active one in
/// place: the page stays, its contents dissolve into that profile's, and
/// that profile's home replaces the old one underneath, unseen
/// (`AppCoordinator.install` keeps this page on top), so back goes there.
///
/// Both kinds of profile have one page, in one order: the profile's
/// picture over its name, the accounts card, who it is, how it looks,
/// Support us, About, then Disconnect or Sign out. A Happy account's
/// picture is only that. A computer's page: the agent's picture, whose menu
/// asks it to change its picture or name (`AgentEditButton`,
/// `ChiefOfStaffAsk`; nothing renamed here); the person's own Profile
/// there (`ProfileViewController`); Appearance (the theme, which
/// each profile keeps on this phone, and Hide projects). A Happy
/// account's, in the same places: Account and Backup & Restore where the
/// computer has Profile; Language, Voice and Agents beside Appearance;
/// connecting a terminal before Support us. Those pages write to that
/// account's synced settings, so they are on its page alone. Voice is
/// a Happy account's only: the assistant runs on its server's credentials
/// and its sessions, and a computer has neither.
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
        /// What kind it is: an agent, or a legacy account.
        var kind: String = Strings.agentConnection
        var isAgentConnection: Bool
        var isActive: Bool
    }

    private let context: AppContext
    private var shownID: String?
    /// The profiles the page had, to tell one just added.
    private var knownProfiles: Set<String> = []
    private var profiles: [Profile] = []
    private let scroll = UIScrollView()
    private let name = UILabel()
    private let subtitle = UILabel()
    private var cards: [SettingsCardView] = []
    private lazy var footers = SettingsFooters(in: scroll)
    private var rows: [[SettingsRow]] = []
    /// What the page shows now, card by card, and where the profiles'
    /// strip is: for the tests, which read the page rather than the screen.
    var shownRowIDs: [[String]] { rows.map { $0.map(\.id) } }
    var shownRowTitles: [[String]] { rows.map { $0.map(\.title) } }
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
    /// The profile's picture over its name; on a connection's page, the
    /// agent's, with its pencil and menu.
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
    nonisolated(unsafe) private var rootChange: NSObjectProtocol?

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
        // A switch made here builds the new home in its account's language:
        // this page, kept over it, speaks it too.
        rootChange = NotificationCenter.default.addObserver(forName: AppCoordinator.rootDidChange, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.rebuild() }
        }
        reload()
    }

    deinit {
        if let rootChange { NotificationCenter.default.removeObserver(rootChange) }
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

    /// The system's back and the bar's own search, which grows into a field
    /// in the bar. No title: the profile's picture and name head the page.
    /// No QR button: scanning is Add's.
    private func setUpBar() {
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
            return Profile(id: account.id, name: account.shownName, subtitle: account.username.map { "@\($0)" } ?? account.kindName, kind: account.kindName, isAgentConnection: false, isActive: account.isActive)
        }
        // With none left, the window's root is the link screen and this
        // page goes with the old one (`AppCoordinator.install`); it lets
        // go of what it watched meanwhile.
        guard !profiles.isEmpty else {
            shownID = nil
            return watchShown()
        }
        // One added while this page is open (Add Agent) is the active one:
        // the page turns to it, as the tick does.
        if !knownProfiles.isEmpty, let added = profiles.first(where: { $0.isActive && !knownProfiles.contains($0.id) }) { shownID = added.id }
        knownProfiles = Set(profiles.map(\.id))
        if shown == nil { shownID = (profiles.first(where: \.isActive) ?? profiles[0]).id }
        for account in accounts { loadImage(account) }
        watchShown()
        rebuild()
    }

    private func loadImage(_ account: AccountSummary) {
        let key = ProfilePictures.key(account, context: context)
        guard imageKeys[account.id] != key else { return }
        imageKeys[account.id] = key
        imageJobs[account.id]?.cancel()
        // What it has now in the first build, the picture when it comes.
        if let placeholder = ProfilePictures.immediate(account, context: context) { images[account.id] = placeholder }
        imageJobs[account.id] = Task { [weak self] in
            guard let self else { return }
            let image = await ProfilePictures.load(account, context: context)
            guard !Task.isCancelled, imageKeys[account.id] == key else { return }
            images[account.id] = image
            rebuild()
        }
    }

    /// The account tapped in the card, or found by search: it becomes the
    /// active profile without leaving this page. Search closes first; the
    /// page dissolves into the profile's at once, where it was scrolled to;
    /// its home replaces the old one under this page once the switch is
    /// made (`AppCoordinator.install`).
    private func choose(_ index: Int) {
        guard profiles.indices.contains(index) else { return }
        let profile = profiles[index]
        if query != nil { endSearch() }
        if shownID != profile.id {
            shownID = profile.id
            watchShown()
            crossfade()
        }
        // One switch at a time, and only the last choice still wanted (one
        // back to the active profile too, behind a switch away from it); a
        // failed one turns the page back to the profile that is active.
        let previous = switching
        let account = context.account
        wanted = profile.id
        switching = Task { [weak self] in
            await previous?.value
            guard self?.wanted ?? profile.id == profile.id,
                  account.accounts.first(where: { $0.id == profile.id })?.isActive == false else { return }
            do {
                try await account.switchAccount(to: profile.id)
            } catch {
                guard let self, view.window != nil, shownID == profile.id else { return }
                shownID = account.accounts.first(where: \.isActive)?.id
                crossfade { self.reload() }
                Alerts.show(Strings.couldNotSwitch, error.localizedDescription, on: self)
            }
        }
    }

    /// The page's contents dissolve into what `change` makes of them (a
    /// fresh build by default), as home does on a switch: the same length
    /// and curve (`AppCoordinator.rootCrossfade`). Only the scrolling part
    /// changes; the bar and its search stay where they are. The page keeps
    /// its place, unless the new one ends before it (`SettingsLayout.keptOffset`).
    private func crossfade(_ change: (() -> Void)? = nil) {
        let apply = {
            UIView.performWithoutAnimation {
                if let change { change() } else { self.rebuild() }
                self.view.layoutIfNeeded()
                let offset = self.settingsLayout.keptOffset(self.scroll.contentOffset.y, viewport: self.scroll.bounds.height, insets: LayoutInsets(self.scroll.adjustedContentInset))
                if offset != self.scroll.contentOffset.y { self.scroll.setContentOffset(CGPoint(x: 0, y: offset), animated: false) }
            }
        }
        guard view.window != nil else { return apply() }
        UIView.transition(with: scroll, duration: AppCoordinator.rootCrossfade, options: [.transitionCrossDissolve, .allowUserInteraction], animations: apply)
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
                rebuild()
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
                rebuild()
            }
        }
        prioritizingWatch = session.watch { [weak self] snapshot in
            guard let self, prioritizing != snapshot.prioritizing else { return }
            prioritizing = snapshot.prioritizing
            rebuild()
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
            let photo = source?.photo ?? source?.placeholder
            guard let self, let source, profileName != source.state.name || profilePhoto !== photo else { return }
            profileName = source.state.name
            profilePhoto = photo
            rebuild()
        })
        source.refresh()
    }

    // MARK: Rows

    /// Every account and agent connection this phone has, in one card, the
    /// active one ticked, with Connect Agent under them. Tapping one makes
    /// it the active one in place; there is no selector and no second Add
    /// anywhere on the page. Every kind is one
    /// row: its picture (or the placeholder its ID picks) round, its name,
    /// and the tick, as the switcher's menu draws them. No row has a line
    /// of its own; the chosen one's is under its name at the top.
    private func accountRows() -> [SettingsRow] {
        typealias Row = SettingsRow
        // The tick is on the profile the page shows: the active one, or the
        // one just tapped while the switch to it is made. A signed-in Happy
        // account and an open agent connection both call themselves active;
        // the page shows the first in the order shown, the connection, the
        // same one the switcher names.
        var rows: [SettingsRow] = profiles.enumerated().map { index, profile in
            Row(
                id: "account:\(profile.id)",
                title: profile.name,
                avatar: true,
                image: images[profile.id],
                value: profile.id == shownID ? "✓" : nil,
                accessory: .none,
                action: { [weak self] in self?.choose(index) },
                // Any of them goes from here, the shown one or not.
                menu: [Row.MenuItem(title: profile.isAgentConnection ? Strings.disconnect : Strings.signOut, glyph: "log-out-outline", destructive: true) { [weak self] in
                    self?.remove(profile.id, direct: profile.isAgentConnection)
                }]
            )
        }
        rows.append(Row(SettingsIndex.connectAgent, accessory: .none, action: { [weak self] in self?.connectAgent() }))
        return rows
    }

    private func rowsFor(_ profile: Profile) -> [[SettingsRow]] {
        typealias Row = SettingsRow
        typealias Index = SettingsIndex
        let id = profile.id
        if profile.isAgentConnection {
            return [
                accountRows(),
                [Row(Index.profile, image: profilePhoto, value: profileName.isEmpty ? nil : profileName, action: { [weak self] in self?.openProfile() })],
                [Row(Index.appearance, action: { [weak self] in self?.open(.appearance) })],
                [Row(Index.supportUs, action: { [weak self] in self?.open(.supportUs) })],
                aboutRows(),
                [Row(id: "disconnect", title: Strings.disconnect, accessory: .none, destructive: true, action: { [weak self] in self?.remove(id, direct: true) })],
            ]
        }
        return [
            accountRows(),
            [
                Row(Index.account, action: { [weak self] in self?.open(.account) }),
                Row(Index.backupRestore, action: { [weak self] in self?.open(.backup) }),
            ],
            [
                Row(Index.appearance, action: { [weak self] in self?.push(.settingsAppearance, for: id) }),
                Row(Index.language, action: { [weak self] in self?.open(.language) }),
                Row(Index.voice, action: { [weak self] in self?.open(.voice) }),
                Row(Index.agents, action: { [weak self] in self?.push(.settingsAgents, for: id) }),
            ],
            [
                Row(Index.scanTerminal, accessory: .none, action: { [weak self] in self?.connectTerminal(scanning: true) }),
                Row(Index.enterTerminal, accessory: .none, action: { [weak self] in self?.connectTerminal(scanning: false) }),
            ],
            [Row(Index.supportUs, action: { [weak self] in self?.open(.supportUs) })],
            aboutRows(),
            [Row(id: "sign-out", title: Strings.signOut, accessory: .none, destructive: true, action: { [weak self] in self?.remove(id, direct: false) })],
        ]
    }

    /// The pages a row opens in settings' cards.
    enum Page: CaseIterable {
        case appearance, supportUs, account, backup, voice, language
    }

    /// Whether `profile`'s page has `page`: a computer's look, or a Happy
    /// account's own pages, once that account is the active one.
    private func has(_ page: Page, _ profile: Profile) -> Bool {
        switch page {
        case .appearance: profile.isAgentConnection
        case .supportUs: true
        case .account, .backup, .voice, .language: !profile.isAgentConnection && activeSession != nil
        }
    }

    private func make(_ page: Page) -> SettingsPageViewController? {
        switch page {
        case .appearance: SettingsPageViewController(title: SettingsIndex.appearance.title) { [weak self] in self?.appearanceRows() ?? [] }
        case .supportUs: SupportUsViewController()
        case .account: activeSession.map { AccountSettingsViewController(context: context, session: $0) }
        case .backup: activeSession.map { BackupSettingsViewController(context: context, session: $0) }
        case .voice: activeSession.map { VoiceSettingsViewController(context: context, session: $0) }
        case .language: activeSession.map { SettingsLanguageViewController(session: $0) }
        }
    }

    /// The rows `page` shows, for search.
    private func rows(_ page: Page) -> [[SettingsRow]] {
        if page == .appearance { return appearanceRows() }
        return make(page)?.makeRows() ?? []
    }

    /// The page that holds the row `id`, if a page does.
    private func page(holding id: String) -> Page? {
        guard let profile = shown else { return nil }
        return Page.allCases.first { page in has(page, profile) && rows(page).joined().contains { $0.id == id } }
    }

    private func open(_ page: Page, reveal: String? = nil) {
        guard isTop, let controller = make(page) else { return }
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
            Row(Index.githubRepo, value: Strings.Links.githubDetail, action: { [weak self] in self?.openBrowser(Strings.Links.github) }),
            Row(Index.reportIssue, action: { [weak self] in self?.openBrowser(Strings.Links.issues) }),
            Row(Index.privacy, action: { [weak self] in self?.openBrowser(Strings.Links.privacy) }),
            Row(Index.terms, action: { [weak self] in self?.openBrowser(Strings.Links.terms) }),
            Row(Index.eula, action: { [weak self] in self?.openBrowser(Strings.Links.eula) }),
            Row(Index.version, value: SettingsIndexModel.versionDetail(version: context.version, variant: context.variant), accessory: .none, action: { [weak self] in self?.versionTapped() }),
        ].withFooter(Strings.Settings.aboutFooter)
    }

    /// What search looks through: the page's rows and the profiles.
    private func searchRows(_ query: String) -> [SettingsRow] {
        var found: [SettingsRow] = []
        for (index, profile) in profiles.enumerated() where profile.name.localizedCaseInsensitiveContains(query) {
            found.append(SettingsRow(id: "profile:\(profile.id)", title: profile.name, avatar: true, image: images[profile.id], value: profile.kind, action: { [weak self] in
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
            // A row on a page of its own opens that page and shows it there,
            // but the computer's look, which changes here.
            let pages = Page.allCases.filter { has($0, profile) }.flatMap { page in
                rows(page).joined().filter { !$0.dimmed && !$0.isCode }.map { row in
                    guard page != .appearance else { return row }
                    var row = row
                    row.action = { [weak self] in
                        self?.endSearch()
                        self?.open(page, reveal: row.id)
                    }
                    row.toggled = nil
                    row.accessory = .chevron
                    return row
                }
            }
            var titles = Set<String>()
            found += (rowsFor(profile).joined() + pages).filter { $0.title.localizedCaseInsensitiveContains(query) && !$0.destructive && titles.insert($0.title).inserted }
        }
        return found
    }

    private func rebuild() {
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
        // The profile's picture over its name, the one the accounts card
        // shows; only a connection's has the pencil and the agent's menu.
        agentButton.isHidden = searching
        agentButton.editable = profile.isAgentConnection
        agentButton.picture = images[profile.id]
        empty.isHidden = !(searching && !(query ?? "").isEmpty && rows.isEmpty)
        name.text = profile.name
        subtitle.text = profile.subtitle
        while cards.count < rows.count { let card = SettingsCardView(); scroll.addSubview(card); cards.append(card) }
        while cards.count > rows.count { cards.removeLast().removeFromSuperview() }
        view.setNeedsLayout()
        // A row search found that only came now (one waiting on the computer).
        if reveal != nil, view.window != nil { DispatchQueue.main.async { [weak self] in self?.showRevealed() } }
    }

    // MARK: Layout

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let width = view.bounds.width
        let searching = query != nil
        // Under the bar, whose row is in the safe area: the cards scroll under it.
        scroll.frame = view.bounds
        let specs = SettingsCardView.specs(rows, width: width)
        let picture = shown == nil ? nil : agentButton.intrinsicContentSize.width
        let layout = SettingsLayout(width: width, nameHeight: ceil(name.font.lineHeight), subtitleHeight: ceil(subtitle.font.lineHeight), cards: specs, footers: SettingsCardView.footers(rows, width: width), searching: searching, showsStrip: false, picture: picture)
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
        footers.show(rows.map { $0.last?.footer }, layout: layout.cards)
        scroll.contentSize = CGSize(width: width, height: layout.contentHeight)
    }

    // MARK: Search

    /// The bar's search field opened: the page narrows as it is typed in.
    func willPresentSearchController(_ searchController: UISearchController) {
        // Nothing for the field to sit beside on a wide phone: closing, it
        // goes straight back into its button, where beside Back it first
        // settled as a field next to it, then shrank (two motions). The
        // edge swipe still goes back meanwhile.
        navigationItem.setHidesBackButton(true, animated: true)
        query = ""
        rebuild()
    }

    func updateSearchResults(for searchController: UISearchController) {
        guard query != nil else { return }
        query = searchController.searchBar.text ?? ""
        rebuild()
    }

    func willDismissSearchController(_ searchController: UISearchController) {
        navigationItem.setHidesBackButton(false, animated: true)
        guard query != nil else { return }
        query = nil
        rebuild()
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
        rebuild()
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

    /// Signs out the account `id`, or disconnects the computer, once the
    /// person says so: from its row's hold, or Sign out and Disconnect.
    func remove(_ id: String, direct: Bool) {
        guard !busy else { return }
        busy = true
        Task { [weak self] in
            guard let self else { return }
            defer { busy = false }
            // A legacy account's key is the only way back: the warning says
            // so. One made for a computer has no key to bring it back.
            let account = context.account.accounts.first { $0.id == id }
            let detail = account.map { direct ? Strings.removeDetail : $0.isLegacy ? Strings.SettingsAccount.logoutConfirm : Strings.AccountSwitcher.signOutMadeForComputer($0.shownName) } ?? Strings.removeDetail
            guard await Alerts.confirm(direct ? Strings.disconnectTitle : Strings.signOutTitle, detail, confirmTitle: direct ? Strings.disconnect : Strings.signOut, destructive: true, on: self) else { return }
            await signOut(id, direct: direct)
        }
    }

    /// Once confirmed: the account goes, and a computer's session with it,
    /// only if it really went. A Happy account forgets nothing, since
    /// `Session.forget` also clears caches shared by every account.
    func signOut(_ id: String, direct: Bool) async {
        do {
            try await context.account.signOut(accountID: id)
            // Off its page first, so nothing here still watches its session.
            if shownID == id { shownID = nil }
            reload()
            if direct { Session.forget(id) }
            Haptics.play(.putAway)
        } catch {
            Alerts.show(Strings.couldNotRemove, error.localizedDescription, on: self)
        }
    }
}
#endif
