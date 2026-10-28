#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Home in Stem Cells mode: one paired computer's sidebar, as desktop's
/// `HappyAgentSpacesSidebar` draws it, under home's header and over the
/// dock. The dock is the new-work screen's own composer, drawn the same and
/// in the same place: a tap in it makes new work, sent with the model its
/// chips hold, and its "+" makes new work with the library open over it.
/// Desktop's Search and Create rows aren't drawn: search is the header's
/// button and create is the dock.
///
/// Search happens here, in place: the header's search pill grows into a
/// field with the keyboard up, the dock steps aside, and the sidebar
/// narrows to what answers as it's typed, with the quick actions and the
/// settings that answer below it, as desktop's ⌘K palette lists them.
/// Ending it puts the list back as it was, folds and scroll and all.
final class StemCellsHomeViewController: UIViewController {
    private let context: AppContext
    /// The computer this screen always shows; nil to follow the choice.
    private let fixedComputer: String?
    private let sidebar = StemCellsSidebarView()
    private let banner = StemCellsBannerView()
    private let empty = StemCellsEmptyView()
    private let dock = AgentInputCardView(configuration: AgentInputCardConfiguration(placeholder: Strings.StemCells.composerPlaceholder))
    private let dockScrim = HeaderScrimView(edge: .bottom)
    private var modelsWatch: StemCellsWatch?
    /// The dock's model or effort list while it is open.
    private var picker: StemCellPickerPresenter?
    private var session: StemCellsSession?
    private var watch: StemCellsWatch?
    private var accountsObservation: AccountsObservation?
    private var carryWork: Task<Void, Never>?
    private var snapshot = StemCellsSnapshot()
    private var directHome = DirectHomeSnapshot()
    private var directWatch: Task<Void, Never>?
    private var usesSpaces: Bool { directHome.usesSpaces && session?.snapshot.availability != .unsupported }
    private var creating = false
    /// Stories, in home's header: open under it, or closed into its title.
    /// Nothing at all while Stories are off.
    private lazy var stories = StoriesHomeController(host: self)
    /// How the stories last changed the list's room, while it is applied.
    private var storiesChange: StoriesHomeController.Change?
    /// Search, in the header, while it is open.
    private var search: Search?
    private let nothingFound = UILabel()
    /// The keyboard's top in this screen; nil while it has never shown.
    private var keyboardTop: CGFloat?

    private struct Search {
        var query = ""
        /// How far below its top the list was when search opened: where
        /// it goes back to.
        var fromTop: CGFloat
        /// Something is typed, so the list is narrowed to what answers it.
        var narrowed = false
        /// What each quick action or setting found does, by its row's id.
        var results: [String: () -> Void] = [:]
    }

    /// One of desktop's palette actions (`actionRows`), as a phone has them.
    private struct QuickAction {
        var id: String
        var title: String
        var glyph: String
        var run: () -> Void
    }

    /// The header home floats over this screen, for the stories to live in.
    weak var header: HomeHeaderView? {
        didSet {
            guard header !== oldValue else { return }
            stories.install(in: header)
            if let header { wireSearch(header) }
        }
    }

    /// Every snapshot shown, for the screen around this one.
    var onSnapshot: ((StemCellsSnapshot) -> Void)?

    /// The dock, which new work's own composer stands in for as it opens.
    var newWorkDock: UIView { dock }

    /// The header and dock home lays its content between.
    var contentInsets = HomeContentInsets(safeArea: .zero, dock: 0) {
        didSet { if contentInsets != oldValue { view.setNeedsLayout() } }
    }

