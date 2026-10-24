#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Home in Stem Cells mode: one paired computer's sidebar, as desktop's
/// `HappyAgentSpacesSidebar` draws it, under home's header and over the
/// dock. The dock's field stays; tapping it makes new work, sent with what
/// the pickers over it hold. Desktop's Search and Create rows aren't drawn:
/// search is the header's button and create is the dock.
final class StemCellsHomeViewController: UIViewController {
    private let context: AppContext
    /// The computer this screen always shows; nil to follow the choice.
    private let fixedComputer: String?
    private let sidebar = StemCellsSidebarView()
    private let banner = StemCellsBannerView()
    private let empty = StemCellsEmptyView()
    let dockView = HomeDockView()
    private let modelBar = StemCellModelBarView()
    private var modelsWatch: StemCellsWatch?
    private let dockText = HomeDockTextStore()
    private var session: StemCellsSession?
    private var watch: StemCellsWatch?
    private var accountsObservation: AccountsObservation?
    private var carryWork: Task<Void, Never>?
    private var snapshot = StemCellsSnapshot()
    private var creating = false
    /// Stories' row above the sidebar; no height while Stories are off.
    private lazy var stories = StoriesHomeController(host: self)

    /// Every snapshot shown, for the screen around this one.
    var onSnapshot: ((StemCellsSnapshot) -> Void)?

    /// The header and dock home lays its content between.
    var contentInsets = HomeContentInsets(safeArea: .zero, dock: 0) {
        didSet { if contentInsets != oldValue { view.setNeedsLayout() } }
    }

