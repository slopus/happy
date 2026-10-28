#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyStore
import UIKit

/// Stem Cells settings, pushed from the picture in either home's header,
/// laid out as Telegram's settings are (its techniques, none of its code):
/// a glass bar (`StemCellsGlassBar`) with back at the left, and search then
/// the QR button in one capsule at the right; every computer and account as story circles, the chosen one
/// centred and ringed, its name and line under it; then every setting the
/// chosen profile has, in grouped cards, none of it behind a "More".
/// Direct connection to computers is an experiment, off until turned on
/// here; off, the computers are hidden and "+" links through the relay.
/// Swiping a profile to the middle makes it the active one and turns the
/// page to it, while home changes underneath (`AppCoordinator.install`
/// keeps this page on top); tapping its circle makes it the active one and
/// goes back to its home. "+" adds a computer in the link sheet.
///
/// A computer's page: its name and status; Prioritizing and Stories; the
/// theme, which each profile keeps on this phone; adding a computer or a
/// Happy account; About; Disconnect. A Happy account's: its own pages
/// (Account, Appearance, Language, Voice, Agents), its connected services,
/// connecting a terminal, Support us, adding; About; Sign out. Those pages
/// write to that account's synced settings, so they are on its page alone.
final class StemCellsSettingsViewController: UIViewController, UIScrollViewDelegate, UIGestureRecognizerDelegate {
    /// Pushes settings over `controller`, on `computer`'s page (the active
    /// profile's when nil). Once: a second tap meanwhile does nothing.
    static func open(context: AppContext, computer: String?, from controller: UIViewController) {
        guard let navigation = controller.navigationController, navigation.topViewController === controller else { return }
        navigation.pushViewController(StemCellsSettingsViewController(context: context, computer: computer), animated: true)
    }

    private struct Profile: Equatable {
        var id: String
        var name: String
        var subtitle: String
        var isDirect: Bool
        var isActive: Bool
    }

    private let context: AppContext
    private var shownID: String?
    private var profiles: [Profile] = []
    private let scroll = UIScrollView()
    private let carousel = StemCellsProfileCarouselView()
    private let name = UILabel()
    private let subtitle = UILabel()
    private var nameField: StemCellsRenameField?
    /// A rename sent, shown until the computer says the same.
    private var heldName: (id: String, name: String)?
    private var cards: [StemCellsSettingsCardView] = []
    private var rows: [[StemCellsSettingsRow]] = []
    private let bar = StemCellsGlassBar()
    private var query: String?
    private let empty = UILabel()
    private var observation: AccountsObservation?
    private var prioritizingWatch: StemCellsWatch?
    private var prioritizing: Bool?
    private var directSettingsWatch: Task<Void, Never>?
    private var projectsHidden = false
    private var storiesWatch: StemCellsWatch?
    /// Whether the computer offers Stories and the person has them on.
    private var stories: StoriesSnapshot.Availability?
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

