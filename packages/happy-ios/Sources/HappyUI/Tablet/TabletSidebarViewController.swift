#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyStore
import UIKit

/// SidebarView.tsx: New session and the archive button on top, then
/// MainView.tsx's sidebar variant (a spinner, EmptySessionsTablet, or the
/// session list), then Settings at the foot. The list is home's own
/// `SessionListViewController`; a tap on a row pushes the chat onto the
/// stack beside the sidebar (`push(_:context:)` finds it), where every
/// other screen the sidebar opens goes too.
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
    private var observation: StoreObservation?

    private(set) var state: TabletSidebarState?
    var onStateChange: ((TabletSidebarState) -> Void)?

    /// The navigation header's height (`DeviceCalculations.headerHeight`);
    /// the controls start below it.
    var headerHeight: CGFloat = DeviceCalculations.headerHeight(isPad: true) {
        didSet { if headerHeight != oldValue { view.setNeedsLayout() } }
    }

    /// The chat open beside the sidebar, whose row stays selected
    /// (SessionsList.tsx `selectedSessionId`).
    var selectedSessionId: String? {
        didSet { if selectedSessionId != oldValue { list?.selectedSessionId = selectedSessionId } }
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
        observation = session.store.observeHome { [weak self] snapshot in
            self?.received(TabletSidebarState(snapshot))
        }
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

    private func received(_ state: TabletSidebarState) {
        guard state != self.state else { return }
        self.state = state
        archive.isHidden = !state.hasArchived
        archive.hidesArchived = state.hidesArchived
        switch state.content {
        case .loading:
            spinner.startAnimating()
            empty.isHidden = true
            list?.view.isHidden = true
        case .empty(let variant):
            spinner.stopAnimating()
            empty.state = variant
            empty.isHidden = false
            list?.view.isHidden = true
        case .list(let sessions, let offline):
            spinner.stopAnimating()
            empty.isHidden = true
            showList(sessions, offline: offline)
        }
        view.setNeedsLayout()
        onStateChange?(state)
    }

    private func showList(_ sessions: SessionList, offline: [MachineChoice]?) {
        if let list {
            list.update(sessions, offline: offline)
            list.view.isHidden = false
            return
        }
        let controller = SessionListViewController(context: context, session: session, list: sessions, offline: offline)
        controller.selectedSessionId = selectedSessionId
        addChild(controller)
        view.insertSubview(controller.view, belowSubview: settingsRow)
        controller.didMove(toParent: self)
        list = controller
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