    init(context: AppContext, computer: String? = nil) {
        self.context = context
        fixedComputer = computer
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        // The conversation's own ground, light and dark.
        view.backgroundColor = UIColor(Palette.surface)
        view.addSubview(sidebar)
        view.addSubview(empty)
        view.addSubview(banner)
        view.addSubview(dockScrim)
        nothingFound.text = Strings.StemCells.nothingFound
        nothingFound.font = StemCellsFonts.ui(.regular, size: 17)
        nothingFound.textColor = UIColor(Palette.stemCellsRowText)
        nothingFound.textAlignment = .center
        nothingFound.numberOfLines = 0
        nothingFound.isHidden = true
        nothingFound.accessibilityIdentifier = "stem-search-nothing"
        view.addSubview(nothingFound)
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardWillChange(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        dock.configuration.showsAdd = true
        dock.configuration.addAccessibilityLabel = Strings.StemCells.addPicture
        dock.configuration.primaryAction = AgentInputPrimaryAction.resolve(
            hasComposerContent: false, isSendBlocked: false, isSendDisabled: false, showAbortButton: false, canAbort: false
        )
        dock.delegate = self
        // Nothing is typed here: the field is where new work begins.
        dock.textView.isUserInteractionEnabled = false
        let entry = UITapGestureRecognizer(target: self, action: #selector(dockTapped(_:)))
        entry.delegate = self
        dock.addGestureRecognizer(entry)
        dock.isAccessibilityElement = false
        dock.textView.isAccessibilityElement = true
        dock.textView.accessibilityTraits = .button
        dock.textView.accessibilityLabel = Strings.StemCells.composerPlaceholder
        dock.textView.accessibilityIdentifier = "stem-new-work"
        view.addSubview(dock)
        sidebar.onSelect = { [weak self] row in self?.open(row) }
        sidebar.onIntent = { [weak self] row in
            guard let agentId = row.agentId, row.targetKind != "surface" else { return }
            self?.session?.warm.intent(agentId)
        }
        sidebar.onFold = { [weak self] row in self?.fold(row) }
        sidebar.onAdd = { [weak self] row in self?.makeNewWork(in: self?.usesSpaces == true ? row.nodeId : nil) }
        sidebar.menu = { [weak self] row in self?.menu(for: row) }
        sidebar.preview = { [weak self] row in self?.preview(for: row) }
        sidebar.onOpenPreview = { [weak self] row in self?.open(row, animated: false) }
        sidebar.beginDrag = { [weak self] row in self?.beginDrag(row) }
        sidebar.onDrop = { [weak self] drag, to in self?.drop(drag, to: to) }
        sidebar.onDragging = { [weak self] active in self?.dragging(active) }
        sidebar.delegate = self
        stories.onInsetChange = { [weak self] change in self?.storiesMoved(change) }
        stories.list = sidebar
        empty.onPair = { [weak self] in
            guard let self else { return }
            DirectPairingFlow.scan(context: context, on: self)
        }
        accountsObservation = context.account.observeAccounts { [weak self] _ in self?.attach() }
        attach()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        attach()
        sidebar.selectedRowId = session?.selectedRowId
        if let store = session?.store { Task { await store.attentionVisibleUpdate(true) } }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        // A row lifted from its menu goes back before another screen covers it.
        sidebar.disarm(animated: false)
        picker?.close(animated: false)
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if let store = session?.store { Task { await store.attentionVisibleUpdate(false) } }
    }

    /// The computer shown: the fixed one, the last chosen, or the first paired.
    private func computerID() -> String? {
        let direct = context.account.direct
        if let fixedComputer { return direct.accounts.contains { $0.id == fixedComputer } ? fixedComputer : nil }
        let preference = StemCellsPreference(variant: context.variant)
        let live = direct.accounts.filter { !$0.revoked }
        if let chosen = preference.computerID, live.contains(where: { $0.id == chosen }) { return chosen }
        return live.first?.id
    }

    private func attach() {
        let id = computerID()
        guard id != session?.accountID else { return }
        // Another computer's sidebar: what was searched was the last one's.
        endSearch(animated: false)
        watch?.invalidate(); watch = nil
        directWatch?.cancel(); directWatch = nil
        modelsWatch?.invalidate(); modelsWatch = nil
        session = id.flatMap { StemCellsSession.session(for: $0, context: context) }
        stories.attach(session)
        sidebar.images = session?.images
        sidebar.apply([])
        snapshot = StemCellsSnapshot()
        directHome = DirectHomeSnapshot()
        if let session {
            sidebar.selectedRowId = session.selectedRowId
            watch = session.watch { [weak self] snapshot in self?.apply(snapshot) }
            directWatch = Task { [weak self, engine = session.engine] in
                for await snapshot in await engine.snapshots() {
                    guard !Task.isCancelled, let self else { return }
                    self.directHome = snapshot
                    if self.usesSpaces { self.apply(session.snapshot) }
                    else { self.applyClassic() }
                }
            }
            modelsWatch = session.models.watch { [weak self] in self?.updateModelBar() }
            session.models.load()
        }
        updateModelBar()
        applyChrome()
    }

    private func apply(_ snapshot: StemCellsSnapshot) {
        guard usesSpaces else { applyClassic(); return }
        let previous = self.snapshot
        self.snapshot = snapshot
        onSnapshot?(snapshot)
        if previous.rows != snapshot.rows || (search?.narrowed == true && previous.allRows != snapshot.allRows) { showRows() }
        warmUp()
        if previous.availability != snapshot.availability || previous.error != snapshot.error || previous.stemCellError != snapshot.stemCellError {
            applyChrome()
        }
    }

    private func applyClassic() {
        let previous = snapshot.rows
        snapshot = StemCellsSnapshot()
        snapshot.availability = directHome.loaded ? .available : .loading
        snapshot.live = directHome.live
        snapshot.rows = directHome.rows
        snapshot.allRows = directHome.allRows
        snapshot.error = directHome.error
        onSnapshot?(snapshot)
        if previous != snapshot.rows || search?.narrowed == true { showRows() }
        warmUp()
        applyChrome()
    }

    private func applyChrome() {
        let hasComputer = session != nil
        empty.isHidden = hasComputer && snapshot.availability != .unsupported
        empty.message = !hasComputer ? Strings.StemCells.noComputer : Strings.StemCells.unsupported
        empty.showsPair = !hasComputer
        sidebar.isHidden = !empty.isHidden
        // Searching, the header is the field: the stories wait.
        stories.isSuppressed = sidebar.isHidden || search != nil
        let reason = { (text: String) in text.isEmpty ? Strings.StemCells.unanswered : text }
        let notice = snapshot.stemCellError.map { Strings.StemCells.newWorkFailed(reason($0)) } ?? snapshot.error.map(reason)
        // Prioritizing being off is Settings' business: home says nothing of it.
        banner.configure(notice: notice)
        dock.isHidden = !hasComputer || snapshot.availability == .unsupported
        dockScrim.isHidden = dock.isHidden
        view.setNeedsLayout()
    }

    /// The rows a phone draws: all but Search and Create, which stay in the
    /// document for desktop.
    static func drawn(_ rows: [StemCellsRow]) -> [StemCellsRow] {
        rows.filter { $0.kind != .search && $0.kind != .create }
    }

    private func updateModelBar() {
        let models = session?.models
        let menus = models?.catalog.flatMap { catalog in models?.newWorkMode.map { StemCellModelMenus(catalog: catalog, selection: $0) } }
        StemCellModelPickers.configure(dock, menus: menus)
        picker?.update(menus: menus, usage: models?.usage ?? [:])
        view.setNeedsLayout()
    }

    /// A pick here is what the next new work is sent with.
    private func choose(_ key: String) {
        guard let models = session?.models else { return }
        StemCellModelPickers.choose(key, state: models, mode: models.newWorkMode) { next in
            models.dockMode = next
        }
    }

    // MARK: Search

    private func wireSearch(_ header: HomeHeaderView) {
        header.searchField.addAction(UIAction { [weak self, weak header] _ in
            guard let self, search != nil else { return }
            search?.query = header?.searchField.text ?? ""
            showRows(toTop: true)
        }, for: .editingChanged)
        // Return puts the keyboard away; what's found stays.
        header.searchField.addAction(UIAction { _ in }, for: .editingDidEndOnExit)
        header.searchCancelButton.addAction(UIAction { [weak self] _ in self?.endSearch() }, for: .primaryActionTriggered)
    }

    /// Search opens in the header, in place: the pill grows into a field
    /// with the keyboard up and the dock steps aside. Nothing is pushed.
    func beginSearch() {
        guard session != nil, search == nil, let header, !sidebar.isHidden else { return }
        sidebar.disarm()
        picker?.close(animated: true)
        search = Search(fromTop: sidebar.contentOffset.y + sidebar.contentInset.top)
        header.searchField.text = ""
        stories.isSuppressed = true
        sidebar.keyboardDismissMode = .onDrag
        searchMoves(header, animated: true)
        header.searchField.becomeFirstResponder()
    }

    /// The field folds back into the search button, and the list is the
    /// sidebar's again, where it was.
    func endSearch(animated: Bool = true) {
        guard let ended = search else { return }
        search = nil
        sidebar.keyboardDismissMode = .none
        stories.isSuppressed = sidebar.isHidden
        if let header {
            header.searchField.resignFirstResponder()
            header.searchField.text = ""
            searchMoves(header, animated: animated)
        }
        showRows()
        restore(fromTop: ended.fromTop)
    }

    /// The header, the dock and the list's room, as search now has them.
    private func searchMoves(_ header: HomeHeaderView, animated: Bool) {
        let searching = search != nil
        let change = {
            header.isSearching = searching
            header.layoutIfNeeded()
            self.dock.alpha = searching ? 0 : 1
            self.dockScrim.presence = searching ? 0 : 1
            self.view.setNeedsLayout()
            self.view.layoutIfNeeded()
        }
        dock.isUserInteractionEnabled = !searching
        if animated {
            // The classic spring: what it animates sees its duration
            // (`inheritedAnimationDuration`), so the header times its fades
            // and its glass's shadow to it.
            UIView.animate(withDuration: 0.42, delay: 0, usingSpringWithDamping: 0.9, initialSpringVelocity: 0, options: [.beginFromCurrentState, .allowUserInteraction], animations: change)
        } else {
            UIView.performWithoutAnimation(change)
        }
    }

    /// The rows the sidebar shows: the document's, or, with something
    /// typed, the rows that answer it and then the quick actions and
    /// settings that do. `toTop`: the query changed, so the list starts
    /// at its top; emptied, it goes back to where it was.
    private func showRows(toTop: Bool = false) {
        let drawn = usesSpaces ? Self.drawn(snapshot.rows) : snapshot.rows
        let query = search?.query.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard var search, !query.isEmpty else {
            let wasNarrowed = self.search?.narrowed == true
            self.search?.narrowed = false
            self.search?.results = [:]
            nothingFound.isHidden = true
            sidebar.apply(drawn)
            if wasNarrowed, let fromTop = self.search?.fromTop { restore(fromTop: fromTop) }
            return
        }
        let found = results(for: query)
        search.narrowed = true
        search.results = found.runs
        self.search = search
        let rows = StemCellsSearch.rows(snapshot.allRows, query: query) + found.rows
        nothingFound.isHidden = !rows.isEmpty
        sidebar.apply(rows)
        if toTop {
            sidebar.layoutIfNeeded()
            sidebar.contentOffset.y = -sidebar.contentInset.top
        }
    }

    /// The list `fromTop` below its top, as far as it now goes.
    private func restore(fromTop: CGFloat) {
        view.layoutIfNeeded()
        sidebar.layoutIfNeeded()
        let top = -sidebar.contentInset.top
        let end = max(top, sidebar.contentSize.height + sidebar.contentInset.bottom - sidebar.bounds.height)
        sidebar.contentOffset.y = max(top, min(end, top + fromTop))
    }

    /// The quick actions and settings that answer `query`, at most six of
    /// each, best first, each under its heading, and what each does.
    private func results(for query: String) -> (rows: [StemCellsRow], runs: [String: () -> Void]) {
        var rows: [StemCellsRow] = []
        var runs: [String: () -> Void] = [:]
        func section(_ id: String, _ label: String, _ found: [(id: String, title: String, glyph: String, run: () -> Void)]) {
            guard !found.isEmpty else { return }
            rows.append(StemCellsRow(id: "search:\(id)", nodeId: "search:\(id)", kind: .section, label: label))
            for one in found {
                let rowId = "search:\(id):\(one.id)"
                rows.append(StemCellsRow(id: rowId, nodeId: rowId, kind: .result, label: one.title, mark: .glyph(one.glyph)))
                runs[rowId] = one.run
            }
        }
        let actions = StemCellsSearch.ranked(quickActions(), query: query) { $0.title }
        section("actions", Strings.StemCells.quickActions, actions.map { ($0.id, $0.title, $0.glyph, $0.run) })
        let computer = session?.accountID
        let stories = session.map { StoriesSession.session(for: $0).snapshot.availability }
        let entries = StemCellsSettingsIndex.computer(stories: stories == .on || stories == .off)
        let settings = StemCellsSearch.ranked(entries, query: query) { $0.title }
        section("settings", Strings.StemCells.settingsResults, settings.map { entry in
            (entry.id, entry.title, entry.glyph, { [weak self] in
                guard let self else { return }
                StemCellsSettingsViewController.open(context: context, computer: computer, reveal: entry.id, from: parent ?? self)
            })
        })
        return (rows, runs)
    }

    /// What desktop's palette offers to do from anywhere, as a phone does it.
    private func quickActions() -> [QuickAction] {
        [
            // New work grows from the dock, so the search gives it back first.
            QuickAction(id: "new-work", title: Strings.StemCells.newWork, glyph: "compose") { [weak self] in
                self?.endSearch(animated: false)
                self?.makeNewWork()
            },
            QuickAction(id: "new-work-picture", title: Strings.StemCells.newWorkWithPicture, glyph: "image-outline") { [weak self] in
                self?.endSearch(animated: false)
                self?.makeNewWork(library: true)
            },
            QuickAction(id: "add-computer", title: Strings.StemCells.addComputer, glyph: "laptop-outline") { [weak self] in
                guard let self else { return }
                StemCellsLinkNavigationController.present(context: context, from: self)
            },
            QuickAction(id: "scan", title: Strings.StemCells.scanQRCode, glyph: "qr-code-outline") { [weak self] in
                guard let self else { return }
                StemCellsScan.scan(context: context, on: self)
            },
            QuickAction(id: "settings", title: Strings.StemCells.openSettingsAction, glyph: "settings-outline") { [weak self] in
                guard let self else { return }
                StemCellsSettingsViewController.open(context: context, computer: session?.accountID, from: parent ?? self)
            },
        ]
    }

    @objc private func keyboardWillChange(_ notification: Notification) {
        guard let frame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
        keyboardTop = min(view.bounds.height, view.convert(frame, from: nil).minY)
        guard search != nil, view.window != nil else { return }
        // A keyboard of a screen over home's moves it only once it's back.
        let top = parent ?? self
        guard header?.searchField.isFirstResponder == true || (navigationController?.topViewController === top && top.presentedViewController == nil) else {
            view.setNeedsLayout()
            return
        }
        let duration = notification.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0.25
        let curve = notification.userInfo?[UIResponder.keyboardAnimationCurveUserInfoKey] as? UInt ?? 7
        view.setNeedsLayout()
        UIView.animate(withDuration: duration, delay: 0, options: [UIView.AnimationOptions(rawValue: curve << 16), .beginFromCurrentState]) {
            self.view.layoutIfNeeded()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let bounds = view.bounds
        let bannerHeight = banner.isEmpty ? 0 : banner.sizeThatFits(CGSize(width: bounds.width, height: .greatestFiniteMagnitude)).height
        let docked = StemCellsDockLayout(size: bounds.size, safeArea: LayoutInsets(view.safeAreaInsets)) { [dock] width in dock.height(fitting: width) }
        dock.setLayoutFrame(docked.card)
        picker?.follow()
        dockScrim.frame = docked.scrim
        // Searching, the dock has stepped aside: the keyboard, or the home
        // indicator, is what the list keeps clear of.
        let searching = StemCellsSearchLayout(size: bounds.size, contentTop: contentInsets.contentTop, safeBottom: view.safeAreaInsets.bottom, keyboardTop: keyboardTop ?? bounds.height, nothingFound: nothingFound.measurable)
        nothingFound.frame = searching.nothingFound
        let listBottom = search != nil ? searching.listBottom : dock.isHidden ? contentInsets.listBottom : docked.listBottom
        let layout = StemCellsHomeLayout(size: bounds.size, contentTop: contentInsets.contentTop, chromeTop: contentInsets.chromeTop, listBottom: listBottom, bannerHeight: bannerHeight, storiesHeight: sidebar.isHidden ? 0 : stories.inset)
        banner.frame = layout.banner
        sidebar.frame = bounds
        session?.warm.layOut(width: bounds.width, environment: traitCollection.textEnvironment)
        let insets = UIEdgeInsets(layout.listInsets)
        if sidebar.contentInset != insets {
            let atTop = sidebar.contentOffset.y <= -sidebar.contentInset.top + 1
            sidebar.contentInset = insets
            sidebar.verticalScrollIndicatorInsets = UIEdgeInsets(layout.indicatorInsets)
            switch storiesChange {
            case .held:
                // The stories opened or closed under the finger: the list stays.
                break
            case .animated:
                // They opened or closed on their own: the list goes to its new top.
                sidebar.contentOffset.y = -insets.top
            case .immediate, nil:
                // A shrinking top (Stories turned off) leaves nothing scrolled past it.
                if atTop || (!sidebar.isDragging && sidebar.contentOffset.y < -insets.top) { sidebar.contentOffset.y = -insets.top }
            }
        }
        empty.frame = layout.empty
        updateHeaderScrim()
    }

    override func didMove(toParent parent: UIViewController?) {
        super.didMove(toParent: parent)
        if parent == nil { header = nil }
    }

    /// The stories' room above the list changed: the list keeps still under
    /// a finger, and otherwise moves to its new top, animated as Telegram's
    /// chat list scrolls to its stories.
    private func storiesMoved(_ change: StoriesHomeController.Change) {
        storiesChange = change
        defer { storiesChange = nil }
        view.setNeedsLayout()
        switch change {
        case .held, .immediate:
            view.layoutIfNeeded()
        case .animated:
            let animator = UIViewPropertyAnimator(duration: 0.3, controlPoint1: CGPoint(x: 0.33, y: 0.52), controlPoint2: CGPoint(x: 0.25, y: 0.99)) { [weak self] in
                self?.view.layoutIfNeeded()
            }
            animator.startAnimation()
        }
    }

    // MARK: Acts

    private func open(_ row: StemCellsRow, animated: Bool = true) {
        guard let session else { return }
        Task { await session.store.attentionInput() }
        // A quick action or a setting search found; the search stays for coming back.
        if row.kind == .result {
            header?.searchField.resignFirstResponder()
            search?.results[row.id]?()
            return
        }
        switch row.kind {
        case .space where row.targetKind == "project" || row.targetKind == "workspace":
            fold(row)
        case .space where row.targetKind == "artifacts":
            navigationController?.pushViewController(DirectArtifactsViewController(session: session), animated: animated)
        case .search:
            beginSearch()
        case .create:
            makeNewWork()
        case .space where row.targetKind == "surface":
            guard let surfaceId = row.targetId else { return }
            session.selectedRowId = row.id
            sidebar.selectedRowId = row.id
            let surface = AgentWire.Surface(id: surfaceId, type: row.surfaceType ?? "", name: row.label)
            navigationController?.pushViewController(StemCellsSurfaceViewController(session: session, surface: surface), animated: animated)
        case .space, .session:
            guard let agentId = row.agentId else { return }
            session.selectedRowId = row.id
            sidebar.selectedRowId = row.id
            session.warm.tap(agentId)
            let space = row.spaceId.flatMap { id in snapshotSpace(id) }
            let chat = StemCellChatViewController(session: session, agentId: agentId, title: row.label, spaceId: row.spaceId, stemCell: space)
            navigationController?.pushViewController(chat, animated: animated)
        default:
            break
        }
    }

    /// What a hold on a row shows over its menu: a conversation's newest
    /// messages, read only, at Telegram's preview size. Rows without one
    /// (headings, surfaces, search) show only their menu.
    private func preview(for row: StemCellsRow) -> UIViewController? {
        guard let session, row.kind == .space || row.kind == .session, row.targetKind != "surface", let agentId = row.agentId else { return nil }
        let space = row.spaceId.flatMap { id in snapshotSpace(id) }
        let chat = StemCellChatViewController(session: session, agentId: agentId, title: row.label, spaceId: row.spaceId, stemCell: space, previewing: true)
        let window = view.window
        let screen = window?.bounds.size ?? view.bounds.size
        let insets = window?.safeAreaInsets ?? view.safeAreaInsets
        chat.preferredContentSize = StemCellsPreviewLayout.size(screen: screen, top: insets.top, bottom: insets.bottom, regular: traitCollection.horizontalSizeClass == .regular)
        return chat
    }

    private func snapshotSpace(_ spaceId: String) -> StemCellChatViewController.Intro? {
        guard let row = snapshot.rows.first(where: { $0.spaceId == spaceId }) else { return nil }
        if case .stemCell(let seed) = row.mark { return .stemCell(seed: seed) }
        if case .clay(let slug) = row.mark { return .clay(slug) }
        return nil
    }

    private func fold(_ row: StemCellsRow) {
        // Narrowed, nothing folds: the document's folds wait for the search to end.
        guard search?.narrowed != true else { return }
        if !usesSpaces, let engine = session?.engine {
            Task { try? await engine.fold(row.id) }
            return
        }
        guard let store = session?.store else { return }
        StemCellsHaptics.play(.fold)
        // A row with subtasks the sidebar doesn't hold yet brings them, open.
        if row.hasHiddenSessions {
            Task { await store.attentionInput(); await store.revealSessions(row.nodeId, sessions: row.sessions) }
            return
        }
        Task { await store.attentionInput(); await store.fold(row.nodeId) }
    }

    /// New work, right below Happy: the row and its empty conversation exist
    /// at once, and the conversation opens over home without going anywhere
    /// (`StemCellsNewWorkTransition`): the composer rides the keyboard up from
    /// the dock as the intro fades in, or, from the dock's "+", stays and the
    /// "+" sheet comes up over it.
    func makeNewWork(in sectionId: String? = nil, library: Bool = false) {
        guard let session, !creating, navigationController?.topViewController === parent || navigationController?.topViewController === self else { return }
        creating = true
        StemCellsHaptics.play(.newWork)
        let store = session.store
        Task { @MainActor in
            let creation = await store.createStemCell(sectionId: sectionId)
            creating = false
            let rowId = "space:\(creation.spaceId)"
            session.selectedRowId = rowId
            sidebar.selectedRowId = rowId
            let chat = StemCellChatViewController(session: session, agentId: creation.agentId, title: Strings.StemCells.untitled, spaceId: creation.spaceId, stemCell: .stemCell(seed: creation.spaceId), creation: creation)
            chat.focusesOnOpen = !library
            chat.focusesAfterPick = library
            chat.opensOverHome = true
            guard let navigation = navigationController else { return }
            navigation.pushViewController(chat, animated: true)
            // Over the screen it goes to, as that screen comes in.
            if library { chat.presentAttach(from: navigation) }
        }
    }

    @objc private func dockTapped(_ gesture: UITapGestureRecognizer) {
        guard gesture.state == .ended else { return }
        sidebar.disarm()
        makeNewWork()
    }

    // MARK: Menus

    /// What a hold on `row` offers: renaming it, moving it, and putting it
    /// away (leaving or archiving, a section's heading deleted), each run
    /// once the preview has gone (a rename needs the keyboard).
    private func menu(for row: StemCellsRow) -> [[StemCellsMenuItem]]? {
        // Searching, a hold has nothing to rename or move among what was found.
        guard usesSpaces, search == nil else { return nil }
        guard let session, [.space, .session, .section].contains(row.kind) else { return nil }
        let store = session.store
        var first: [StemCellsMenuItem] = []
        if let rename = renaming(row) { first.append(StemCellsMenuItem(title: rename.title, icon: "pencil", run: rename.begin)) }
        if beginDrag(row) != nil {
            first.append(StemCellsMenuItem(title: Strings.StemCells.reorder, icon: "reorder") { [weak self] in self?.sidebar.armReorder(row.id) })
        }
        // HappyAgentSpacesSidebar's menus: new work closes from here and
        // only from here; other work is left or archived.
        var leaving = closing(row).map { act in
            StemCellsMenuItem(title: act.title, icon: act.icon, destructive: act.destructive) {
                StemCellsHaptics.play(.putAway)
                act.run()
            }
        }
        if row.kind == .section {
            // Only the heading goes: its rows join the block above.
            leaving.append(StemCellsMenuItem(title: Strings.StemCells.deleteSection, icon: "trash", destructive: true) {
                StemCellsHaptics.play(.putAway)
                Task { await store.attentionInput(); await store.removeSection(row.nodeId) }
            })
        }
        let groups = [first, leaving].filter { !$0.isEmpty }
        return groups.isEmpty ? nil : groups
    }

    /// A row's rename, when it has one: a section's heading, a task's or a
    /// bot's name, never Happy's. It happens in the row itself.
    private func renaming(_ row: StemCellsRow) -> (title: String, begin: () -> Void)? {
        guard let store = session?.store, !row.isHappy else { return nil }
        switch row.kind {
        case .section:
            return (Strings.StemCells.renameSection, { [weak self] in
                self?.sidebar.beginRename(row.id, text: row.label) { label in Task { await store.relabel(row.nodeId, label: label) } }
            })
        case .space where row.targetKind == "task" || row.targetKind == "bot":
            guard let spaceId = row.spaceId else { return nil }
            return (row.targetKind == "bot" ? Strings.StemCells.renameBot : Strings.StemCells.renameTask, { [weak self] in
                let current = row.label == Strings.StemCells.untitled ? "" : row.label
                self?.sidebar.beginRename(row.id, text: current) { title in Task { await store.rename(spaceId, title: title) } }
            })
        default:
            return nil
        }
    }

    /// How a row's work is put away, as desktop offers it: new work nobody
    /// named closes; a task is left, and archived too when the person may;
    /// a bot is archived. Never Happy.
    private func closing(_ row: StemCellsRow) -> [(title: String, icon: String, destructive: Bool, run: () -> Void)] {
        guard let store = session?.store, !row.isHappy else { return [] }
        if row.kind == .session, let agentId = row.agentId {
            return [(Strings.StemCells.archiveSubtask, "archive", true, { Task { await store.archiveSubtask(agentId) } })]
        }
        guard row.kind == .space else { return [] }
        if row.isUntouchedStemCell, let spaceId = row.spaceId {
            return [(Strings.StemCells.closeNewWork, "close", true, { Task { await store.discard(spaceId) } })]
        }
        guard let targetId = row.targetId else { return [] }
        switch row.targetKind {
        case "task":
            var acts: [(title: String, icon: String, destructive: Bool, run: () -> Void)] = [
                (Strings.StemCells.leaveTask, "close", false, { Task { await store.leave(taskId: targetId) } }),
            ]
            if row.canArchive {
                acts.append((Strings.StemCells.archiveTask, "archive", true, { Task { await store.archive(kind: "task", id: targetId) } }))
            }
            return acts
        case "bot":
            return [(Strings.StemCells.archiveBot, "archive", true, { Task { await store.archive(kind: "bot", id: targetId) } })]
        default:
            return []
        }
    }

    // MARK: Carry

    private func beginDrag(_ row: StemCellsRow) -> StemCellsDrag? {
        guard search == nil, let document = snapshot.document else { return nil }
        return StemCellsDrag(holding: row.id, drawn: Self.drawn(snapshot.rows), all: snapshot.allRows, document: document)
    }

    private func drop(_ drag: StemCellsDrag, to: Int) {
        guard let store = session?.store else { return }
        guard case .some(let after) = drag.after(to: to) else { return }
        inOrder { await store.move(drag.moving, after: after) }
    }

    private func dragging(_ active: Bool) {
        // A carry scrolls the list near its edges: not a pull on the stories.
        stories.carrying = active
        guard let store = session?.store else { return }
        inOrder {
            if active { await store.attentionInput() }
            await store.setDragging(active)
        }
    }

    /// Runs `work` after what the carry asked of the store before it: a
    /// drop's move reaches the store ahead of the carry's end.
    private func inOrder(_ work: @escaping @MainActor () async -> Void) {
        let previous = carryWork
        carryWork = Task { @MainActor in
            await previous?.value
            await work()
        }
    }
}

extension StemCellsHomeViewController: UIScrollViewDelegate {
    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        stories.listWillBeginDragging()
        // Scrolling is being in the list: Prioritizing's batches wait.
        if let store = session?.store { Task { await store.attentionInput() } }
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        stories.listDidScroll()
        updateHeaderScrim()
    }

    /// The header's blur comes in as the list goes under it.
    private func updateHeaderScrim() {
        header?.scrim.presence = HeaderScrim.presence(scrolledUnder: sidebar.contentOffset.y + sidebar.contentInset.top)
    }

    func scrollViewWillEndDragging(_ scrollView: UIScrollView, withVelocity velocity: CGPoint, targetContentOffset: UnsafeMutablePointer<CGPoint>) {
        stories.listWillEndDragging(target: targetContentOffset)
    }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        stories.listDidEndDragging(decelerate: decelerate)
        if !decelerate { warmUp() }
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        stories.listDidEndDecelerating()
        warmUp()
    }

    /// The sidebar's conversations and those on screen, for reading ahead.
    private func warmUp() {
        guard let session, !snapshot.allRows.isEmpty else { return }
        sidebar.layoutIfNeeded()
        session.warm.update(rows: snapshot.allRows, visible: sidebar.visibleRows, references: snapshot.references)
    }
}

/// The note above the list: the last thing the computer refused.
final class StemCellsBannerView: UIView {
    private let title = UILabel()
    private let card = UIView()
    private(set) var isEmpty = true

