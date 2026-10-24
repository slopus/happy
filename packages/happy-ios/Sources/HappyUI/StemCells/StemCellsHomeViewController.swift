#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Home in Stem Cells mode: one paired computer's sidebar, as desktop's
/// `HappyAgentSpacesSidebar` draws it, under home's header and over the
/// dock. The dock's field stays; tapping it makes new work.
final class StemCellsHomeViewController: UIViewController {
    private let context: AppContext
    /// The computer this screen always shows; nil to follow the choice.
    private let fixedComputer: String?
    private let sidebar = StemCellsSidebarView()
    private let banner = StemCellsBannerView()
    private let empty = StemCellsEmptyView()
    let dockView = HomeDockView()
    private let dockText = HomeDockTextStore()
    private var session: StemCellsSession?
    private var watch: StemCellsWatch?
    private var accountsObservation: AccountsObservation?
    private var snapshot = StemCellsSnapshot()
    private var creating = false

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
        sidebar.delegate = self
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
        session = id.flatMap { StemCellsSession.session(for: $0, context: context) }
        sidebar.images = session?.images
        sidebar.apply([])
        snapshot = StemCellsSnapshot()
        if let session {
            sidebar.selectedRowId = session.selectedRowId
            watch = session.watch { [weak self] snapshot in self?.apply(snapshot) }
        }
        applyChrome()
    }

    private func apply(_ snapshot: StemCellsSnapshot) {
        let previous = self.snapshot
        self.snapshot = snapshot
        onSnapshot?(snapshot)
        if previous.rows != snapshot.rows { sidebar.apply(snapshot.rows) }
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
        view.setNeedsLayout()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let bounds = view.bounds
        dockText.prepare(HomeDockController.textKey(width: bounds.width, text: TextEnvironment(traitCollection)))
        let bannerHeight = banner.isEmpty ? 0 : banner.sizeThatFits(CGSize(width: bounds.width, height: .greatestFiniteMagnitude)).height
        banner.frame = CGRect(x: 0, y: contentInsets.contentTop, width: bounds.width, height: bannerHeight)
        sidebar.frame = bounds
        let top = contentInsets.contentTop + bannerHeight
        let insets = UIEdgeInsets(top: top, left: 0, bottom: contentInsets.listBottom, right: 0)
        if sidebar.contentInset != insets {
            let atTop = sidebar.contentOffset.y <= -sidebar.contentInset.top + 1
            sidebar.contentInset = insets
            sidebar.verticalScrollIndicatorInsets = UIEdgeInsets(top: contentInsets.chromeTop, left: 0, bottom: contentInsets.listBottom, right: 0)
            if atTop { sidebar.contentOffset.y = -insets.top }
        }
        empty.frame = bounds.inset(by: UIEdgeInsets(top: contentInsets.contentTop, left: 0, bottom: contentInsets.listBottom, right: 0))
        dockView.frame = bounds
    }

    // MARK: Acts

    private func open(_ row: StemCellsRow) {
        guard let session else { return }
        Task { await session.store.attentionInput() }
        switch row.kind {
        case .search:
            navigationController?.pushViewController(StemCellsSearchViewController(session: session, onOpen: { [weak self] row in self?.open(row) }), animated: true)
        case .create:
            makeNewWork()
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
        Task { await store.attentionInput(); await store.fold(row.nodeId) }
    }

    /// New work, right below Happy: the row and its empty conversation exist
    /// at once, and the conversation opens on the intro with the composer up.
    func makeNewWork() {
        guard let session, !creating, navigationController?.topViewController === parent || navigationController?.topViewController === self else { return }
        creating = true
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
            items.append(UIAction(title: row.collapsed == true ? Strings.StemCells.unfold : Strings.StemCells.fold, image: UIImage(systemName: row.collapsed == true ? "chevron.down" : "chevron.right")) { [weak self] _ in self?.fold(row) })
            items.append(UIAction(title: Strings.StemCells.renameSection, image: UIImage(systemName: "pencil")) { [weak self] _ in
                self?.rename(current: row.label) { label in Task { await store.relabel(row.nodeId, label: label) } }
            })
        case .space:
            let openTitle = row.targetKind == "bot" ? Strings.StemCells.openBot : Strings.StemCells.open
            items.append(UIAction(title: openTitle, image: UIImage(systemName: "arrow.up.forward.square")) { [weak self] _ in self?.open(row) })
            if row.isHappy {
                items.append(UIMenu(options: .displayInline, children: [
                    UIAction(title: Strings.StemCells.tidyNow, image: UIImage(systemName: "list.bullet")) { _ in Task { await store.tidy() } },
                ]))
                break
            }
            if let spaceId = row.spaceId, row.targetKind == "task" || row.targetKind == "bot" {
                items.append(UIAction(title: row.targetKind == "bot" ? Strings.StemCells.renameBot : Strings.StemCells.renameTask, image: UIImage(systemName: "pencil")) { [weak self] _ in
                    self?.rename(current: row.label == Strings.StemCells.untitled ? "" : row.label) { title in Task { await store.rename(spaceId, title: title) } }
                })
            }
            // HappyAgentSpacesSidebar's menus: new work closes from here and
            // only from here; other work is left or archived.
            if row.isUntouchedStemCell, let spaceId = row.spaceId {
                items.append(UIMenu(options: .displayInline, children: [
                    UIAction(title: Strings.StemCells.closeNewWork, image: UIImage(systemName: "xmark"), attributes: .destructive) { _ in Task { await store.discard(spaceId) } },
                ]))
            } else if let targetId = row.targetId, row.targetKind == "task" {
                var leaving: [UIMenuElement] = [
                    UIAction(title: Strings.StemCells.leaveTask, image: UIImage(systemName: "xmark")) { _ in Task { await store.leave(taskId: targetId) } },
                ]
                if row.canArchive {
                    leaving.append(UIAction(title: Strings.StemCells.archiveTask, image: UIImage(systemName: "archivebox"), attributes: .destructive) { _ in Task { await store.archive(kind: "task", id: targetId) } })
                }
                items.append(UIMenu(options: .displayInline, children: leaving))
            } else if let targetId = row.targetId, row.targetKind == "bot" {
                items.append(UIMenu(options: .displayInline, children: [
                    UIAction(title: Strings.StemCells.archiveBot, image: UIImage(systemName: "archivebox"), attributes: .destructive) { _ in Task { await store.archive(kind: "bot", id: targetId) } },
                ]))
            }
        case .session:
            items.append(UIAction(title: Strings.StemCells.open, image: UIImage(systemName: "arrow.up.forward.square")) { [weak self] _ in self?.open(row) })
        default:
            return nil
        }
        return UIMenu(children: items)
    }

    private func rename(current: String, _ done: @escaping (String) -> Void) {
        let alert = UIAlertController(title: Strings.StemCells.rename, message: nil, preferredStyle: .alert)
        alert.addTextField { field in field.text = current; field.autocapitalizationType = .sentences; field.clearButtonMode = .whileEditing }
        alert.addAction(UIAlertAction(title: Strings.StemCells.cancel, style: .cancel))
        alert.addAction(UIAlertAction(title: Strings.StemCells.save, style: .default) { [weak alert] _ in
            let text = alert?.textFields?.first?.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !text.isEmpty { done(text) }
        })
        present(alert, animated: true)
    }
}

