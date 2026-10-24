#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Settings in a stack of its own, shown as a sheet over home. Home's root
/// changes when another profile is chosen; this sheet stays up through it
/// while it shows only its own page (`AppCoordinator.install`).
final class StemCellsSettingsNavigationController: UINavigationController {
    private var context: AppContext?

    static func present(context: AppContext, computer: String?, from controller: UIViewController) {
        let navigation = StemCellsSettingsNavigationController(rootViewController: StemCellsSettingsViewController(context: context, computer: computer))
        navigation.context = context
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        navigation.modalPresentationStyle = .pageSheet
        controller.present(navigation, animated: true)
    }

    /// Kept up through a root change only on its own page with nothing
    /// over it; a pushed flow that ends in a root change (pairing, signing
    /// in, signing out) goes with the old root.
    var keepsThroughRootChange: Bool {
        viewControllers.count == 1 && presentedViewController == nil
    }

    /// Adding a Happy account ends when the sheet goes, signed in or not.
    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isBeingDismissed, context?.account.isAddingAccount == true { context?.account.cancelAddingAccount() }
    }
}

/// Stem Cells settings, opened from the computer's picture in home's
/// header, laid out as Telegram's settings are (its techniques, none of
/// its code): a bar with the QR button at the left and a capsule of search
/// and Edit at the right; every computer and account as story circles,
/// the chosen one centred and ringed, its name and line under it; then a
/// few grouped cards. Choosing a profile makes it the active one and
/// turns the page to it.
///
/// Kept sparse on purpose. On a computer: Prioritizing, More, Disconnect.
/// On a Happy account: Account, Appearance, Language, More, Sign out.
/// The computer's status, adding a Happy account and Happy's whole
/// settings went under More; switching and adding went into the circles;
/// pairing into the QR button; renaming into Edit.
final class StemCellsSettingsViewController: UIViewController, UIScrollViewDelegate {
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
    private let qr = StemCellsGlassView()
    private let capsule = StemCellsGlassView()
    private let searchButton = UIButton(type: .system)
    private let editButton = UIButton(type: .system)
    private let searchField = UISearchTextField()
    private let cancelSearch = UIButton(type: .system)
    private var query: String?
    private let empty = UILabel()
    private var observation: AccountsObservation?
    private var prioritizingWatch: StemCellsWatch?
    private var prioritizing: Bool?
    private var storiesWatch: StemCellsWatch?
    /// Whether the computer offers Stories and the person has them on.
    private var stories: StoriesSnapshot.Availability?
    private var images: [String: UIImage] = [:]
    private var imageKeys: [String: String] = [:]
    private var imageJobs: [String: Task<Void, Never>] = [:]
    private var busy = false
    private var switching: Task<Void, Never>?

