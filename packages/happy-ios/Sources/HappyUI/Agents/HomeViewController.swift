#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Home: one paired computer's sidebar, as desktop's classic sidebar
/// (`SidebarRows`) draws it, under the navigation bar. Nothing is
/// typed here: compose in the bar (`compose()`) opens new work, an empty
/// conversation whose first message makes it. Desktop's Search and Create
/// rows aren't drawn: search and compose are the bar's.
///
/// Search is the bar's field (the host drives `beginSearch`, `search(_:)`
/// and `endSearch`); what answers shows in its own component over home
/// (`HomeSearchResultsView`): the rows that answer, then the quick actions
/// and the settings that do, as desktop's ⌘K palette lists them. Home's
/// list is never touched by it: its rows, scroll and insets stay as they
/// were through opening, typing and closing.
final class HomeViewController: UIViewController {
    private let context: AppContext
    /// The computer this screen always shows; nil to follow the choice.
    private let fixedAgentConnection: String?
    private let sidebar = SidebarView()
    private let banner = BannerView()
    private let empty = EmptyView()
    private var session: Session?
    private var accountsObservation: AccountsObservation?
    private var snapshot = Snapshot()
    private var agentHome = HomeSnapshot()
    private var connectionWatch: Task<Void, Never>?
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
    /// What search finds, over home.
    private let resultsView = HomeSearchResultsView()
    /// The keyboard's top in this screen; nil while it has never shown.
    private var keyboardTop: CGFloat?

    private struct Search {
        var query = ""
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

    /// Home's list, under the bar: the scroll edge the bar shades.
    var list: UIScrollView { sidebar }

    /// Search's results over home, while something answers.
    var resultsList: UIScrollView? { search != nil ? resultsView.list : nil }

    /// The bar home lays its content under.
    var contentInsets = HomeContentInsets(safeArea: .zero, dock: 0) {
        didSet { if contentInsets != oldValue { view.setNeedsLayout() } }
    }
    var searchContentInsets: HomeContentInsets? {
        didSet { if searchContentInsets != oldValue { view.setNeedsLayout() } }
    }

