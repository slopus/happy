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
final class SessionListViewController: UIViewController, UITableViewDelegate {
    private enum ItemID: Hashable {
        case session(String)
        case archiveToggle
        case day(Int)
        case project(String)
    }

    private enum Item: Equatable {
        case flat(SessionList.Item)
        case project(ProjectHomeRow)
    }

    private let context: AppContext
    private let session: AccountSession
    private(set) var list: SessionList
    private var offline: [MachineChoice]?
    private let tableView = UITableView(frame: .zero, style: .plain)
    private var dataSource: UITableViewDiffableDataSource<Int, ItemID>!
    private var items: [ItemID: Item] = [:]
    private let sizingRow = SessionRowCell(style: .default, reuseIdentifier: nil)
    private let sizingDay = SessionDayHeaderCell(style: .default, reuseIdentifier: nil)
    private let sizingToggle = ArchiveToggleCell(style: .default, reuseIdentifier: nil)
    private let sizingMachine = ProjectMachineHeaderCell(style: .default, reuseIdentifier: nil)
    private let sizingSection = ProjectSectionCell(style: .default, reuseIdentifier: nil)
    private let sizingCard = ProjectCardCell(style: .default, reuseIdentifier: nil)
    private let sizingWorktree = WorktreeCell(style: .default, reuseIdentifier: nil)
    private let sizingChat = ProjectChatCell(style: .default, reuseIdentifier: nil)
    private let banners = HomeListHeaderView()
    private lazy var actions = HomeSessionActions(context: context, session: session, host: self)
    private let changelogMarker = ChangelogReadMarker(storage: UserDefaultsStore(suiteName: ChangelogReadMarker.suiteName))

    /// Where rows start and stop under home's header and dock.
    var contentInsets: HomeContentInsets? {
        didSet { if contentInsets != oldValue { applyContentInsets() } }
    }
    private var didScrollToTop = false

