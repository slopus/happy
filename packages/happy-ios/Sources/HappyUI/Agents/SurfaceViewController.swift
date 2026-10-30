#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// A Surface on the phone, kept minimal: a todo list shows its todos live
/// and takes a new one; a document shows its Markdown, read-only; any other
/// kind says to open it on the computer. Desktop's editors stay desktop's.
final class SurfaceViewController: UIViewController {
    private let session: Session
    private let surfaceId: String
    private let type: String

    private let scrollView = UIScrollView()
    private let field = UITextField()
    private let empty = UILabel()
    private var rows: [String: TodoRowView] = [:]
    private var todos: [AgentWire.Todo] = []
    private var document: ChatPlanView?
    private var documentPlan: ChatRowPlan?
    private var documentText: String?
    private var following: Task<Void, Never>?
    private var watch: Watch?

    init(session: Session, surface: AgentWire.Surface) {
        self.session = session
        surfaceId = surface.id
        type = surface.type
        super.init(nibName: nil, bundle: nil)
        title = surface.name
        navigationItem.largeTitleDisplayMode = .never
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(Palette.surface)
        scrollView.alwaysBounceVertical = true
        scrollView.keyboardDismissMode = .interactive
        view.addSubview(scrollView)
        empty.font = Fonts.ui(.regular, size: 15)
        empty.textColor = UIColor(Palette.rowText)
        empty.textAlignment = .center
        empty.numberOfLines = 0
        scrollView.addSubview(empty)
        switch type {
        case "todo":
            field.placeholder = Strings.addTodo
            field.font = Fonts.ui(.regular, size: 16)
            field.backgroundColor = UIColor(Palette.button)
            field.layer.cornerRadius = 10
            field.layer.cornerCurve = .continuous
            field.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 12, height: 1))
            field.leftViewMode = .always
            field.returnKeyType = .done
            field.accessibilityIdentifier = "todo-field"
            field.addAction(UIAction { [weak self] _ in self?.add() }, for: .editingDidEndOnExit)
            scrollView.addSubview(field)
            empty.text = Strings.noTodos
            let events = session.store
            let surfaceId = surfaceId
            following = Task { [weak self] in
                let stream = await events.conversationEvents(surfaceId)
                await self?.reload()
                for await _ in stream { await self?.reload() }
            }
        case "document":
            let refresh = UIRefreshControl()
            refresh.addAction(UIAction { [weak self, weak refresh] _ in
                Task { await self?.reload(); refresh?.endRefreshing() }
            }, for: .valueChanged)
            scrollView.refreshControl = refresh
            Task { await reload() }
        default:
            empty.text = Strings.openOnComputer
        }
        watch = session.watch { [weak self] snapshot in
            guard let self, let row = snapshot.allRows.first(where: { $0.targetKind == "surface" && $0.targetId == self.surfaceId }) else { return }
            if title != row.label { title = row.label }
        }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setNavigationBarHidden(false, animated: animated)
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isMovingFromParent || navigationController == nil {
            following?.cancel()
            watch?.invalidate()
        }
    }

    // MARK: Reads

    private func reload() async {
        let client = session.client
        let surfaceId = surfaceId
        switch type {
        case "todo":
            guard let todos = try? await client.todos(surfaceId) else { return }
            show(todos)
        case "document":
            guard let text = try? await client.document(surfaceId) else { return }
            await show(document: text)
        default:
            break
        }
    }

    private func show(_ todos: [AgentWire.Todo]) {
        guard todos != self.todos || rows.isEmpty != todos.isEmpty else { return }
        self.todos = todos
        var seen = Set<String>()
        for todo in todos {
            seen.insert(todo.id)
            let row = rows[todo.id] ?? {
                let row = TodoRowView()
                scrollView.addSubview(row)
                rows[todo.id] = row
                return row
            }()
            row.configure(todo)
        }
        for (id, row) in rows where !seen.contains(id) {
            row.removeFromSuperview()
            rows.removeValue(forKey: id)
        }
        view.setNeedsLayout()
    }

    /// The Markdown planned off the main thread, as a conversation's agent text.
    private func show(document text: String) async {
        documentText = text
        let width = view.bounds.width
        guard width > 0 else { view.setNeedsLayout(); return }
        let key = ChatPlanner.Key(width: width, maxContentWidth: ContentWidth.maxWidth, environment: traitCollection.textEnvironment)
        let syntax = session.syntax
        let item = ChatItem(id: "document:\(surfaceId)", role: .agent, pieces: [.text(text)], delivery: .sent)
        let plan = await Task.detached { ChatPlanner.plan(item, key: key, copied: false, syntax: syntax) }.value
        documentPlan = plan
        let planView = document ?? {
            let planView = ChatPlanView()
            planView.drawsStaticContent = true
            planView.isAccessibilityElement = true
            planView.accessibilityIdentifier = "document"
            scrollView.addSubview(planView)
            document = planView
            return planView
        }()
        planView.apply(plan)
        planView.accessibilityLabel = text
        empty.text = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? Strings.emptyDocument : nil
        view.setNeedsLayout()
    }

    // MARK: Acts

    private func add() {
        let text = field.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !text.isEmpty else { return }
        field.text = ""
        let client = session.client
        let surfaceId = surfaceId
        Task { [weak self] in
            try? await client.addTodo(surfaceId, id: ClientID.make(), text: text)
            await self?.reload()
        }
    }

    // MARK: Layout

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        scrollView.frame = view.bounds
        let width = view.bounds.width
        switch type {
        case "todo":
            let layout = TodoLayout(width: width, todos: todos.map { rows[$0.id]?.textMeasurable ?? Measurable.fixed(width: 0, height: 0) }, empty: empty.measurable)
            field.frame = layout.field
            for (index, todo) in todos.enumerated() {
                guard let row = rows[todo.id] else { continue }
                row.frame = layout.rows[index].frame
                row.place(layout.rows[index])
            }
            empty.isHidden = layout.empty == nil
            empty.frame = layout.empty ?? .zero
            scrollView.contentSize = CGSize(width: width, height: layout.contentHeight)
        case "document":
            if let documentPlan, documentPlan.size.width != width, let documentText {
                Task { await show(document: documentText) }
            }
            let showsEmpty = empty.text != nil
            let body = showsEmpty ? empty.measurable : Measurable.fixed(width: width, height: documentPlan?.size.height ?? 0)
            let layout = SurfaceBodyLayout(width: width, body: body, inset: showsEmpty ? 16 : 0)
            document?.setLayoutFrame(showsEmpty ? .zero : layout.body)
            empty.isHidden = !showsEmpty
            empty.frame = showsEmpty ? layout.body : .zero
            scrollView.contentSize = CGSize(width: width, height: layout.contentHeight)
        default:
            let layout = SurfaceBodyLayout(width: width, body: empty.measurable, inset: 16)
            empty.frame = layout.body
            scrollView.contentSize = CGSize(width: width, height: layout.contentHeight)
        }
    }
}

/// One todo: its box, ticked once done, and its text, faded and struck through then.
final class TodoRowView: UIView {
    private let box = IconView(nil, size: 20, tint: Palette.rowText)
    private let label = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)
        label.numberOfLines = 0
        addSubview(box)
        addSubview(label)
        isAccessibilityElement = true
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    var textMeasurable: Measurable { label.measurable }

    func configure(_ todo: AgentWire.Todo) {
        let done = todo.status == "completed"
        box.icon = done ? .ionicons("checkmark-circle") : .ionicons("ellipse-outline")
        var attributes: [NSAttributedString.Key: Any] = [
            .font: Fonts.ui(.regular, size: 16),
            .foregroundColor: UIColor(done ? Palette.rowText : Palette.text),
        ]
        if done { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
        label.attributedText = NSAttributedString(string: todo.text, attributes: attributes)
        accessibilityLabel = todo.text
        accessibilityValue = done ? Strings.todoDone : nil
        accessibilityIdentifier = "todo"
    }

    func place(_ layout: TodoLayout.Row) {
        box.frame = layout.box
        label.frame = layout.text
    }
}
#endif