    init(context: AppContext, computer: String? = nil) {
        self.context = context
        fixedComputer = computer
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.groupedBackground)
        view.addSubview(sidebar)
        view.addSubview(empty)
        view.addSubview(banner)
        view.addSubview(dockView)
        view.addSubview(modelBar)
        modelBar.onPress = { [weak self] kind in self?.pick(kind) }
        dockView.showsScrim = true
        dockView.prompt = ""
        dockView.entryButton.accessibilityIdentifier = "stem-new-work"
        dockView.entryButton.addAction(UIAction { [weak self] _ in self?.makeNewWork() }, for: .touchUpInside)
        dockView.sendButton.addAction(UIAction { [weak self] _ in self?.makeNewWork() }, for: .touchUpInside)
        dockText.onChange = { [weak self] in
            guard let self else { return }
            dockView.text = dockText.current
        }
        sidebar.onSelect = { [weak self] row in self?.open(row) }
        sidebar.onFold = { [weak self] row in self?.fold(row) }
        sidebar.menu = { [weak self] row in self?.menu(for: row) }
        sidebar.swipeActions = { [weak self] row in self?.swipeActions(for: row) ?? [] }
        sidebar.beginDrag = { [weak self] row in self?.beginDrag(row) }
        sidebar.onDrop = { [weak self] drag, to in self?.drop(drag, to: to) }
        sidebar.onDragging = { [weak self] active in self?.dragging(active) }
        sidebar.delegate = self
        sidebar.addSubview(stories.row)
        stories.onHeightChange = { [weak self] in self?.view.setNeedsLayout() }
        banner.onTurnOn = { [weak self] in
            guard let store = self?.session?.store else { return }
            Task { await store.enablePrioritizing() }
        }
        empty.onPair = { [weak self] in
            guard let self else { return }
            DirectPairingFlow.scan(context: context, on: self)
        }
        accountsObservation = context.account.observeAccounts { [weak self] _ in self?.attach() }
        attach()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        attach()
        sidebar.selectedRowId = session?.selectedRowId
        if let store = session?.store { Task { await store.attentionVisibleUpdate(true) } }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if let store = session?.store { Task { await store.attentionVisibleUpdate(false) } }
    }

    /// The computer shown: the fixed one, the last chosen, or the first paired.
    private func computerID() -> String? {
        let direct = context.account.direct
        if let fixedComputer { return direct.accounts.contains { $0.id == fixedComputer } ? fixedComputer : nil }
        let preference = StemCellsPreference(variant: context.variant)
        let live = direct.accounts.filter { !$0.revoked }
        if let chosen = preference.computerID, live.contains(where: { $0.id == chosen }) { return chosen }
        return live.first?.id
    }

    private func attach() {
        let id = computerID()
        guard id != session?.accountID else { return }
        watch?.invalidate(); watch = nil
        modelsWatch?.invalidate(); modelsWatch = nil
        session = id.flatMap { StemCellsSession.session(for: $0, context: context) }
        stories.attach(session)
        sidebar.images = session?.images
        sidebar.apply([])
        snapshot = StemCellsSnapshot()
        if let session {
            sidebar.selectedRowId = session.selectedRowId
            watch = session.watch { [weak self] snapshot in self?.apply(snapshot) }
            modelsWatch = session.models.watch { [weak self] in self?.updateModelBar() }
            session.models.load()
        }
        updateModelBar()
        applyChrome()
    }

    private func apply(_ snapshot: StemCellsSnapshot) {
        let previous = self.snapshot
        self.snapshot = snapshot
        onSnapshot?(snapshot)
        if previous.rows != snapshot.rows { sidebar.apply(Self.drawn(snapshot.rows)) }
        if previous.prioritizing != snapshot.prioritizing || previous.availability != snapshot.availability || previous.error != snapshot.error || previous.stemCellError != snapshot.stemCellError {
            applyChrome()
        }
    }

    private func applyChrome() {
        let hasComputer = session != nil
        empty.isHidden = hasComputer && snapshot.availability != .unsupported
        empty.message = !hasComputer ? Strings.StemCells.noComputer : Strings.StemCells.unsupported
        empty.showsPair = !hasComputer
        sidebar.isHidden = !empty.isHidden
        let reason = { (text: String) in text.isEmpty ? Strings.StemCells.unanswered : text }
        let notice = snapshot.stemCellError.map { Strings.StemCells.newWorkFailed(reason($0)) } ?? snapshot.error.map(reason)
        banner.configure(
            prioritizingOff: hasComputer && snapshot.availability == .available && snapshot.prioritizing == false,
            notice: notice
        )
        dockView.isHidden = !hasComputer || snapshot.availability == .unsupported
        modelBar.isHidden = dockView.isHidden
        view.setNeedsLayout()
    }

    /// The rows a phone draws: all but Search and Create, which stay in the
    /// document for desktop.
    static func drawn(_ rows: [StemCellsRow]) -> [StemCellsRow] {
        rows.filter { $0.kind != .search && $0.kind != .create }
    }

    private func updateModelBar() {
        let models = session?.models
        let menus = models?.catalog.flatMap { catalog in models?.newWorkMode.map { StemCellModelMenus(catalog: catalog, selection: $0) } }
        modelBar.configure(menus)
        view.setNeedsLayout()
    }

    /// A pick here is what the next new work is sent with.
    private func pick(_ kind: StemCellModelPickers.Kind) {
        guard let models = session?.models, let mode = models.newWorkMode else {
            session?.models.load()
            return
        }
        StemCellModelPickers.present(kind, from: self, state: models, mode: mode) { next in
            models.dockMode = next
        }
    }

    /// Search, from the header.
    func openSearch() {
        guard let session else { return }
        navigationController?.pushViewController(StemCellsSearchViewController(session: session, onOpen: { [weak self] row in self?.open(row) }), animated: true)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let bounds = view.bounds
        dockText.prepare(HomeDockController.textKey(width: bounds.width, text: TextEnvironment(traitCollection)))
        let bannerHeight = banner.isEmpty ? 0 : banner.sizeThatFits(CGSize(width: bounds.width, height: .greatestFiniteMagnitude)).height
        dockView.frame = bounds
        let bar = modelBar.layout(field: dockView.fieldFrame)
        // The list keeps clear of the pickers over the dock too.
        let barHeight = modelBar.isHidden ? 0 : StemCellModelBarLayout.height + StemCellModelBarLayout.gap
        dockView.scrimRaise = barHeight
        let layout = StemCellsHomeLayout(size: bounds.size, contentTop: contentInsets.contentTop, chromeTop: contentInsets.chromeTop, listBottom: contentInsets.listBottom + barHeight, bannerHeight: bannerHeight, storiesHeight: sidebar.isHidden ? 0 : stories.height)
        banner.frame = layout.banner
        sidebar.frame = bounds
        stories.row.frame = layout.stories
        let insets = UIEdgeInsets(layout.listInsets)
        if sidebar.contentInset != insets {
            let atTop = sidebar.contentOffset.y <= -sidebar.contentInset.top + 1
            sidebar.contentInset = insets
            sidebar.verticalScrollIndicatorInsets = UIEdgeInsets(layout.indicatorInsets)
            // A shrinking top (Stories turned off) leaves nothing scrolled past it.
            if atTop || (!sidebar.isDragging && sidebar.contentOffset.y < -insets.top) { sidebar.contentOffset.y = -insets.top }
        }
        empty.frame = layout.empty
        modelBar.frame = bounds
        modelBar.place(field: bar.frame.isEmpty ? .zero : dockView.fieldFrame)
    }

    // MARK: Acts

    private func open(_ row: StemCellsRow) {
        guard let session else { return }
        Task { await session.store.attentionInput() }
        switch row.kind {
        case .search:
            openSearch()
        case .create:
            makeNewWork()
        case .space where row.targetKind == "surface":
            guard let surfaceId = row.targetId else { return }
            session.selectedRowId = row.id
            sidebar.selectedRowId = row.id
            let surface = AgentWire.Surface(id: surfaceId, type: row.surfaceType ?? "", name: row.label)
            navigationController?.pushViewController(StemCellsSurfaceViewController(session: session, surface: surface), animated: true)
        case .space, .session:
            guard let agentId = row.agentId else { return }
            session.selectedRowId = row.id
            sidebar.selectedRowId = row.id
            let space = row.spaceId.flatMap { id in snapshotSpace(id) }
            let chat = StemCellChatViewController(session: session, agentId: agentId, title: row.label, spaceId: row.spaceId, stemCell: space)
            navigationController?.pushViewController(chat, animated: true)
        default:
            break
        }
    }

    private func snapshotSpace(_ spaceId: String) -> StemCellChatViewController.Intro? {
        guard let row = snapshot.rows.first(where: { $0.spaceId == spaceId }) else { return nil }
        if case .stemCell(let seed) = row.mark { return .stemCell(seed: seed) }
        if case .clay(let slug) = row.mark { return .clay(slug) }
        return nil
    }

    private func fold(_ row: StemCellsRow) {
        guard let store = session?.store else { return }
        StemCellsHaptics.play(.fold)
        Task { await store.attentionInput(); await store.fold(row.nodeId) }
    }

    /// New work, right below Happy: the row and its empty conversation exist
    /// at once, and the conversation opens on the intro with the composer up.
    func makeNewWork() {
        guard let session, !creating, navigationController?.topViewController === parent || navigationController?.topViewController === self else { return }
        creating = true
        StemCellsHaptics.play(.newWork)
        let store = session.store
        Task { @MainActor in
            let creation = await store.createStemCell()
            creating = false
            let rowId = "space:\(creation.spaceId)"
            session.selectedRowId = rowId
            sidebar.selectedRowId = rowId
            let chat = StemCellChatViewController(session: session, agentId: creation.agentId, title: Strings.StemCells.untitled, spaceId: creation.spaceId, stemCell: .stemCell(seed: creation.spaceId), creation: creation)
            navigationController?.pushViewController(chat, animated: true)
        }
    }

    // MARK: Menus

    private func menu(for row: StemCellsRow) -> UIMenu? {
        guard let session else { return nil }
        let store = session.store
        var items: [UIMenuElement] = []
        switch row.kind {
        case .section:
            items.append(UIAction(title: row.collapsed == true ? Strings.StemCells.unfold : Strings.StemCells.fold, image: StemCellsGlyphs.image(row.collapsed == true ? "chevron-down" : "chevron-right")) { [weak self] _ in self?.fold(row) })
            if let rename = renaming(row) {
                items.append(UIAction(title: rename.title, image: StemCellsGlyphs.image("pencil")) { [weak self] _ in
                    self?.sidebar.afterMenuCloses { rename.begin() }
                })
            }
        case .space:
            let openTitle = row.targetKind == "bot" ? Strings.StemCells.openBot : Strings.StemCells.open
            items.append(UIAction(title: openTitle, image: StemCellsGlyphs.image("open")) { [weak self] _ in self?.open(row) })
            // Opening comes first, then what the row shows under it.
            if row.hasHiddenSessions {
                items.append(UIAction(title: Strings.StemCells.showSubtasks, image: StemCellsGlyphs.image("eye")) { _ in Task { await store.revealSessions(row.nodeId, sessions: row.sessions) } })
            }
            if row.hasShownSessions {
                items.append(UIAction(title: Strings.StemCells.hideSubtasks, image: StemCellsGlyphs.image("eye-off")) { _ in Task { await store.hideSessions(row.nodeId) } })
            }
            if row.isHappy {
                items.append(UIMenu(options: .displayInline, children: [
                    UIAction(title: Strings.StemCells.tidyNow, image: StemCellsGlyphs.image("list")) { _ in Task { await store.tidy() } },
                ]))
                break
            }
            if let rename = renaming(row) {
                items.append(UIAction(title: rename.title, image: StemCellsGlyphs.image("pencil")) { [weak self] _ in
                    self?.sidebar.afterMenuCloses { rename.begin() }
                })
            }
            // HappyAgentSpacesSidebar's menus: new work closes from here and
            // only from here; other work is left or archived.
            let leaving = closing(row).map { act in
                UIAction(title: act.title, image: StemCellsGlyphs.image(act.icon), attributes: act.destructive ? .destructive : []) { _ in
                    StemCellsHaptics.play(.putAway)
                    act.run()
                }
            }
            if !leaving.isEmpty { items.append(UIMenu(options: .displayInline, children: leaving)) }
        case .session:
            items.append(UIAction(title: Strings.StemCells.open, image: StemCellsGlyphs.image("open")) { [weak self] _ in self?.open(row) })
        default:
            return nil
        }
        return UIMenu(children: items)
    }

    /// A row's rename, when it has one: a section's heading, a task's or a
    /// bot's name, never Happy's. It happens in the row itself.
    private func renaming(_ row: StemCellsRow) -> (title: String, begin: () -> Void)? {
        guard let store = session?.store, !row.isHappy else { return nil }
        switch row.kind {
        case .section:
            return (Strings.StemCells.renameSection, { [weak self] in
                self?.sidebar.beginRename(row.id, text: row.label) { label in Task { await store.relabel(row.nodeId, label: label) } }
            })
        case .space where row.targetKind == "task" || row.targetKind == "bot":
            guard let spaceId = row.spaceId else { return nil }
            return (row.targetKind == "bot" ? Strings.StemCells.renameBot : Strings.StemCells.renameTask, { [weak self] in
                let current = row.label == Strings.StemCells.untitled ? "" : row.label
                self?.sidebar.beginRename(row.id, text: current) { title in Task { await store.rename(spaceId, title: title) } }
            })
        default:
            return nil
        }
    }

    /// How a row's work is put away, as desktop offers it: new work nobody
    /// named closes; a task is left, and archived too when the person may;
    /// a bot is archived. Never Happy.
    private func closing(_ row: StemCellsRow) -> [(title: String, short: String, icon: String, destructive: Bool, run: () -> Void)] {
        guard let store = session?.store, row.kind == .space, !row.isHappy else { return [] }
        if row.isUntouchedStemCell, let spaceId = row.spaceId {
            return [(Strings.StemCells.closeNewWork, Strings.StemCells.swipeClose, "close", true, { Task { await store.discard(spaceId) } })]
        }
        guard let targetId = row.targetId else { return [] }
        switch row.targetKind {
        case "task":
            var acts: [(title: String, short: String, icon: String, destructive: Bool, run: () -> Void)] = [
                (Strings.StemCells.leaveTask, Strings.StemCells.swipeLeave, "close", false, { Task { await store.leave(taskId: targetId) } }),
            ]
            if row.canArchive {
                acts.append((Strings.StemCells.archiveTask, Strings.StemCells.swipeArchive, "archive", true, { Task { await store.archive(kind: "task", id: targetId) } }))
            }
            return acts
        case "bot":
            return [(Strings.StemCells.archiveBot, Strings.StemCells.swipeArchive, "archive", true, { Task { await store.archive(kind: "bot", id: targetId) } })]
        default:
            return []
        }
    }

    /// A row pulled open: Rename, then the one way it is put away (Archive
    /// where the person may, else Leave or Close).
    private func swipeActions(for row: StemCellsRow) -> [StemCellsSwipeAction] {
        var actions: [StemCellsSwipeAction] = []
        if let rename = renaming(row) {
            actions.append(StemCellsSwipeAction(title: Strings.StemCells.rename, destructive: false, identifier: "rename", handler: rename.begin))
        }
        if let away = closing(row).last {
            actions.append(StemCellsSwipeAction(title: away.short, destructive: away.destructive, identifier: away.short.lowercased(), handler: {
                StemCellsHaptics.play(.putAway)
                away.run()
            }))
        }
        return actions
    }

    // MARK: Carry

    private func beginDrag(_ row: StemCellsRow) -> StemCellsDrag? {
        guard let document = snapshot.document else { return nil }
        return StemCellsDrag(holding: row.id, drawn: Self.drawn(snapshot.rows), all: snapshot.allRows, document: document)
    }

    private func drop(_ drag: StemCellsDrag, to: Int) {
        guard let store = session?.store else { return }
        guard case .some(let after) = drag.after(to: to) else { return }
        inOrder { await store.move(drag.moving, after: after) }
    }

    private func dragging(_ active: Bool) {
        guard let store = session?.store else { return }
        inOrder {
            if active { await store.attentionInput() }
            await store.setDragging(active)
        }
    }

    /// Runs `work` after what the carry asked of the store before it: a
    /// drop's move reaches the store ahead of the carry's end.
    private func inOrder(_ work: @escaping @MainActor () async -> Void) {
        let previous = carryWork
        carryWork = Task { @MainActor in
            await previous?.value
            await work()
        }
    }
}

