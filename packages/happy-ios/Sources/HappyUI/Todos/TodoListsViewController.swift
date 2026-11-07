#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit
import UltraView

/// Home's Todos row: the computer's todo lists in one of home's grouped
/// cards, by name, with how many todos each has left. It opens on the
/// catalog kept on the phone (`SurfaceCatalogFeed`), reads it again, then
/// follows its events. The bar's + makes a todo
/// list or a document, named in an alert, and opens it.
final class TodoListsViewController: UIViewController {
    private let session: Session
    private let feed: SurfaceCatalogFeed
    private let library: TodoLibrary
    let list = CardListView()
    private(set) lazy var newItem = UIBarButtonItem(image: .icon(.ionicons("add"), size: 26), menu: newMenu())
    private var pipeline: ApplyPipeline<TodoListsInput, Applied, Output>?
    private var headerWatch: Watch?
    private var accessWatch: Watch?
    private var following: Task<Void, Never>?
    /// The Surfaces the rows on screen show, by ID.
    private(set) var surfaces: [String: AgentWire.Surface] = [:]
    /// The catalog as last read, for counting again.
    private var catalog = SurfaceCatalogFeed.State()
    /// A name is being sent to the computer.
    private var creating = false

    struct Applied: Sendable {
        var items: [String: CardItem] = [:]
        var order: [String] = []
        var counter: UInt64 = 0
    }

    struct Output: Sendable {
        var items: [CardItem]
        var surfaces: [String: AgentWire.Surface]
        var width: CGFloat
        /// The rows at another width, for a width change (`CardListView.replan`).
        var replan: @Sendable (CGFloat) -> [CardItem]
    }