    override init(frame: CGRect) {
        super.init(frame: frame)
        card.backgroundColor = UIColor(Palette.stemCellsRowSelected)
        card.layer.cornerRadius = 12
        card.layer.cornerCurve = .continuous
        addSubview(card)
        title.font = StemCellsFonts.ui(.semiBold, size: 15)
        title.textColor = UIColor(Palette.stemCellsRowTextActive)
        card.addSubview(title)
        isHidden = true
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func configure(notice: String?) {
        isEmpty = notice == nil
        isHidden = isEmpty
        title.text = notice
        setNeedsLayout()
    }

    private func layout(width: CGFloat) -> StemCellsBannerLayout {
        StemCellsBannerLayout(width: width, title: title.measurable, detail: nil, button: nil)
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        isEmpty ? .zero : layout(width: size.width).size
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(width: bounds.width)
        card.frame = layout.card
        title.frame = layout.title
    }
}

/// No computer paired, or one too old: what to do about it.
final class StemCellsEmptyView: UIView {
    var onPair: (() -> Void)?
    private let mark = StemCellMarkView()
    private let label = UILabel()
    private let button = UIButton(type: .system)

    var message = "" { didSet { label.text = message; setNeedsLayout() } }
    var showsPair = true { didSet { button.isHidden = !showsPair } }