extension StemCellsHomeViewController: UIScrollViewDelegate {
    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        sidebar.closeSwipe(animated: true)
        // Scrolling is being in the list: Prioritizing's batches wait.
        if let store = session?.store { Task { await store.attentionInput() } }
    }
}

/// The note above the list: Prioritizing is off, with the one way to turn
/// it on, or the last thing the computer refused.
final class StemCellsBannerView: UIView {
    var onTurnOn: (() -> Void)?
    private let title = UILabel()
    private let detail = UILabel()
    private let button = UIButton(type: .system)
    private let card = UIView()
    private(set) var isEmpty = true

    override init(frame: CGRect) {
        super.init(frame: frame)
        card.backgroundColor = UIColor(Palette.stemCellsRowSelected)
        card.layer.cornerRadius = 12
        card.layer.cornerCurve = .continuous
        addSubview(card)
        title.font = StemCellsFonts.ui(.semiBold, size: 15)
        title.textColor = UIColor(Palette.stemCellsRowTextActive)
        detail.font = StemCellsFonts.ui(.regular, size: 14)
        detail.textColor = UIColor(Palette.stemCellsRowText)
        detail.numberOfLines = 0
        var configuration = UIButton.Configuration.filled()
        configuration.cornerStyle = .capsule
        configuration.baseBackgroundColor = UIColor(Palette.stemCellsRowTextActive)
        configuration.baseForegroundColor = UIColor(Palette.groupedBackground)
        configuration.attributedTitle = AttributedString(Strings.StemCells.turnOn, attributes: AttributeContainer([.font: StemCellsFonts.ui(.semiBold, size: 14)]))
        configuration.contentInsets = NSDirectionalEdgeInsets(top: 6, leading: 14, bottom: 6, trailing: 14)
        button.configuration = configuration
        button.addAction(UIAction { [weak self] _ in self?.onTurnOn?() }, for: .touchUpInside)
        for view in [title, detail, button] { card.addSubview(view) }
        isHidden = true
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    func configure(prioritizingOff: Bool, notice: String?) {
        isEmpty = !prioritizingOff && notice == nil
        isHidden = isEmpty
        button.isHidden = !prioritizingOff
        title.text = prioritizingOff ? Strings.StemCells.prioritizingOff : notice
        detail.text = prioritizingOff ? Strings.StemCells.prioritizingOffDetail : nil
        detail.isHidden = !prioritizingOff
        setNeedsLayout()
    }

    private func layout(width: CGFloat) -> StemCellsBannerLayout {
        StemCellsBannerLayout(
            width: width, title: title.measurable,
            detail: detail.isHidden ? nil : detail.measurable,
            button: button.isHidden ? nil : button.sizeThatFits(.zero)
        )
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        isEmpty ? .zero : layout(width: size.width).size
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = layout(width: bounds.width)
        card.frame = layout.card
        title.frame = layout.title
        detail.frame = layout.detail ?? .zero
        button.frame = layout.button ?? .zero
    }
}

/// No computer paired, or one too old: what to do about it.
final class StemCellsEmptyView: UIView {
    var onPair: (() -> Void)?
    private let mark = StemCellMarkView()
    private let label = UILabel()
    private let button = UIButton(type: .system)

