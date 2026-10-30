#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Home in V2 mode: one paired computer's sidebar, as desktop's
/// `HappyAgentSpacesSidebar` draws it, under the navigation bar and over the
/// dock. The dock is the new-work screen's own composer, drawn the same and
/// in the same place: a tap in it makes new work, sent with the model its
/// chips hold, and its "+" makes new work with the library open over it.
/// Desktop's Search and Create rows aren't drawn: search is the bar's
/// and create is the dock.
///
/// Search happens here, in place: the bar's search grows into a field
/// with the keyboard up (the host drives `beginSearch`, `search(_:)` and
/// `endSearch`), the dock steps aside, and the sidebar
/// narrows to what answers as it's typed, with the quick actions and the
/// settings that answer below it, as desktop's ⌘K palette lists them.
/// Ending it puts the list back as it was, folds and scroll and all.
final class HomeViewController: UIViewController {
    private let context: AppContext
    /// The computer this screen always shows; nil to follow the choice.
    private let fixedAgentConnection: String?
    private let sidebar = SidebarView()
    private let banner = BannerView()
    private let empty = EmptyView()
    private let dock = AgentInputCardView(configuration: AgentInputCardConfiguration(placeholder: Strings.composerPlaceholder))
    private let dockScrim = HeaderScrimView(edge: .bottom)
    private var modelsWatch: Watch?
    /// The dock's model or effort list while it is open.
    private var picker: PickerPresenter?
    private var session: Session?
    private var watch: Watch?
    private var accountsObservation: AccountsObservation?
    private var carryWork: Task<Void, Never>?
    private var snapshot = Snapshot()
    private var agentHome = HomeSnapshot()
    private var connectionWatch: Task<Void, Never>?
    private var usesSpaces: Bool { agentHome.usesSpaces && session?.snapshot.availability != .unsupported }
    /// New work on its way to the screen, by the store's ask: a second tap
    /// meanwhile gets the same and opens nothing more.
    private var opening: Set<UUID> = []
    /// Stories, in a band under the bar: open above the list, or put away.
    /// Nothing at all while Stories are off.
    private lazy var stories = StoriesHomeController(host: self)
    /// How the stories last changed the list's room, while it is applied.
    private var storiesChange: StoriesHomeController.Change?
    /// Search, in the bar, while it is open.
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

    /// The stories' band, under the bar.
    private let storiesBand = StoriesBandView()
    /// Search ended here (a quick action took the screen): the bar's
    /// search field closes too.
    var onSearchEnded: (() -> Void)?

    /// Every snapshot shown, for the screen around this one.
    var onSnapshot: ((Snapshot) -> Void)?

    /// The dock, which new work's own composer stands in for as it opens.
    var newWorkDock: UIView { dock }

    /// The bar and dock home lays its content between.
    var contentInsets = HomeContentInsets(safeArea: .zero, dock: 0) {
        didSet { if contentInsets != oldValue { view.setNeedsLayout() } }
    }