    override init(frame: CGRect) {
        super.init(frame: frame)
        mark.seed = "stem-cells"
        label.font = StemCellsFonts.ui(.medium, size: 16)
        label.textColor = UIColor(Palette.stemCellsRowText)
        label.textAlignment = .center
        label.numberOfLines = 0
        var configuration = UIButton.Configuration.filled()
        configuration.cornerStyle = .capsule
        configuration.baseBackgroundColor = UIColor(Palette.stemCellsRowTextActive)
        configuration.baseForegroundColor = UIColor(Palette.groupedBackground)
        configuration.attributedTitle = AttributedString(Strings.StemCells.pairComputer, attributes: AttributeContainer([.font: StemCellsFonts.ui(.semiBold, size: 16)]))
        configuration.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 22, bottom: 12, trailing: 22)
        button.configuration = configuration
        button.addAction(UIAction { [weak self] _ in self?.onPair?() }, for: .touchUpInside)
        for view in [mark, label, button] { addSubview(view) }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = StemCellsEmptyLayout(size: bounds.size, label: label.measurable, button: button.isHidden ? nil : button.sizeThatFits(.zero))
        mark.frame = layout.mark
        label.frame = layout.label
        button.frame = layout.button ?? .zero
    }
}
extension StemCellsHomeViewController: AgentInputCardDelegate, UIGestureRecognizerDelegate {
    func agentInputCardDidPressPrimary(_ card: AgentInputCardView) { makeNewWork() }
    func agentInputCardDidPressSend(_ card: AgentInputCardView) { makeNewWork() }

