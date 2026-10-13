#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyWire
import UIKit

/// The home session list (SessionsList.tsx, flat grouping) in a
/// UITableView: live sessions by activity, the archive toggle, and the
/// archive by day when shown. The offline plaque heads the table while
/// every computer is offline. Rows open nothing yet: chat is not ported, so
/// a tap only marks the session read.
final class SessionListViewController: UIViewController, UITableViewDelegate {
    private enum ItemID: Hashable {
        case session(String)
        case archiveToggle
        case day(Int)
    }

    private let session: AccountSession
    private(set) var list: SessionList
    private var offline: [MachineChoice]?
    private let tableView = UITableView(frame: .zero, style: .plain)
    private var dataSource: UITableViewDiffableDataSource<Int, ItemID>!
    private var items: [ItemID: SessionList.Item] = [:]
    private let sizingRow = SessionRowCell(style: .default, reuseIdentifier: nil)
    private let sizingDay = SessionDayHeaderCell(style: .default, reuseIdentifier: nil)
    private let sizingToggle = ArchiveToggleCell(style: .default, reuseIdentifier: nil)
    private var plaque: ItemGroupView?

    init(session: AccountSession, list: SessionList, offline: [MachineChoice]?) {
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
        tableView.backgroundColor = UIColor(Palette.flatListBackground)
        tableView.separatorStyle = .none
        tableView.delegate = self
        tableView.register(SessionRowCell.self, forCellReuseIdentifier: SessionRowCell.reuseIdentifier)
        tableView.register(SessionDayHeaderCell.self, forCellReuseIdentifier: SessionDayHeaderCell.reuseIdentifier)
        tableView.register(ArchiveToggleCell.self, forCellReuseIdentifier: ArchiveToggleCell.reuseIdentifier)
        dataSource = UITableViewDiffableDataSource(tableView: tableView) { [weak self] tableView, indexPath, id in
            self?.cell(tableView, indexPath, id) ?? UITableViewCell()
        }
        dataSource.defaultRowAnimation = .fade
        let longPress = UILongPressGestureRecognizer(target: self, action: #selector(longPressed(_:)))
        tableView.addGestureRecognizer(longPress)
        apply(animated: false)
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

    private func apply(animated: Bool) {
        var ids: [ItemID] = []
        var next: [ItemID: SessionList.Item] = [:]
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
            next[id] = item
        }
        let changed = ids.filter { id in items[id].map { $0 != next[id] } ?? false }
        items = next

        var snapshot = NSDiffableDataSourceSnapshot<Int, ItemID>()
        snapshot.appendSections([0])
        snapshot.appendItems(ids)
        snapshot.reconfigureItems(changed.filter { dataSource.snapshot().itemIdentifiers.contains($0) })
        dataSource.apply(snapshot, animatingDifferences: animated)
        updatePlaque()
    }

    private func cell(_ tableView: UITableView, _ indexPath: IndexPath, _ id: ItemID) -> UITableViewCell? {
        switch items[id] {
        case .session(let row)?:
            let cell = tableView.dequeueReusableCell(withIdentifier: SessionRowCell.reuseIdentifier, for: indexPath) as? SessionRowCell
            cell?.configure(row, style: list.avatarStyle, monochrome: list.avatarMonochrome)
            return cell
        case .archiveToggle(let hidden)?:
            let cell = tableView.dequeueReusableCell(withIdentifier: ArchiveToggleCell.reuseIdentifier, for: indexPath) as? ArchiveToggleCell
            cell?.configure(hidden: hidden)
            return cell
        case .dayHeader(let age)?:
            let cell = tableView.dequeueReusableCell(withIdentifier: SessionDayHeaderCell.reuseIdentifier, for: indexPath) as? SessionDayHeaderCell
            cell?.configure(age)
            return cell
        case nil:
            return nil
        }
    }

    // MARK: Offline plaque

    /// OfflineMachinesBanner.tsx: a quiet plaque heading the list.
    private func updatePlaque() {
        guard let offline, !offline.isEmpty else {
            plaque = nil
            tableView.tableHeaderView = nil
            return
        }
        let title = offline.count == 1
            ? Strings.Troubleshoot.bannerTitleOne(name: offline[0].name)
            : Strings.Troubleshoot.bannerTitleMany
        let row = ItemRowView(
            title: title,
            subtitle: Strings.Troubleshoot.bannerSubtitle,
            icon: ItemIcon("exclamationmark.triangle", tint: Palette.warningText)
        ) { [weak self] in
            self?.openTroubleshoot()
        }
        let group = plaque ?? ItemGroupView(rows: [])
        group.rows = [row]
        group.untitledPaddingTop = 4
        group.paddingBottom = 16
        plaque = group
        tableView.tableHeaderView = group
        sizeHeader()
    }

    private func sizeHeader() {
        guard let plaque, tableView.tableHeaderView === plaque else { return }
        let height = plaque.sizeThatFits(CGSize(width: tableView.bounds.width, height: .greatestFiniteMagnitude)).height
        if plaque.frame.size != CGSize(width: tableView.bounds.width, height: height) {
            plaque.frame = CGRect(x: 0, y: 0, width: tableView.bounds.width, height: height)
            tableView.tableHeaderView = plaque
        }
    }

    private func openTroubleshoot() {
        navigationController?.pushViewController(TroubleshootViewController(session: session), animated: true)
    }

    // MARK: Delegate

    func tableView(_ tableView: UITableView, heightForRowAt indexPath: IndexPath) -> CGFloat {
        guard let id = dataSource.itemIdentifier(for: indexPath), let item = items[id] else { return 0 }
        let width = tableView.bounds.width
        let fit = CGSize(width: width, height: .greatestFiniteMagnitude)
        switch item {
        case .session(let row):
            sizingRow.configure(row, style: list.avatarStyle, monochrome: list.avatarMonochrome)
            return sizingRow.sizeThatFits(fit).height
        case .dayHeader(let age):
            sizingDay.configure(age)
            return sizingDay.sizeThatFits(fit).height
        case .archiveToggle(let hidden):
            sizingToggle.configure(hidden: hidden)
            return sizingToggle.sizeThatFits(fit).height
        }
    }

    func tableView(_ tableView: UITableView, shouldHighlightRowAt indexPath: IndexPath) -> Bool {
        guard let id = dataSource.itemIdentifier(for: indexPath) else { return false }
        if case .day = id { return false }
        return true
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        guard let id = dataSource.itemIdentifier(for: indexPath) else { return }
        switch items[id] {
        case .session(let row)?:
            session.actions.markRead(sessionId: row.id)
        case .archiveToggle(let hidden)?:
            session.updateSettings(["hideInactiveSessions": .bool(!hidden)])
        default:
            break
        }
    }

    /// FlatSessionRow.tsx's swipe: "Archive Session" on red.
    func tableView(_ tableView: UITableView, trailingSwipeActionsConfigurationForRowAt indexPath: IndexPath) -> UISwipeActionsConfiguration? {
        guard let id = dataSource.itemIdentifier(for: indexPath), case .session(let row)? = items[id], !row.archived else { return nil }
        let action = UIContextualAction(style: .destructive, title: Strings.SessionInfo.archiveSession) { [weak self] _, _, done in
            done(true)
            self?.archive(row.id)
        }
        action.image = .symbol("archivebox", pointSize: 20)
        action.backgroundColor = UIColor(Palette.statusError)
        let configuration = UISwipeActionsConfiguration(actions: [action])
        configuration.performsFirstActionWithFullSwipe = false
        return configuration
    }

    /// useSessionActionAlert: the "Session" alert on a long press. Only
    /// Archive is ported; details, resume and fork need screens that are not
    /// here yet.
    @objc private func longPressed(_ gesture: UILongPressGestureRecognizer) {
        guard gesture.state == .began,
              let indexPath = tableView.indexPathForRow(at: gesture.location(in: tableView)),
              let id = dataSource.itemIdentifier(for: indexPath),
              case .session(let row)? = items[id]
        else { return }
        let alert = UIAlertController(title: Strings.Session.actionsTitle, message: nil, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: Strings.Session.archiveAction, style: .destructive) { [weak self] _ in
            self?.archive(row.id)
        })
        alert.addAction(UIAlertAction(title: Strings.Common.cancel, style: .cancel))
        present(alert, animated: true)
    }

    private func archive(_ sessionId: String) {
        let actions = session.actions
        Task { @MainActor [weak self] in
            do {
                try await actions.archive(sessionId: sessionId)
            } catch {
                guard let self else { return }
                let message = (error as? SessionActionError) == .botNeedsMachine
                    ? Strings.SessionInfo.botNeedsMachine
                    : Strings.SessionInfo.failedToArchiveSession
                Alerts.show(Strings.Common.error, message, on: self)
            }
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
