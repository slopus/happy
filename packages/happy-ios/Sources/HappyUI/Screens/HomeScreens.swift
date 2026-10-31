#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyStore
import HappyWire
import UIKit

/// Signed in: app/(app)/index.tsx and SessionsListWrapper.tsx. Home stays
/// the navigation root for the whole session and swaps its content as the
/// store changes (`HomeState`):
///   - until the machines are known, no computer, or none reachable with
///     nothing listed: a notice in home (`HomeNoticeViewController`),
///     never an onboarding screen;
///   - "No sessions yet" on a reachable computer with nothing on it;
///   - the session list otherwise.
///
/// Every state has home's bar: the account's picture at the left,
/// "Sessions" with the connection under it, and the filter menu and
/// settings at the right.
///
/// Nothing is typed here: compose in the bar (`compose()`) opens an empty
/// chat, whose first send starts the session (`LegacyComposeStart`). It is
/// offered in every state but Link Your Computer and, where a computer is
/// a home of its own (`Preference`), the offline checklist: with no
/// computer to reach there is nothing to start work on. There, the
/// account's picture leads to the profiles' settings, where a computer is
/// chosen instead.
///
/// Screens pushed over it (settings, server, troubleshoot) stay where they
/// are when a computer arrives, as they do in happy-app.
public final class LegacyHomeViewController: UIViewController, ComposeHosting {
    private let context: AppContext
    private let session: AccountSession
    /// Home's content worked out off the main thread from the account's
    /// home feed (`HomeDerivation`); only what changed is applied here.
    private var pipeline: ApplyPipeline<HomeDerivation.Input, HomeDerivation.Applied, HomeUpdate>?
    private var observation: ApplyObservation?
    /// Derives home again when a stamp or heading can next read differently
    /// (`HomeClockBoundary`), with no store change.
    private let clockWake = ClockWake()
    private var state: HomeContent?
    /// The home filter's choice, as last derived.
    private var grouping: SessionListGrouping = .flat
    private var content: UIViewController?
    private var preparesArchives = false
    private var switcher: AccountSwitcher?

    public init(context: AppContext, session: AccountSession) {
        self.context = context
        self.session = session
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.groupedBackground)
        showsBackTitle()
        switcher = AccountSwitcher(context: context, controller: self)
        let pipeline = ApplyPipeline<HomeDerivation.Input, HomeDerivation.Applied, HomeUpdate>(
            input: HomeDerivation.Input(
                expandedProjects: context.account.localSettings.expandedProjects,
                // In the screens' language; a new one builds home again.
                unknownMachine: Strings.Home.unknownMachine
            ),
            state: HomeDerivation.Applied(),
            derive: { [clockWake] in HomeDerivation.derive($0, applied: $1, wake: clockWake) },
            apply: { [weak self] update in
                // Nothing from an account that is no longer the active one.
                guard let self, self.isCurrentAccount else { return false }
                ApplyPerf.measure(.home) { self.apply(update) }
                return true
            }
        )
        clockWake.onWake { [weak pipeline] in pipeline?.update { _ in } }
        pipeline.follow(session.homeFeed.snapshots()) { $0.snapshot = $1 }
        // FlatSessionRow's draft glyph: one draft appearing or going
        // reconfigures that row alone.
        pipeline.followDrafts(session.homeFeed, into: \.draftSessionIds)
        self.pipeline = pipeline
        observation = pipeline.observation
        // Tablet (HappyUI/Tablet): the shell flips this with the window's width.
        registerForTraitChanges([TabletLayoutTrait.self]) { (self: Self, _) in self.updateNavigation(animated: false) }
        // The stream ends when the session stops.
        let statusUpdates = session.statusUpdates
        Task { @MainActor [weak self] in
            for await status in statusUpdates {
                self?.status = status
            }
        }
        // sync.ts `nativeUpdateSync`: asked at start and whenever the app
        // becomes active.
        checkNativeUpdate()
        NotificationCenter.default.addObserver(self, selector: #selector(appBecameActive), name: UIApplication.didBecomeActiveNotification, object: nil)
        // Midnight, a new time zone, a clock set by hand: the stamps are
        // written again, off the main thread.
        NotificationCenter.default.addObserver(self, selector: #selector(clockChanged), name: UIApplication.significantTimeChangeNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(rendererChanged), name: HomeRendererPreference.didChange, object: nil)
    }

    /// Something can be started from compose: a computer is linked and,
    /// where a computer is a home of its own, one is reachable. The bar
    /// shows compose only then.
    var canCompose: Bool {
        guard !traitCollection.isTabletLayout else { return false }
        return switch state {
        case nil, .link?: false
        case .offline?: !Preference(variant: context.variant).isAvailable
        default: true
        }
    }

    deinit {
        clockWake.cancel()
    }

    @objc private func appBecameActive() {
        checkNativeUpdate()
        // A wake that fell due while the app was suspended.
        clockChanged()
    }

    @objc private func clockChanged() {
        pipeline?.update { _ in }
    }

    private func checkNativeUpdate() {
        guard let request = NativeUpdateCheck.Request.current() else { return }
        NativeUpdateCheck.shared.invalidate(api: session.api, request: request)
    }

    public override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        rendererChanged()
        // The server may have changed on a screen pushed from here.
        updateNavigation(animated: animated)
        HomeToolbar.show(for: self, animated: animated)
    }

