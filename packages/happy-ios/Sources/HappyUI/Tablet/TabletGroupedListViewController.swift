#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyWire
import UIKit

/// The sidebar's list grouped by project (`TabletGroupedList`), on home's
/// UltraList (`HomeUltraListAdapter`, its rows bridged by
/// `TabletGroupedRow.ID.ultraBridgeID`): SessionsList.tsx's bots, machine
/// rules, checkout headings over cards of chats, the archive toggle and the
/// archived cards, under the same notices as home's list
/// (HomeListHeader.tsx).
///
/// Its rows are worked out off the main thread (`TabletSidebarDerivation`)
/// and prepared and drawn off it. The open chat's row stays selected across
/// every update.
///
/// Its rows and notices follow the person's text size, as RN's do, in the
/// text environment made off the main thread for it. The notices are
/// home's header, measured off the main thread at that size as home's are
/// (docs/DYNAMIC-TYPE.md).
final class TabletGroupedListViewController: UIViewController {
    private typealias Row = TabletGroupedRow

    private let context: AppContext
    private let session: AccountSession
    private(set) var model = TabletGroupedList.empty
    private let rendered = HomeUltraListView()
    private lazy var ultraList = HomeUltraListAdapter(view: rendered, pictures: session.avatarPictures)
    private var ultraText: HomeTextEnvironment?
    private var ultraTextRequested: TextEnvironment?
    private var ultraTextTask: Task<Void, Never>?
    private let banners = HomeListHeaderView()
    private var bannerState: HomeBanners?
    /// What the header was last measured for; its height lands only for
    /// this.
    private(set) var headerRequested: HeaderKey?
    private(set) var headerTask: Task<Void, Never>?
    private lazy var actions = HomeSessionActions(context: context, session: session, host: self)
    /// useHappyAction: one kill at a time per chat.
    private var killing: Set<String> = []
    private let changelogMarker = ChangelogReadMarker(storage: UserDefaultsStore(suiteName: ChangelogReadMarker.suiteName))
    private var nativeUpdateObservation: AccountsObservation?

    /// The open chat (SessionsList.tsx `selectedSessionId`).
    var selectedSessionId: String? {
        didSet { if selectedSessionId != oldValue { updateUltraList() } }
    }

    /// Room under the last row (SessionsList.tsx `bottomContentInset`).
    var bottomInset: CGFloat = 0 {
        didSet {
            if bottomInset != oldValue, isViewLoaded { ultraList.setInsets(top: 0, bottom: bottomInset) }
        }
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
        // A long press on a chat opens the "Session" alert
        // (useSessionActionAlert); the headings have none.
        adapter.onLongPress = { [weak self] id in
            guard let self, self.context.account.session === self.session, let sessionID = self.row(id)?.sessionId else { return }
            self.actions.present(sessionId: sessionID)
        }
        // "Archive Session" on red: FlatSessionRow's swipe on the bots,
        // which archives, and CompactSessionRow's on the chats, which only
        // stops the session; a task's rows leave it.
        adapter.onArchive = { [weak self] id in
            guard let self, self.context.account.session === self.session, let row = self.row(id), let sessionID = row.sessionId else { return }
            switch row {
            case .chat: self.kill(sessionID)
            case .task(let task): if task.leaves { self.actions.leave(sessionID) }
            default: self.actions.archive(sessionID)
            }
        }
        adapter.onCreateWorkspace = { [weak self] id in
            guard let self, self.context.account.session === self.session, case .workspace(let header)? = self.row(id) else { return }
            self.startSession(in: header.place)
        }
        adapter.setInsets(top: 0, bottom: bottomInset)
        view = rendered
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        // Home's notices, drawn here at the person's text size.
        banners.traitOverrides.followsTextSize = true
        banners.onTroubleshoot = { [weak self] in self?.open(.troubleshoot) }
        banners.onNativeUpdate = { [weak self] in self?.openStore() }
        banners.onWhatsNew = { [weak self] in self?.openWhatsNew() }
        nativeUpdateObservation = NativeUpdateCheck.shared.observe { [weak self] in
            self?.updateBanners()
        }
        // A new text size or screen: the rows and the notices are measured again.
        registerForTraitChanges([UITraitPreferredContentSizeCategory.self, UITraitDisplayScale.self]) { (self: Self, _) in
            self.updateUltraList()
            self.sizeHeader()
        }
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.updateUltraList() }
        updateBanners()
        updateUltraList()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // What's New may have been read on a screen opened from here.
        updateBanners()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        updateUltraList()
        sizeHeader()
    }

    /// Shows `next`. Returns how many rows `changeset` touched.
    @discardableResult
    func apply(_ next: TabletGroupedList, changeset: RowChangeset, animated: Bool) -> Int {
        let previous = model
        model = next
        updateUltraList()
        if next.offline != previous.offline { updateBanners() }
        return changeset.touchedRows
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
            ultraList.setBanner(nil, height: 0)
            return
        }
        let key = HeaderKey(
            banners: state,
            width: view.bounds.width,
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
        ultraList.setBanner(banners, height: height)
    }

    /// Let go of: nothing of the list answers or prepares any more.
    func deactivate() { ultraTextTask?.cancel(); ultraList.deactivate() }

    private func updateUltraList() {
        guard isViewLoaded else { return }
        let text = TextEnvironment(traitCollection)
        if text != ultraTextRequested {
            ultraTextRequested = text
            ultraTextTask = Task { @MainActor [weak self] in
                let environment = await HomeTextEnvironment.make(text)
                guard let self, !Task.isCancelled, self.ultraTextRequested == text else { return }
                self.ultraText = environment; self.updateUltraList()
            }
        }
        guard let environment = ultraText, environment.text == text else { return }
        let bridgeModel = HomeListModel(ids: [], rows: [], avatarStyle: model.avatarStyle, avatarMonochrome: model.avatarMonochrome, grouped: true, offline: model.offline)
        ultraList.update(.init(model: bridgeModel, width: view.bounds.width, environment: environment, dark: traitCollection.userInterfaceStyle == .dark, selected: selectedSessionId, tablet: model))
    }

    private func row(_ id: HomeListRow.ID) -> Row? {
        model.ids.firstIndex { $0.ultraBridgeID == id }.map { model.rows[$0] }
    }

    private func select(_ id: HomeListRow.ID) {
        guard context.account.session === session, let row = self.row(id) else { return }
        switch row {
        case .archiveToggle(let hidden): session.updateSettings(["hideInactiveSessions": .bool(!hidden)])
        case .machine(let id?, _) where !id.isEmpty: open(.machine(id: id))
        default: if let sessionID = row.sessionId { open(.session(id: sessionID)) }
        }
        updateUltraList()
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
}
#endif
