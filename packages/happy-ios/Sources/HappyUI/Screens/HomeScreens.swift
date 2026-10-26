#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyStore
import UIKit

/// Signed in: app/(app)/index.tsx and SessionsListWrapper.tsx. Home stays
/// the navigation root for the whole session and swaps its content as the
/// store changes (`HomeState`):
///   - a spinner until the machines are known;
///   - Link Your Computer while none is linked;
///   - the offline checklist while none is reachable and nothing is listed;
///   - "No sessions yet" on a reachable computer with nothing on it;
///   - the session list otherwise.
///
/// Link Your Computer keeps the onboarding header in the navigation bar.
/// Every other state is MainView.tsx's phone home: the bar is hidden, and
/// the home header floats over content that scrolls under it.
///
/// The dock sits at the foot of every state but Link Your Computer, which
/// is not MainView in happy-app; content leaves it 108pt. Where a computer
/// is a home of its own (`StemCellsPreference`), it leaves the offline
/// checklist too: with no computer to reach there is nothing to start work
/// on. There, the account's picture leads to the profiles' settings, where
/// a computer is chosen instead.
///
/// Screens pushed over it (settings, server, troubleshoot) stay where they
/// are when a computer arrives, as they do in happy-app.
public final class HomeViewController: UIViewController {
    private let context: AppContext
    private let session: AccountSession
    private let titleView = NavigationTitleView()
    private let header = HomeHeaderView()
    private let dockView = HomeDockView()
    private var dock: HomeDockController?
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
    private var accountControl: HomeAccountControl?

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
        // OnboardingHeader's title, which scales; the rows below don't yet.
        setScaledTitleView(titleView)
        showsBackTitle()
        header.isHidden = true
        header.settingsButton.addAction(UIAction { [weak self] _ in self?.openSettings() }, for: .primaryActionTriggered)
        header.filterButton.menu = filterMenu()
        header.filterButton.showsMenuAsPrimaryAction = true
        header.filterButton.preferredMenuElementOrder = .fixed
        dockView.isHidden = true
        view.addSubview(dockView)
        view.addSubview(header)
        accountControl = HomeAccountControl(context: context, controller: self, header: header)
        if StemCellsPreference(variant: context.variant).isAvailable {
            accountControl?.opensSettings = { [weak self] in
                guard let self else { return }
                StemCellsSettingsViewController.open(context: context, computer: nil, from: self)
            }
        }
        let pipeline = ApplyPipeline<HomeDerivation.Input, HomeDerivation.Applied, HomeUpdate>(
            input: HomeDerivation.Input(
                expandedProjects: context.account.localSettings.expandedProjects,
                includesDock: true,
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
        // A new text size: the dock's text heights are made again.
        registerForTraitChanges([UITraitPreferredContentSizeCategory.self, UITraitDisplayScale.self]) { (self: Self, _) in
            self.view.setNeedsLayout()
        }
        // The stream ends when the session stops.
        let statusUpdates = session.statusUpdates
        Task { @MainActor [weak self] in
            for await status in statusUpdates {
                self?.header.status = status
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

    /// Something can be started from the dock: a computer is linked and,
    /// where a computer is a home of its own, one is reachable.
    private var showsDock: Bool {
        switch state {
        case nil, .link?: false
        case .offline?: !StemCellsPreference(variant: context.variant).isAvailable
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
    }

    public override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        // Screens pushed from here have the ordinary bar; settings, its glass one.
        if let top = navigationController?.topViewController, top !== self, !(top is StemCellsSettingsViewController) {
            navigationController?.setNavigationBarHidden(false, animated: animated)
        }
    }

    public override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // The dock's text heights for this width and text size, made off
        // the main thread before the composer opens.
        dock?.prepareText(width: view.bounds.width, text: TextEnvironment(traitCollection))
        let layout = HomeScreenLayout(
            size: view.bounds.size,
            safeArea: LayoutInsets(view.safeAreaInsets),
            dock: showsDock ? HomeDockLayout.Metrics.contentInset : 0
        )
        header.frame = layout.header
        dockView.frame = view.bounds
        applyInsets(layout.insets)
    }

    private var isCurrentAccount: Bool {
        context.account.session === session
    }

    /// Returns how many rows it touched.
    private func apply(_ update: HomeUpdate) -> Int {
        grouping = update.grouping
        if let snapshot = update.dock {
            if let dock {
                dock.update(snapshot)
            } else {
                dock = HomeDockController(restingView: dockView, host: self, context: context, session: session, snapshot: snapshot)
                view.setNeedsLayout()
            }
        }
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
        let floating = state != .link
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
        // The scrim is for a list that scrolls under the dock.
        dockView.showsScrim = state.kind == .list
        var rows = 0
        switch (previous, state) {
        case (.offline?, .offline(let choices, let hasArchived)):
            let checklist = content as? OfflineChecklistViewController
            if checklist?.choices != choices { checklist?.choices = choices }
            if checklist?.hasArchived != hasArchived { checklist?.hasArchived = hasArchived }
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
        case .loading:
            LoadingViewController()
        case .link:
            LinkComputerViewController(context: context, session: session)
        case .offline(let choices, let hasArchived):
            OfflineChecklistViewController(context: context, session: session, choices: choices, hasArchived: hasArchived)
        case .noSessions:
            NoSessionsViewController(context: context, session: session)
        case .list(let model):
            makeList(model, changeset: update.changeset)
        }
    }

    private func makeList(_ model: HomeListModel, changeset: RowChangeset) -> SessionListViewController {
        let controller = SessionListViewController(context: context, session: session)
        controller.onCreateWorkspace = { [weak self] origin in
            self?.dock?.createWorkspace(origin) ?? false
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
            self.view.insertSubview(next.view, belowSubview: self.dockView)
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

    /// The link screen has happy-app's onboarding header: no title, the
    /// custom server under it, and a gear to the onboarding settings. Every
    /// other state hides the bar for the floating home header.
    private func updateNavigation(animated: Bool) {
        guard let state else { return }
        let floating = state != .link
        // Tablet (HappyUI/Tablet): beside the sidebar the index route draws
        // nothing, nor its header and dock (MainView.tsx `isTablet`).
        let blank = floating && traitCollection.isTabletLayout
        content?.view.isHidden = blank
        header.isHidden = !floating || blank
        dock?.isAvailable = showsDock && !blank
        if navigationController?.topViewController === self {
            navigationController?.setNavigationBarHidden(floating, animated: animated)
        }
        if floating {
            titleView.title = nil
            titleView.subtitle = nil
            navigationItem.rightBarButtonItem = nil
        } else {
            titleView.title = nil
            titleView.subtitle = context.customServerHost
            navigationItem.rightBarButtonItem = settingsBarButton(action: #selector(openOnboardingSettings))
        }
        // Not `sizeToFit`, which would hold a longer server to the width of
        // the one before it.
        titleView.frame.size = titleView.intrinsicContentSize
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

    @objc private func openOnboardingSettings() {
        navigationController?.pushViewController(OnboardingSettingsViewController(context: context), animated: true)
    }

    private func openSettings() {
        push(.settings, context: context)
    }
}

final class LoadingViewController: UIViewController {
    override func loadView() {
        view = LoadingView()
    }
}

/// OnboardingLinkComputer from components/onboarding/LinkComputer.tsx.
/// Scanning opens once both boxes are ticked, and the ticks are kept until
/// logout. A link that went through keeps the button busy until the
/// computer arrives and home swaps this screen out, or for ten seconds if
/// it never does. A failed one says so on the line above the button. The
/// only way back is the gear's "Log out and start over".
final class LinkComputerViewController: UIViewController {
    static let machineArrivalTimeout: Duration = .seconds(10)

    /// A link that went through, where this screen is a step of adding a
    /// computer rather than the account's home (the link sheet).
    var onLinked: (() -> Void)?
    private let context: AppContext
    private let session: AccountSession
    private let content = LinkComputerContentView()
    private lazy var screen = OnboardingScreenView(
        content: content,
        primary: RoundButton(title: Strings.Onboarding.scanButton),
        secondary: RoundButton(title: Strings.Onboarding.pasteLink, size: .normal, display: .inverted)
    )
    /// The approval request is in flight.
    private var linking = false
    /// Approved; waiting for the computer to sync in.
    private var approved = false
    private var approvalTimeout: Task<Void, Never>?

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
        view = screen
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        screen.primary.loadingTitle = Strings.Onboarding.linking
        screen.primary.onTap = { [weak self] in self?.scan() }
        screen.secondary.onTap = { [weak self] in self?.paste() }
        screen.help.onTap = { [weak self] in
            guard let self else { return }
            Alerts.help(on: self)
        }
        content.onOpenWebsite = {
            UIApplication.shared.open(Strings.Onboarding.desktopURL)
        }
        let saved = context.account.localSettings.linkComputerChecklist
        content.ticked = Set(LinkComputerContentView.Step.allCases.filter {
            $0 == .install ? saved.install : saved.open
        })
        content.onToggle = { [weak self] ticked in
            self?.context.account.localSettings.linkComputerChecklist = LinkChecklist(
                install: ticked.contains(.install),
                open: ticked.contains(.open)
            )
            self?.update()
        }
        update()
    }

    private var busy: Bool {
        linking || approved
    }

    private func update() {
        let ready = content.ticked == Set(LinkComputerContentView.Step.allCases)
        screen.primary.isLoading = busy
        screen.primary.isEnabled = !busy && ready
        screen.secondary.isEnabled = !busy
        content.isEnabled = !busy
    }

    private func scan() {
        content.error = nil
        Task { @MainActor in
            guard let text = await PairingFlow.scan(.terminal, from: self) else {
                return PairingAnalytics.shared.log(.cancelled(method: .relay, start: .scan))
            }
            await link(text, start: .scan)
        }
    }

    private func paste() {
        content.error = nil
        Task { @MainActor in
            let text = await Alerts.prompt(
                Strings.Onboarding.pasteLinkTitle,
                Strings.Onboarding.pasteLinkMessage,
                placeholder: "happy://terminal?...",
                confirmTitle: Strings.Onboarding.pasteLinkConfirm,
                on: self
            )
            guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else {
                return PairingAnalytics.shared.log(.cancelled(method: .relay, start: .pasteLink))
            }
            await link(text, start: .pasteLink)
        }
    }

    private func link(_ text: String, start: PairingStart) async {
        guard !busy else { return }
        if DirectPairingFlow.openIfDirect(text, context: context, on: self, start: start) { return }
        linking = true
        update()
        let outcome = await PairingFlow.approve(text, expecting: .terminal, session: session)
        linking = false
        if case .approved = outcome {
            PairingAnalytics.shared.log(.completed(method: .relay, start: start))
        } else {
            PairingAnalytics.shared.log(.failed(method: .relay, start: start))
        }
        switch outcome {
        case .approved:
            PairingFlow.report(outcome, kind: .terminal, on: self)
            if let onLinked { return onLinked() }
            approved = true
            approvalTimeout?.cancel()
            approvalTimeout = Task { @MainActor [weak self] in
                try? await Task.sleep(for: Self.machineArrivalTimeout)
                guard !Task.isCancelled, let self else { return }
                approved = false
                update()
            }
        case .failed:
            content.error = Strings.Onboarding.linkFailed
            UIAccessibility.post(notification: .announcement, argument: Strings.Onboarding.linkFailed)
        case .invalidLink, .terminalNeedsUpdate:
            // These need more than one line, and scanning again won't help.
            PairingFlow.report(outcome, kind: .terminal, on: self)
        }
        update()
    }
}

/// LinkComputerChecklist from components/onboarding/LinkComputer.tsx:
/// computers are linked but none is reachable. The install box is already
/// ticked; the job now is to get Happy running again.
final class OfflineChecklistViewController: UIViewController {
    var choices: [MachineChoice] {
        didSet { applyChoices() }
    }

    /// Offers "Show archived", which turns the archive on and so lists it.
    var hasArchived: Bool {
        didSet { applyChoices() }
    }

    private let context: AppContext
    private let session: AccountSession
    private let checklist = OfflineChecklistView()
    private var linking = false
    private var approved = false
    private var approvalTimeout: Task<Void, Never>?

    init(context: AppContext, session: AccountSession, choices: [MachineChoice], hasArchived: Bool = false) {
        self.context = context
        self.session = session
        self.choices = choices
        self.hasArchived = hasArchived
        super.init(nibName: nil, bundle: nil)
        followsTextSize()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func loadView() {
        view = checklist
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        checklist.troubleshoot.onTap = { [weak self] in
            guard let self else { return }
            navigationController?.pushViewController(TroubleshootViewController(context: context, session: session), animated: true)
        }
        checklist.linkAnother.onTap = { [weak self] in self?.scan() }
        checklist.showArchived.onTap = { [weak self] in
            self?.session.updateSettings(["hideInactiveSessions": .bool(false)])
        }
        applyChoices()
        update()
    }

    private func applyChoices() {
        guard isViewLoaded else { return }
        checklist.showsArchivedButton = hasArchived
        if choices.count == 1 {
            checklist.title = Strings.Onboarding.offlineTitleOne(name: choices[0].name)
            checklist.linkedTitle = Strings.Onboarding.offlineLinkedStep(name: choices[0].name)
        } else {
            checklist.title = Strings.Onboarding.offlineTitleMany
            checklist.linkedTitle = Strings.Onboarding.offlineLinkedStepMany(count: choices.count)
        }
    }

    private func update() {
        checklist.linkAnother.isLoading = linking || approved
        checklist.linkAnother.title = approved ? Strings.Onboarding.linking : Strings.Onboarding.linkAnother
    }

    private func scan() {
        Task { @MainActor in
            guard let text = await PairingFlow.scan(.terminal, from: self), !linking, !approved else { return }
            if DirectPairingFlow.openIfDirect(text, context: context, on: self) { return }
            linking = true
            update()
            let outcome = await PairingFlow.approve(text, expecting: .terminal, session: session)
            linking = false
            // No inline error line here: failures are alerts, as in happy-app.
            PairingFlow.report(outcome, kind: .terminal, on: self)
            if outcome == .approved { startWaitingForComputer() }
            update()
        }
    }

    private func startWaitingForComputer() {
        approved = true
        approvalTimeout?.cancel()
        approvalTimeout = Task { @MainActor [weak self] in
            try? await Task.sleep(for: LinkComputerViewController.machineArrivalTimeout)
            guard !Task.isCancelled, let self else { return }
            approved = false
            update()
        }
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