    init(context: AppContext, session: AccountSession, list: SessionList, offline: [MachineChoice]?) {
        self.context = context
        self.session = session
        self.list = list
        self.offline = offline
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
        tableView.delegate = self
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
        dataSource = UITableViewDiffableDataSource(tableView: tableView) { [weak self] tableView, indexPath, id in
            self?.cell(tableView, indexPath, id) ?? UITableViewCell()
        }
        dataSource.defaultRowAnimation = .fade
        let longPress = UILongPressGestureRecognizer(target: self, action: #selector(longPressed(_:)))
        tableView.addGestureRecognizer(longPress)
        banners.onTroubleshoot = { [weak self] in self?.openTroubleshoot() }
        banners.onWhatsNew = { [weak self] in self?.openWhatsNew() }
        apply(animated: false)
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

    func update(_ list: SessionList, offline: [MachineChoice]?) {
        self.list = list
        self.offline = offline
        guard isViewLoaded else { return }
        apply(animated: view.window != nil)
    }

    // MARK: Data

    private var grouped: Bool {
        list.projects != nil
    }

    private func apply(animated: Bool) {
        // The flat variant paints rows and page alike; the grouped one sits
        // on the grouped background (ProjectHomeList.tsx `container`).
        tableView.backgroundColor = UIColor(grouped ? Palette.groupedBackground : Palette.flatListBackground)
        var ids: [ItemID] = []
        var next: [ItemID: Item] = [:]
        if let projects = list.projects {
            var dayIndex = 0
            for row in projects.rows(expanded: context.account.localSettings.expandedProjects) {
                let id: ItemID
                switch row {
                case .archiveToggle: id = .archiveToggle
                case .archiveHeader:
                    id = .day(dayIndex)
                    dayIndex += 1
                default: id = .project(row.key)
                }
                ids.append(id)
                next[id] = .project(row)
            }
        } else {
            var dayIndex = 0
            for item in list.items {
                let id: ItemID
                switch item {
                case .session(let row): id = .session(row.id)
                case .archiveToggle: id = .archiveToggle
                case .dayHeader:
                    id = .day(dayIndex)
                    dayIndex += 1
                }
                ids.append(id)
                next[id] = .flat(item)
            }
        }
        let changed = ids.filter { id in items[id].map { $0 != next[id] } ?? false }
        items = next

        var snapshot = NSDiffableDataSourceSnapshot<Int, ItemID>()
        snapshot.appendSections([0])
        snapshot.appendItems(ids)
        snapshot.reconfigureItems(changed.filter { dataSource.snapshot().itemIdentifiers.contains($0) })
        dataSource.apply(snapshot, animatingDifferences: animated)
        updateBanners()
    }

    private func cell(_ tableView: UITableView, _ indexPath: IndexPath, _ id: ItemID) -> UITableViewCell? {
        guard let item = items[id] else { return nil }
        let identifier = Self.reuseIdentifier(item)
        let cell = tableView.dequeueReusableCell(withIdentifier: identifier, for: indexPath)
        configure(cell, item)
        return cell
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

    /// One configuration for live cells and the offscreen sizing ones.
    private func configure(_ cell: UITableViewCell, _ item: Item) {
        switch item {
        case .flat(.session(let row)):
            (cell as? SessionRowCell)?.configure(row, style: list.avatarStyle, monochrome: list.avatarMonochrome)
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
            cell.configure(entry, style: list.avatarStyle, monochrome: list.avatarMonochrome)
            cell.onCreateWorkspace = { [weak self] entry in self?.createWorkspace(entry) }
        case .project(.worktree(let worktree, let last)):
            (cell as? WorktreeCell)?.configure(worktree, last: last)
        case .project(.worktreeToggle(let toggle)):
            (cell as? WorktreeCell)?.configure(toggle)
        case .project(.bot(let row)):
            (cell as? ProjectChatCell)?.configure(row, archived: false, style: list.avatarStyle, monochrome: list.avatarMonochrome)
        case .project(.archived(let row)):
            (cell as? ProjectChatCell)?.configure(row, archived: true, style: list.avatarStyle, monochrome: list.avatarMonochrome)
        }
    }

    private func sizingCell(_ item: Item) -> UITableViewCell {
        switch item {
        case .flat(.session): sizingRow
        case .flat(.archiveToggle), .project(.archiveToggle): sizingToggle
        case .flat(.dayHeader): sizingDay
        case .project(.machine): sizingMachine
        case .project(.section), .project(.archiveHeader): sizingSection
        case .project(.project): sizingCard
        case .project(.worktree), .project(.worktreeToggle): sizingWorktree
        case .project(.bot), .project(.archived): sizingChat
        }
    }

    static func dayTitle(_ age: SessionList.DayAge) -> String {
        switch age {
        case .today: Strings.SessionHistory.today
        case .yesterday: Strings.SessionHistory.yesterday
        case .daysAgo(let count): Strings.SessionHistory.daysAgo(count)
        }
    }

    /// The session a row opens and offers actions for.
    private func sessionId(_ item: Item) -> String? {
        switch item {
        case .flat(.session(let row)), .project(.bot(let row)), .project(.archived(let row)): row.id
        case .project(.project(let entry)): entry.sessionId
        case .project(.worktree(let worktree, _)): worktree.sessionId
        default: nil
        }
    }

    // MARK: Banners

    /// HomeListHeader.tsx: the offline plaque, then the update banner.
    private func updateBanners() {
        guard isViewLoaded else { return }
        var offlineTitle: String?
        if let offline, !offline.isEmpty {
            offlineTitle = offline.count == 1
                ? Strings.Troubleshoot.bannerTitleOne(name: offline[0].name)
                : Strings.Troubleshoot.bannerTitleMany
        }
        banners.offlineTitle = offlineTitle
        banners.showsWhatsNew = changelogMarker.hasUnread(latestTitle: ChangelogViewController.bundled.latestTitle)
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
        let height = banners.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        if banners.frame.size != CGSize(width: width, height: height) {
            banners.frame = CGRect(x: 0, y: 0, width: width, height: height)
            tableView.tableHeaderView = banners
        }
    }

    private func openTroubleshoot() {
        push(.troubleshoot, context: context)
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
        apply(animated: true)
    }

    /// ProjectRow's `+`: the new-session screen in this project's
    /// "Create New" worktree choice.
    private func createWorkspace(_ entry: ProjectHomeEntry) {
        guard let origin = entry.origin else { return }
        push(.newSession(machineId: origin.machineId, path: origin.path, prompt: nil), context: context)
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
        guard let id = dataSource.itemIdentifier(for: indexPath), let item = items[id] else { return 0 }
        let cell = sizingCell(item)
        configure(cell, item)
        return cell.sizeThatFits(CGSize(width: tableView.bounds.width, height: .greatestFiniteMagnitude)).height
    }

    func tableView(_ tableView: UITableView, shouldHighlightRowAt indexPath: IndexPath) -> Bool {
        guard let id = dataSource.itemIdentifier(for: indexPath), let item = items[id] else { return false }
        switch item {
        case .flat(.session), .flat(.archiveToggle), .project(.archiveToggle), .project(.worktreeToggle):
            return true
        default:
            return sessionId(item) != nil
        }
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        guard let id = dataSource.itemIdentifier(for: indexPath), let item = items[id] else { return }
        switch item {
        case .flat(.archiveToggle(let hidden)), .project(.archiveToggle(let hidden)):
            session.updateSettings(["hideInactiveSessions": .bool(!hidden)])
        case .project(.worktreeToggle(let toggle)):
            toggleExpanded(toggle.projectId)
        default:
            guard let sessionId = sessionId(item) else { return }
            push(.session(id: sessionId), context: context)
        }
    }

    /// FlatSessionRow.tsx's swipe: "Archive Session" on red. Only the flat
    /// rows swipe.
    func tableView(_ tableView: UITableView, trailingSwipeActionsConfigurationForRowAt indexPath: IndexPath) -> UISwipeActionsConfiguration? {
        guard let id = dataSource.itemIdentifier(for: indexPath),
              case .flat(.session(let row))? = items[id],
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
              let id = dataSource.itemIdentifier(for: indexPath),
              let item = items[id]
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
    private let session: AccountSession
    private let content = NoSessionsView()

    init(session: AccountSession) {
        self.session = session
        super.init(nibName: nil, bundle: nil)
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
    }
}
#endif
