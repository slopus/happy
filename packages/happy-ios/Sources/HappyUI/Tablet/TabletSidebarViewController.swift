#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyStore
import UIKit

/// SidebarView.tsx: New session and the archive button on top, then
/// MainView.tsx's sidebar variant (a spinner, EmptySessionsTablet, or
/// SessionsList.tsx), then Settings at the foot. The flat list is home's
/// own `SessionListViewController`; grouped by project it is
/// SessionsList's own hierarchy (`TabletGroupedListViewController`), not
/// home's project cards. A tap on a row pushes the chat onto the stack
/// beside the sidebar (`push(_:context:)` finds it), where every other
/// screen the sidebar opens goes too.
///
/// It reads the same home snapshot as the phone home and tells the shell
/// when home turns into Link Your Computer, which the shell steps aside
/// for.
final class TabletSidebarViewController: UIViewController {
    private let context: AppContext
    private let session: AccountSession
    private let newSession = SidebarNewSessionButton()
    private let archive = SidebarArchiveButton()
    private let settingsRow = SidebarSettingsRow()
    private let empty = TabletEmptySessionsView()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private var list: SessionListViewController?
    private var grouped: TabletGroupedListViewController?
    /// Worked out off the main thread from the account's home feed
    /// (`TabletSidebarDerivation`), with the grouped list's heading heights
    /// at the person's text size (`TabletGroupedHeights`); only what changed
    /// is applied here.
    private var observation: ApplyObservation?
    /// The checkouts whose headings show; a new message in one refreshes
    /// its status. Withdrawn when the sidebar goes.
    private let gitInterest: GitCheckoutInterest
    /// The next instant a stamp or a day heading can read differently.
    private let clockWake = ClockWake()
    private var pipeline: ApplyPipeline<TabletSidebarViewInput, TabletSidebarViewState, TabletSidebarViewUpdate>?
    /// The grouped list's width as last handed to the pipeline.
    private var listWidth: CGFloat = 0

    private(set) var state: TabletSidebarFrame?
    var onStateChange: ((TabletSidebarFrame) -> Void)?

    /// The navigation header's height (`DeviceCalculations.headerHeight`);
    /// the controls start below it.
    var headerHeight: CGFloat = DeviceCalculations.headerHeight(isPad: true) {
        didSet { if headerHeight != oldValue { view.setNeedsLayout() } }
    }

    /// The chat open beside the sidebar, whose row stays selected
    /// (SessionsList.tsx `selectedSessionId`).
    var selectedSessionId: String? {
        didSet {
            guard selectedSessionId != oldValue else { return }
            list?.selectedSessionId = selectedSessionId
            grouped?.selectedSessionId = selectedSessionId
        }
    }

