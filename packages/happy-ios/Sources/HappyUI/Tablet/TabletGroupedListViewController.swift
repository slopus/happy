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
final class TabletGroupedListViewController: UIViewController, UITableViewDataSource, UITableViewDelegate {
    private typealias Row = TabletGroupedRow

    private let context: AppContext
    private let session: AccountSession
    private(set) var model = TabletGroupedList.empty
    private let tableView = UITableView(frame: .zero, style: .plain)
    /// The table has asked for its rows once; from then on it only takes
    /// changesets.
    private var tableLoaded = false
    private var heights: [Row.ID: (row: Row, width: CGFloat, height: CGFloat)] = [:]
    private let sizingSection = TabletSectionHeaderCell(style: .default, reuseIdentifier: nil)
    private let sizingMachine = TabletMachineRuleCell(style: .default, reuseIdentifier: nil)
    private let sizingWorkspace = TabletWorkspaceHeaderCell(style: .default, reuseIdentifier: nil)
    private let sizingToggle = ArchiveToggleCell(style: .default, reuseIdentifier: nil)
    private let banners = HomeListHeaderView()
    private var bannerState: BannerState?
    private var headerSized: (state: BannerState, width: CGFloat)?
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
        banners.onTroubleshoot = { [weak self] in self?.open(.troubleshoot) }
        banners.onNativeUpdate = { [weak self] in self?.openStore() }
        banners.onWhatsNew = { [weak self] in self?.openWhatsNew() }
        nativeUpdateObservation = NativeUpdateCheck.shared.observe { [weak self] in
            self?.updateBanners()
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

    /// Shows `next`; `changeset` takes the rows on screen (`model`) to it.
    /// Returns how many rows it touched.
    @discardableResult
    func apply(_ next: TabletGroupedList, changeset: RowChangeset, animated: Bool) -> Int {
        let previous = model
        model = next
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
            if !changeset.deletes.isEmpty {
                let kept = Set(next.ids)
                heights = heights.filter { kept.contains($0.key) }
            }
        }
        var reconfigure = changeset.reconfigures.map { IndexPath(row: $0, section: 0) }
        if next.avatarStyle != previous.avatarStyle || next.avatarMonochrome != previous.avatarMonochrome {
            // Every avatar on screen redraws; the rest are made when shown.
            reconfigure = tableView.indexPathsForVisibleRows ?? []
        }
        if !reconfigure.isEmpty {
            let width = tableView.bounds.width
            var heightChanged = false
            for path in reconfigure where path.row < next.ids.count {
                // Only rows whose height follows their text, and only those
                // already measured; the rest are measured when shown.
                guard fixedHeight(next.rows[path.row], width: width) == nil else { continue }
                let id = next.ids[path.row]
                guard let cached = heights[id], cached.width == width, cached.row != next.rows[path.row] else { continue }
                let height = measure(next.rows[path.row], width: width)
                heights[id] = (next.rows[path.row], width, height)
                if height != cached.height { heightChanged = true }
            }
            tableView.reconfigureRows(at: reconfigure)
            if heightChanged {
                UIView.performWithoutAnimation { tableView.performBatchUpdates(nil) }
            }
        }
        if next.offline != previous.offline { updateBanners() }
        applySelection()
        return changeset.touchedRows
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

    /// One configuration for live cells and the offscreen sizing ones.
    private func configure(_ cell: UITableViewCell, _ row: Row) {
        switch row {
        case .botsHeader:
            (cell as? TabletSectionHeaderCell)?.configure(Strings.Tablet.bots)
        case .archiveHeader(let age):
            (cell as? TabletSectionHeaderCell)?.configure(SessionListViewController.dayTitle(age))
        case .bot(let session):
            (cell as? SessionRowCell)?.configure(session, style: model.avatarStyle, monochrome: model.avatarMonochrome)
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
        case .bot: return HomeRowHeights.flatSession(width: width)
        case .chat(let chat):
            return TabletGroupedRowHeights.chat(width: width, hairline: hairline, first: chat.first, last: chat.last, projectEnd: chat.projectEnd)
        case .archived(let archived):
            return TabletGroupedRowHeights.archived(width: width, hairline: hairline, last: archived.last)
        default: return nil
        }
    }

    private func sizingCell(_ row: Row) -> UITableViewCell? {
        switch row {
        case .botsHeader, .archiveHeader: sizingSection
        case .machine: sizingMachine
        case .workspace: sizingWorkspace
        case .archiveToggle: sizingToggle
        case .bot, .chat, .archived: nil
        }
    }

    private func measure(_ row: Row, width: CGFloat) -> CGFloat {
        guard let cell = sizingCell(row) else { return 0 }
        configure(cell, row)
        return cell.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
    }

    // MARK: Banners

    private struct BannerState: Equatable {
        var offlineTitle: String?
        var nativeUpdate: Bool
        var whatsNew: Bool
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
        let state = BannerState(
            offlineTitle: offlineTitle,
            nativeUpdate: NativeUpdateCheck.shared.updateURL != nil,
            whatsNew: changelogMarker.hasUnread(latestTitle: ChangelogViewController.bundled.latestTitle)
        )
        guard state != bannerState else { return }
        bannerState = state
        banners.offlineTitle = state.offlineTitle
        banners.showsNativeUpdate = state.nativeUpdate
        banners.showsWhatsNew = state.whatsNew
        if banners.isEmpty {
            tableView.tableHeaderView = nil
        } else {
            tableView.tableHeaderView = banners
            sizeHeader()
        }
    }

    private func sizeHeader() {
        guard tableView.tableHeaderView === banners else { return }
        let width = tableView.bounds.width
        // Measured again only when what it shows or the width changed.
        guard headerSized?.state != bannerState || headerSized?.width != width else { return }
        headerSized = bannerState.map { ($0, width) }
        let height = banners.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        if banners.frame.size != CGSize(width: width, height: height) {
            banners.frame = CGRect(x: 0, y: 0, width: width, height: height)
            tableView.tableHeaderView = banners
        }
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
        // Headings, rules and the toggle measure their label once per value
        // and width, as home's list does.
        let id = model.ids[indexPath.row]
        if let cached = heights[id], cached.width == width, cached.row == row { return cached.height }
        let height = measure(row, width: width)
        heights[id] = (row, width, height)
        return height
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
