#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyWire
import UIKit

/// The sidebar's list grouped by project (`TabletGroupedList`), in a
/// UITableView: SessionsList.tsx's bots, machine rules, checkout headings
/// over cards of chats, the archive toggle and the archived cards, under
/// the same notices as home's list (HomeListHeader.tsx).
///
/// Its rows are worked out off the main thread (`TabletSidebarDerivation`):
/// `apply` gets the rows and exactly which of them changed, and only
/// inserts, deletes, moves or reconfigures those. The open chat's row stays
/// selected across every update.
///
/// Its rows and notices follow the person's text size, as RN's do: the
/// headings' and the bots' heights come measured at that size with the rows
/// (`TabletGroupedHeights`), and the chats' and archived cards' are
/// fixed, as in RN, with their text drawn scaled inside. The notices are
/// home's header, measured off the main thread at that size as home's are
/// (docs/DYNAMIC-TYPE.md).
final class TabletGroupedListViewController: UIViewController, UITableViewDataSource, UITableViewDelegate {
    private typealias Row = TabletGroupedRow

    private let context: AppContext
    private let session: AccountSession
    private(set) var model = TabletGroupedList.empty
    private let tableView = UITableView(frame: .zero, style: .plain)
    /// The table has asked for its rows once; from then on it only takes
    /// changesets.
    private var tableLoaded = false
    /// The headings' and bots' heights for `model`'s rows, measured off the
    /// main thread at this screen's text size and the list's width.
    private var headings = TabletHeadingHeights<Row.ID>()
    private let banners = HomeListHeaderView()
    private var bannerState: HomeBanners?
    /// What the header was last measured for; its height lands only for
    /// this.
    private(set) var headerRequested: HeaderKey?
    private(set) var headerTask: Task<Void, Never>?
    private lazy var actions = HomeSessionActions(context: context, session: session, host: self)
    /// useHappyAction: one kill at a time per chat; its swipe is off
    /// meanwhile (`enabled={!archivingSession}`).
    private var killing: Set<String> = []
    private let changelogMarker = ChangelogReadMarker(storage: UserDefaultsStore(suiteName: ChangelogReadMarker.suiteName))
    private var nativeUpdateObservation: AccountsObservation?

    /// The open chat (SessionsList.tsx `selectedSessionId`).
    var selectedSessionId: String? {
        didSet { if selectedSessionId != oldValue { applySelection() } }
    }

    /// Room under the last row (SessionsList.tsx `bottomContentInset`).
    var bottomInset: CGFloat = 0 {
        didSet {
            if bottomInset != oldValue, isViewLoaded {
                tableView.contentInset.bottom = bottomInset
            }
        }
    }