    func agentInputCardDidPressAdd(_ card: AgentInputCardView) {
        sidebar.disarm()
        makeNewWork(library: true)
    }

    func agentInputCardDidInvalidateHeight(_ card: AgentInputCardView) { view.setNeedsLayout() }

    func agentInputCard(_ card: AgentInputCardView, didSelect key: String, in chip: AgentInputChip) {
        choose(key)
    }

    /// A chip opens its list; with no models yet, they are asked for again.
    func agentInputCard(_ card: AgentInputCardView, didPress chip: AgentInputChip) {
        sidebar.disarm()
        guard let models = session?.models else { return }
        guard let catalog = models.catalog, let mode = models.newWorkMode else { return models.load() }
        picker?.close(animated: false)
        let picker = StemCellPickerPresenter(list: chip == .effort ? .effort : .model, card: card, menus: StemCellModelMenus(catalog: catalog, selection: mode), usage: models.usage) { [weak self] key in
            self?.choose(key)
        }
        picker.onClose = { [weak self, weak picker] in
            if let self, self.picker === picker { self.picker = nil }
        }
        self.picker = picker
        picker.show(in: view)
        StemCellModelPickers.opened(models, mode: mode)
    }

    func agentInputCard(_ card: AgentInputCardView, didOpenMenuIn chip: AgentInputChip) {
        sidebar.disarm()
        guard let models = session?.models else { return }
        StemCellModelPickers.opened(models, mode: models.newWorkMode)
    }

    /// The dock's own taps are its field's: its buttons and chips keep theirs.
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        var view = touch.view
        while let current = view, current !== dock {
            // A disabled control (the empty send) takes no tap: the field's.
            if let control = current as? UIControl, control.isEnabled { return false }
            view = current.superview
        }
        return true
    }
}
#endif