    init(context: AppContext, computer: String? = nil) {
        self.context = context
        fixedAgentConnection = computer
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        // The conversation's own ground, light and dark.
        view.backgroundColor = UIColor(Palette.surface)
        view.addSubview(sidebar)
        view.addSubview(storiesBand)
        stories.install(in: storiesBand)
        view.addSubview(empty)
        view.addSubview(banner)
        view.addSubview(dockScrim)
        nothingFound.text = Strings.nothingFound
        nothingFound.font = Fonts.ui(.regular, size: 17)
        nothingFound.textColor = UIColor(Palette.rowText)
        nothingFound.textAlignment = .center
        nothingFound.numberOfLines = 0
        nothingFound.isHidden = true
        nothingFound.accessibilityIdentifier = "search-nothing"
        view.addSubview(nothingFound)
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardWillChange(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        dock.configuration.showsAdd = true
        dock.configuration.addAccessibilityLabel = Strings.addPicture
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
        dock.textView.accessibilityLabel = Strings.composerPlaceholder
        dock.textView.accessibilityIdentifier = "new-work"
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
        // Agent stories turn the conversations' rows into story rows.
        stories.onRings = { [weak self] _ in self?.showRows() }
        sidebar.onOpenStory = { [weak self] row, ring in
            guard let agentId = row.agentId else { return }
            self?.stories.openRing(agentId: agentId, name: row.label, from: ring)
        }
        stories.list = sidebar
        empty.onPair = { [weak self] in
            guard let self else { return }
            AccountAdding.begin(context: context, from: self)
        }
        accountsObservation = context.account.observeAccounts { [weak self] _ in self?.attach() }
        attach()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        attach()
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
        // The row opened stays lit while its screen comes in, then lets go,
        // as Telegram's chat list does: coming back, by the back button or
        // a swipe, finds nothing selected. This list is never beside the
        // conversation it opened (on iPad too it is pushed over), so there
        // is no open chat for a selection to show.
        sidebar.selectedRowId = nil
        if let store = session?.store { Task { await store.attentionVisibleUpdate(false) } }
    }

    /// The computer shown: the fixed one, the last chosen, or the first paired.
    private func agentConnectionID() -> String? {
        let direct = context.account.agentConnections
        if let fixedAgentConnection { return direct.accounts.contains { $0.id == fixedAgentConnection } ? fixedAgentConnection : nil }
        let preference = Preference(variant: context.variant)
        let live = direct.accounts.filter { !$0.revoked }
        if let chosen = preference.agentConnectionID, live.contains(where: { $0.id == chosen }) { return chosen }
        return live.first?.id
    }

    private func attach() {
        let id = agentConnectionID()
        guard id != session?.accountID else { return }
        // Another computer's sidebar: what was searched was the last one's.
        endSearch(animated: false)
        watch?.invalidate(); watch = nil
        connectionWatch?.cancel(); connectionWatch = nil
        modelsWatch?.invalidate(); modelsWatch = nil
        session = id.flatMap { Session.session(for: $0, context: context) }
        stories.attach(session)
        sidebar.images = session?.images
        sidebar.apply([])
        snapshot = Snapshot()
        agentHome = HomeSnapshot()
        if let session {
            watch = session.watch { [weak self] snapshot in self?.apply(snapshot) }
            connectionWatch = Task { [weak self, engine = session.engine] in
                for await snapshot in await engine.snapshots() {
                    guard !Task.isCancelled, let self else { return }
                    self.agentHome = snapshot
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

    private func apply(_ snapshot: Snapshot) {
        guard usesSpaces else { applyClassic(); return }
        let previous = self.snapshot
        self.snapshot = snapshot
        onSnapshot?(snapshot)
        if previous.rows != snapshot.rows || (search?.narrowed == true && previous.allRows != snapshot.allRows) { showRows() }
        warmUp()
        if previous.availability != snapshot.availability || previous.error != snapshot.error || previous.creationError != snapshot.creationError {
            applyChrome()
        }
    }

    private func applyClassic() {
        let previous = snapshot.rows
        snapshot = Snapshot()
        snapshot.availability = agentHome.loaded ? .available : .loading
        snapshot.live = agentHome.live
        snapshot.rows = agentHome.rows
        snapshot.allRows = agentHome.allRows
        snapshot.error = agentHome.error
        onSnapshot?(snapshot)
        if previous != snapshot.rows || search?.narrowed == true { showRows() }
        warmUp()
        applyChrome()
    }

    private func applyChrome() {
        let hasAgentConnection = session != nil
        empty.isHidden = hasAgentConnection && snapshot.availability != .unsupported
        empty.message = !hasAgentConnection ? Strings.noAgentConnection : Strings.unsupported
        empty.showsPair = !hasAgentConnection
        sidebar.isHidden = !empty.isHidden
        // Searching, the bar is the field: the stories wait.
        stories.isSuppressed = sidebar.isHidden || search != nil
        let reason = { (text: String) in text.isEmpty ? Strings.unanswered : text }
        let notice = snapshot.creationError.map { Strings.newWorkFailed(reason($0)) } ?? snapshot.error.map(reason)
        // Prioritizing being off is Settings' business: home says nothing of it.
        banner.configure(notice: notice)
        dock.isHidden = !hasAgentConnection || snapshot.availability == .unsupported
        dockScrim.isHidden = dock.isHidden
        view.setNeedsLayout()
    }

    /// The rows a phone draws: all but Search and Create, which stay in the
    /// document for desktop.
    static func drawn(_ rows: [Row]) -> [Row] {
        rows.filter { $0.kind != .search && $0.kind != .create }
    }

    private func updateModelBar() {
        let models = session?.models
        let menus = models?.catalog.flatMap { catalog in models?.newWorkMode.map { ModelMenus(catalog: catalog, selection: $0) } }
        ModelPickers.configure(dock, menus: menus)
        picker?.update(menus: menus, usage: models?.usage ?? [:])
        view.setNeedsLayout()
    }

    /// A pick here is what the next new work is sent with.
    private func choose(_ key: String) {
        guard let models = session?.models else { return }
        ModelPickers.choose(key, state: models, mode: models.newWorkMode) { next in
            models.dockMode = next
        }
    }

    // MARK: Search

    /// What is typed in the bar's search field.
    func search(_ query: String) {
        guard search != nil, search?.query != query else { return }
        search?.query = query
        showRows(toTop: true)
    }

    /// Search opens in the bar, in place: the field takes the bar with the
    /// keyboard up and the dock steps aside. Nothing is pushed.
    func beginSearch() {
        guard session != nil, search == nil, !sidebar.isHidden else { return }
        sidebar.disarm()
        picker?.close(animated: true)
        search = Search(fromTop: sidebar.contentOffset.y + sidebar.contentInset.top)
        stories.isSuppressed = true
        sidebar.keyboardDismissMode = .onDrag
        searchMoves(animated: true)
    }

    /// The field folds back into the search button, and the list is the
    /// sidebar's again, where it was.
    func endSearch(animated: Bool = true) {
        guard let ended = search else { return }
        search = nil
        sidebar.keyboardDismissMode = .none
        stories.isSuppressed = sidebar.isHidden
        searchMoves(animated: animated)
        onSearchEnded?()
        showRows()
        restore(fromTop: ended.fromTop)
    }

    /// The dock and the list's room, as search now has them.
    private func searchMoves(animated: Bool) {
        let searching = search != nil
        let change = {
            self.dock.alpha = searching ? 0 : 1
            self.dockScrim.presence = searching ? 0 : 1
            self.view.setNeedsLayout()
            self.view.layoutIfNeeded()
        }
        dock.isUserInteractionEnabled = !searching
        if animated {
            // The classic spring.
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
            sidebar.apply(Rows.withStories(drawn, rings: stories.rings))
            if wasNarrowed, let fromTop = self.search?.fromTop { restore(fromTop: fromTop) }
            return
        }
        let found = results(for: query)
        search.narrowed = true
        search.results = found.runs
        self.search = search
        let rows = HappyCore.Search.rows(snapshot.allRows, query: query) + found.rows
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
    private func results(for query: String) -> (rows: [Row], runs: [String: () -> Void]) {
        var rows: [Row] = []
        var runs: [String: () -> Void] = [:]
        func section(_ id: String, _ label: String, _ found: [(id: String, title: String, glyph: String, run: () -> Void)]) {
            guard !found.isEmpty else { return }
            rows.append(Row(id: "search:\(id)", nodeId: "search:\(id)", kind: .section, label: label))
            for one in found {
                let rowId = "search:\(id):\(one.id)"
                rows.append(Row(id: rowId, nodeId: rowId, kind: .result, label: one.title, mark: .glyph(one.glyph)))
                runs[rowId] = one.run
            }
        }
        let actions = HappyCore.Search.ranked(quickActions(), query: query) { $0.title }
        section("actions", Strings.quickActions, actions.map { ($0.id, $0.title, $0.glyph, $0.run) })
        let computer = session?.accountID
        let entries = SettingsIndex.computer
        let settings = HappyCore.Search.ranked(entries, query: query) { $0.title }
        section("settings", Strings.settingsResults, settings.map { entry in
            (entry.id, entry.title, entry.glyph, { [weak self] in
                guard let self else { return }
                SettingsViewController.open(context: context, computer: computer, reveal: entry.id, from: parent ?? self)
            })
        })
        return (rows, runs)
    }

    /// What desktop's palette offers to do from anywhere, as a phone does it.
    private func quickActions() -> [QuickAction] {
        [
            // New work grows from the dock, so the search gives it back first.
            QuickAction(id: "new-work", title: Strings.newWork, glyph: "compose") { [weak self] in
                self?.endSearch(animated: false)
                self?.makeNewWork()
            },
            QuickAction(id: "new-work-picture", title: Strings.newWorkWithPicture, glyph: "image-outline") { [weak self] in
                self?.endSearch(animated: false)
                self?.makeNewWork(library: true)
            },
            QuickAction(id: "connect-agent", title: Strings.connectAgent, glyph: "laptop-outline") { [weak self] in
                guard let self else { return }
                AccountAdding.begin(context: context, from: self)
            },
            QuickAction(id: "scan", title: Strings.scanQRCode, glyph: "qr-code-outline") { [weak self] in
                guard let self else { return }
                Scan.scan(context: context, on: self)
            },
            QuickAction(id: "settings", title: Strings.openSettingsAction, glyph: "settings-outline") { [weak self] in
                guard let self else { return }
                SettingsViewController.open(context: context, computer: session?.accountID, from: parent ?? self)
            },
        ]
    }

    @objc private func keyboardWillChange(_ notification: Notification) {
        guard let frame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
        keyboardTop = min(view.bounds.height, view.convert(frame, from: nil).minY)
        guard search != nil, view.window != nil else { return }
        // A keyboard of a screen over home's moves it only once it's back.
        let top = parent ?? self
        guard navigationController?.topViewController === top && (top.presentedViewController == nil || top.presentedViewController is UISearchController) else {
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
        let docked = DockLayout(size: bounds.size, safeArea: LayoutInsets(view.safeAreaInsets)) { [dock] width in dock.height(fitting: width) }
        dock.setLayoutFrame(docked.card)
        picker?.follow()
        dockScrim.frame = docked.scrim
        // Searching, the dock has stepped aside: the keyboard, or the home
        // indicator, is what the list keeps clear of.
        let searching = SearchLayout(size: bounds.size, contentTop: contentInsets.contentTop, safeBottom: view.safeAreaInsets.bottom, keyboardTop: keyboardTop ?? bounds.height, nothingFound: nothingFound.measurable)
        nothingFound.frame = searching.nothingFound
        let listBottom = search != nil ? searching.listBottom : dock.isHidden ? contentInsets.listBottom : docked.listBottom
        let layout = HomeLayout(size: bounds.size, contentTop: contentInsets.contentTop, chromeTop: contentInsets.chromeTop, listBottom: listBottom, bannerHeight: bannerHeight, storiesHeight: sidebar.isHidden ? 0 : stories.inset)
        banner.frame = layout.banner
        storiesBand.frame = CGRect(x: 0, y: contentInsets.chromeTop, width: bounds.width, height: max(0, bounds.height - contentInsets.chromeTop))
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
    }

    override func didMove(toParent parent: UIViewController?) {
        super.didMove(toParent: parent)
        if parent == nil { stories.install(in: nil) }
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

    private func open(_ row: Row, animated: Bool = true) {
        guard let session else { return }
        Task { await session.store.attentionInput() }
        // A quick action or a setting search found; the search stays for coming back.
        if row.kind == .result {
            view.window?.endEditing(true)
            search?.results[row.id]?()
            return
        }
        switch row.kind {
        case .space where row.targetKind == "project" || row.targetKind == "workspace":
            fold(row)
        case .space where row.targetKind == "artifacts":
            navigationController?.pushViewController(ArtifactsViewController(session: session), animated: animated)
        case .search:
            beginSearch()
        case .create:
            makeNewWork()
        case .space where row.targetKind == "surface":
            guard let surfaceId = row.targetId else { return }
            sidebar.selectedRowId = row.id
            let surface = AgentWire.Surface(id: surfaceId, type: row.surfaceType ?? "", name: row.label)
            navigationController?.pushViewController(SurfaceViewController(session: session, surface: surface), animated: animated)
        case .space, .session:
            guard let agentId = row.agentId else { return }
            sidebar.selectedRowId = row.id
            session.warm.tap(agentId)
            let space = row.spaceId.flatMap { id in snapshotSpace(id) }
            let chat = ChatViewController(session: session, agentId: agentId, title: row.label, spaceId: row.spaceId, seedling: space)
            navigationController?.pushViewController(chat, animated: animated)
        default:
            break
        }
    }

    /// What a hold on a row shows over its menu: a conversation's newest
    /// messages, read only, at Telegram's preview size. Rows without one
    /// (headings, surfaces, search) show only their menu.
    private func preview(for row: Row) -> UIViewController? {
        guard let session, row.kind == .space || row.kind == .session, row.targetKind != "surface", let agentId = row.agentId else { return nil }
        let space = row.spaceId.flatMap { id in snapshotSpace(id) }
        let chat = ChatViewController(session: session, agentId: agentId, title: row.label, spaceId: row.spaceId, seedling: space, previewing: true)
        let window = view.window
        let screen = window?.bounds.size ?? view.bounds.size
        let insets = window?.safeAreaInsets ?? view.safeAreaInsets
        chat.preferredContentSize = PreviewLayout.size(screen: screen, top: insets.top, bottom: insets.bottom, regular: traitCollection.horizontalSizeClass == .regular)
        return chat
    }

    private func snapshotSpace(_ spaceId: String) -> ChatViewController.Intro? {
        guard let row = snapshot.rows.first(where: { $0.spaceId == spaceId }) else { return nil }
        if case .seedling(let seed) = row.mark { return .seedling(seed: seed) }
        if case .clay(let slug) = row.mark { return .clay(slug) }
        return nil
    }

    private func fold(_ row: Row) {
        // Narrowed, nothing folds: the document's folds wait for the search to end.
        guard search?.narrowed != true else { return }
        if !usesSpaces, let engine = session?.engine {
            Task { try? await engine.fold(row.id) }
            return
        }
        guard let store = session?.store else { return }
        Haptics.play(.fold)
        // A row with subtasks the sidebar doesn't hold yet brings them, open.
        if row.hasHiddenSessions {
            Task { await store.attentionInput(); await store.revealSessions(row.nodeId, sessions: row.sessions) }
            return
        }
        Task { await store.attentionInput(); await store.fold(row.nodeId) }
    }

    /// New work, right below Happy: the row and its empty conversation exist
    /// at once, and the conversation opens over home without going anywhere
    /// (`NewWorkTransition`): the composer rides the keyboard up from
    /// the dock as the intro fades in, or, from the dock's "+", stays and the
    /// "+" sheet comes up over it. Leaving new work never closes it, so
    /// new work already standing empty is opened instead, where it is
    /// (desktop's rule): from the dock any, newest first; from a heading's
    /// "+" only one under that heading.
    func makeNewWork(in sectionId: String? = nil, library: Bool = false) {
        guard let session, navigationController?.topViewController === parent || navigationController?.topViewController === self else { return }
        let store = session.store
        Task { @MainActor in
            let going = await store.goToNewWork(under: sectionId)
            guard opening.insert(going.id).inserted else { return }
            Haptics.play(.newWork)
            let creation = await going.work.value
            opening.remove(going.id)
            // Another ask got to the screen first.
            guard navigationController?.topViewController === parent || navigationController?.topViewController === self else { return }
            let rowId = "space:\(creation.spaceId)"
            sidebar.selectedRowId = rowId
            let chat = ChatViewController(session: session, agentId: creation.agentId, title: Strings.untitled, spaceId: creation.spaceId, seedling: .seedling(seed: creation.spaceId), creation: creation)
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
    private func menu(for row: Row) -> [[MenuItem]]? {
        // Searching, a hold has nothing to rename or move among what was found.
        guard usesSpaces, search == nil else { return nil }
        guard let session, [.space, .session, .section].contains(row.kind) else { return nil }
        let store = session.store
        var first: [MenuItem] = []
        if let rename = renaming(row) { first.append(MenuItem(title: rename.title, icon: "pencil", run: rename.begin)) }
        if beginDrag(row) != nil {
            first.append(MenuItem(title: Strings.reorder, icon: "reorder") { [weak self] in self?.sidebar.armReorder(row.id) })
        }
        // HappyAgentSpacesSidebar's menus: new work closes from here and
        // only from here; other work is left or archived.
        var leaving = closing(row).map { act in
            MenuItem(title: act.title, icon: act.icon, destructive: act.destructive) {
                Haptics.play(.putAway)
                act.run()
            }
        }
        if row.kind == .section {
            // Only the heading goes: its rows join the block above.
            leaving.append(MenuItem(title: Strings.deleteSection, icon: "trash", destructive: true) {
                Haptics.play(.putAway)
                Task { await store.attentionInput(); await store.removeSection(row.nodeId) }
            })
        }
        let groups = [first, leaving].filter { !$0.isEmpty }
        return groups.isEmpty ? nil : groups
    }

    /// A row's rename, when it has one: a section's heading, a task's or a
    /// bot's name, never Happy's. It happens in the row itself.
    private func renaming(_ row: Row) -> (title: String, begin: () -> Void)? {
        guard let store = session?.store, !row.isHappy else { return nil }
        switch row.kind {
        case .section:
            return (Strings.renameSection, { [weak self] in
                self?.sidebar.beginRename(row.id, text: row.label) { label in Task { await store.relabel(row.nodeId, label: label) } }
            })
        case .space where row.targetKind == "task" || row.targetKind == "bot":
            guard let spaceId = row.spaceId else { return nil }
            return (row.targetKind == "bot" ? Strings.renameBot : Strings.renameTask, { [weak self] in
                let current = row.label == Strings.untitled ? "" : row.label
                self?.sidebar.beginRename(row.id, text: current) { title in Task { await store.rename(spaceId, title: title) } }
            })
        default:
            return nil
        }
    }

    /// How a row's work is put away, as desktop offers it: new work nobody
    /// named closes; a task is left, and archived too when the person may;
    /// a bot is archived; a Surface is left. Never Happy.
    private func closing(_ row: Row) -> [(title: String, icon: String, destructive: Bool, run: () -> Void)] {
        guard let store = session?.store, !row.isHappy else { return [] }
        if row.kind == .session, let agentId = row.agentId {
            return [(Strings.archiveSubtask, "archive", true, { Task { await store.archiveSubtask(agentId, nodeId: row.nodeId) } })]
        }
        guard row.kind == .space else { return [] }
        if row.isUntouchedSeedling, let spaceId = row.spaceId {
            return [(Strings.closeNewWork, "close", true, { Task { await store.discard(spaceId) } })]
        }
        guard let targetId = row.targetId else { return [] }
        switch row.targetKind {
        case "task":
            var acts: [(title: String, icon: String, destructive: Bool, run: () -> Void)] = [
                (Strings.leaveTask, "close", false, { Task { await store.leave(taskId: targetId, nodeId: row.nodeId) } }),
            ]
            if row.canArchive {
                acts.append((Strings.archiveTask, "archive", true, { Task { await store.archive(kind: "task", id: targetId, nodeId: row.nodeId) } }))
            }
            return acts
        case "bot":
            return [(Strings.archiveBot, "archive", true, { Task { await store.archive(kind: "bot", id: targetId, nodeId: row.nodeId) } })]
        case "surface":
            return [(Strings.leaveSurface, "close", false, { Task { await store.leave(surfaceId: targetId, nodeId: row.nodeId) } })]
        default:
            return []
        }
    }

    // MARK: Carry

    private func beginDrag(_ row: Row) -> Drag? {
        guard search == nil, let document = snapshot.document else { return nil }
        return Drag(holding: row.id, drawn: Self.drawn(snapshot.rows), all: snapshot.allRows, document: document)
    }

    private func drop(_ drag: Drag, to: Int) {
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

extension HomeViewController: UIScrollViewDelegate {
    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        stories.listWillBeginDragging()
        // Scrolling is being in the list: Prioritizing's batches wait.
        if let store = session?.store { Task { await store.attentionInput() } }
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        stories.listDidScroll()
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

    /// The rows the sidebar shows and where it is scrolled, for reading
    /// ahead what is on screen and around it.
    private func warmUp() {
        guard let session, !snapshot.allRows.isEmpty else { return }
        sidebar.layoutIfNeeded()
        let shown = sidebar.shownRows
        session.warm.update(rows: shown.isEmpty ? snapshot.rows : shown, visible: shown.isEmpty ? nil : sidebar.visibleRange, references: snapshot.references)
    }
}

/// The note above the list: the last thing the computer refused.
final class BannerView: UIView {
    private let title = UILabel()
    private let card = UIView()
    private(set) var isEmpty = true

    override init(frame: CGRect) {
        super.init(frame: frame)
        card.backgroundColor = UIColor(Palette.rowSelected)
        card.layer.cornerRadius = 12
        card.layer.cornerCurve = .continuous
        addSubview(card)
        title.font = Fonts.ui(.semiBold, size: 15)
        title.textColor = UIColor(Palette.rowTextActive)
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

    private func layout(width: CGFloat) -> BannerLayout {
        BannerLayout(width: width, title: title.measurable, detail: nil, button: nil)
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
final class EmptyView: UIView {
    var onPair: (() -> Void)?
    private let mark = MarkView()
    private let label = UILabel()
    private let button = UIButton(type: .system)

    var message = "" { didSet { label.text = message; setNeedsLayout() } }
    var showsPair = true { didSet { button.isHidden = !showsPair } }

    override init(frame: CGRect) {
        super.init(frame: frame)
        mark.seed = "v2"
        label.font = Fonts.ui(.medium, size: 16)
        label.textColor = UIColor(Palette.rowText)
        label.textAlignment = .center
        label.numberOfLines = 0
        var configuration = UIButton.Configuration.filled()
        configuration.cornerStyle = .capsule
        configuration.baseBackgroundColor = UIColor(Palette.rowTextActive)
        configuration.baseForegroundColor = UIColor(Palette.groupedBackground)
        configuration.attributedTitle = AttributedString(Strings.connectAgent, attributes: AttributeContainer([.font: Fonts.ui(.semiBold, size: 16)]))
        configuration.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 22, bottom: 12, trailing: 22)
        button.configuration = configuration
        button.addAction(UIAction { [weak self] _ in self?.onPair?() }, for: .touchUpInside)
        for view in [mark, label, button] { addSubview(view) }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = EmptyLayout(size: bounds.size, label: label.measurable, button: button.isHidden ? nil : button.sizeThatFits(.zero))
        mark.frame = layout.mark
        label.frame = layout.label
        button.frame = layout.button ?? .zero
    }
}
extension HomeViewController: AgentInputCardDelegate, UIGestureRecognizerDelegate {
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
        let picker = PickerPresenter(list: chip == .effort ? .effort : .model, card: card, menus: ModelMenus(catalog: catalog, selection: mode), usage: models.usage) { [weak self] key in
            self?.choose(key)
        }
        picker.onClose = { [weak self, weak picker] in
            if let self, self.picker === picker { self.picker = nil }
        }
        self.picker = picker
        picker.show(in: view)
        ModelPickers.opened(models, mode: mode)
    }

    func agentInputCard(_ card: AgentInputCardView, didOpenMenuIn chip: AgentInputChip) {
        sidebar.disarm()
        guard let models = session?.models else { return }
        ModelPickers.opened(models, mode: models.newWorkMode)
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
