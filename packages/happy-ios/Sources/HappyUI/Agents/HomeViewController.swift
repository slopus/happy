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
    private let sidebar = SidebarList()
    private let empty = EmptyView()
    private var session: Session?
    private var accountsObservation: AccountsObservation?
    private var snapshot = Snapshot()
    private var agentHome = HomeSnapshot()
    private var connectionWatch: Task<Void, Never>?
    private var headerWatch: Watch?
    /// No network at all: the header says so, so the list doesn't too.
    private var waitingForNetwork = false
    /// A new task on its way to the screen: a second tap meanwhile opens nothing more.
    private var opening = false
    /// Search, in the bar, while it is open.
    private var search: Search?
    /// What search finds, over home.
    let resultsView = HomeSearchResultsView()
    /// The keyboard's top in this screen; nil while it has never shown.
    private var keyboardTop: CGFloat?

    private struct Search {
        var query = ""
        /// What each quick action, setting or found thing does, by its row's id.
        var results: [String: () -> Void] = [:]
        /// What the computer found, and for which query.
        var remote: (query: String, results: [HappyCore.Search.Result])?
        /// The computer's answer on its way, cancelled by the next keystroke.
        var asking: Task<Void, Never>?
    }

    /// Whether this computer answers search; nil until asked.
    private var servesSearch: Bool?
    /// The Surfaces and artifacts the phone keeps, searched as it types.
    private var surfaceCatalog: SurfaceCatalogFeed?
    private var catalogWatches: [Task<Void, Never>] = []
    private var surfaces: [AgentWire.Surface] = []
    private var artifacts: [ArtifactSummary] = []

    /// One of desktop's palette actions (`actionRows`), as a phone has them.
    private struct QuickAction {
        var id: String
        var title: String
        var glyph: String
        var run: () -> Void
    }

    /// Search ended here (a quick action took the screen): the bar's
    /// search field closes too.
    var onSearchEnded: (() -> Void)?

    /// Every snapshot shown, for the screen around this one.
    var onSnapshot: ((Snapshot) -> Void)?

    /// Home's list moved, however it moved, for the screen around this
    /// one: the iPad sidebar's search field rides on it.
    var onListScroll: (() -> Void)?

    /// The scroll edge the bar shades: it follows home's list.
    var list: UIScrollView { sidebar.edge }

    /// Home's list, under the bar.
    var homeList: SidebarList { sidebar }

    /// Search's results over home, while something answers.
    var resultsList: UIScrollView? { search != nil ? resultsView.list.edge : nil }

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
        applyGround()
        registerForTraitChanges([SidebarColumnTrait.self]) { (self: Self, _) in self.applyGround() }
        view.addSubview(sidebar)
        view.addSubview(empty)
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
        sidebar.onWillBeginDragging = { [weak self] in self?.listWillBeginDragging() }
        sidebar.onScroll = { [weak self] in self?.listDidScroll() }
        sidebar.onMove = { [weak self] in self?.onListScroll?() }
        sidebar.onDidEndDragging = { [weak self] decelerate in self?.listDidEndDragging(decelerate: decelerate) }
        sidebar.onDidEndDecelerating = { [weak self] in self?.listDidEndDecelerating() }
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
        // On a phone the row opened stays lit while its screen comes in,
        // then lets go, as Telegram's chat list does: coming back, by the
        // back button or a swipe, finds nothing selected. Beside the main
        // panel home never disappears, and its selection follows what the
        // panel shows (`shownBeside`).
        sidebar.selectedRowId = nil
        if let store = session?.store { Task { await store.attentionVisibleUpdate(false) } }
    }

    /// No ground as the iPad's sidebar: the system's sidebar shows there.
    private func applyGround() {
        view.backgroundColor = traitCollection.isSidebarColumn ? .clear : UIColor(Palette.groupedGround)
        // What search finds is on the sidebar's glass too; home's list
        // fades from under it instead (`listShowsUnderResults`).
        resultsView.backgroundColor = traitCollection.isSidebarColumn ? .clear : UIColor(Palette.groupedGround)
    }

    /// What search finds covers home's list on its own ground; on the
    /// sidebar's glass, where it has none, the list fades out under it.
    private var listShowsUnderResults: Bool { !traitCollection.isSidebarColumn }

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
        servesSearch = nil
        connectionWatch?.cancel(); connectionWatch = nil
        headerWatch = nil; waitingForNetwork = false
        session = id.flatMap { Session.session(for: $0, context: context) }
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
            headerWatch = session.watchHeader { [weak self] state in
                guard let self, waitingForNetwork != (state == .waitingForNetwork) else { return }
                waitingForNetwork = state == .waitingForNetwork
                applyConnection(agentHome)
            }
            // New work opens on the computer's models: read ahead of compose.
            session.models.load()
        }
        applyChrome()
    }

    /// Connection snapshots may change the notice at the top of the list,
    /// which comes and goes as a row does (`SidebarList.notice`): the rows'
    /// inset stays, and rows on screen move only at the list's top.
    func applyConnection(_ home: HomeSnapshot) {
        agentHome = home
        let previous = snapshot.rows
        snapshot = Snapshot()
        snapshot.availability = agentHome.loaded ? .available : .loading
        snapshot.live = agentHome.live
        snapshot.rows = agentHome.rows
        snapshot.allRows = agentHome.allRows
        // A refused action says why for a moment, where a lost connection would.
        snapshot.error = (waitingForNetwork ? nil : agentHome.error) ?? agentHome.notice.map { $0.isEmpty ? Strings.refused : $0 }
        onSnapshot?(snapshot)
        if previous != snapshot.rows {
            sidebar.apply(snapshot.rows)
            if shownBeside != nil { updateSelection() }
        }
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
        let reason = { (text: String) in text.isEmpty ? Strings.unanswered : text }
        let notice = snapshot.error.map(reason)
        // Prioritizing being off is Settings' business: home says nothing of it.
        sidebar.notice = notice
        view.setNeedsLayout()
    }

    // MARK: Search

    /// What is typed in the bar's search field.
    func search(_ query: String) {
        guard search != nil, search?.query != query else { return }
        search?.query = query
        showResults()
        ask(query)
    }

    /// The computer's half of `query`, after a pause in the typing: the
    /// last request goes as the next keystroke comes. A computer that
    /// doesn't serve it leaves the phone's own results.
    private func ask(_ query: String) {
        search?.asking?.cancel()
        let typed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let client = session?.client, !typed.isEmpty, typed.count <= 256, servesSearch != false else { return }
        search?.asking = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(120))
            guard !Task.isCancelled, let self else { return }
            if servesSearch == nil {
                guard let serves = try? await client.servesSearch() else { return }
                servesSearch = serves
                guard serves else { return }
            }
            guard !Task.isCancelled, let answer = try? await client.search(typed), !Task.isCancelled, search?.query == query else { return }
            search?.remote = (query, answer.results)
            showResults()
        }
    }

    /// The Surface catalog and the artifacts, kept current while search is open.
    private func watchCatalogs() {
        guard let session, catalogWatches.isEmpty else { return }
        let feed = SurfaceCatalogFeed(engine: session.engine)
        surfaceCatalog = feed
        let artifacts = session.engine.artifacts
        catalogWatches = [
            Task { [weak self] in
                await feed.start()
                for await state in await feed.states() {
                    guard let self, !Task.isCancelled else { return }
                    surfaces = state.surfaces
                    if search != nil { showResults() }
                }
            },
            Task { [weak self] in
                await artifacts.start()
                for await state in await artifacts.states() {
                    guard let self, !Task.isCancelled else { return }
                    self.artifacts = state.items
                    if search != nil { showResults() }
                }
            },
        ]
    }

    private func stopCatalogs() {
        catalogWatches.forEach { $0.cancel() }
        catalogWatches = []
        if let feed = surfaceCatalog { Task { await feed.stop() } }
        surfaceCatalog = nil
    }

    /// The bar's field opened. Home stays exactly as it is, and so does the
    /// header; the results fade in over home, the conversations last active
    /// until something is typed.
    func beginSearch() {
        guard session != nil, search == nil, !sidebar.isHidden else { return }
        search = Search()
        resultsView.clear()
        watchCatalogs()
        showResults()
        // The status bar takes the results to their top, never home under them.
        sidebar.list.scrollsToTop = false
        resultsView.isHidden = false
        UIView.animate(withDuration: 0.2, delay: 0, options: [.beginFromCurrentState, .curveEaseOut]) {
            self.resultsView.alpha = 1
            if !self.listShowsUnderResults { self.sidebar.alpha = 0 }
        }
    }

    /// The field closed: the results fade away, and home is as it was.
    func endSearch(animated: Bool = true) {
        guard search != nil else { return }
        search?.asking?.cancel()
        search = nil
        stopCatalogs()
        let gone = { [weak self] in
            // Search opened again while it faded: it stays.
            guard let self, search == nil else { return }
            resultsView.clear()
            resultsView.isHidden = true
            sidebar.list.scrollsToTop = true
        }
        if animated {
            UIView.animate(withDuration: 0.2, delay: 0, options: [.beginFromCurrentState, .curveEaseOut]) {
                self.resultsView.alpha = 0
                self.sidebar.alpha = 1
            } completion: { _ in gone() }
        } else {
            resultsView.alpha = 0
            sidebar.alpha = 1
            gone()
        }
        onSearchEnded?()
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
        let fused = fusedResults(for: query, remote: search.remote?.query == search.query ? search.remote?.results ?? [] : [])
        search.results = found.runs.merging(fused.runs) { first, _ in first }
        self.search = search
        resultsView.show(fused.rows + found.rows, query: query)
    }

    /// One flat list of what answers `query`: what the phone holds, at
    /// once, fused with what the computer found once it answers
    /// (`Search.fuse`). A row the phone found keeps its place in the
    /// list when the computer's results come in around it. Every result
    /// draws alike, a glyph before its title, wherever it came from; a
    /// sidebar row opens as the sidebar opens it.
    private func fusedResults(for query: String, remote: [HappyCore.Search.Result]) -> (rows: [Row], runs: [String: () -> Void]) {
        let local = HappyCore.Search.local(rows: snapshot.allRows, surfaces: surfaces, artifacts: artifacts, query: query)
        let fused = HappyCore.Search.fuse(remote: remote.map { ($0.key, $0.rank) }, local: local.map(\.key))
        var rows: [Row] = []
        var runs: [String: () -> Void] = [:]
        for one in fused {
            let id = "found:\(one.key)"
            // What the computer found in the content, under the title, wherever the row came from.
            let detail = one.remote.flatMap { Self.detail(remote[$0]) }
            if let index = one.local {
                var row: Row
                switch local[index].found {
                case .row(let found):
                    row = Row(id: id, nodeId: id, kind: .result, label: found.label, mark: .glyph(Self.glyph(found)))
                    runs[id] = { [weak self] in self?.open(found) }
                case .surface(let surface):
                    row = Row(id: id, nodeId: id, kind: .result, label: surface.name, mark: .glyph(Rows.surfaceGlyph(surface.type)))
                    runs[id] = { [weak self] in self?.openSurface(AgentWire.Surface(id: surface.id, type: surface.type, name: surface.name), row: id) }
                case .artifact(let artifact):
                    row = Row(id: id, nodeId: id, kind: .result, label: artifact.title, mark: .glyph(artifact.live || artifact.type == "html" ? "globe-outline" : "doc"))
                    runs[id] = { [weak self] in self?.openArtifact(id: artifact.id, type: artifact.type, title: artifact.title, row: id) }
                }
                row.detail = detail
                rows.append(row)
            } else if let index = one.remote {
                let result = remote[index]
                var row = Row(id: id, nodeId: id, kind: .result, label: label(result), mark: .glyph(Self.glyph(result)))
                row.detail = detail
                rows.append(row)
                runs[id] = { [weak self] in self?.open(result, row: id) }
            }
        }
        return (rows, runs)
    }

    /// The line under a result's title: the words it matched in the
    /// content, or a message's; for a vault item, the folders it is in,
    /// which say why a match only in them found it.
    private static func detail(_ result: HappyCore.Search.Result) -> String? {
        if result.match == "content" || result.type == "message", let snippet = result.snippet?.trimmingCharacters(in: .whitespacesAndNewlines), !snippet.isEmpty { return snippet }
        guard result.type == "vault_file" || result.type == "vault_folder", let path = result.path else { return nil }
        let folders = path.split(separator: "/").dropLast()
        return folders.isEmpty ? nil : folders.joined(separator: " › ")
    }

    private func label(_ result: HappyCore.Search.Result) -> String {
        switch result.type {
        // A vault app shows without its `.artifact`, as the vault shows it.
        case "vault_file": VaultEntry.shownName(result.label)
        // A message is titled by its conversation; what it says is under it.
        case "message": result.agentId.flatMap(conversationTitle) ?? Strings.untitledSession
        default: result.label
        }
    }

    /// A sidebar row's glyph among the results, as the computer's result
    /// for it would have.
    private static func glyph(_ row: Row) -> String {
        if row.kind == .session { return "chatbubbles-outline" }
        switch row.targetKind {
        case "surface": return Rows.surfaceGlyph(row.surfaceType)
        case "task", "bot", "agent": return "agents"
        default:
            if case .glyph(let glyph) = row.mark { return glyph }
            return "agents"
        }
    }

    private static func glyph(_ result: HappyCore.Search.Result) -> String {
        switch result.type {
        case "vault_file": result.kind == "artifact" ? "globe-outline" : "doc"
        case "vault_folder": "folder-outline"
        case "document": "doc"
        case "message": "chatbubbles-outline"
        case "todo": "tasks"
        case "calendar_event": "calendar"
        case "artifact": result.artifactType == "html" ? "globe-outline" : "doc"
        case "surface": Rows.surfaceGlyph(result.surfaceType)
        case "agent": result.kind == "chat" || result.kind == "subtask" ? "chatbubbles-outline" : "agents"
        default: "search"
        }
    }

    /// A Surface's name as the phone knows it, for a result that names only its ID.
    private func surfaceName(_ surfaceId: String) -> String? {
        surfaces.first { $0.id == surfaceId }?.name ?? snapshot.allRows.first { $0.targetKind == "surface" && $0.targetId == surfaceId }?.label
    }

    /// A conversation's title as the sidebar shows it.
    private func conversationTitle(_ agentId: String) -> String? {
        snapshot.allRows.first { $0.agentId == agentId }?.label
    }

    /// Opens what the computer found, where the phone shows it: a message
    /// opens its conversation.
    private func open(_ result: HappyCore.Search.Result, row: String) {
        guard let session else { return }
        switch result.type {
        case "agent", "message":
            guard let agentId = result.agentId else { return }
            session.warm.tap(agentId)
            show(ChatViewController(session: session, agentId: agentId, title: label(result), spaceId: nil, intro: nil), for: row)
        case "document", "surface", "todo", "calendar_event":
            guard let surfaceId = result.surfaceId else { return }
            let type = switch result.type {
            case "document": "document"
            case "todo": "todo"
            case "calendar_event": "calendar"
            default: result.surfaceType ?? ""
            }
            let named = result.type == "document" || result.type == "surface"
            openSurface(AgentWire.Surface(id: surfaceId, type: type, name: named ? result.label : surfaceName(surfaceId) ?? ""), row: row)
        case "artifact":
            guard let artifactId = result.artifactId else { return }
            openArtifact(id: artifactId, type: result.artifactType ?? "", title: result.label, row: row)
        case "vault_file", "vault_folder":
            let folder = result.type == "vault_folder"
            guard let surfaceId = result.surfaceId, let id = folder ? result.folderId : result.fileId else { return }
            let vaultName = surfaceName(surfaceId) ?? Strings.Vaults.title
            Task { [weak self] in
                do {
                    let place = try await session.engine.vaults.location(surfaceId, id, folder: folder)
                    guard let self else { return }
                    let controller: UIViewController = folder
                        ? VaultViewController(session: session, surfaceId: surfaceId, vaultName: vaultName, folder: place.entry, ancestors: place.ancestors)
                        : VaultPreviewViewController(session: session, surfaceId: surfaceId, vaultName: vaultName, entry: place.entry)
                    show(controller, for: row)
                } catch {
                    guard let self else { return }
                    Alerts.show(Strings.Vaults.failedTitle, VaultActions.message(error), on: self)
                }
            }
        default:
            break
        }
    }

    private func openSurface(_ surface: AgentWire.Surface, row: String) {
        guard let session else { return }
        let controller = SurfaceScreens.make(session: session, surface: surface)
        MainPanelKey.record("surface:\(surface.id)", for: controller)
        show(controller, for: row)
    }

    private func openArtifact(id: String, type: String, title: String, row: String) {
        guard let session else { return }
        show(ArtifactViewController(session: session, artifact: Artifact(id: id, version: 1, type: type, title: title, followsLatest: true)), for: row)
    }

    private func show(_ controller: UIViewController, for rowId: String) {
        openedRows.setObject(rowId as NSString, forKey: controller)
        navigationController?.pushViewController(controller, animated: true)
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
        // Search's results keep clear of the keyboard; home's list never
        // changes for them.
        // On a wide window the list, what search finds and the empty state
        // all hold to `ContentWidth.maxWidth` and sit in the middle; a
        // phone is as wide as it ever was.
        let layout = HomeLayout(size: bounds.size, contentTop: contentInsets.contentTop, chromeTop: contentInsets.chromeTop, listBottom: contentInsets.listBottom, maxWidth: ContentWidth.maxWidth, sides: LayoutInsets(view.safeAreaInsets))
        resultsView.frame = layout.content
        // The results start right at the bar's foot, with no gap of home's.
        let searchInsets = searchContentInsets ?? contentInsets
        resultsView.insets = UIEdgeInsets(top: searchInsets.chromeTop, left: 0, bottom: searchInsets.listBottom, right: 0)
        sidebar.frame = layout.content
        session?.warm.layOut(width: layout.column.width, environment: traitCollection.textEnvironment)
        let insets = UIEdgeInsets(layout.listInsets)
        let indicator = UIEdgeInsets(layout.indicatorInsets)
        if sidebar.contentInsets != insets {
            // A shrinking top leaves nothing scrolled past it.
            let atTop = sidebar.isAtTop
            sidebar.setInsets(insets, indicator: indicator, keepsTop: atTop || (!sidebar.isDragging && sidebar.contentOffsetY < -insets.top))
        } else {
            sidebar.setInsets(insets, indicator: indicator, keepsTop: false)
        }
        empty.frame = layout.empty
    }


    // MARK: Beside the main panel

    /// The main panel's root while home is the iPad's sidebar; nil on a
    /// phone. Its row stays selected, found again as the rows change.
    var shownBeside: UIViewController? {
        didSet { if shownBeside !== oldValue { updateSelection() } }
    }

    /// The row each screen was opened from, while it lives.
    private let openedRows = NSMapTable<UIViewController, NSString>.weakToStrongObjects()

    private func updateSelection() {
        sidebar.selectedRowId = shownBeside.flatMap(selectedRowId(for:))
    }

    /// The row of what `shown` shows: the one it was opened from while
    /// that is still listed, else the first row of its conversation.
    private func selectedRowId(for shown: UIViewController) -> String? {
        let rows = snapshot.rows
        if let opened = openedRows.object(forKey: shown) as String?, rows.contains(where: { $0.id == opened }) { return opened }
        if let chat = shown as? ChatViewController, !chat.shownAgentId.isEmpty {
            return rows.first { ($0.kind == .space || $0.kind == .session) && $0.targetKind != "surface" && $0.agentId == chat.shownAgentId }?.id
        }
        if shown is ArtifactsViewController { return rows.first { $0.targetKind == "artifacts" }?.id }
        if shown is TodoListsViewController { return rows.first { $0.targetKind == "todos" }?.id }
        if shown is FeedViewController { return rows.first { $0.targetKind == "feed" }?.id }
        return nil
    }

    /// Pushes what a row opens; from the sidebar it becomes the main
    /// panel's root (`SidebarNavigationController`).
    private func show(_ controller: UIViewController, for row: Row, animated: Bool) {
        openedRows.setObject(row.id as NSString, forKey: controller)
        navigationController?.pushViewController(controller, animated: animated)
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
            sidebar.selectedRowId = row.id
            show(ArtifactsViewController(session: session), for: row, animated: animated)
        case .space where row.targetKind == "todos":
            sidebar.selectedRowId = row.id
            show(TodoListsViewController(session: session), for: row, animated: animated)
        case .space where row.targetKind == "feed":
            sidebar.selectedRowId = row.id
            show(FeedViewController(session: session), for: row, animated: animated)
        case .search:
            beginSearch()
        case .create:
            makeNewWork()
        case .space where row.targetKind == "surface":
            guard let surfaceId = row.targetId else { return }
            sidebar.selectedRowId = row.id
            let surface = AgentWire.Surface(id: surfaceId, type: row.surfaceType ?? "", name: row.label)
            let controller = SurfaceScreens.make(session: session, surface: surface)
            MainPanelKey.record("surface:\(surfaceId)", for: controller)
            show(controller, for: row, animated: animated)
        case .space, .session:
            guard let agentId = row.agentId else { return }
            sidebar.selectedRowId = row.id
            session.warm.tap(agentId)
            let space = row.spaceId.flatMap { id in snapshotSpace(id) }
            let chat = ChatViewController(session: session, agentId: agentId, title: row.label, spaceId: row.spaceId, intro: space)
            show(chat, for: row, animated: animated)
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
        let chat = ChatViewController(session: session, agentId: agentId, title: row.label, spaceId: row.spaceId, intro: space, previewing: true)
        let window = view.window
        let screen = window?.bounds.size ?? view.bounds.size
        let insets = window?.safeAreaInsets ?? view.safeAreaInsets
        chat.preferredContentSize = PreviewLayout.size(screen: screen, top: insets.top, bottom: insets.bottom, regular: traitCollection.horizontalSizeClass == .regular)
        return chat
    }

    private func snapshotSpace(_ spaceId: String) -> ChatViewController.Intro? {
        guard let row = snapshot.rows.first(where: { $0.spaceId == spaceId }) else { return nil }
        if case .clay(let slug) = row.mark { return .clay(slug) }
        return nil
    }

    /// The bar's compose: new work.
    func compose() {
        makeNewWork()
    }

    /// A new task: its empty conversation is pushed with the keyboard
    /// coming up, or, for a picture, the "+" sheet over it. Nothing is made
    /// on the computer and no row shows until its first message is sent,
    /// so leaving it leaves nothing behind; compose again before then opens
    /// the same one, with what was typed in it.
    ///
    /// Dictated on home's microphone, the words are its first message,
    /// sent as it comes in, so the task starts at once; to look over, they
    /// wait in its composer instead.
    func makeNewWork(library: Bool = false, dictated: RecordButton.Result? = nil) {
        guard let session, !opening, navigationController?.topViewController === parent || navigationController?.topViewController === self else { return }
        opening = true
        let store = session.store
        Task { @MainActor in
            defer { opening = false }
            let task = await store.newTask()
            // Gone from the screen meanwhile: nothing is pushed over another.
            guard navigationController?.topViewController === parent || navigationController?.topViewController === self else { return }
            Haptics.play(.newWork)
            let chat: ChatViewController
            switch dictated {
            case .send(let words)?:
                chat = NewWork.chat(session, task: task, dictated: words)
            case .review(let words)?:
                chat = NewWork.chat(session, task: task, prefill: ChatPrefill(prefix: words))
            case nil:
                chat = NewWork.chat(session, task: task, library: library)
            }
            guard let navigation = navigationController else { return }
            if library {
                navigation.pushViewController(chat, animated: true)
                // Over the screen it goes to, as that screen comes in.
                chat.presentAttach(from: navigation)
            } else if case .send? = dictated {
                // Nothing to type: no keyboard, the words go as it comes in.
                navigation.pushViewController(chat, animated: true)
            } else {
                // The keyboard first, then the push in its frame (`KeyboardPush`).
                KeyboardPush.push(chat, on: navigation, traits: chat.card.textView)
            }
        }
    }
}

extension HomeViewController {
    private func listWillBeginDragging() {
        // Scrolling is being in the list: Prioritizing's batches wait.
        if let store = session?.store { Task { await store.attentionInput() } }
    }

    private func listDidScroll() {
        #if DEBUG || HAPPY_FIXTURES
        GymFrameMeter.noteScroll()
        #endif
    }

    private func listDidEndDragging(decelerate: Bool) {
        if !decelerate { warmUp() }
    }

    private func listDidEndDecelerating() {
        warmUp()
    }

    /// The rows the sidebar shows and where it is scrolled, for reading
    /// ahead what is on screen and around it.
    private func warmUp() {
        guard let session, !snapshot.allRows.isEmpty else { return }
        let shown = sidebar.shownRows
        session.warm.update(rows: shown.isEmpty ? snapshot.rows : shown, visible: shown.isEmpty ? nil : sidebar.visibleRange, references: snapshot.references)
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