    init(context: AppContext, computer: String?) {
        self.context = context
        shownID = computer
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = Strings.Settings.title
        view.backgroundColor = UIColor(Palette.stemCellsSettingsGround)
        view.accessibilityIdentifier = "stem-settings"
        scroll.alwaysBounceVertical = true
        scroll.keyboardDismissMode = .interactive
        scroll.delegate = self
        view.addSubview(scroll)
        carousel.onSelect = { [weak self] index in self?.choose(index) }
        carousel.onAdd = { [weak self] in
            guard let self else { return }
            StemCellsScan.scan(context: context, on: self)
        }
        scroll.addSubview(carousel)
        name.font = StemCellsFonts.ui(.medium, size: 28)
        name.textColor = UIColor(Palette.stemCellsSettingsText)
        name.textAlignment = .center
        name.accessibilityIdentifier = "stem-settings-name"
        name.isUserInteractionEnabled = true
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
            // Beside the circles' and rows' own taps, never instead of them.
            tap.delegate = PressRecognizer.simultaneous
            return tap
        }())
        setUpBar()
        observation = context.account.observeAccounts { [weak self] _ in self?.reload() }
        reload()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setNavigationBarHidden(true, animated: animated)
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if navigationController?.topViewController !== self { navigationController?.setNavigationBarHidden(false, animated: animated) }
    }

    // MARK: Bar

    private func setUpBar() {
        let qrButton = UIButton(type: .system)
        qrButton.setImage(StemCellsGlyphs.image("qr-code-outline", size: 22), for: .normal)
        qrButton.tintColor = UIColor(Palette.stemCellsSettingsRing)
        qrButton.accessibilityLabel = Strings.StemCells.showQR
        qrButton.accessibilityIdentifier = "stem-settings-qr"
        qrButton.addAction(UIAction { [weak self] _ in self?.showQR() }, for: .touchUpInside)
        qr.content.addSubview(qrButton)
        qrButton.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(qr)
        searchButton.setImage(StemCellsGlyphs.image("search-outline", size: 20), for: .normal)
        searchButton.tintColor = UIColor(Palette.stemCellsSettingsRing)
        searchButton.accessibilityLabel = Strings.StemCells.searchSettings
        searchButton.accessibilityIdentifier = "stem-settings-search"
        searchButton.addAction(UIAction { [weak self] _ in self?.beginSearch() }, for: .touchUpInside)
        capsule.content.addSubview(searchButton)
        editButton.setTitle(Strings.StemCells.edit, for: .normal)
        editButton.titleLabel?.font = StemCellsFonts.ui(.semiBold, size: 17)
        editButton.setTitleColor(UIColor(Palette.stemCellsSettingsRing), for: .normal)
        editButton.contentHorizontalAlignment = .left
        editButton.accessibilityIdentifier = "stem-settings-edit"
        editButton.addAction(UIAction { [weak self] _ in self?.editTapped() }, for: .touchUpInside)
        capsule.content.addSubview(editButton)
        view.addSubview(capsule)
        searchField.placeholder = Strings.StemCells.searchSettings
        searchField.font = StemCellsFonts.ui(.regular, size: 17)
        searchField.returnKeyType = .search
        searchField.accessibilityIdentifier = "stem-settings-search-field"
        searchField.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            query = searchField.text ?? ""
            rebuild(animated: false)
        }, for: .editingChanged)
        searchField.isHidden = true
        view.addSubview(searchField)
        cancelSearch.setTitle(Strings.Common.cancel, for: .normal)
        cancelSearch.titleLabel?.font = StemCellsFonts.ui(.regular, size: 17)
        cancelSearch.setTitleColor(UIColor(Palette.stemCellsSettingsPrimary), for: .normal)
        cancelSearch.isHidden = true
        cancelSearch.addAction(UIAction { [weak self] _ in self?.endSearch() }, for: .touchUpInside)
        view.addSubview(cancelSearch)
    }

    private var editWidth: CGFloat? {
        guard shown?.isDirect == true else { return nil }
        let title = nameField == nil ? Strings.StemCells.edit : Strings.StemCells.done
        return (title as NSString).size(withAttributes: [.font: StemCellsFonts.ui(.semiBold, size: 17)]).width
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
            return Profile(id: account.id, name: name, subtitle: account.username.map { "@\($0)" } ?? account.serverURL.host ?? Strings.StemCells.happyAccount, isDirect: false, isActive: account.isActive)
        }
        if let held = heldName, direct.first(where: { $0.id == held.id })?.name == held.name { heldName = nil }
        guard !profiles.isEmpty else {
            presentingViewController?.dismiss(animated: true)
            return
        }
        if shown == nil { shownID = (profiles.first(where: \.isActive) ?? profiles[0]).id }
        for account in accounts { loadImage(account) }
        watchPrioritizing()
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

    /// The circle that came to rest: the page turns to it and it becomes
    /// the active profile (home changes under this sheet).
    private func choose(_ index: Int) {
        guard profiles.indices.contains(index) else { return }
        let profile = profiles[index]
        endEditingName(keep: true)
        shownID = profile.id
        watchPrioritizing()
        rebuild(animated: true)
        guard !profile.isActive else { return }
        // One switch at a time, and only the last choice still wanted; a
        // failed one turns the page back to the profile that is active.
        let previous = switching
        switching = Task { [weak self] in
            await previous?.value
            guard let self, shownID == profile.id,
                  context.account.accounts.first(where: { $0.id == profile.id })?.isActive == false else { return }
            do { try await context.account.switchAccount(to: profile.id) }
            catch {
                guard shownID == profile.id else { return }
                shownID = context.account.accounts.first(where: \.isActive)?.id
                reload()
                Alerts.show(Strings.StemCells.couldNotSwitch, error.localizedDescription, on: self)
            }
        }
    }

    private func watchPrioritizing() {
        prioritizingWatch?.invalidate()
        prioritizingWatch = nil
        prioritizing = nil
        storiesWatch?.invalidate()
        storiesWatch = nil
        stories = nil
        guard let profile = shown, profile.isDirect, let session = StemCellsSession.session(for: profile.id, context: context) else { return }
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
        let id = profile.id
        if profile.isDirect {
            var experiments = [StemCellsSettingsRow(id: "prioritizing", title: Strings.StemCells.prioritizing, icon: ("pulse-outline", .orange), accessory: .toggle, isOn: prioritizing == true, toggled: { [weak self] on in self?.setPrioritizing(on) })]
            // Stories: only where the computer offers them.
            if stories == .on || stories == .off {
                experiments.append(StemCellsSettingsRow(id: "stories", title: Strings.Stories.setting, icon: ("sparkles-outline", .blue), accessory: .toggle, isOn: stories == .on, toggled: { [weak self] on in self?.setStories(on) }))
            }
            return [
                experiments,
                [StemCellsSettingsRow(id: "more", title: Strings.StemCells.more, icon: ("more", .gray), action: { [weak self] in self?.openMore(profile) })],
                [StemCellsSettingsRow(id: "disconnect", title: Strings.StemCells.disconnect, accessory: .none, destructive: true, action: { [weak self] in self?.remove(id, direct: true) })],
            ]
        }
        return [
            [
                StemCellsSettingsRow(id: "account", title: Strings.StemCells.account, icon: ("person-outline", .blue), action: { [weak self] in self?.push(.settingsAccount, for: id) }),
                StemCellsSettingsRow(id: "appearance", title: Strings.StemCells.appearance, icon: ("color-palette-outline", .purple), action: { [weak self] in self?.push(.settingsAppearance, for: id) }),
                StemCellsSettingsRow(id: "language", title: Strings.StemCells.language, icon: ("language-outline", .green), action: { [weak self] in self?.push(.settingsLanguage, for: id) }),
            ],
            [StemCellsSettingsRow(id: "more", title: Strings.StemCells.more, icon: ("more", .gray), action: { [weak self] in self?.push(.settings, for: id) })],
            [StemCellsSettingsRow(id: "sign-out", title: Strings.StemCells.signOut, accessory: .none, destructive: true, action: { [weak self] in self?.remove(id, direct: false) })],
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
        let width = view.bounds.width
        let searching = query != nil
        let bar = StemCellsSettingsBarLayout(width: width, safeTop: view.safeAreaInsets.top, editWidth: editWidth, cancelWidth: searching ? cancelSearch.intrinsicContentSize.width : nil)
        qr.frame = bar.qr
        capsule.frame = bar.capsule
        searchButton.frame = bar.search
        editButton.isHidden = bar.edit == nil
        editButton.setTitle(nameField == nil ? Strings.StemCells.edit : Strings.StemCells.done, for: .normal)
        if let edit = bar.edit { editButton.frame = edit }
        qr.isHidden = searching
        capsule.isHidden = searching
        searchField.isHidden = !searching
        cancelSearch.isHidden = !searching
        if let field = bar.field, let cancel = bar.cancel {
            searchField.frame = field
            cancelSearch.frame = cancel
        }
        scroll.frame = view.bounds
        let top = bar.bottom
        if scroll.contentInset.top != top {
            scroll.contentInset.top = top
            scroll.verticalScrollIndicatorInsets.top = top
        }
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

    private func beginSearch() {
        endEditingName(keep: true)
        query = ""
        searchField.text = ""
        rebuild(animated: false)
        view.setNeedsLayout()
        view.layoutIfNeeded()
        searchField.becomeFirstResponder()
    }

    private func endSearch() {
        query = nil
        searchField.resignFirstResponder()
        rebuild(animated: false)
        view.setNeedsLayout()
    }

    // MARK: Rename (Edit)

    private func editTapped() {
        if nameField != nil { endEditingName(keep: true); return }
        guard let profile = shown, profile.isDirect else { return }
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
        if field.isFirstResponder { field.resignFirstResponder() } else { finishRename(shownID ?? "", kept: keep ? field.text : nil) }
    }

    @objc private func tappedAway() {
        endEditingName(keep: true)
    }

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

    /// A Happy account's page, once that account is the active one.
    private func push(_ route: Route, for id: String) {
        guard context.account.session != nil, context.account.accounts.first(where: { $0.id == id })?.isActive == true else { return }
        push(route, context: context)
    }

    private func openMore(_ profile: Profile) {
        navigationController?.pushViewController(StemCellsMoreViewController(context: context, computer: profile.id), animated: true)
    }

    private func showQR() {
        guard let profile = shown else { return }
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

/// What a computer's page keeps out of the way: its status, adding a
/// Happy account, and Happy's whole settings when one is signed in.
final class StemCellsMoreViewController: UIViewController {
    private let context: AppContext
    private let computer: String
    private let list = GroupedListView()
    private var observation: AccountsObservation?

    init(context: AppContext, computer: String) {
        self.context = context
        self.computer = computer
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func loadView() { view = list }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = Strings.StemCells.more
        view.accessibilityIdentifier = "stem-settings-more"
        observation = context.account.observeAccounts { [weak self] _ in self?.update() }
    }

    /// Back from signing in without finishing: no account is being added.
    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        if context.account.isAddingAccount { context.account.cancelAddingAccount() }
    }

    private func update() {
        let status = context.account.direct.accounts.first { $0.id == computer }?.status.title
        let state = ItemRowView(title: Strings.StemCells.status, subtitle: status, icon: ItemIcon(.ionicons("desktop-outline"), tint: Palette.iconBlue))
        state.showsChevron = false
        let add = ItemRowView(title: Strings.StemCells.addHappyAccount, icon: ItemIcon(.ionicons("person-add-outline"), tint: Palette.iconBlue)) { [weak self] in
            guard let self else { return }
            context.account.beginAddingAccount()
            navigationController?.pushViewController(WelcomeViewController(context: context), animated: true)
        }
        var sections: [UIView] = [ItemGroupView(rows: [state]), ItemGroupView(rows: [add])]
        if context.account.session != nil {
            let happy = ItemRowView(title: Strings.StemCells.happySettings, icon: ItemIcon(.ionicons("settings-outline"), tint: Palette.iconBlue)) { [weak self] in
                guard let self else { return }
                push(.settings, context: context)
            }
            sections.append(ItemGroupView(rows: [happy]))
        }
        list.sections = sections
    }
}
#endif