    var message = "" { didSet { label.text = message; setNeedsLayout() } }
    var showsPair = true { didSet { button.isHidden = !showsPair } }

    override init(frame: CGRect) {
        super.init(frame: frame)
        mark.seed = "stem-cells"
        label.font = StemCellsFonts.ui(.medium, size: 16)
        label.textColor = UIColor(Palette.stemCellsRowText)
        label.textAlignment = .center
        label.numberOfLines = 0
        var configuration = UIButton.Configuration.filled()
        configuration.cornerStyle = .capsule
        configuration.baseBackgroundColor = UIColor(Palette.stemCellsRowTextActive)
        configuration.baseForegroundColor = UIColor(Palette.groupedBackground)
        configuration.attributedTitle = AttributedString(Strings.StemCells.pairComputer, attributes: AttributeContainer([.font: StemCellsFonts.ui(.semiBold, size: 16)]))
        configuration.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 22, bottom: 12, trailing: 22)
        button.configuration = configuration
        button.addAction(UIAction { [weak self] _ in self?.onPair?() }, for: .touchUpInside)
        for view in [mark, label, button] { addSubview(view) }
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        let layout = StemCellsEmptyLayout(size: bounds.size, label: label.measurable, button: button.isHidden ? nil : button.sizeThatFits(.zero))
        mark.frame = layout.mark
        label.frame = layout.label
        button.frame = layout.button ?? .zero
    }
}
#endif