    init(context: AppContext, session: AccountSession) {
        self.context = context
        self.session = session
        gitInterest = session.gitStatus.interest()
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.groupedBackground)
        view.clipsToBounds = true
        spinner.color = UIColor(Palette.textSecondary)
        spinner.hidesWhenStopped = true
        empty.isHidden = true
        archive.isHidden = true
        for subview in [newSession, archive, empty, spinner, settingsRow] as [UIView] {
            view.addSubview(subview)
        }
        newSession.addAction(UIAction { [weak self] _ in self?.openNewSession() }, for: .touchUpInside)
        archive.addAction(UIAction { [weak self] _ in self?.toggleArchive() }, for: .touchUpInside)
        settingsRow.addAction(UIAction { [weak self] _ in self?.open(.settings) }, for: .touchUpInside)
        empty.button.addAction(UIAction { [weak self] _ in self?.emptyAction() }, for: .touchUpInside)
        applyBorder()
        registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitDisplayScale.self]) { (self: Self, _) in
            self.applyBorder()
        }
        let pipeline = ApplyPipeline<TabletSidebarViewInput, TabletSidebarViewState, TabletSidebarViewUpdate>(
            input: TabletSidebarViewInput(
                // In the screens' language; a new one builds the sidebar
                // again.
                feeds: TabletSidebarInput(unknownMachine: Strings.Home.unknownMachine),
                text: TextEnvironment(traitCollection)
            ),
            state: TabletSidebarViewState(),
            derive: { [clockWake] in TabletGroupedHeights.derive($0, applied: $1, wake: clockWake) },
            apply: { [weak self] update in
                // A result worked out for an account that is no longer the
                // active one (a switch while this sidebar is still on
                // screen) is refused; the shell builds a new sidebar.
                guard let self, self.context.account.session === self.session else { return false }
                if let checkouts = update.rows?.checkouts { self.gitInterest.set(checkouts) }
                ApplyPerf.measure(.sidebar) { self.received(update) }
                return true
            }
        )
        clockWake.onWake { [weak pipeline] in pipeline?.update { _ in } }
        pipeline.follow(session.homeFeed.snapshots()) { $0.feeds.snapshot = $1 }
        // The drafts the flat rows, the chats and the archived cards draw.
        pipeline.followDrafts(session.homeFeed, into: \.feeds.draftSessionIds)
        // Only what has been fetched already, and only when what a heading
        // shows changed.
        let git = session.gitStatus
        Task { [weak pipeline] in
            let statuses = await git.headingStatuses()
            pipeline?.follow(statuses) { $0.feeds.git = $1 }
        }
        self.pipeline = pipeline
        observation = pipeline.observation
        // A new text size or screen: the headings are measured again off
        // the main thread, and their rows take the new heights.
        registerForTraitChanges([UITraitPreferredContentSizeCategory.self, UITraitDisplayScale.self]) { (self: Self, _) in
            let text = TextEnvironment(self.traitCollection)
            self.pipeline?.update { $0.text = text }
        }
        // A wake that fell due while the app was suspended; midnight, a new
        // time zone, a clock set by hand. Derived again off the main thread.
        NotificationCenter.default.addObserver(self, selector: #selector(clockChanged), name: UIApplication.didBecomeActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(clockChanged), name: UIApplication.significantTimeChangeNotification, object: nil)
    }

    deinit {
        clockWake.cancel()
    }

    @objc private func clockChanged() {
        pipeline?.update { _ in }
    }

    /// The sidebar's own hairline frame, on all four sides.
    private func applyBorder() {
        view.layer.borderWidth = view.hairline
        view.layer.borderColor = UIColor(Palette.divider).resolvedColor(with: traitCollection).cgColor
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // The hairline is the screen's pixel, known once on screen.
        applyBorder()
        let layout = TabletSidebarLayout(.init(
            size: view.bounds.size,
            safeTop: view.safeAreaInsets.top,
            safeBottom: view.safeAreaInsets.bottom,
            headerHeight: headerHeight,
            hairline: view.hairline,
            newSessionIcon: newSession.icon.sizeThatFits(.zero),
            newSessionTitle: newSession.label.measurable,
            archiveIcon: archive.isHidden ? nil : archive.icon.sizeThatFits(.zero),
            settingsIcon: settingsRow.icon.sizeThatFits(.zero),
            settingsTitle: settingsRow.label.measurable,
            spinner: spinner.sizeThatFits(.zero)
        ))
        newSession.setLayoutFrame(layout.newSessionButton)
        newSession.icon.setLayoutFrame(layout.newSessionIcon.offsetBy(dx: -layout.newSessionButton.minX, dy: -layout.newSessionButton.minY))
        newSession.label.setLayoutFrame(layout.newSessionTitle.offsetBy(dx: -layout.newSessionButton.minX, dy: -layout.newSessionButton.minY))
        if let button = layout.archiveButton, let icon = layout.archiveIcon {
            archive.setLayoutFrame(button)
            archive.icon.setLayoutFrame(icon.offsetBy(dx: -button.minX, dy: -button.minY))
        }
        let row = layout.settingsRow
        settingsRow.setLayoutFrame(row)
        settingsRow.divider.setLayoutFrame(layout.settingsDivider.offsetBy(dx: -row.minX, dy: -row.minY))
        settingsRow.icon.setLayoutFrame(layout.settingsIcon.offsetBy(dx: -row.minX, dy: -row.minY))
        settingsRow.label.setLayoutFrame(layout.settingsTitle.offsetBy(dx: -row.minX, dy: -row.minY))

        empty.setLayoutFrame(layout.content)
        list?.view.setLayoutFrame(layout.content)
        grouped?.view.setLayoutFrame(layout.content)
        if layout.content.width != listWidth {
            let width = layout.content.width
            listWidth = width
            pipeline?.update { $0.width = width }
        }
        grouped?.bottomInset = layout.listBottomInset
        spinner.setLayoutFrame(layout.spinner)
        // Home's list pads itself under its floating header; here nothing
        // floats over it.
        var insets = HomeContentInsets(safeArea: .zero, dock: 0)
        insets.chromeTop = 0
        insets.contentTop = 0
        insets.listBottom = layout.listBottomInset
        list?.contentInsets = insets
    }

    // MARK: State

    /// Returns how many rows it touched.
    private func received(_ update: TabletSidebarViewUpdate) -> Int {
        guard let rows = update.rows else {
            // Only the headings' heights: a new text size or width.
            return grouped?.applyHeadings(update.headings, moved: update.moved) ?? 0
        }
        return received(rows, headings: update.headings, moved: update.moved)
    }

    private func received(_ update: TabletSidebarUpdate, headings: TabletHeadingHeights<TabletGroupedRow.ID>, moved: Set<TabletGroupedRow.ID>) -> Int {
        let state = update.frame
        let previous = self.state
        self.state = state
        var rows = 0
        if archive.isHidden != !state.hasArchived { archive.isHidden = !state.hasArchived }
        if archive.hidesArchived != state.hidesArchived { archive.hidesArchived = state.hidesArchived }
        switch state.content {
        case .loading:
            spinner.startAnimating()
            empty.isHidden = true
            list?.view.isHidden = true
            grouped?.view.isHidden = true
            grouped?.applyHeadings(headings, moved: moved)
        case .empty(let variant):
            spinner.stopAnimating()
            empty.state = variant
            empty.isHidden = false
            list?.view.isHidden = true
            grouped?.view.isHidden = true
            grouped?.applyHeadings(headings, moved: moved)
        case .list(let model):
            spinner.stopAnimating()
            empty.isHidden = true
            grouped?.view.isHidden = true
            grouped?.applyHeadings(headings, moved: moved)
            rows = showList(model, changeset: update.changeset ?? RowChangeset())
        case .grouped(let model):
            spinner.stopAnimating()
            empty.isHidden = true
            list?.view.isHidden = true
            rows = showGrouped(model, changeset: update.changeset ?? RowChangeset(), headings: headings, moved: moved)
        }
        // Only a change of what fills the sidebar moves anything.
        if previous?.content.kind != state.content.kind || previous?.hasArchived != state.hasArchived {
            view.setNeedsLayout()
        }
        if previous?.showsInstallStep != state.showsInstallStep { onStateChange?(state) }
        return rows
    }

    private func showList(_ model: HomeListModel, changeset: RowChangeset) -> Int {
        if let list {
            let rows = list.apply(model, changeset: changeset, animated: view.window != nil)
            list.view.isHidden = false
            return rows
        }
        let controller = SessionListViewController(context: context, session: session)
        controller.apply(model, changeset: changeset, animated: false)
        controller.selectedSessionId = selectedSessionId
        addChild(controller)
        view.insertSubview(controller.view, belowSubview: settingsRow)
        controller.didMove(toParent: self)
        list = controller
        view.setNeedsLayout()
        return model.rows.count
    }

    private func showGrouped(
        _ model: TabletGroupedList,
        changeset: RowChangeset,
        headings: TabletHeadingHeights<TabletGroupedRow.ID>,
        moved: Set<TabletGroupedRow.ID>
    ) -> Int {
        if let grouped {
            let rows = grouped.apply(model, changeset: changeset, headings: headings, moved: moved, animated: view.window != nil)
            grouped.view.isHidden = false
            return rows
        }
        let controller = TabletGroupedListViewController(context: context, session: session)
        controller.apply(model, changeset: changeset, headings: headings, moved: moved, animated: false)
        controller.selectedSessionId = selectedSessionId
        addChild(controller)
        view.insertSubview(controller.view, belowSubview: settingsRow)
        controller.didMove(toParent: self)
        grouped = controller
        view.setNeedsLayout()
        return model.rows.count
    }

    // MARK: Actions

    private func open(_ route: Route) {
        push(route, context: context)
    }

    /// `router.navigate('/new')`.
    private func openNewSession() {
        open(.newSession(machineId: nil, path: nil, prompt: nil))
    }

    private func toggleArchive() {
        guard let state else { return }
        session.updateSettings(["hideInactiveSessions": .bool(!state.hidesArchived)])
    }

    /// Start New Session with a reachable computer; troubleshoot with none
    /// (`useOfflineMachineTroubleshooting`).
    private func emptyAction() {
        switch empty.state {
        case .online: openNewSession()
        case .offline: open(.troubleshoot)
        case .noMachines: break
        }
    }
}
#endif