extension StemCellsHomeViewController: UIScrollViewDelegate {
    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
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

    private var metrics: (inset: CGFloat, padding: CGFloat) { (StemCellsMetrics.inset + 4, 14) }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        guard !isEmpty else { return .zero }
        let width = size.width - 2 * metrics.inset - 2 * metrics.padding
        let buttonWidth = button.isHidden ? 0 : button.sizeThatFits(.zero).width + 12
        let titleHeight = title.sizeThatFits(CGSize(width: width - buttonWidth, height: .greatestFiniteMagnitude)).height
        let detailHeight = detail.isHidden ? 0 : detail.sizeThatFits(CGSize(width: width - buttonWidth, height: .greatestFiniteMagnitude)).height + 2
        return CGSize(width: size.width, height: titleHeight + detailHeight + 2 * metrics.padding + 8)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let (inset, padding) = metrics
        card.frame = CGRect(x: inset, y: 0, width: bounds.width - 2 * inset, height: max(0, bounds.height - 8))
        let buttonSize = button.isHidden ? .zero : button.sizeThatFits(.zero)
        let textWidth = card.bounds.width - 2 * padding - (button.isHidden ? 0 : buttonSize.width + 12)
        let titleHeight = title.sizeThatFits(CGSize(width: textWidth, height: .greatestFiniteMagnitude)).height
        title.frame = CGRect(x: padding, y: padding, width: textWidth, height: titleHeight)
        let detailHeight = detail.isHidden ? 0 : detail.sizeThatFits(CGSize(width: textWidth, height: .greatestFiniteMagnitude)).height
        detail.frame = CGRect(x: padding, y: title.frame.maxY + 2, width: textWidth, height: detailHeight)
        button.frame = CGRect(x: card.bounds.width - padding - buttonSize.width, y: (card.bounds.height - buttonSize.height) / 2, width: buttonSize.width, height: buttonSize.height)
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
        let width = min(bounds.width - 48, 360)
        let labelHeight = label.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        let buttonSize = button.isHidden ? .zero : button.sizeThatFits(.zero)
        let total = 64 + 20 + labelHeight + (button.isHidden ? 0 : 24 + buttonSize.height)
        var y = (bounds.height - total) / 2
        mark.frame = CGRect(x: (bounds.width - 64) / 2, y: y, width: 64, height: 64)
        y += 84
        label.frame = CGRect(x: (bounds.width - width) / 2, y: y, width: width, height: labelHeight)
        y += labelHeight + 24
        button.frame = CGRect(x: (bounds.width - buttonSize.width) / 2, y: y, width: buttonSize.width, height: buttonSize.height)
    }
}
#endif