    init(context: AppContext, computer: String?) {
        self.context = context
        shownID = computer
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.stemCellsSettingsGround)
        view.accessibilityIdentifier = "stem-settings"
        scroll.alwaysBounceVertical = true
        scroll.keyboardDismissMode = .interactive
        scroll.delegate = self
        view.addSubview(scroll)
        carousel.onSelect = { [weak self] index in self?.choose(index) }
        carousel.onTap = { [weak self] index in self?.choose(index, closing: true) }
        carousel.onAdd = { [weak self] _ in self?.addComputer() }
        scroll.addSubview(carousel)
        name.font = StemCellsFonts.ui(.medium, size: 28)
        name.textColor = UIColor(Palette.stemCellsSettingsText)
        name.textAlignment = .center
        name.accessibilityIdentifier = "stem-settings-name"
        name.isUserInteractionEnabled = true
        name.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(nameTapped)))
        subtitle.font = StemCellsFonts.ui(.regular, size: 17)
        subtitle.textColor = UIColor(Palette.stemCellsSettingsSecondary)
        subtitle.textAlignment = .center
        scroll.addSubview(name)
        scroll.addSubview(subtitle)
        empty.text = Strings.StemCells.nothingFound
        empty.font = StemCellsFonts.ui(.regular, size: 17)
        empty.textColor = UIColor(Palette.stemCellsSettingsSecondary)
        empty.textAlignment = .center
        empty.isHidden = true
        scroll.addSubview(empty)
        scroll.addGestureRecognizer({
            let tap = UITapGestureRecognizer(target: self, action: #selector(tappedAway))
            tap.cancelsTouchesInView = false
            tap.delegate = self
            return tap
        }())
        setUpBar()
        observation = context.account.observeAccounts { [weak self] _ in self?.reload() }
        reload()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // Back from Welcome without signing in: no account is being added.
        if context.account.isAddingAccount, presentedViewController == nil { context.account.cancelAddingAccount() }
    }

    override func didMove(toParent parent: UIViewController?) {
        super.didMove(toParent: parent)
        guard parent == nil else { return }
        // Gone with Welcome over it, its account was never added.
        if context.account.isAddingAccount { context.account.cancelAddingAccount() }
    }

    // MARK: Bar

    /// Back; no title, as Telegram's has none; search, then the QR button
    /// at the far right, in one capsule.
    private func setUpBar() {
        // On a tablet the shell's header holds back.
        bar.leading = traitCollection.isTabletLayout ? nil : .back
        bar.onLeading = { [weak self] in self?.navigationController?.popViewController(animated: true) }
        bar.actions = [
            StemCellsGlassBar.Action(image: StemCellsGlyphs.image("search", size: 22), label: Strings.StemCells.searchSettings, id: "stem-settings-search") { [weak self] in self?.beginSearch() },
            StemCellsGlassBar.Action(image: StemCellsGlyphs.image("qr-code-outline", size: 22), label: Strings.StemCells.showQR, id: "stem-settings-qr") { [weak self] in self?.showQR() },
        ]
        let field = bar.searchField
        field.placeholder = Strings.StemCells.searchSettings
        field.accessibilityIdentifier = "stem-settings-search-field"
        field.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            query = bar.searchField.text ?? ""
            rebuild(animated: false)
        }, for: .editingChanged)
        bar.onEndSearch = { [weak self] in self?.endSearch() }
        StemCellsGlassChrome.install(bar, on: self)
    }

    // MARK: Profiles

    private var shown: Profile? { profiles.first { $0.id == shownID } }

    /// Computers first, then Happy accounts, each in the order added.
    private func reload() {
        let accounts = context.account.accounts
        let direct = context.account.direct.accounts
        profiles = (accounts.filter(\.isDirect) + accounts.filter { !$0.isDirect }).map { account in
            if account.isDirect, let computer = direct.first(where: { $0.id == account.id }) {
                let name = heldName?.id == account.id ? heldName!.name : computer.name
                return Profile(id: account.id, name: name, subtitle: computer.status.title, isDirect: true, isActive: account.isActive)
            }
            let name = account.name ?? account.username ?? Strings.StemCells.happyAccount
            return Profile(id: account.id, name: name, subtitle: account.username.map { "@\($0)" } ?? Strings.StemCells.happyAccount, isDirect: false, isActive: account.isActive)
        }
        if let held = heldName, direct.first(where: { $0.id == held.id })?.name == held.name { heldName = nil }
        // With none left, the window's root is the link screen and this
        // page goes with the old one (`AppCoordinator.install`).
        guard !profiles.isEmpty else { return }
        if shown == nil { shownID = (profiles.first(where: \.isActive) ?? profiles[0]).id }
        for account in accounts { loadImage(account) }
        watchShown()
        showCarousel()
        rebuild(animated: false)
    }

    private func showCarousel() {
        let items = profiles.map { StemCellsProfileCarouselView.Item(id: $0.id, label: $0.name, image: images[$0.id], isDirect: $0.isDirect) }
        let selected = profiles.firstIndex { $0.id == shownID } ?? 0
        if carousel.items != items || carousel.selected != selected { carousel.set(items, selected: selected) }
    }

    private func loadImage(_ account: AccountSummary) {
        let key = StemCellsProfilePictures.key(account, context: context)
        guard imageKeys[account.id] != key else { return }
        imageKeys[account.id] = key
        imageJobs[account.id]?.cancel()
        imageJobs[account.id] = Task { [weak self] in
            guard let self else { return }
            let image = await StemCellsProfilePictures.load(account, context: context)
            guard !Task.isCancelled, imageKeys[account.id] == key else { return }
            images[account.id] = image
            showCarousel()
        }
    }

    /// The circle that came to rest, or was tapped: the page turns to it
    /// and it becomes the active profile, home changing under this page.
    /// `closing` (a tap) then goes back to that home, once it is there.
    private func choose(_ index: Int, closing: Bool = false) {
        guard profiles.indices.contains(index) else { return }
        let profile = profiles[index]
        endEditingName(keep: true)
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
                    Alerts.show(Strings.StemCells.couldNotSwitch, error.localizedDescription, on: self)
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

    /// Telegram's "Add Account", for a computer: the link sheet.
    private func addComputer() {
        endEditingName(keep: true)
        StemCellsLinkNavigationController.present(context: context, from: self)
    }

    /// Another Happy account, beside the profiles there are.
    private func addHappyAccount() {
        guard isTop else { return }
        context.account.beginAddingAccount()
        show(WelcomeViewController(context: context, offersPairing: false))
    }

    private func watchShown() {
        directSettingsWatch?.cancel(); directSettingsWatch = nil
        projectsHidden = false
        prioritizingWatch?.invalidate()
        prioritizingWatch = nil
        prioritizing = nil
        storiesWatch?.invalidate()
        storiesWatch = nil
        stories = nil
        settingsObservation = nil
        snapshot = SettingsSnapshot()
        guard let profile = shown else { return }
        if !profile.isDirect {
            // Only the active account has a session to read.
            guard let session = context.account.session, session.keys.anonID == profile.id else { return }
            settingsObservation = session.store.observeSettings { [weak self] snapshot in
                guard let self, self.snapshot != snapshot else { return }
                self.snapshot = snapshot
                rebuild(animated: false)
            }
            return
        }
        guard let session = StemCellsSession.session(for: profile.id, context: context) else { return }
        directSettingsWatch = Task { [weak self, engine = session.engine] in
            for await snapshot in await engine.snapshots() {
                guard !Task.isCancelled, let self else { return }
                let hidden = DirectSettings.projectsHidden(snapshot.settings)
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
        storiesWatch = StoriesSession.session(for: session).watch { [weak self] snapshot in
            guard let self, stories != snapshot.availability else { return }
            stories = snapshot.availability
            rebuild(animated: false)
        }
    }

    // MARK: Rows

    private func rowsFor(_ profile: Profile) -> [[StemCellsSettingsRow]] {
        typealias Row = StemCellsSettingsRow
        let id = profile.id
        let adding = [
            Row(id: "add-computer", title: Strings.StemCells.addComputer, icon: ("laptop-outline", .blue), action: { [weak self] in self?.addComputer() }),
            Row(id: "add-account", title: Strings.StemCells.addHappyAccount, icon: ("person-add-outline", .gray), action: { [weak self] in self?.addHappyAccount() }),
        ]
        if profile.isDirect {
            // Home follows desktop's authoritative account setting. There is
            // deliberately no independent renderer or layout selector here.
            var experiments = [Row(id: "hide-projects", title: "Hide projects", icon: ("folder-outline", .orange), accessory: .toggle, isOn: projectsHidden, toggled: { [weak self] on in
                guard let engine = self?.context.account.direct.syncEngine(for: id) else { return }
                Task { try? await engine.setProjectsHidden(on) }
            })]
            // Stories: only where the computer offers them.
            if stories == .on || stories == .off {
                experiments.append(Row(id: "stories", title: Strings.Stories.setting, icon: ("sparkles-outline", .blue), accessory: .toggle, isOn: stories == .on, toggled: { [weak self] on in self?.setStories(on) }))
            }
            experiments.append(directConnectionRow())
            return [
                [
                    Row(id: "edit-name", title: Strings.StemCells.editName, icon: ("create-outline", .blue), action: { [weak self] in self?.beginRename() }),
                    Row(id: "status", title: Strings.StemCells.status, icon: ("desktop-outline", .green), value: profile.subtitle, accessory: .none),
                ],
                experiments,
                [themeRow()],
                adding,
                aboutRows(),
                [Row(id: "disconnect", title: Strings.StemCells.disconnect, accessory: .none, destructive: true, action: { [weak self] in self?.remove(id, direct: true) })],
            ]
        }
        let model = SettingsIndexModel(profile: snapshot.profile)
        return [
            [
                Row(id: "account", title: Strings.Settings.account, icon: ("person-circle-outline", .blue), action: { [weak self] in self?.push(.settingsAccount, for: id) }),
                Row(id: "appearance", title: Strings.Settings.appearance, icon: ("color-palette-outline", .purple), action: { [weak self] in self?.push(.settingsAppearance, for: id) }),
                Row(id: "language", title: Strings.StemCells.language, icon: ("language-outline", .green), action: { [weak self] in self?.push(.settingsLanguage, for: id) }),
                Row(id: "voice", title: Strings.StemCells.voice, icon: ("mic-outline", .orange), action: { [weak self] in self?.push(.settingsVoice, for: id) }),
                Row(id: "agents", title: Strings.Settings.agents, icon: ("options-outline", .teal), action: { [weak self] in self?.push(.settingsAgents, for: id) }),
            ],
            [
                Row(id: "claude", title: Strings.Settings.claudeCode, icon: ("code-slash-outline", .orange), value: model.claudeConnected ? Strings.StemCells.connected : Strings.StemCells.connect, accessory: .none, action: { [weak self] in self?.claude(connected: model.claudeConnected) }),
                Row(id: "github", title: Strings.Settings.github, icon: ("logo-github", .gray), value: model.githubLogin.map { "@\($0)" } ?? Strings.StemCells.connect, accessory: .none, action: { [weak self] in self?.github(connected: model.githubLogin != nil) }),
            ],
            [
                Row(id: "scan-terminal", title: Strings.StemCells.connectTerminal, icon: ("qr-code-outline", .indigo), accessory: .none, action: { [weak self] in self?.connectTerminal(scanning: true) }),
                Row(id: "enter-terminal", title: Strings.StemCells.enterTerminalURL, icon: ("link-outline", .indigo), accessory: .none, action: { [weak self] in self?.connectTerminal(scanning: false) }),
            ],
            [directConnectionRow()],
            [Row(id: "support-us", title: Strings.SupportUs.title, icon: ("heart-outline", .red), action: { [weak self] in self?.show(SupportUsViewController()) })],
            adding,
            aboutRows(),
            [Row(id: "sign-out", title: Strings.StemCells.signOut, accessory: .none, destructive: true, action: { [weak self] in self?.remove(id, direct: false) })],
        ]
    }

    /// The Direct connection experiment, on this phone.
    private func directConnectionRow() -> StemCellsSettingsRow {
        let context = context
        return StemCellsSettingsRow(id: "direct-connection", title: Strings.StemCells.directConnection, icon: ("flask-outline", .purple), accessory: .toggle, isOn: StemCellsPreference(variant: context.variant).directConnection, toggled: { on in
            StemCellsExperiments.turn(on, context: context, surface: .settings)
        })
    }

    /// The profile's theme on this phone: a tap goes Adaptive, Light, Dark.
    private func themeRow() -> StemCellsSettingsRow {
        StemCellsSettingsRow(id: "theme", title: Strings.SettingsAppearance.theme, icon: ("contrast-outline", .indigo), value: Self.themeName(context.account.localSettings.themePreference), accessory: .none, action: { [weak self] in self?.cycleTheme() })
    }

    private func aboutRows() -> [StemCellsSettingsRow] {
        typealias Row = StemCellsSettingsRow
        return [
            Row(id: "whats-new", title: Strings.Settings.whatsNew, icon: ("sparkles-outline", .orange), action: { [weak self] in self?.show(ChangelogViewController()) }),
            Row(id: "github-repo", title: Strings.Settings.github, icon: ("logo-github", .gray), value: Strings.Links.githubDetail, action: { UIApplication.shared.open(Strings.Links.github) }),
            Row(id: "report-issue", title: Strings.Settings.reportIssue, icon: ("bug-outline", .red), action: { UIApplication.shared.open(Strings.Links.issues) }),
            Row(id: "privacy", title: Strings.Settings.privacyPolicy, icon: ("shield-checkmark-outline", .blue), action: { UIApplication.shared.open(Strings.Links.privacy) }),
            Row(id: "terms", title: Strings.Settings.termsOfService, icon: ("document-text-outline", .gray), action: { UIApplication.shared.open(Strings.Links.terms) }),
            Row(id: "eula", title: Strings.Settings.eula, icon: ("document-text-outline", .gray), action: { UIApplication.shared.open(Strings.Links.eula) }),
            Row(id: "version", title: Strings.Common.version, icon: ("information-circle-outline", .gray), value: SettingsIndexModel.versionDetail(version: context.version, variant: context.variant), accessory: .none, action: { [weak self] in self?.versionTapped() }),
        ]
    }

    /// What search looks through: the page's rows and the profiles.
    private func searchRows(_ query: String) -> [StemCellsSettingsRow] {
        var found: [StemCellsSettingsRow] = []
        for (index, profile) in profiles.enumerated() where profile.name.localizedCaseInsensitiveContains(query) {
            found.append(StemCellsSettingsRow(id: "profile:\(profile.id)", title: profile.name, icon: (profile.isDirect ? "desktop-outline" : "person-outline", .blue), value: profile.isDirect ? Strings.StemCells.directComputer : Strings.StemCells.happyAccount, action: { [weak self] in
                self?.endSearch()
                self?.carousel.set(self?.carousel.items ?? [], selected: index)
                self?.choose(index)
            }))
        }
        if let profile = shown {
            found += rowsFor(profile).flatMap { $0 }.filter { $0.title.localizedCaseInsensitiveContains(query) && !$0.destructive }
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
        // A row tapped keeps a name being typed first.
        rows = rows.map { card in
            card.map { row in
                var row = row
                if let action = row.action {
                    row.action = { [weak self] in
                        self?.endEditingName(keep: true)
                        action()
                    }
                }
                return row
            }
        }
        let searching = query != nil
        carousel.isHidden = searching
        name.isHidden = searching || nameField != nil
        subtitle.isHidden = searching
        empty.isHidden = !(searching && !(query ?? "").isEmpty && rows.isEmpty)
        let text = heldName?.id == profile.id ? heldName!.name : profile.name
        for (label, value) in [(name, text), (subtitle, profile.subtitle)] where label.text != value {
            if animated {
                UIView.transition(with: label, duration: 0.2, options: [.transitionCrossDissolve, .beginFromCurrentState], animations: { label.text = value })
            } else {
                label.text = value
            }
        }
        name.accessibilityTraits = profile.isDirect ? .button : .staticText
        while cards.count < rows.count { let card = StemCellsSettingsCardView(); scroll.addSubview(card); cards.append(card) }
        while cards.count > rows.count { cards.removeLast().removeFromSuperview() }
        view.setNeedsLayout()
        if animated {
            for card in cards { card.alpha = 0 }
            view.layoutIfNeeded()
            UIView.animate(withDuration: 0.2) { for card in self.cards { card.alpha = 1 } }
        }
    }

    // MARK: Layout

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // On a tablet the shell's header holds back, as the window resizes too.
        let leading: StemCellsGlassBar.Leading? = traitCollection.isTabletLayout ? nil : .back
        if bar.leading != leading { bar.leading = leading }
        let width = view.bounds.width
        let searching = query != nil
        // Under the bar, whose row is in the safe area: the cards scroll under it.
        scroll.frame = view.bounds
        let specs = rows.map { card in
            card.map { StemCellsSettingsLayout.RowSpec(hasIcon: $0.icon != nil, valueWidth: StemCellsSettingsCardView.valueWidth($0.value), accessory: $0.accessory) }
        }
        let layout = StemCellsSettingsLayout(width: width, nameHeight: ceil(name.font.lineHeight), subtitleHeight: ceil(subtitle.font.lineHeight), cards: specs, searching: searching)
        carousel.frame = layout.strip
        name.frame = layout.name
        nameField?.frame = layout.name
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

    /// A field takes the bar's row, as Telegram's does.
    private func beginSearch() {
        endEditingName(keep: true)
        query = ""
        bar.searchField.text = ""
        rebuild(animated: false)
        UIView.animate(withDuration: 0.25) { self.bar.isSearching = true }
        bar.searchField.becomeFirstResponder()
    }

    private func endSearch() {
        query = nil
        bar.searchField.resignFirstResponder()
        rebuild(animated: false)
        UIView.animate(withDuration: 0.25) { self.bar.isSearching = false }
    }

    // MARK: Rename

    @objc private func nameTapped() { beginRename() }

    /// The name, in place, as a field; Return or a tap away keeps it.
    private func beginRename() {
        guard nameField == nil, query == nil, let profile = shown, profile.isDirect else { return }
        let field = StemCellsRenameField()
        field.font = name.font
        field.textColor = name.textColor
        field.tintColor = UIColor(Palette.stemCellsSettingsPrimary)
        field.textAlignment = .center
        field.text = name.text
        field.returnKeyType = .done
        field.autocapitalizationType = .words
        field.accessibilityIdentifier = "stem-settings-rename"
        field.frame = name.frame
        field.onFinish = { [weak self] kept in self?.finishRename(profile.id, kept: kept) }
        scroll.addSubview(field)
        nameField = field
        name.isHidden = true
        view.setNeedsLayout()
        field.becomeFirstResponder()
        field.selectAll(nil)
    }

    private func endEditingName(keep: Bool) {
        guard let field = nameField else { return }
        // Its own profile's, whichever shows now.
        if field.isFirstResponder { field.resignFirstResponder() } else { field.onFinish?(keep ? field.text : nil) }
    }

    @objc private func tappedAway() {
        endEditingName(keep: true)
    }

    /// Beside the circles' and rows' own taps, never instead of them; not
    /// on the name, whose tap starts the rename, or the rows.
    func gestureRecognizer(_ gesture: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        guard let view = touch.view else { return true }
        if view === name || cards.contains(where: { view.isDescendant(of: $0) }) { return false }
        return nameField.map { !view.isDescendant(of: $0) } ?? true
    }

    func gestureRecognizer(_ gesture: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

    private func finishRename(_ id: String, kept: String?) {
        guard let field = nameField else { return }
        nameField = nil
        field.onFinish = nil
        field.removeFromSuperview()
        name.isHidden = query != nil
        view.setNeedsLayout()
        let previous = profiles.first { $0.id == id }?.name
        guard let kept = kept?.trimmingCharacters(in: .whitespacesAndNewlines), !kept.isEmpty, kept != previous else { return }
        // Shown at once and kept until the computer says the same: no flicker back.
        heldName = (id, kept)
        name.text = kept
        StemCellsHaptics.play(.renamed)
        Task { [weak self] in
            guard let self else { return }
            do {
                try await context.account.direct.rename(id, to: kept)
            } catch {
                heldName = nil
                reload()
                let message = StemCellsStore.describe(error)
                Alerts.show(Strings.StemCells.couldNotRename, message.isEmpty ? error.localizedDescription : message, on: self)
            }
        }
    }

    // MARK: Actions

    private func setPrioritizing(_ on: Bool) {
        guard let profile = shown, let session = StemCellsSession.session(for: profile.id, context: context) else { return }
        prioritizing = on
        let store = session.store
        Task { await store.setPrioritizing(on) }
    }

    private func setStories(_ on: Bool) {
        guard let profile = shown, let session = StemCellsSession.session(for: profile.id, context: context) else { return }
        stories = on ? .on : .off
        let store = StoriesSession.session(for: session).store
        Task { await store.setEnabled(on) }
    }

    /// Adaptive, Light, Dark, and round again, as Happy's Appearance page
    /// does. A sheet of the three would be dismissing as the whole window
    /// changes style under it, which UIKit leaves drawn.
    private func cycleTheme() {
        ThemeController.set(context.account.localSettings.themePreference.next, in: context)
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

    /// Pushed in the glass bar this page wears.
    private func show(_ controller: UIViewController) {
        guard isTop else { return }
        StemCellsGlassChrome.dress(controller, over: self)
        navigationController?.pushViewController(controller, animated: true)
    }

    /// Nothing pushed or on its way: a second tap meanwhile opens nothing.
    private var isTop: Bool {
        navigationController?.topViewController === self && navigationController?.transitionCoordinator == nil && presentedViewController == nil
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
        guard !connecting, let session = activeSession else { return }
        connecting = true
        Task { @MainActor in
            defer { connecting = false }
            let text = scanning ? await SettingsConnections.scanTerminal(on: self) : await SettingsConnections.promptTerminalURL(on: self)
            guard let text else { return }
            await SettingsConnections.approveTerminal(text, session: session, on: self)
        }
    }

    private func showQR() {
        guard let profile = shown else { return }
        endEditingName(keep: true)
        let sheet = StemCellsQRSheetViewController(name: profile.name, image: images[profile.id], isDirect: profile.isDirect)
        sheet.onScan = { [weak self] in
            guard let self else { return }
            StemCellsScan.scan(context: context, on: self)
        }
        sheet.onEnterLink = { [weak self] in
            guard let self else { return }
            StemCellsScan.enterLink(context: context, on: self)
        }
        present(sheet, animated: true)
    }

    private func remove(_ id: String, direct: Bool) {
        guard !busy else { return }
        busy = true
        Task { [weak self] in
            guard let self else { return }
            defer { busy = false }
            guard await Alerts.confirm(direct ? Strings.StemCells.disconnectTitle : Strings.StemCells.signOutTitle, Strings.StemCells.removeDetail, confirmTitle: direct ? Strings.StemCells.disconnect : Strings.StemCells.signOut, destructive: true, on: self) else { return }
            do {
                try await context.account.signOut(accountID: id)
                if direct { StemCellsSession.forget(id) }
                StemCellsHaptics.play(.putAway)
                shownID = nil
                reload()
            } catch {
                Alerts.show(Strings.StemCells.couldNotRemove, error.localizedDescription, on: self)
            }
        }
    }
}
/// The Direct connection experiment: computers paired straight to this
/// phone. Turned off, they stay paired but hidden, and a computer open
/// gives way to the Happy account, or Welcome.
@MainActor
enum StemCellsExperiments {
    static func setDirectConnection(_ on: Bool, context: AppContext, surface: PairingSurface) async {
        guard record(on, context: context, surface: surface) else { return }
        await context.account.setShowsComputers(StemCellsPreference(variant: context.variant).showsComputers)
    }

    /// From a switch: the choice is kept at once, so the page drawn again
    /// meanwhile shows it; the computers follow.
    static func turn(_ on: Bool, context: AppContext, surface: PairingSurface) {
        guard record(on, context: context, surface: surface) else { return }
        Task { await context.account.setShowsComputers(StemCellsPreference(variant: context.variant).showsComputers) }
    }

    private static func record(_ on: Bool, context: AppContext, surface: PairingSurface) -> Bool {
        let preference = StemCellsPreference(variant: context.variant)
        guard preference.isAvailable, preference.directConnection != on else { return false }
        preference.directConnection = on
        PairingAnalytics.shared.log(.experimentToggled(on: on, surface: surface))
        return true
    }
}
#endif
