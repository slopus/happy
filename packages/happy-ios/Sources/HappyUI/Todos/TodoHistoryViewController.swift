#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Who changed what on one todo: its permanent revisions, newest first,
/// each with the person or agent that made it, what it did and when.
/// Read from the computer; the face and name are a document history's.
@MainActor
final class TodoHistoryViewController: UITableViewController {
    private let session: Session
    private let surfaceId: String
    private let todo: TodoItem
    private(set) var rows: [(revision: TodoRevision, change: TodoRevision.Change)] = []
    private var names: [String: String] = [:]
    private let empty = UILabel()

    init(session: Session, surfaceId: String, todo: TodoItem) {
        self.session = session
        self.surfaceId = surfaceId
        self.todo = todo
        super.init(style: .insetGrouped)
        navigationItem.title = Strings.Todos.historyTitle
        navigationItem.subtitle = todo.heading ?? todo.text
        navigationItem.largeTitleDisplayMode = .never
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.groupedGround)
        tableView.backgroundColor = UIColor(Palette.groupedGround)
        tableView.register(DocumentHistoryCell.self, forCellReuseIdentifier: DocumentHistoryCell.reuse)
        tableView.accessibilityIdentifier = "todo.history"
        tableView.allowsSelection = false
        empty.text = Strings.Todos.historyLoading
        empty.textAlignment = .center
        empty.numberOfLines = 0
        empty.textColor = UIColor(Palette.settingsSecondary)
        empty.font = .preferredFont(forTextStyle: .subheadline)
        empty.adjustsFontForContentSizeCategory = true
        tableView.backgroundView = empty
        load()
    }

    private func load() {
        let library = session.engine.todos
        let surfaceId = surfaceId, todoId = todo.id
        Task { [weak self] in
            let read = try? await library.history(surfaceId, todoId)
            guard let self else { return }
            let revisions = read?.revisions ?? []
            rows = Array(zip(revisions, TodoRevision.changes(revisions)).reversed()).map { ($0.0, $0.1) }
            names = read?.names ?? [:]
            empty.text = read == nil ? Strings.Todos.historyUnavailable : Strings.Todos.historyEmpty
            tableView.backgroundView?.isHidden = !rows.isEmpty
            tableView.reloadData()
        }
    }

    /// Who made a revision: the person, with "An agent" when an agent did
    /// it for them.
    private func actor(_ revision: TodoRevision) -> String {
        let person = revision.userId.flatMap { names[$0] }
        let agent = revision.agentId != nil || revision.source == "tool"
        switch (person, agent) {
        case (let name?, false): return name
        case (let name?, true): return "\(name) · \(Strings.Todos.agent)"
        case (nil, true): return Strings.Todos.agent
        case (nil, false): return Strings.Todos.someone
        }
    }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { rows.count }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: DocumentHistoryCell.reuse, for: indexPath) as! DocumentHistoryCell
        let row = rows[indexPath.row]
        let when = Date(timeIntervalSince1970: row.revision.todo.updatedAt / 1000).formatted(date: .abbreviated, time: .shortened)
        cell.show(title: actor(row.revision), detail: "\(Strings.Todos.change(row.change)) · \(when)", face: nil, seed: row.revision.userId ?? row.revision.agentId ?? "someone")
        cell.accessoryType = .none
        cell.accessibilityTraits = .staticText
        cell.accessibilityIdentifier = "todo.history.\(indexPath.row)"
        return cell
    }
}
#endif