    init(context: AppContext, session: AccountSession) {
        self.context = context
        self.session = session
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func loadView() {
        view = tableView
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        tableView.separatorStyle = .none
        tableView.contentInsetAdjustmentBehavior = .never
        tableView.backgroundColor = UIColor(Palette.groupedBackground)
        tableView.contentInset.bottom = bottomInset
        tableView.delegate = self
        tableView.dataSource = self
        for (type, identifier) in [
            (TabletSectionHeaderCell.self as UITableViewCell.Type, TabletSectionHeaderCell.reuseIdentifier),
            (SessionRowCell.self, SessionRowCell.reuseIdentifier),
            (TabletMachineRuleCell.self, TabletMachineRuleCell.reuseIdentifier),
            (TabletWorkspaceHeaderCell.self, TabletWorkspaceHeaderCell.reuseIdentifier),
            (TabletChatCell.self, TabletChatCell.reuseIdentifier),
            (ArchiveToggleCell.self, ArchiveToggleCell.reuseIdentifier),
            (TabletArchivedCell.self, TabletArchivedCell.reuseIdentifier),
        ] {
            tableView.register(type, forCellReuseIdentifier: identifier)
        }
        let longPress = UILongPressGestureRecognizer(target: self, action: #selector(longPressed(_:)))
        tableView.addGestureRecognizer(longPress)
        // Home's notices, drawn here at the person's text size.
        banners.traitOverrides.followsTextSize = true
        banners.onTroubleshoot = { [weak self] in self?.open(.troubleshoot) }
        banners.onNativeUpdate = { [weak self] in self?.openStore() }
        banners.onWhatsNew = { [weak self] in self?.openWhatsNew() }
        nativeUpdateObservation = NativeUpdateCheck.shared.observe { [weak self] in
            self?.updateBanners()
        }
        // A new text size or screen: the notices are measured again.
        registerForTraitChanges([UITraitPreferredContentSizeCategory.self, UITraitDisplayScale.self]) { (self: Self, _) in
            self.sizeHeader()
        }
        tableView.reloadData()
        tableLoaded = true
        updateBanners()
        applySelection()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // What's New may have been read on a screen opened from here.
        updateBanners()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        sizeHeader()
    }

    /// Shows `next`; `changeset` takes the rows on screen (`model`) to it,
    /// and `headings` are its headings' heights, `moved` the rows on screen
    /// whose height they changed. Returns how many rows it touched.
    @discardableResult
    func apply(
        _ next: TabletGroupedList,
        changeset: RowChangeset,
        headings: TabletHeadingHeights<TabletGroupedRow.ID>,
        moved: Set<TabletGroupedRow.ID>,
        animated: Bool
    ) -> Int {
        let previous = model
        let previousMetrics = self.headings.metrics
        model = next
        // Before any insert asks for a height.
        self.headings = headings
        guard isViewLoaded, tableLoaded else { return 0 }
        if changeset.isStructural {
            let rows = { (indexes: [Int]) in indexes.map { IndexPath(row: $0, section: 0) } }
            let animation: UITableView.RowAnimation = animated ? .fade : .none
            let update = {
                self.tableView.performBatchUpdates {
                    self.tableView.deleteRows(at: rows(changeset.deletes), with: animation)
                    self.tableView.insertRows(at: rows(changeset.inserts), with: animation)
                    for move in changeset.moves {
                        self.tableView.moveRow(at: IndexPath(row: move.from, section: 0), to: IndexPath(row: move.to, section: 0))
                    }
                }
            }
            if animated { update() } else { UIView.performWithoutAnimation(update) }
        }
        var reconfigure = changeset.reconfigures.map { IndexPath(row: $0, section: 0) }
        if next.avatarStyle != previous.avatarStyle || next.avatarMonochrome != previous.avatarMonochrome {
            // Every avatar on screen redraws; the rest are made when shown.
            reconfigure = tableView.indexPathsForVisibleRows ?? []
        }
        let bots = botsTakingLines(from: previousMetrics)
        if !bots.isEmpty {
            reconfigure = Array(Set(reconfigure).union(bots))
        }
        if !reconfigure.isEmpty {
            tableView.reconfigureRows(at: reconfigure)
        }
        // A heading whose height moved: the table asks for heights again.
        if !moved.isEmpty {
            UIView.performWithoutAnimation { tableView.performBatchUpdates(nil) }
        }
        if next.offline != previous.offline { updateBanners() }
        applySelection()
        return changeset.touchedRows
    }

    /// New heights for the rows as they are: a new text size or width.
    /// Returns how many rows moved or took new lines.
    @discardableResult
    func applyHeadings(_ headings: TabletHeadingHeights<TabletGroupedRow.ID>, moved: Set<TabletGroupedRow.ID>) -> Int {
        let previousMetrics = self.headings.metrics
        self.headings = headings
        guard isViewLoaded, tableLoaded else { return 0 }
        let bots = botsTakingLines(from: previousMetrics)
        guard !moved.isEmpty || !bots.isEmpty else { return 0 }
        UIView.performWithoutAnimation {
            tableView.performBatchUpdates {
                if !bots.isEmpty { tableView.reconfigureRows(at: bots) }
            }
        }
        return max(moved.count, bots.count)
    }

    /// Every bot's row when the lines its cell draws with changed: all of
    /// them, so a cell the table made ahead for a row off screen takes the
    /// new lines too; the table reconfigures only the cells it has.
    private func botsTakingLines(from previous: TabletHeadingMetrics?) -> [IndexPath] {
        guard headings.metrics?.sessionLines != previous?.sessionLines else { return [] }
        return model.rows.indices.compactMap { index in
            if case .bot = model.rows[index] { return IndexPath(row: index, section: 0) }
            return nil
        }
    }

    /// Selects the open chat's row, wherever it moved; nothing else stays
    /// selected.
    private func applySelection() {
        guard isViewLoaded, tableLoaded else { return }
        let index = selectedSessionId.flatMap { id in model.rows.firstIndex { $0.sessionId == id } }
        let path = index.map { IndexPath(row: $0, section: 0) }
        if let current = tableView.indexPathForSelectedRow, current != path {
            tableView.deselectRow(at: current, animated: false)
        }
        if let path, tableView.indexPathForSelectedRow != path {
            tableView.selectRow(at: path, animated: false, scrollPosition: .none)
        }
    }

    // MARK: Data

    func numberOfSections(in tableView: UITableView) -> Int {
        1
    }

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        model.rows.count
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        guard let row = row(at: indexPath) else { return UITableViewCell() }
        let cell = tableView.dequeueReusableCell(withIdentifier: Self.reuseIdentifier(row), for: indexPath)
        configure(cell, row)
        return cell
    }

    private func row(at indexPath: IndexPath) -> Row? {
        model.rows.indices.contains(indexPath.row) ? model.rows[indexPath.row] : nil
    }

    private static func reuseIdentifier(_ row: Row) -> String {
        switch row {
        case .botsHeader, .archiveHeader: TabletSectionHeaderCell.reuseIdentifier
        case .bot: SessionRowCell.reuseIdentifier
        case .machine: TabletMachineRuleCell.reuseIdentifier
        case .workspace: TabletWorkspaceHeaderCell.reuseIdentifier
        case .chat: TabletChatCell.reuseIdentifier
        case .archiveToggle: ArchiveToggleCell.reuseIdentifier
        case .archived: TabletArchivedCell.reuseIdentifier
        }
    }

    /// One configuration for every live cell.
    private func configure(_ cell: UITableViewCell, _ row: Row) {
        if let cell = cell as? SessionRowCell { cell.avatar.pictures = session.avatarPictures }
        if let cell = cell as? TabletWorkspaceHeaderCell { cell.avatar.pictures = session.avatarPictures }
        if let cell = cell as? TabletArchivedCell { cell.avatar.pictures = session.avatarPictures }
        switch row {
        case .botsHeader:
            (cell as? TabletSectionHeaderCell)?.configure(Strings.Tablet.bots)
        case .archiveHeader(let age):
            (cell as? TabletSectionHeaderCell)?.configure(SessionListViewController.dayTitle(age))
        case .bot(let session):
            guard let cell = cell as? SessionRowCell else { return }
            // Home's row, drawn here at the person's text size, with the
            // lines its height was measured with.
            cell.traitOverrides.followsTextSize = true
            cell.lines = headings.metrics?.sessionLines ?? .designed
            cell.configure(session, style: model.avatarStyle, monochrome: model.avatarMonochrome)
        case .machine(let id, let name):
            (cell as? TabletMachineRuleCell)?.configure(name: name, opens: id?.isEmpty == false)
        case .workspace(let header):
            guard let cell = cell as? TabletWorkspaceHeaderCell else { return }
            cell.configure(header, style: model.avatarStyle, monochrome: model.avatarMonochrome)
            cell.onAdd = { [weak self] in self?.startSession(in: header.place) }
        case .chat(let chat):
            (cell as? TabletChatCell)?.configure(chat)
        case .archiveToggle(let hidden):
            guard let cell = cell as? ArchiveToggleCell else { return }
            // Home's cell, drawn here at the person's text size.
            cell.traitOverrides.followsTextSize = true
            cell.banded = false
            cell.backgroundColor = UIColor(Palette.groupedBackground)
            cell.configure(hidden: hidden)
        case .archived(let archived):
            (cell as? TabletArchivedCell)?.configure(archived, style: model.avatarStyle, monochrome: model.avatarMonochrome)
        }
    }

    /// Rows that are one height whatever they say.
    private func fixedHeight(_ row: Row, width: CGFloat) -> CGFloat? {
        let hairline = view.hairline
        switch row {
        case .chat(let chat):
            return TabletGroupedRowHeights.chat(width: width, hairline: hairline, first: chat.first, last: chat.last, projectEnd: chat.projectEnd)
        case .archived(let archived):
            return TabletGroupedRowHeights.archived(width: width, hairline: hairline, last: archived.last)
        default: return nil
        }
    }


    // MARK: Banners

    /// Everything the header's height is measured from: the notices and
    /// their words, the list's width, how wide a group may grow, and the
    /// text size and screen.
    struct HeaderKey: Equatable {
        var banners: HomeBanners
        var width: CGFloat
        var maxWidth: CGFloat
        var text: TextEnvironment
    }

    /// HomeListHeader.tsx: the offline plaque, then the update banner. The
    /// header is set again only when what it shows changed.
    private func updateBanners() {
        guard isViewLoaded else { return }
        var offlineTitle: String?
        if let offline = model.offline, !offline.isEmpty {
            offlineTitle = offline.count == 1
                ? Strings.Troubleshoot.bannerTitleOne(name: offline[0].name)
                : Strings.Troubleshoot.bannerTitleMany
        }
        let state = HomeBanners(
            offlineTitle: offlineTitle,
            nativeUpdate: NativeUpdateCheck.shared.updateURL != nil,
            whatsNew: changelogMarker.hasUnread(latestTitle: ChangelogViewController.bundled.latestTitle)
        )
        guard state != bannerState else { return }
        bannerState = state
        sizeHeader()
    }

    /// The header is measured off the main thread, as home's is, and set,
    /// with what it shows, once its height is in; only when the notices,
    /// the width or the text size changed. No notices takes it away at
    /// once.
    private func sizeHeader() {
        guard isViewLoaded, let state = bannerState else { return }
        guard !state.isEmpty else {
            headerRequested = nil
            if tableView.tableHeaderView != nil { tableView.tableHeaderView = nil }
            return
        }
        let key = HeaderKey(
            banners: state,
            width: tableView.bounds.width,
            maxWidth: ContentWidth.maxWidth,
            text: TextEnvironment(traitCollection)
        )
        guard key.width > 0, key != headerRequested else { return }
        headerRequested = key
        headerTask = Task { @MainActor [weak self] in
            let height = await Task.detached(priority: .userInitiated) {
                HomeRowMeasurer.headerHeight(
                    key.banners,
                    width: key.width,
                    maxWidth: key.maxWidth,
                    environment: HomeTextEnvironment(key.text)
                )
            }.value
            self?.landHeader(key, height: height)
        }
    }

    /// A header height measured off the main thread. Only one measured for
    /// exactly what was last asked for lands; any other is refused, and the
    /// header shown stays.
    func landHeader(_ key: HeaderKey, height: CGFloat) {
        guard key == headerRequested else { return }
        // The words the height was measured with.
        banners.content = key.banners
        banners.frame = CGRect(x: 0, y: 0, width: key.width, height: height)
        tableView.tableHeaderView = banners
    }

    // MARK: Actions

    private func open(_ route: Route) {
        push(route, context: context)
    }

    /// UpdateBanner.tsx `handleOpenStore`.
    private func openStore() {
        guard let link = NativeUpdateCheck.shared.updateURL, let url = URL(string: link) else { return }
        UIApplication.shared.open(url)
    }

    /// UpdateBanner.tsx marks What's New read a second after opening it.
    private func openWhatsNew() {
        open(.changelog)
        let marker = changelogMarker
        let latest = ChangelogViewController.bundled.latestTitle
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(1))
            marker.markViewed(latest)
            self?.updateBanners()
        }
    }

    /// ProjectGroup.tsx `handleNewSession`: the draft points at this
    /// checkout, then the new-session screen opens (the sidebar has no dock
    /// to focus).
    private func startSession(in place: TabletNewSessionPlace) {
        let draft = NewSessionDraftStore.shared(for: context.account.localSettings)
        if let machineId = place.machineId { draft.setMachineId(machineId) }
        if let path = place.path { draft.setPath(path) }
        draft.setSessionType(place.worktreeKey == nil ? .simple : .worktree)
        draft.setWorktreeKey(place.worktreeKey)
        open(.newSession(machineId: nil, path: nil, prompt: nil))
    }

    // MARK: Delegate

    func tableView(_ tableView: UITableView, heightForRowAt indexPath: IndexPath) -> CGFloat {
        guard let row = row(at: indexPath) else { return 0 }
        let width = tableView.bounds.width
        if let height = fixedHeight(row, width: width) { return height }
        // Headings, rules and the toggle: measured with the rows, off the
        // main thread.
        if let height = headings.height(model.ids[indexPath.row]) { return height }
        // Not expected: the heights come with the rows. Sized from the same
        // metrics, which is arithmetic, not text measurement.
        guard let metrics = headings.metrics, let heading = TabletGroupedHeights.heading(row) else { return 0 }
        return TabletGroupedRowHeights.heading(heading, width: width, metrics: metrics)
    }

    func tableView(_ tableView: UITableView, shouldHighlightRowAt indexPath: IndexPath) -> Bool {
        guard let row = row(at: indexPath) else { return false }
        switch row {
        case .archiveToggle: return true
        case .machine(let id, _): return id?.isEmpty == false
        default: return row.sessionId != nil
        }
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        guard let row = row(at: indexPath) else { return }
        switch row {
        case .archiveToggle(let hidden):
            session.updateSettings(["hideInactiveSessions": .bool(!hidden)])
        case .machine(let id?, _) where !id.isEmpty:
            open(.machine(id: id))
        default:
            if let sessionId = row.sessionId { open(.session(id: sessionId)) }
        }
        // Only the open chat stays selected; the shell says which it is.
        applySelection()
    }

    /// "Archive Session" on red: FlatSessionRow's swipe on the bots, which
    /// archives, and CompactSessionRow's on the chats, which only stops the
    /// session. Archived cards don't swipe.
    func tableView(_ tableView: UITableView, trailingSwipeActionsConfigurationForRowAt indexPath: IndexPath) -> UISwipeActionsConfiguration? {
        guard let row = row(at: indexPath), let sessionId = row.sessionId else { return nil }
        let kills: Bool
        switch row {
        case .bot: kills = false
        case .chat: kills = true
        default: return nil
        }
        if kills, killing.contains(sessionId) { return nil }
        let action = UIContextualAction(style: .destructive, title: Strings.SessionInfo.archiveSession) { [weak self] _, _, done in
            // The swipe closes first (`swipeableRef.current?.close()`).
            done(true)
            if kills { self?.kill(sessionId) } else { self?.actions.archive(sessionId) }
        }
        action.image = .icon(.ionicons("archive-outline"), size: 20)
        action.backgroundColor = UIColor(Palette.statusError)
        let configuration = UISwipeActionsConfiguration(actions: [action])
        configuration.performsFirstActionWithFullSwipe = false
        return configuration
    }

    /// CompactSessionRow's `performArchive`: `sessionKill`, and its message
    /// (or "Failed to archive session") when the CLI says no.
    private func kill(_ sessionId: String) {
        guard killing.insert(sessionId).inserted else { return }
        let ops = session.homeSessionOps
        Task { @MainActor [weak self] in
            let outcome = await TabletChatArchive.run(ops, sessionId: sessionId)
            guard let self else { return }
            killing.remove(sessionId)
            switch outcome {
            case .killed: break
            case .refused(let message): alert(message ?? Strings.SessionInfo.failedToArchiveSession)
            case .failed: alert(Strings.Home.actionUnknownError)
            }
        }
    }

    /// useHappyAction's "Error" alert.
    private func alert(_ message: String) {
        Alerts.show(Strings.Home.actionError, message, on: presentedViewController ?? self)
    }

    /// A long press on a chat opens the "Session" alert
    /// (useSessionActionAlert); the headings have none.
    @objc private func longPressed(_ gesture: UILongPressGestureRecognizer) {
        guard gesture.state == .began,
              let indexPath = tableView.indexPathForRow(at: gesture.location(in: tableView)),
              let sessionId = row(at: indexPath)?.sessionId
        else { return }
        actions.present(sessionId: sessionId)
    }
}
#endif
