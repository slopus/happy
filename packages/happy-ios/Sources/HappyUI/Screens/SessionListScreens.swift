#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyWire
import UIKit

/// The home session list on UltraList (`HomeUltraListAdapter`), in either
/// of happy-app's layouts (SessionsListWrapper.tsx):
///   - flat (SessionsList.tsx): live sessions by activity, the archive
///     toggle, and the archive by day when shown;
///   - grouped by project (ProjectHomeList.tsx): each computer, its bots
///     and its projects with their worktrees, then the same archive.
/// Above the rows sit the offline plaque while every computer is offline
/// and the update banner (HomeListHeader.tsx), as the list's first row. A
/// tap opens the chat; a long press opens the "Session" alert; a swipe
/// archives or leaves. The list runs under the floating home header, padded
/// by `contentInsets`.
///
/// Its rows are worked out off the main thread (`HomeDerivation`), and
/// prepared and drawn off it too. No row is measured on the main thread:
/// every height comes from the pure layouts and the lines of the screen's
/// text environment (`HomeRowMeasurer`), which is worked out off the main
/// thread for the person's text size, and the notices above the rows are
/// measured off the main thread too. The list draws its text at that size
/// (`followsTextSize`); it shows no rows until the first environment is in.
final class SessionListViewController: UIViewController {
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
    private let rendered = HomeUltraListView()
    private lazy var ultraList = HomeUltraListAdapter(view: rendered, pictures: session.avatarPictures)
    private var archiveModels: HomeArchiveModels?
    private var archiveReceiptTask: Task<Void, Never>?
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
    /// How many text environments after the first have landed (tests): a
    /// size asked for and asked away again lands nothing.
    private(set) var textEnvironmentApplies = 0
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
        didSet { if selectedSessionId != oldValue { updateUltraList() } }
    }

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
        let adapter = ultraList
        adapter.onSelect = { [weak self] id in self?.select(id) }
        adapter.onLongPress = { [weak self] id in self?.hold(id) }
        adapter.onArchivePersistenceFailure = { [weak self] in
            guard let self, self.context.account.session === self.session else { return }
            Alerts.show(Strings.Common.error, Strings.Home.actionUnknownError, on: self)
        }
        adapter.onArchive = { [weak self] id in
            guard let self, self.context.account.session === self.session else { return }
            switch self.row(id) {
            case .flat(.session(let row))? where !row.archived:
                if !row.avatar.isTask { self.actions.archive(row.id) } else if row.leaves { self.actions.leave(row.id) }
            case .project(.task(let row))? where row.leaves:
                self.actions.leave(row.id)
            default:
                break
            }
        }
        adapter.onCreateWorkspace = { [weak self] id in
            guard let self, self.context.account.session === self.session,
                  case .project(.project(let entry))? = self.row(id) else { return }
            self.createWorkspace(entry)
        }
        let receipts = session.archiveVisibilityWriter.receipts()
        archiveReceiptTask = Task { [weak self] in
            for await receipt in receipts {
                guard let self, self.context.account.session === self.session else { return }
                self.ultraList.receiveArchiveReceipt(receipt)
            }
        }
        view = rendered
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        banners.onTroubleshoot = { [weak self] in self?.openTroubleshoot() }
        banners.onNativeUpdate = { [weak self] in self?.openStore() }
        banners.onWhatsNew = { [weak self] in self?.openWhatsNew() }
        nativeUpdateObservation = NativeUpdateCheck.shared.observe { [weak self] in
            self?.updateBanners()
        }
        registerForTraitChanges([UITraitDisplayScale.self, UITraitPreferredContentSizeCategory.self]) { (self: Self, _) in
            self.requestTextEnvironment()
        }
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.updateUltraList() }
        // The rows come in with the first text environment.
        requestTextEnvironment()
        updateBanners()
        applyContentInsets()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // What's New may have been read on a screen pushed from here.
        updateBanners()
    }

    /// MainView.tsx: rows start 12 below the header and end above the
    /// dock; the scroll indicator runs from the header's edge to the dock.
    private func applyContentInsets() {
        guard isViewLoaded, let insets = contentInsets else { return }
        ultraList.setInsets(insets)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        updateUltraList()
        sizeHeader()
    }

    /// Shows `next`; `changeset` says how many rows it touched, which is
    /// returned.
    @discardableResult
    func apply(_ next: HomeListModel, changeset: RowChangeset, animated: Bool) -> Int {
        let previous = model
        model = next
        updateUltraList()
        if next.offline != previous.offline { updateBanners() }
        return changeset.touchedRows
    }

    /// What a row's height is made of: a heading's text as the list draws
    /// it, and for a toggle whether it heads a band; whether a session has
    /// a workspace line and line counts.
    static func kind(_ item: HomeListRow, grouped: Bool) -> HomeRowKind? {
        switch item {
        case .flat(.session(let row)):
            .flatSession(workspace: row.workspaceName != nil, changes: row.changes != nil)
        case .flat(.archiveToggle(let hidden)), .project(.archiveToggle(let hidden)):
            .archiveToggle(label: hidden ? Strings.Sidebar.showArchived : Strings.Sidebar.hideArchived, banded: !grouped)
        case .project(.machine(_, let name)):
            .machineHeader(name: name)
        case .flat(.dayHeader), .project(.section), .project(.archiveHeader), .project(.project), .project(.worktree),
             .project(.worktreeToggle), .project(.bot), .project(.task), .project(.archived):
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
    /// every row and the notices their new heights, the list keeping what
    /// the reader sees.
    func land(_ environment: HomeTextEnvironment) {
        guard isViewLoaded, environment.text == textRequested, environment != textEnvironment else { return }
        #if DEBUG
        if textEnvironment != nil { textEnvironmentApplies += 1 }
        #endif
        textEnvironment = environment
        updateUltraList()
        sizeHeader()
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
            ultraList.setBanner(nil, height: 0)
            return
        }
        guard let environment = textEnvironment else { return }
        let key = HeaderKey(banners: state, width: view.bounds.width, maxWidth: ContentWidth.maxWidth, environment: environment)
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
    /// header shown stays.
    func landHeader(_ key: HeaderKey, height: CGFloat) {
        guard key == headerRequested else { return }
        // The words the height was measured with.
        banners.content = key.banners
        banners.frame = CGRect(x: 0, y: 0, width: key.width, height: height)
        ultraList.setBanner(banners, height: height)
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

    // MARK: Rows

    private func updateUltraList() {
        guard isViewLoaded, let environment = textEnvironment else { return }
        ultraList.update(.init(model: model, width: view.bounds.width, environment: environment, dark: traitCollection.userInterfaceStyle == .dark, selected: selectedSessionId, archiveModels: archiveModels, viewportHeight: view.bounds.height))
    }

    func setArchiveModels(_ models: HomeArchiveModels?, settings: HomeArchiveSettings?) {
        archiveModels = models
        ultraList.receiveArchiveSettings(settings)
        updateUltraList()
    }

    /// Let go of: nothing of the list answers or prepares any more.
    func deactivate() {
        archiveReceiptTask?.cancel(); archiveReceiptTask = nil
        textEnvironmentTask?.cancel(); headerTask?.cancel(); ultraList.deactivate()
    }

    private func row(_ id: HomeListRow.ID) -> Item? {
        if let displayed = ultraList.displayedModel {
            return displayed.ids.firstIndex(of: id).map { displayed.rows[$0] }
        }
        return model.ids.firstIndex(of: id).map { model.rows[$0] }
    }

    private func select(_ id: HomeListRow.ID) {
        guard context.account.session === session, let item = self.row(id) else { return }
        switch item {
        case .flat(.archiveToggle(let hidden)), .project(.archiveToggle(let hidden)):
            if !traitCollection.isTabletLayout {
                guard let intent = session.archiveVisibilityWriter.submit(hidden: !(ultraList.archiveHidden ?? hidden)) else { return }
                ultraList.showArchiveIntent(intent)
            } else {
                session.updateSettings(["hideInactiveSessions": .bool(!hidden)])
            }
        case .project(.worktreeToggle(let toggle)):
            toggleExpanded(toggle.projectId)
        default:
            guard let sessionId = item.sessionId else { return }
            push(.session(id: sessionId), context: context)
        }
        updateUltraList()
    }

    /// A long press: the "Session" alert on a flat row (useSessionActionAlert),
    /// "Create workspace" on a project card. The grouped list's other rows
    /// have no long press.
    private func hold(_ id: HomeListRow.ID) {
        guard context.account.session === session, let item = self.row(id) else { return }
        switch item {
        case .flat(.session(let row)), .project(.task(let row)): actions.present(sessionId: row.id)
        case .project(.project(let entry)): showProjectActions(entry)
        default: break
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
