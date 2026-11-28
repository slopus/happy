#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit
import UltraView

/// Home's Documents or TODOs row: every Surface of the section's type
/// the computer has, joined or not, in one of home's grouped cards, by
/// name, a todo list with how many todos it has left. It opens on the
/// catalog kept on the phone (`SurfaceCatalogFeed`), reads it again, then
/// follows its events. A tap opens the Surface's own screen; the bar's +
/// makes one of the section's type, named in an alert, and opens it.
final class SurfaceListViewController: UIViewController {
    let section: SurfaceSection
    private let session: Session
    private let feed: SurfaceCatalogFeed
    private let library: TodoLibrary
    let list = CardListView()
    /// Makes one of the section's type, as desktop's + does.
    private(set) lazy var newItem = UIBarButtonItem(primaryAction: UIAction(image: .icon(.ionicons("add"), size: 26)) { [weak self] _ in self?.askName() })
    private var pipeline: ApplyPipeline<SurfaceListInput, Applied, Output>?
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

    init(session: Session, section: SurfaceSection) {
        self.session = session
        self.section = section
        feed = SurfaceCatalogFeed(engine: session.engine)
        library = session.engine.todos
        super.init(nibName: nil, bundle: nil)
        title = section.title
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
        view.accessibilityIdentifier = "\(section.targetKind)-list"
        list.accessibilityIdentifier = "\(section.targetKind)-list-list"
        view.addSubview(list)
        list.onSelect = { [weak self] id in self?.open(id) }
        HeaderBar.edge(list.edge, in: self)
        newItem.accessibilityLabel = section.new
        newItem.accessibilityIdentifier = "\(section.targetKind)-list-new"
        // A role that can't write content makes nothing here.
        let showNew = { [weak self] in
            guard let self else { return }
            navigationItem.rightBarButtonItem = session.gate.allows(.contentWrite) ? newItem : nil
        }
        showNew()
        accessWatch = session.watchAccess(showNew)

        let pipeline = ApplyPipeline<SurfaceListInput, Applied, Output>(
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
            guard let self else { return }
            navigationItem.title = Strings.HeaderStatus.title(state) ?? section.title
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

    private func currentInput() -> SurfaceListInput {
        var input = SurfaceListInput()
        input.section = section
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

    /// How many todos each list has left: at once from the lists open on
    /// the phone or kept on it, then from the computer for every list.
    private func countOutstanding(_ state: SurfaceCatalogFeed.State) async {
        guard section == .todos else { return }
        let ids = state.of("todo").map(\.id)
        let kept = await library.outstanding(ids)
        pipeline?.update { $0.outstanding = kept }
        let read = await library.outstandingRead(ids)
        guard read != kept else { return }
        pipeline?.update { $0.outstanding = read }
    }

    nonisolated static func derive(_ input: SurfaceListInput, applied: Applied) -> (output: Output, state: Applied)? {
        let next = SurfaceListItems.items(input)
        var counter = applied.counter
        let items = CardItems.revise(next, previous: applied.items, counter: &counter)
        let order = items.map(\.id)
        let unchanged = order == applied.order && items.allSatisfy { applied.items[$0.id]?.revision == $0.revision }
        guard !unchanged else { return nil }
        let surfaces = Dictionary(input.state.of(input.section.type).map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let state = Applied(items: Dictionary(items.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first }), order: order, counter: counter)
        let replan: @Sendable (CGFloat) -> [CardItem] = { width in
            var input = input
            input.width = width
            return SurfaceListItems.items(input)
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

    /// Asks the new Surface's name; Create stays off while it's blank.
    func askName() {
        let alert = UIAlertController(title: section.new, message: nil, preferredStyle: .alert)
        let create = UIAlertAction(title: Strings.Todos.create, style: .default) { [weak self, weak alert] _ in
            let name = alert?.textFields?.first?.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            self?.create(name: name)
        }
        create.isEnabled = false
        let identifier = "\(section.targetKind)-list-name"
        alert.addTextField { field in
            field.placeholder = Strings.Todos.namePlaceholder
            field.autocapitalizationType = .sentences
            field.returnKeyType = .done
            field.accessibilityIdentifier = identifier
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
    func create(name: String) {
        guard !name.isEmpty, !creating else { return }
        creating = true
        newItem.isEnabled = false
        let client = session.engine.client
        let type = section.type
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
