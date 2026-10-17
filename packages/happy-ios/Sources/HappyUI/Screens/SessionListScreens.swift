#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyWire
import UIKit

/// The home session list in a UITableView, in either of happy-app's
/// layouts (SessionsListWrapper.tsx):
///   - flat (SessionsList.tsx): live sessions by activity, the archive
///     toggle, and the archive by day when shown;
///   - grouped by project (ProjectHomeList.tsx): each computer, its bots
///     and its projects with their worktrees, then the same archive.
/// Above the rows sit the offline plaque while every computer is offline
/// and the update banner (HomeListHeader.tsx). A tap opens the chat; a long
/// press opens the "Session" alert. The table runs under the floating home
/// header, padded by `contentInsets`.
///
/// Its rows are worked out off the main thread (`HomeDerivation`): `apply`
/// gets the rows and exactly which of them changed, and only inserts,
/// deletes, moves or reconfigures those. No row is measured: every height
/// comes from the pure layouts and the lines of the screen's text
/// environment (`HomeRowMeasurer`), which is worked out off the main thread
/// for the person's text size, and the notices above the rows are measured
/// off the main thread too. The list draws its text at that size
/// (`followsTextSize`); it shows no rows until the first environment is in.
final class SessionListViewController: UIViewController, UITableViewDataSource, UITableViewDelegate {
    private typealias Item = HomeListRow

    private let context: AppContext
    private let session: AccountSession
    private(set) var model = HomeListModel.empty
    /// Opens home's composer on a project's new workspace
    /// (`requestHomeDockFocus`); false when there is no dock to open.
    var onCreateWorkspace: ((WorkspaceOrigin) -> Bool)?
    /// A project's worktrees were shown or hidden (`expandedProjects`
    /// changed): the owner derives the rows again.
    var onExpandedProjectsChange: (() -> Void)?
    private let tableView = UITableView(frame: .zero, style: .plain)
    /// The table has asked for its rows once; from then on it only takes
    /// changesets.
    private var tableLoaded = false
    /// The lines, glyph boxes and scale the rows and notices are drawn
    /// with, for the text size and screen scale last landed; nil until the
    /// first is in.
    private(set) var textEnvironment: HomeTextEnvironment?
    /// The text size and scale last asked for: only an environment made
    /// for it lands.
    private var textRequested: TextEnvironment?
    /// The latest environment being made (tests wait on it).
    private(set) var textEnvironmentTask: Task<Void, Never>?
    /// The notices to show, and what the header was last asked for: only a
    /// height measured for exactly that lands.
    private var bannerState: HomeBanners?
    private(set) var headerRequested: HeaderKey?
    #if DEBUG
    /// How many text environments have moved the rows' heights (tests): a
    /// size asked for and asked away again moves nothing.
    private(set) var textEnvironmentApplies = 0
    /// The rows the last of them reconfigured (tests): every session's,
    /// on screen or not.
    private(set) var textEnvironmentReconfigured: [IndexPath] = []
    #endif
    /// The latest header measure (tests wait on it).
    private(set) var headerTask: Task<Void, Never>?
    private let banners = HomeListHeaderView()
    private lazy var actions = HomeSessionActions(context: context, session: session, host: self)
    private let changelogMarker = ChangelogReadMarker(storage: UserDefaultsStore(suiteName: ChangelogReadMarker.suiteName))
    private var nativeUpdateObservation: AccountsObservation?

    /// Where rows start and stop under home's header and dock.
    var contentInsets: HomeContentInsets? {
        didSet { if contentInsets != oldValue { applyContentInsets() } }
    }

    // Tablet (HappyUI/Tablet): in the sidebar, the open chat's row stays
    // selected (SessionsList.tsx `selectedSessionId`); flat rows only.
    var selectedSessionId: String? {
        didSet { if selectedSessionId != oldValue { applySelection() } }
    }

    private func applySelection() {
        guard isViewLoaded, tableLoaded else { return }
        if let path = selectedSessionId.flatMap({ model.index(ofSession: $0) }).map({ IndexPath(row: $0, section: 0) }) {
            tableView.selectRow(at: path, animated: false, scrollPosition: .none)
        } else if let path = tableView.indexPathForSelectedRow {
            tableView.deselectRow(at: path, animated: false)
        }
    }

    private var didScrollToTop = false