    public override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        HomeToolbar.leave(self, animated: animated)
    }

    public override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        switcher?.layout()
        applyInsets(HomeContentInsets(underBar: LayoutInsets(view.safeAreaInsets), dock: 0))
    }

    private var isCurrentAccount: Bool {
        context.account.session === session
    }

    /// Returns how many rows it touched.
    private func apply(_ update: HomeUpdate) -> Int {
        grouping = update.grouping
        let touched = update.contentChanged ? show(update) : 0
        (content as? SessionListViewController)?.setArchiveModels(update.archiveModels, settings: update.archiveSettings)
        prepareArchivesIfNeeded()
        return touched
    }

    private func prepareArchivesIfNeeded() {
        let wanted = state?.kind == .list && context.account.localSettings.homeListRenderer == .ultraList && !traitCollection.isTabletLayout
        guard wanted != preparesArchives else { return }
        preparesArchives = wanted
        pipeline?.update { $0.preparesArchives = wanted }
    }

    /// The list's projects were opened or closed: derive the rows again.
    private func expandedProjectsChanged() {
        let expanded = context.account.localSettings.expandedProjects
        pipeline?.update { $0.expandedProjects = expanded }
    }

    /// The list pads itself under the header; every other state sees the
    /// padding as safe area, as SessionsListWrapper pads them.
    private func applyInsets(_ insets: HomeContentInsets) {
        guard let content else { return }
        let floating = true
        if let list = content as? SessionListViewController {
            list.contentInsets = insets
            setAdditionalSafeArea(.zero, on: list)
        } else {
            let extra = floating ? UIEdgeInsets(insets.additionalSafeArea(over: LayoutInsets(view.safeAreaInsets))) : .zero
            setAdditionalSafeArea(extra, on: content)
        }
    }

    private func setAdditionalSafeArea(_ insets: UIEdgeInsets, on child: UIViewController) {
        if child.additionalSafeAreaInsets != insets { child.additionalSafeAreaInsets = insets }
    }

    private func show(_ update: HomeUpdate) -> Int {
        let state = update.content
        let previous = self.state
        self.state = state
        var rows = 0
        switch (previous, state) {
        case (.loading?, .loading), (.link?, .link), (.offline?, .offline), (.loading?, .link), (.link?, .loading),
             (.loading?, .offline), (.offline?, .loading), (.link?, .offline), (.offline?, .link):
            // One notice in place, its words changed.
            (content as? HomeNoticeViewController)?.kind = Self.notice(state)
        case (.list?, .list(let model)):
            rows = (content as? SessionListViewController)?.apply(model, changeset: update.changeset, animated: view.window != nil) ?? 0
        default:
            embed(makeContent(for: update), animated: previous != nil)
            rows = state.list?.rows.count ?? 0
        }
        if update.kindChanged { updateNavigation(animated: previous != nil) }
        return rows
    }

    private func makeContent(for update: HomeUpdate) -> UIViewController {
        switch update.content {
        case .loading, .link, .offline:
            HomeNoticeViewController(context: context, session: session, kind: Self.notice(update.content))
        case .noSessions:
            NoSessionsViewController(context: context, session: session)
        case .list(let model):
            makeList(model, changeset: update.changeset)
        }
    }

    /// What home says in place of the list, under its own bar.
    private static func notice(_ content: HomeContent) -> HomeNoticeViewController.Kind {
        switch content {
        case .link: .noComputer
        case .offline(let choices, let hasArchived): .offline(choices, hasArchived: hasArchived)
        default: .connecting
        }
    }

    private func makeList(_ model: HomeListModel, changeset: RowChangeset) -> SessionListViewController {
        let controller = SessionListViewController(context: context, session: session)
        // ProjectRow's `+` (ProjectHomeList.tsx `createWorkspace`): the
        // draft moves to the project, asking for a new workspace, and an
        // empty chat opens on it.
        controller.onCreateWorkspace = { [weak self] origin in
            guard let self, canCompose else { return false }
            NewSessionDraftStore.shared(for: context.account.localSettings).prepareWorkspace(origin)
            compose()
            return true
        }
        controller.onExpandedProjectsChange = { [weak self] in self?.expandedProjectsChanged() }
        controller.apply(model, changeset: changeset, animated: false)
        return controller
    }

    @objc private func rendererChanged() {
        prepareArchivesIfNeeded()
        guard isCurrentAccount, let list = content as? SessionListViewController,
              list.rendererPreference != context.account.localSettings.homeListRenderer else { return }
        embed(makeList(list.model, changeset: RowChangeset()), animated: false)
        updateNavigation(animated: false)
    }

    private func embed(_ next: UIViewController, animated: Bool) {
        let previous = content
        (previous as? SessionListViewController)?.deactivateRenderer()
        content = next
        previous?.willMove(toParent: nil)
        addChild(next)
        next.view.frame = view.bounds
        next.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        let swap = {
            previous?.view.removeFromSuperview()
            self.view.insertSubview(next.view, at: 0)
        }
        if animated {
            UIView.transition(with: view, duration: 0.25, options: .transitionCrossDissolve, animations: swap)
        } else {
            swap()
        }
        previous?.removeFromParent()
        next.didMove(toParent: self)
        view.setNeedsLayout()
    }

    /// Home's own title and buttons in the bar, whatever it shows.
    private func updateNavigation(animated: Bool) {
        guard let state else { return }
        let floating = true
        // Tablet (HappyUI/Tablet): beside the sidebar the index route draws
        // nothing, nor its header and dock (MainView.tsx `isTablet`).
        let blank = floating && traitCollection.isTabletLayout
        content?.view.isHidden = blank
        if floating {
            // The account's name is the bar's title; the connection hangs under it.
            let headerState: Strings.HeaderStatus.State = switch status {
            case .connected: .online
            case .connecting: .connecting
            case .disconnected, .error: .offline
            }
            switcher?.subtitle = Strings.HeaderStatus.text(headerState)
            // Beside the sidebar home draws nothing, but the bar is over
            // the sidebar too: the switcher stays, or a tablet has no way
            // to the accounts at all.
            navigationItem.leftBarButtonItem = switcher?.barItem
            let items: [HeaderBar.Trailing: UIBarButtonItem] = [.filter: filterItem, .settings: settingsItem]
            if canCompose, let host = self as UIViewController as? ComposeHosting {
                let compose = composeItem(host)
                compose.sharesBackground = false
                toolbarItems = [.flexibleSpace(), compose]
            } else { toolbarItems = nil }
            navigationItem.rightBarButtonItems = blank ? nil : HeaderBar.trailing(items)
            if navigationController?.topViewController === self { HomeToolbar.show(for: self, animated: animated) }
        }
        view.setNeedsLayout()
    }

    /// MainView.tsx `HeaderRight`: the grouping choice and a way to the
    /// appearance settings. happy-app draws it as a native SwiftUI menu with
    /// SF Symbols, so this one uses the same symbols.
    private func filterMenu() -> UIMenu {
        UIMenu(children: [
            UIDeferredMenuElement.uncached { [weak self] completion in
                completion(self?.filterMenuElements() ?? [])
            },
        ])
    }

    private func filterMenuElements() -> [UIMenuElement] {
        let current = grouping
        let options: [(SessionListGrouping, String)] = [
            (.flat, Strings.SessionsFilter.flatList),
            (.project, Strings.SessionsFilter.groupByProject),
        ]
        let choices: [UIMenuElement] = options.map { mode, title in
            UIAction(title: title, state: current == mode ? .on : .off) { [weak self] _ in
                self?.session.updateSettings(["sessionListGrouping": .string(mode.rawValue)])
            }
        }
        let grouping = UIMenu(
            title: Strings.SessionsFilter.groupingTitle,
            image: UIImage(systemName: "rectangle.grid.1x2"),
            options: .displayInline,
            children: choices
        )
        let appearance = UIAction(title: Strings.Home.appearanceSettings, image: UIImage(systemName: "paintpalette")) { [weak self] _ in
            guard let self else { return }
            push(.settingsAppearance, context: context)
        }
        return [grouping, UIMenu(options: .displayInline, children: [appearance])]
    }

    /// The connection, under "Sessions" while it isn't connected.
    /// Not private, so a test can flip it.
    var status: RealtimeStatus = HomeConnectionStatus.initial {
        didSet { if status != oldValue { updateNavigation(animated: false) } }
    }

    private lazy var settingsItem = HeaderBar.settingsItem { [weak self] in self?.openSettings() }

    private func composeItem(_ host: ComposeHosting) -> UIBarButtonItem {
        HeaderBar.composeItem { [weak host] in host?.compose() }
    }

    private lazy var filterItem: UIBarButtonItem = {
        let item = UIBarButtonItem(image: .icon(.ionicons("filter"), size: 22), menu: filterMenu())
        item.accessibilityLabel = Strings.Home.filterTitle
        // As `HeaderBar`'s own items are named, so a test finds it without
        // depending on the label's language.
        item.accessibilityIdentifier = "filter"
        item.preferredMenuElementOrder = .fixed
        return item
    }()

    private func openSettings() {
        push(.settings, context: context)
    }

    /// The bar's compose: an empty chat, whose first send starts the
    /// session on the machine and folder picked last.
    func compose() {
        guard canCompose, let navigation = navigationController, navigation.topViewController === self,
              navigation.transitionCoordinator == nil else { return }
        let chat = LegacyChatViewController(context: context, session: session, sessionId: ComposeChat.makeId())
        navigation.pushViewController(chat, animated: true)
    }
}