    init(session: Session) {
        self.session = session
        feed = SurfaceCatalogFeed(engine: session.engine)
        library = session.engine.todos
        super.init(nibName: nil, bundle: nil)
        title = Strings.Todos.title
        navigationItem.largeTitleDisplayMode = .never
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    // Not `isolated deinit` (see `Watch`).
    deinit {
        following?.cancel()
        pipeline?.cancel()
        Task { [feed] in await feed.stop() }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        followsTextSize()
        view.backgroundColor = UIColor(Palette.groupedGround)
        view.accessibilityIdentifier = "todo-lists"
        list.accessibilityIdentifier = "todo-lists-list"
        view.addSubview(list)
        list.onSelect = { [weak self] id in self?.open(id) }
        HeaderBar.edge(list.edge, in: self)
        newItem.accessibilityLabel = Strings.Todos.new
        newItem.accessibilityIdentifier = "todo-lists-new"
        // A role that can't write content makes nothing here.
        let showNew = { [weak self] in
            guard let self else { return }
            navigationItem.rightBarButtonItem = session.gate.allows(.contentWrite) ? newItem : nil
        }
        showNew()
        accessWatch = session.watchAccess(showNew)

        let pipeline = ApplyPipeline<TodoListsInput, Applied, Output>(
            input: currentInput(),
            state: Applied(),
            derive: { input, applied in Self.derive(input, applied: applied) },
            apply: { [weak self] output in self?.show(output) ?? false }
        )
        self.pipeline = pipeline
        following = Task { [feed, weak self, weak pipeline] in
            let states = await feed.states()
            Task { await feed.start() }
            for await state in states {
                guard !Task.isCancelled else { return }
                pipeline?.update { $0.state = state }
                self?.catalog = state
                await self?.countOutstanding(state)
            }
        }
        registerForTraitChanges(UIView.textSizeTraits + [UITraitUserInterfaceStyle.self, UITraitDisplayScale.self]) { (self: Self, _) in
            self.updateInput()
        }
        headerWatch = session.watchHeader { [weak self] state in
            self?.navigationItem.title = Strings.HeaderStatus.title(state) ?? Strings.Todos.title
        }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // A list opened from here may have fewer left by now.
        let state = catalog
        Task { await countOutstanding(state) }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        list.maxWidth = ContentWidth.maxWidth
        list.frame = view.bounds
        let safe = view.safeAreaInsets
        list.setInsets(UIEdgeInsets(top: safe.top + CardListMetrics.contentTop, left: 0, bottom: safe.bottom + CardListMetrics.contentBottom, right: 0))
        updateInput()
    }

    // MARK: Derivation

    private func currentInput() -> TodoListsInput {
        var input = TodoListsInput()
        input.width = list.contentWidth
        input.scale = traitCollection.textEnvironment?.scale.multiplier ?? 1
        input.displayScale = traitCollection.displayScale > 0 ? traitCollection.displayScale : 2
        input.dark = traitCollection.userInterfaceStyle == .dark
        return input
    }

    private func updateInput() {
        let next = currentInput()
        pipeline?.update { input in
            input.width = next.width
            input.scale = next.scale
            input.displayScale = next.displayScale
            input.dark = next.dark
        }
    }

    /// How many todos each list has left, from the lists open on the
    /// phone or kept on it; a list never opened here shows none.
    private func countOutstanding(_ state: SurfaceCatalogFeed.State) async {
        let counts = await library.outstanding(state.of("todo").map(\.id))
        pipeline?.update { $0.outstanding = counts }
    }

    nonisolated static func derive(_ input: TodoListsInput, applied: Applied) -> (output: Output, state: Applied)? {
        let next = TodoListsItems.items(input)
        var counter = applied.counter
        let items = CardItems.revise(next, previous: applied.items, counter: &counter)
        let order = items.map(\.id)
        let unchanged = order == applied.order && items.allSatisfy { applied.items[$0.id]?.revision == $0.revision }
        guard !unchanged else { return nil }
        let surfaces = Dictionary(input.state.of("todo").map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let state = Applied(items: Dictionary(items.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first }), order: order, counter: counter)
        let replan: @Sendable (CGFloat) -> [CardItem] = { width in
            var input = input
            input.width = width
            return TodoListsItems.items(input)
        }
        return (Output(items: items, surfaces: surfaces, width: input.width, replan: replan), state)
    }

    private func show(_ output: Output) -> Bool {
        guard output.width == list.contentWidth else { return false }
        surfaces = output.surfaces
        list.apply(output.items, animated: true, replan: output.replan)
        return true
    }

    // MARK: Acts

    private func open(_ id: String) {
        guard let surface = surfaces[id] else { return }
        navigationController?.pushViewController(SurfaceScreens.make(session: session, surface: surface), animated: true)
    }

    private func newMenu() -> UIMenu {
        UIMenu(children: [
            UIAction(title: Strings.Todos.newList, image: .icon(.ionicons("checkbox-outline"), size: 20)) { [weak self] _ in self?.askName(type: "todo") },
            UIAction(title: Strings.Todos.newDocument, image: .icon(.ionicons("document-text-outline"), size: 20)) { [weak self] _ in self?.askName(type: "document") },
        ])
    }

    /// Asks the new Surface's name; Create stays off while it's blank.
    func askName(type: String) {
        let alert = UIAlertController(title: type == "todo" ? Strings.Todos.newListTitle : Strings.Todos.newDocumentTitle, message: nil, preferredStyle: .alert)
        let create = UIAlertAction(title: Strings.Todos.create, style: .default) { [weak self, weak alert] _ in
            let name = alert?.textFields?.first?.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            self?.create(type: type, name: name)
        }
        create.isEnabled = false
        alert.addTextField { field in
            field.placeholder = Strings.Todos.namePlaceholder
            field.autocapitalizationType = .sentences
            field.returnKeyType = .done
            field.accessibilityIdentifier = "todo-lists-name"
            field.addAction(UIAction { [weak field] _ in
                create.isEnabled = !(field?.text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
            }, for: .editingChanged)
        }
        alert.addAction(UIAlertAction(title: Strings.Todos.cancel, style: .cancel))
        alert.addAction(create)
        alert.preferredAction = create
        present(alert, animated: true)
    }

    /// Makes the Surface on the computer, shows it in the catalog at once
    /// and opens it: a todo list on its todos, a document in its editor.
    func create(type: String, name: String) {
        guard !name.isEmpty, !creating else { return }
        creating = true
        newItem.isEnabled = false
        let client = session.engine.client
        Task { [weak self, feed] in
            let made: Result<AgentWire.Surface, Error>
            do {
                made = .success(type == "document" ? try await client.createDocument(name: name) : try await client.createSurface(type: type, name: name))
            } catch {
                made = .failure(error)
            }
            if case .success(let surface) = made { await feed.add(surface) }
            guard let self else { return }
            self.creating = false
            self.newItem.isEnabled = true
            switch made {
            case .success(let surface):
                self.navigationController?.pushViewController(SurfaceScreens.make(session: self.session, surface: surface), animated: true)
            case .failure(let error):
                Alerts.show(Strings.Todos.createFailedTitle, Strings.Todos.createFailed(error.localizedDescription), on: self)
            }
        }
    }
}
#endif