    init(context: AppContext, session: AccountSession) {
        self.context = context
        self.session = session
        super.init(nibName: nil, bundle: nil)
        followsTextSize()
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
        // Every row's height is arithmetic on lines already worked out
        // (nothing is measured for it), so the table asks for all of them
        // instead of estimating the rows it hasn't shown. With estimates,
        // the content's end and the rows off screen were guesses, and the
        // row at the top moved when a new text size landed.
        tableView.estimatedRowHeight = 0
        tableView.estimatedSectionHeaderHeight = 0
        tableView.estimatedSectionFooterHeight = 0
        tableView.delegate = self
        tableView.dataSource = self
        for (type, identifier) in [
            (SessionRowCell.self as UITableViewCell.Type, SessionRowCell.reuseIdentifier),
            (SessionDayHeaderCell.self, SessionDayHeaderCell.reuseIdentifier),
            (ArchiveToggleCell.self, ArchiveToggleCell.reuseIdentifier),
            (ProjectMachineHeaderCell.self, ProjectMachineHeaderCell.reuseIdentifier),
            (ProjectSectionCell.self, ProjectSectionCell.reuseIdentifier),
            (ProjectCardCell.self, ProjectCardCell.reuseIdentifier),
            (WorktreeCell.self, WorktreeCell.reuseIdentifier),
            (ProjectChatCell.self, ProjectChatCell.reuseIdentifier),
        ] {
            tableView.register(type, forCellReuseIdentifier: identifier)
        }
        let longPress = UILongPressGestureRecognizer(target: self, action: #selector(longPressed(_:)))
        tableView.addGestureRecognizer(longPress)
        banners.onTroubleshoot = { [weak self] in self?.openTroubleshoot() }
        banners.onNativeUpdate = { [weak self] in self?.openStore() }
        banners.onWhatsNew = { [weak self] in self?.openWhatsNew() }
        nativeUpdateObservation = NativeUpdateCheck.shared.observe { [weak self] in
            self?.updateBanners()
        }
        registerForTraitChanges([UITraitDisplayScale.self, UITraitPreferredContentSizeCategory.self]) { (self: Self, _) in
            self.requestTextEnvironment()
        }
        tableView.backgroundColor = UIColor(model.grouped ? Palette.groupedBackground : Palette.flatListBackground)
        // The rows come in with the first text environment.
        requestTextEnvironment()
        updateBanners()
        applySelection()
        applyContentInsets()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // What's New may have been read on a screen pushed from here.
        updateBanners()
    }

    /// MainView.tsx: rows start 12 below the header and end above the
    /// dock; the scroll indicator starts at the header's edge.
    private func applyContentInsets() {
        guard isViewLoaded, let insets = contentInsets else { return }
        tableView.contentInset = UIEdgeInsets(top: insets.contentTop, left: 0, bottom: insets.listBottom, right: 0)
        tableView.verticalScrollIndicatorInsets = UIEdgeInsets(top: insets.chromeTop, left: 0, bottom: 0, right: 0)
        if !didScrollToTop {
            didScrollToTop = true
            tableView.contentOffset = CGPoint(x: 0, y: -insets.contentTop)
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        sizeHeader()
    }

    /// Shows `next`; `changeset` takes the rows on screen (`model`) to it.
    /// Returns how many rows it touched.
    @discardableResult
    func apply(_ next: HomeListModel, changeset: RowChangeset, animated: Bool) -> Int {
        let previous = model
        model = next
        guard isViewLoaded, tableLoaded else { return 0 }
        if next.grouped != previous.grouped {
            // The two layouts share no row ids, so the changeset swaps every
            // row; only the page colour is left to change.
            tableView.backgroundColor = UIColor(next.grouped ? Palette.groupedBackground : Palette.flatListBackground)
        }
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
        if !reconfigure.isEmpty {
            tableView.reconfigureRows(at: reconfigure)
            // Only a heading's height can follow its text, and a session's
            // its workspace line and line counts; the table asks for
            // heights again only when one of them moved.
            let width = tableView.bounds.width
            var before: [HomeListRow.ID: Int]?
            let heightChanged = reconfigure.contains { path in
                guard path.row < next.ids.count, Self.fixedHeight(next.rows[path.row], width: width) == nil else { return false }
                // A row reconfigured in place keeps its index; only one that
                // moved is looked up.
                let id = next.ids[path.row]
                let old: Int
                if path.row < previous.ids.count, previous.ids[path.row] == id {
                    old = path.row
                } else {
                    let index = before ?? Dictionary(previous.ids.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
                    before = index
                    guard let found = index[id] else { return false }
                    old = found
                }
                return height(previous.rows[old], grouped: previous.grouped, width: width) != height(next.rows[path.row], grouped: next.grouped, width: width)
            }
            if heightChanged {
                UIView.performWithoutAnimation { tableView.performBatchUpdates(nil) }
            }
        }
        if next.offline != previous.offline { updateBanners() }
        applySelection() // Tablet
        return changeset.touchedRows
    }

    // MARK: Data

    private var grouped: Bool {
        model.grouped
    }

    func numberOfSections(in tableView: UITableView) -> Int {
        1
    }

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        tableLoaded ? model.rows.count : 0
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        guard let item = item(at: indexPath) else { return UITableViewCell() }
        let cell = tableView.dequeueReusableCell(withIdentifier: Self.reuseIdentifier(item), for: indexPath)
        configure(cell, item)
        return cell
    }

    private func item(at indexPath: IndexPath) -> Item? {
        model.rows.indices.contains(indexPath.row) ? model.rows[indexPath.row] : nil
    }

    /// Rows that are one height whatever they say and at any text size
    /// (`HomeRowHeights`): RN gives them a fixed `height`, and their text
    /// is centred in it.
    private static func fixedHeight(_ item: Item, width: CGFloat) -> CGFloat? {
        switch item {
        case .project(.project): HomeRowHeights.projectCard(width: width)
        case .project(.worktree), .project(.worktreeToggle): HomeRowHeights.worktree(width: width)
        case .project(.bot), .project(.archived): HomeRowHeights.projectChat(width: width)
        default: nil
        }
    }

    /// A row's height without a cell: the constant rows' own, a heading's
    /// from one line of its style, a session's from its lines
    /// (`HomeRowMeasurer`, checked against the cells by
    /// `HomeRowMeasurerTests` and `HomeListTextSizeTests`).
    private func height(_ item: Item, grouped: Bool, width: CGFloat) -> CGFloat {
        if let height = Self.fixedHeight(item, width: width) { return height }
        guard let kind = Self.kind(item, grouped: grouped), let environment = textEnvironment else { return 0 }
        return HomeRowMeasurer.height(kind, width: width, environment: environment)
    }

    /// What a row's height is made of: a heading's text as `configure`
    /// sets it, and for a toggle whether it heads a band; whether a
    /// session has a workspace line and line counts.
    static func kind(_ item: HomeListRow, grouped: Bool) -> HomeRowKind? {
        switch item {
        case .flat(.session(let row)):
            .flatSession(workspace: row.workspaceName != nil, changes: row.changes != nil)
        case .flat(.dayHeader(let age)):
            .dayHeader(label: dayTitle(age))
        case .flat(.archiveToggle(let hidden)), .project(.archiveToggle(let hidden)):
            .archiveToggle(label: hidden ? Strings.Sidebar.showArchived : Strings.Sidebar.hideArchived, banded: !grouped)
        case .project(.machine(_, let name)):
            .machineHeader(name: name)
        case .project(.section(_, let label)):
            .section(label: label == .bots ? Strings.Home.bots : Strings.Home.projects)
        case .project(.archiveHeader(let age)):
            .section(label: dayTitle(age))
        case .project(.project), .project(.worktree), .project(.worktreeToggle), .project(.bot), .project(.archived):
            nil
        }
    }

    // MARK: Text size

    /// Asks for the environment of the screen's text size and scale, made
    /// off the main thread, unless it is the one asked for last. Asking
    /// again for the one shown only forgets what was asked for between.
    private func requestTextEnvironment() {
        let text = TextEnvironment(traitCollection)
        guard text != textRequested else { return }
        textRequested = text
        guard text != textEnvironment?.text else { return }
        textEnvironmentTask = Task { @MainActor [weak self] in
            let environment = await HomeTextEnvironment.make(text)
            self?.land(environment)
        }
    }

    /// An environment made off the main thread. Only the one for the text
    /// size and scale last asked for lands; any other is refused, and what
    /// is shown stays. The first brings the rows in; a later one gives
    /// every row and the notices their new heights, with the row at the
    /// top of the list kept where it is. Every session row is reconfigured
    /// in that batch, so a cell the table has already made for a row off
    /// screen (cell prefetching) takes the new lines too; the table
    /// reconfigures only the cells it has.
    func land(_ environment: HomeTextEnvironment) {
        guard isViewLoaded, environment.text == textRequested, environment != textEnvironment else { return }
        let first = textEnvironment == nil
        textEnvironment = environment
        ApplyPerf.measure(.homeList) {
            if first {
                tableLoaded = true
                tableView.reloadData()
                return model.rows.count
            }
            #if DEBUG
            textEnvironmentApplies += 1
            #endif
            let sessions = model.rows.indices.compactMap { index -> IndexPath? in
                if case .flat(.session) = model.rows[index] { return IndexPath(row: index, section: 0) }
                return nil
            }
            #if DEBUG
            textEnvironmentReconfigured = sessions
            #endif
            keepingTopRow {
                UIView.performWithoutAnimation {
                    tableView.performBatchUpdates { tableView.reconfigureRows(at: sessions) }
                }
            }
            return tableView.indexPathsForVisibleRows?.count ?? 0
        }
        if first { applySelection() }
        sizeHeader()
    }

    /// Runs `change`, which moves heights above or in the list, and keeps
    /// the row at the top of the list where it was on screen; a list at
    /// its top stays at its top.
    private func keepingTopRow(_ change: () -> Void) {
        let inset = tableView.adjustedContentInset
        let top = tableView.contentOffset.y + inset.top
        var anchor: (path: IndexPath, offset: CGFloat)?
        if top > 0 {
            for path in tableView.indexPathsForVisibleRows ?? [] {
                let rect = tableView.rectForRow(at: path)
                if rect.maxY > top {
                    anchor = (path, rect.minY - top)
                    break
                }
            }
        }
        change()
        guard let anchor, anchor.path.row < tableView.numberOfRows(inSection: anchor.path.section) else { return }
        let y = tableView.rectForRow(at: anchor.path).minY - anchor.offset - inset.top
        let bottom = max(-inset.top, tableView.contentSize.height + inset.bottom - tableView.bounds.height)
        tableView.contentOffset.y = min(max(y, -inset.top), bottom)
    }

    private static func reuseIdentifier(_ item: Item) -> String {
        switch item {
        case .flat(.session): SessionRowCell.reuseIdentifier
        case .flat(.archiveToggle), .project(.archiveToggle): ArchiveToggleCell.reuseIdentifier
        case .flat(.dayHeader): SessionDayHeaderCell.reuseIdentifier
        case .project(.machine): ProjectMachineHeaderCell.reuseIdentifier
        case .project(.section), .project(.archiveHeader): ProjectSectionCell.reuseIdentifier
        case .project(.project): ProjectCardCell.reuseIdentifier
        case .project(.worktree), .project(.worktreeToggle): WorktreeCell.reuseIdentifier
        case .project(.bot), .project(.archived): ProjectChatCell.reuseIdentifier
        }
    }

    /// One configuration for every live cell.
    private func configure(_ cell: UITableViewCell, _ item: Item) {
        if let cell = cell as? SessionRowCell { cell.avatar.pictures = session.avatarPictures }
        if let cell = cell as? ProjectCardCell { cell.avatar.pictures = session.avatarPictures }
        if let cell = cell as? ProjectChatCell { cell.avatar.pictures = session.avatarPictures }
        switch item {
        case .flat(.session(let row)):
            guard let cell = cell as? SessionRowCell else { return }
            cell.lines = textEnvironment?.rows.sessionLines ?? .designed
            cell.configure(row, style: model.avatarStyle, monochrome: model.avatarMonochrome)
        case .flat(.archiveToggle(let hidden)), .project(.archiveToggle(let hidden)):
            guard let cell = cell as? ArchiveToggleCell else { return }
            cell.banded = !grouped
            cell.backgroundColor = UIColor(grouped ? Palette.groupedBackground : Palette.flatListBackground)
            cell.configure(hidden: hidden)
        case .flat(.dayHeader(let age)):
            (cell as? SessionDayHeaderCell)?.configure(age)
        case .project(.machine(_, let name)):
            (cell as? ProjectMachineHeaderCell)?.configure(name: name)
        case .project(.section(_, let label)):
            (cell as? ProjectSectionCell)?.configure(label == .bots ? Strings.Home.bots : Strings.Home.projects)
        case .project(.archiveHeader(let age)):
            (cell as? ProjectSectionCell)?.configure(Self.dayTitle(age))
        case .project(.project(let entry)):
            guard let cell = cell as? ProjectCardCell else { return }
            cell.configure(entry, style: model.avatarStyle, monochrome: model.avatarMonochrome)
            cell.onCreateWorkspace = { [weak self] entry in self?.createWorkspace(entry) }
        case .project(.worktree(let worktree, let last)):
            (cell as? WorktreeCell)?.configure(worktree, last: last)
        case .project(.worktreeToggle(let toggle)):
            (cell as? WorktreeCell)?.configure(toggle)
        case .project(.bot(let row)):
            (cell as? ProjectChatCell)?.configure(row, archived: false, style: model.avatarStyle, monochrome: model.avatarMonochrome)
        case .project(.archived(let row)):
            (cell as? ProjectChatCell)?.configure(row, archived: true, style: model.avatarStyle, monochrome: model.avatarMonochrome)
        }
    }

    static func dayTitle(_ age: SessionList.DayAge) -> String {
        switch age {
        case .today: Strings.SessionHistory.today
        case .yesterday: Strings.SessionHistory.yesterday
        case .daysAgo(let count): Strings.SessionHistory.daysAgo(count)
        }
    }

    // MARK: Banners

    /// Everything the header's height is measured from: the notices and
    /// their words, the list's width, how wide a group may grow, and the
    /// text environment.
    struct HeaderKey: Equatable {
        var banners: HomeBanners
        var width: CGFloat
        var maxWidth: CGFloat
        var environment: HomeTextEnvironment
    }

    /// HomeListHeader.tsx: the offline plaque, then the update banner.
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

    /// The header is measured off the main thread, and set, with what it
    /// shows, once its height is in; only when the notices, the width or
    /// the text environment changed. No notices takes it away at once.
    private func sizeHeader() {
        guard let state = bannerState else { return }
        guard !state.isEmpty else {
            headerRequested = nil
            if tableView.tableHeaderView != nil {
                keepingTopRow { tableView.tableHeaderView = nil }
            }
            return
        }
        guard let environment = textEnvironment else { return }
        let key = HeaderKey(banners: state, width: tableView.bounds.width, maxWidth: ContentWidth.maxWidth, environment: environment)
        guard key.width > 0, key != headerRequested else { return }
        headerRequested = key
        headerTask = Task { @MainActor [weak self] in
            let height = await Task.detached(priority: .userInitiated) {
                HomeRowMeasurer.headerHeight(key.banners, width: key.width, maxWidth: key.maxWidth, environment: key.environment)
            }.value
            self?.landHeader(key, height: height)
        }
    }

    /// A header height measured off the main thread. Only one measured for
    /// exactly what was last asked for lands; any other is refused, and the
    /// header shown stays. The row at the top of the list stays where it
    /// is.
    func landHeader(_ key: HeaderKey, height: CGFloat) {
        guard key == headerRequested else { return }
        ApplyPerf.measure(.homeList) {
            // The words the height was measured with.
            banners.content = key.banners
            keepingTopRow {
                banners.frame = CGRect(x: 0, y: 0, width: key.width, height: height)
                tableView.tableHeaderView = banners
            }
            return 1
        }
    }

    private func openTroubleshoot() {
        push(.troubleshoot, context: context)
    }

    /// UpdateBanner.tsx `handleOpenStore`.
    private func openStore() {
        guard let link = NativeUpdateCheck.shared.updateURL, let url = URL(string: link) else { return }
        UIApplication.shared.open(url)
    }

    /// UpdateBanner.tsx marks What's New read a second after opening it.
    private func openWhatsNew() {
        push(.changelog, context: context)
        let marker = changelogMarker
        let latest = ChangelogViewController.bundled.latestTitle
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(1))
            marker.markViewed(latest)
            self?.updateBanners()
        }
    }