    init(context: AppContext, computer: String? = nil) {
        self.context = context
        fixedAgentConnection = computer
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        // The conversation's own ground, light and dark; the list on it is
        // grouped, a quiet card per section, Happy's own card first.
        view.backgroundColor = UIColor(Palette.groupedGround)
        sidebar.style = .grouped
        view.addSubview(sidebar)
        view.addSubview(storiesBand)
        stories.install(in: storiesBand)
        view.addSubview(empty)
        view.addSubview(banner)
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardWillChange(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        resultsView.isHidden = true
        resultsView.alpha = 0
        resultsView.list.onSelect = { [weak self] row in self?.open(row) }
        resultsView.onDismiss = { [weak self] in self?.endSearch() }
        resultsView.list.onIntent = { [weak self] row in
            guard let agentId = row.agentId, row.targetKind != "surface" else { return }
            self?.session?.warm.intent(agentId)
        }
        view.addSubview(resultsView)
        sidebar.onSelect = { [weak self] row in self?.open(row) }
        sidebar.onIntent = { [weak self] row in
            guard let agentId = row.agentId, row.targetKind != "surface" else { return }
            self?.session?.warm.intent(agentId)
        }
        sidebar.preview = { [weak self] row in self?.preview(for: row) }
        sidebar.onOpenPreview = { [weak self] row in self?.open(row, animated: false) }
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
        connectionWatch?.cancel(); connectionWatch = nil
        session = id.flatMap { Session.session(for: $0, context: context) }
        stories.attach(session)
        sidebar.images = session?.images
        resultsView.list.images = session?.images
        sidebar.apply([])
        snapshot = Snapshot()
        agentHome = HomeSnapshot()
        if let session {
            connectionWatch = Task { [weak self, engine = session.engine] in
                for await snapshot in await engine.snapshots() {
                    guard !Task.isCancelled, let self else { return }
                    self.applyConnection(snapshot)
                }
            }
            // New work opens on the computer's models: read ahead of compose.
            session.models.load()
        }
        applyChrome()
    }

    /// Connection snapshots may change the notice over the list. Its
    /// arrival never changes the rows' inset or screen positions.
    func applyConnection(_ home: HomeSnapshot) {
        agentHome = home
        let previous = snapshot.rows
        snapshot = Snapshot()
        snapshot.availability = agentHome.loaded ? .available : .loading
        snapshot.live = agentHome.live
        snapshot.rows = agentHome.rows
        snapshot.allRows = agentHome.allRows
        snapshot.error = agentHome.error
        onSnapshot?(snapshot)
        if previous != snapshot.rows { showRows() }
        if search != nil { showResults() }
        warmUp()
        applyChrome()
    }

    private func applyChrome() {
        let hasAgentConnection = session != nil
        empty.isHidden = hasAgentConnection && snapshot.availability != .unsupported
        empty.message = !hasAgentConnection ? Strings.noAgentConnection : Strings.unsupported
        empty.showsPair = !hasAgentConnection
        sidebar.isHidden = !empty.isHidden
        stories.isSuppressed = sidebar.isHidden
        let reason = { (text: String) in text.isEmpty ? Strings.unanswered : text }
        let notice = snapshot.creationError.map { Strings.newWorkFailed(reason($0)) } ?? snapshot.error.map(reason)
        // Prioritizing being off is Settings' business: home says nothing of it.
        banner.configure(notice: notice)
        view.setNeedsLayout()
    }

    // MARK: Search

    /// What is typed in the bar's search field.
    func search(_ query: String) {
        guard search != nil, search?.query != query else { return }
        search?.query = query
        showResults()
    }

    /// The bar's field opened. Home stays exactly as it is, and so does the
    /// header; the results fade in over home, the conversations last active
    /// until something is typed.
    func beginSearch() {
        guard session != nil, search == nil, !sidebar.isHidden else { return }
        search = Search()
        resultsView.clear()
        showResults()
        resultsView.isHidden = false
        UIView.animate(withDuration: 0.2, delay: 0, options: [.beginFromCurrentState, .curveEaseOut]) {
            self.resultsView.alpha = 1
        }
    }

    /// The field closed: the results fade away, and home is as it was.
    func endSearch(animated: Bool = true) {
        guard search != nil else { return }
        search = nil
        let gone = { [weak self] in
            // Search opened again while it faded: it stays.
            guard let self, search == nil else { return }
            resultsView.clear()
            resultsView.isHidden = true
        }
        if animated {
            UIView.animate(withDuration: 0.2, delay: 0, options: [.beginFromCurrentState, .curveEaseOut]) {
                self.resultsView.alpha = 0
            } completion: { _ in gone() }
        } else {
            resultsView.alpha = 0
            gone()
        }
        onSearchEnded?()
    }

    /// Home's own rows, with the stories' rings.
    private func showRows() {
        sidebar.apply(shownRows)
    }

    /// The rows the list draws: the list with the stories' rings, its tree kept.
    private var shownRows: [Row] {
        SidebarRows.withStories(snapshot.rows, rings: stories.rings)
    }

    /// What answers the query, in the results over home: the rows that
    /// answer it, then the quick actions and settings that do. Nothing
    /// typed: the conversations last active.
    private func showResults() {
        guard var search else { return }
        let query = search.query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else {
            search.results = [:]
            self.search = search
            resultsView.show(HappyCore.Search.recent(snapshot.allRows), query: "")
            return
        }
        let found = results(for: query)
        search.results = found.runs
        self.search = search
        resultsView.show(HappyCore.Search.rows(snapshot.allRows, query: query) + found.rows, query: query)
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
            // New work takes the screen, so the search gives it back first.
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
        resultsView.keyboardTop = keyboardTop
        guard search != nil, view.window != nil else { return }
        // A keyboard of a screen over home's moves it only once it's back.
        let top = parent ?? self
        guard navigationController?.topViewController === top && (top.presentedViewController == nil || top.presentedViewController is UISearchController) else {
            view.setNeedsLayout()
            return
        }
        let duration = notification.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0.25
        let curve = notification.userInfo?[UIResponder.keyboardAnimationCurveUserInfoKey] as? UInt ?? 7
        UIView.animate(withDuration: duration, delay: 0, options: [UIView.AnimationOptions(rawValue: curve << 16), .beginFromCurrentState]) {
            self.resultsView.layoutIfNeeded()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let bounds = view.bounds
        let bannerHeight = banner.isEmpty ? 0 : banner.sizeThatFits(CGSize(width: bounds.width, height: .greatestFiniteMagnitude)).height
        // Search's results keep clear of the keyboard; home's list never
        // changes for them.
        // On a wide window the list, the stories, what search finds and the
        // empty state all hold to `ContentWidth.maxWidth` and sit in the
        // middle; a phone is as wide as it ever was.
        let layout = HomeLayout(size: bounds.size, contentTop: contentInsets.contentTop, chromeTop: contentInsets.chromeTop, listBottom: contentInsets.listBottom, bannerHeight: bannerHeight, storiesHeight: sidebar.isHidden ? 0 : stories.inset, maxWidth: ContentWidth.maxWidth, bannerOverlaysList: true)
        resultsView.frame = layout.content
        // The results start right at the bar's foot, with no gap of home's.
        let searchInsets = searchContentInsets ?? contentInsets
        resultsView.insets = UIEdgeInsets(top: searchInsets.chromeTop, left: 0, bottom: searchInsets.listBottom, right: 0)
        banner.frame = layout.banner
        storiesBand.frame = CGRect(x: layout.content.minX, y: contentInsets.chromeTop, width: layout.content.width, height: max(0, bounds.height - contentInsets.chromeTop))
        sidebar.frame = layout.content
        session?.warm.layOut(width: layout.content.width, environment: traitCollection.textEnvironment)
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
            // A folder opens nothing: its sessions are listed under it.
            break
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

    /// The bar's compose: new work.
    func compose() {
        makeNewWork()
    }

    /// New work, right below Happy: the row and its empty conversation exist
    /// at once, and the conversation is pushed with the keyboard coming up,
    /// or, for a picture, the "+" sheet over it. Leaving new work never
    /// closes it, so new work already standing empty is opened instead,
    /// where it is (desktop's rule): from the bar any, newest first; from a
    /// heading's "+" only one under that heading.
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
            sidebar.selectedRowId = "space:\(creation.spaceId)"
            let chat = NewWork.chat(session, creation: creation, library: library)
            guard let navigation = navigationController else { return }
            navigation.pushViewController(chat, animated: true)
            // Over the screen it goes to, as that screen comes in.
            if library { chat.presentAttach(from: navigation) }
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
#endif