@MainActor
enum ComputerRow {
    /// A computer as troubleshoot.tsx lists it; a tap opens its machine
    /// screen.
    static func make(_ computer: TroubleshootComputer, onTap: @escaping () -> Void) -> ItemRowView {
        ItemRowView(
            title: computer.name,
            subtitle: computer.online ? nil : Strings.Troubleshoot.machineOffline,
            icon: ItemIcon(.ionicons("desktop-outline"), tint: Palette.textSecondary, size: 28),
            onTap: onTap
        )
    }
}

/// app/(app)/troubleshoot.tsx: what to check when every linked computer is
/// offline, the computers, and an AI prompt pointed at the local logs.
final class TroubleshootViewController: UIViewController {
    private let context: AppContext
    private let session: AccountSession
    private let list = GroupedListView()
    private let guide = TroubleshootGuideView()
    private let prompt = CopyPromptView()
    private var aiPrompt = ""
    private var copiedReset: Task<Void, Never>?

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
        view = list
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = Strings.Troubleshoot.title
        guide.onOpenWebsite = {
            UIApplication.shared.open(Strings.Onboarding.desktopURL)
        }
        prompt.button.onTap = { [weak self] in self?.copyPrompt() }
    }

    /// The computers and the prompt, worked out off the main thread by the
    /// account's troubleshooting feed, and read only while this screen is
    /// on screen.
    private lazy var feed = VisibleFeed<TroubleshootState> { [weak self] state in
        guard let self, self.context.account.session === self.session else { return false }
        ApplyPerf.measure(.screen) {
            self.update(state)
            return state.computers.count
        }
        return true
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        feed.start { session.troubleshootingFeed.snapshots() }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        feed.stop()
    }

    private func update(_ state: TroubleshootState) {
        aiPrompt = state.aiPrompt
        var sections: [UIView] = [guide]
        if !state.computers.isEmpty {
            sections.append(ItemGroupView(title: Strings.Troubleshoot.machines, rows: state.computers.map { computer in
                ComputerRow.make(computer) { [weak self] in
                    guard let self else { return }
                    push(.machine(id: computer.id), context: context)
                }
            }))
        }
        sections.append(prompt)
        list.sections = sections
    }

    private func copyPrompt() {
        UIPasteboard.general.string = aiPrompt
        prompt.button.title = Strings.Troubleshoot.copied
        copiedReset?.cancel()
        copiedReset = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            self?.prompt.button.title = Strings.Troubleshoot.copyAiPrompt
        }
    }
}
#endif