    // MARK: Projects

    private func toggleExpanded(_ projectId: String) {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        var expanded = context.account.localSettings.expandedProjects
        if expanded.contains(projectId) {
            expanded.remove(projectId)
        } else {
            expanded.insert(projectId)
        }
        context.account.localSettings.expandedProjects = expanded
        onExpandedProjectsChange?()
    }

    /// ProjectRow's `+`: home's composer on this project's "Create New"
    /// workspace, or the new-session screen on it when the dock can't open.
    private func createWorkspace(_ entry: ProjectHomeEntry) {
        guard let origin = entry.origin else { return }
        if onCreateWorkspace?(origin) == true { return }
        NewSessionDraftStore.shared(for: context.account.localSettings).prepareWorkspace(origin)
        push(.newSession(machineId: nil, path: nil, prompt: nil), context: context)
    }

    private func showProjectActions(_ entry: ProjectHomeEntry) {
        guard entry.origin != nil else { return }
        let alert = UIAlertController(title: entry.name, message: nil, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: Strings.Home.createWorkspace, style: .default) { [weak self] _ in
            self?.createWorkspace(entry)
        })
        alert.addAction(UIAlertAction(title: Strings.Common.cancel, style: .cancel))
        present(alert, animated: true)
    }

    // MARK: Delegate

    func tableView(_ tableView: UITableView, heightForRowAt indexPath: IndexPath) -> CGFloat {
        guard let item = item(at: indexPath) else { return 0 }
        return height(item, grouped: grouped, width: tableView.bounds.width)
    }

    func tableView(_ tableView: UITableView, shouldHighlightRowAt indexPath: IndexPath) -> Bool {
        guard let item = item(at: indexPath) else { return false }
        switch item {
        case .flat(.session), .flat(.archiveToggle), .project(.archiveToggle), .project(.worktreeToggle):
            return true
        default:
            return item.sessionId != nil
        }
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        guard let item = item(at: indexPath) else { return }
        switch item {
        case .flat(.archiveToggle(let hidden)), .project(.archiveToggle(let hidden)):
            session.updateSettings(["hideInactiveSessions": .bool(!hidden)])
        case .project(.worktreeToggle(let toggle)):
            toggleExpanded(toggle.projectId)
        default:
            guard let sessionId = item.sessionId else { return }
            push(.session(id: sessionId), context: context)
        }
        applySelection() // Tablet
    }

    /// FlatSessionRow.tsx's swipe: "Archive Session" on red. Only the flat
    /// rows swipe.
    func tableView(_ tableView: UITableView, trailingSwipeActionsConfigurationForRowAt indexPath: IndexPath) -> UISwipeActionsConfiguration? {
        guard case .flat(.session(let row))? = item(at: indexPath),
              !row.archived
        else { return nil }
        let action = UIContextualAction(style: .destructive, title: Strings.SessionInfo.archiveSession) { [weak self] _, _, done in
            done(true)
            self?.actions.archive(row.id)
        }
        action.image = .icon(.ionicons("archive-outline"), size: 20)
        action.backgroundColor = UIColor(Palette.statusError)
        let configuration = UISwipeActionsConfiguration(actions: [action])
        configuration.performsFirstActionWithFullSwipe = false
        return configuration
    }

    /// A long press: the "Session" alert on a flat row (useSessionActionAlert),
    /// "Create workspace" on a project card. The grouped list's other rows
    /// have no long press.
    @objc private func longPressed(_ gesture: UILongPressGestureRecognizer) {
        guard gesture.state == .began,
              let indexPath = tableView.indexPathForRow(at: gesture.location(in: tableView)),
              let item = item(at: indexPath)
        else { return }
        switch item {
        case .flat(.session(let row)):
            actions.present(sessionId: row.id)
        case .project(.project(let entry)):
            showProjectActions(entry)
        default:
            break
        }
    }
}

/// A reachable computer with nothing on it yet.
final class NoSessionsViewController: UIViewController {
    private let context: AppContext
    private let session: AccountSession
    private let content = NoSessionsView()

    init(context: AppContext, session: AccountSession) {
        self.context = context
        self.session = session
        super.init(nibName: nil, bundle: nil)
        // Every size on it is measured off main at the size it is drawn.
        followsTextSize()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func loadView() {
        view = content
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        content.showArchived.onTap = { [weak self] in
            self?.session.updateSettings(["hideInactiveSessions": .bool(false)])
        }
        content.startNewSession.onTap = { [weak self] in
            guard let self else { return }
            self.push(.newSession(machineId: nil, path: nil, prompt: nil), context: self.context)
        }
    }
}
#endif
