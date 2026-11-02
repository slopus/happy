#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit
import UltraView

/// A System Monitor Surface: the computer's machine overview, live, as the
/// desktop shows it, in home's inset grouped cards. The machine, then CPU,
/// graphics, memory and disk, each its reading over its history, then the
/// busiest processes, filtered and sorted. A snapshot a second while the
/// screen shows, none while it is hidden or the app is in the background
/// (`SystemMonitorFeed`). Every row is drawn off the main thread, its
/// charts with it, and only the rows whose numbers moved are drawn again.
/// With the computer away the last sample stays, marked as such, and the
/// title says what the link is doing. The bar's search filters the
/// processes and its sort menu orders them: kept out of the rows, so no
/// live view joins the window as the list scrolls.
final class MonitorViewController: UIViewController, UISearchResultsUpdating, UISearchControllerDelegate {
    private let session: Session
    let surfaceId: String
    private let name: String
    private let feed: SystemMonitorFeed
    let list = CardListView()
    private(set) lazy var searchController = UISearchController(searchResultsController: nil)
    let sortItem = UIBarButtonItem(title: nil, menu: nil)
    private var pipeline: ApplyPipeline<MonitorInput, Applied, Output>?
    private var headerWatch: Watch?
    private var following: Task<Void, Never>?
    private var visible = false
    private var keyboardTop: CGFloat?
    private(set) var sort = ProcessTable.Sort.standard

    struct Applied: Sendable {
        var items: [String: CardItem] = [:]
        var order: [String] = []
        var counter: UInt64 = 0
        var table = ProcessTable()
    }

    struct Output: Sendable {
        var items: [CardItem]
        var width: CGFloat
        /// The same items at another width, for a width change.
        var replan: @Sendable (CGFloat) -> [CardItem]
    }

    init(session: Session, surface: AgentWire.Surface) {
        self.session = session
        surfaceId = surface.id
        name = surface.name.isEmpty ? Strings.Monitor.title : surface.name
        feed = SystemMonitorFeed(engine: session.engine, surfaceId: surface.id)
        super.init(nibName: nil, bundle: nil)
        title = name
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
        view.accessibilityIdentifier = "system-monitor"
        list.accessibilityIdentifier = "system-monitor-list"
        view.addSubview(list)
        HeaderBar.edge(list.edge, in: self)
        setUpBar()

        let pipeline = ApplyPipeline<MonitorInput, Applied, Output>(
            input: currentInput(),
            state: Applied(),
            derive: { input, applied in Self.derive(input, applied: applied) },
            apply: { [weak self] output in self?.show(output) ?? false }
        )
        self.pipeline = pipeline
        following = Task { [feed, weak pipeline] in
            let states = await feed.states()
            pipeline?.follow(ifChanged: states) { input, state in
                guard input.state != state else { return false }
                input.state = state
                return true
            }
        }
        registerForTraitChanges(UIView.textSizeTraits + [UITraitUserInterfaceStyle.self, UITraitDisplayScale.self]) { (self: Self, _) in
            self.updateInput()
        }
        headerWatch = session.watchHeader { [weak self] state in
            guard let self else { return }
            navigationItem.title = Strings.HeaderStatus.title(state) ?? name
            // Back online: read now rather than at the next retry.
            if state == .online { Task { [feed] in await feed.poke() } }
        }
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(background), name: UIApplication.didEnterBackgroundNotification, object: nil)
        center.addObserver(self, selector: #selector(foreground), name: UIApplication.willEnterForegroundNotification, object: nil)
        center.addObserver(self, selector: #selector(keyboardWillChange(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        center.addObserver(self, selector: #selector(keyboardWillHide(_:)), name: UIResponder.keyboardWillHideNotification, object: nil)
    }

    /// The bar's own search, growing into a field in it, as Artifacts', and
    /// the sort beside it.
    private func setUpBar() {
        searchController.searchResultsUpdater = self
        searchController.delegate = self
        searchController.obscuresBackgroundDuringPresentation = false
        searchController.searchBar.placeholder = Strings.Monitor.filter
        searchController.searchBar.autocapitalizationType = .none
        searchController.searchBar.autocorrectionType = .no
        searchController.searchBar.searchTextField.accessibilityIdentifier = "system-monitor-filter"
        navigationItem.searchController = searchController
        navigationItem.hidesSearchBarWhenScrolling = false
        navigationItem.preferredSearchBarPlacement = .integratedButton
        if #available(iOS 26.0, *) { navigationItem.searchBarPlacementAllowsToolbarIntegration = false }
        sortItem.accessibilityIdentifier = "system-monitor-sort"
        navigationItem.rightBarButtonItem = sortItem
        updateSortItem()
    }

    /// What the processes are filtered by.
    var filter: String { searchController.searchBar.text ?? "" }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        visible = true
        Task { [feed] in await feed.resume() }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        visible = false
        Task { [feed] in await feed.pause() }
    }

    @objc private func background() { Task { [feed] in await feed.pause() } }

    @objc private func foreground() {
        guard visible else { return }
        Task { [feed] in await feed.resume() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        list.maxWidth = ContentWidth.maxWidth
        list.frame = view.bounds
        applyInsets()
        updateInput()
    }

    private func applyInsets() {
        let safe = view.safeAreaInsets
        var bottom = safe.bottom
        if let keyboardTop { bottom = max(bottom, view.bounds.height - keyboardTop) }
        list.setInsets(UIEdgeInsets(top: safe.top + CardListMetrics.contentTop, left: 0, bottom: bottom + CardListMetrics.contentBottom, right: 0))
    }

    // MARK: Derivation

    private func currentInput() -> MonitorInput {
        var input = MonitorInput()
        input.width = list.contentWidth
        input.scale = traitCollection.textEnvironment?.scale.multiplier ?? 1
        input.displayScale = traitCollection.displayScale > 0 ? traitCollection.displayScale : 2
        input.dark = traitCollection.userInterfaceStyle == .dark
        input.filter = filter
        input.sort = sort
        return input
    }

    private func updateInput() {
        let next = currentInput()
        pipeline?.update { input in
            input.width = next.width
            input.maxWidth = next.maxWidth
            input.scale = next.scale
            input.displayScale = next.displayScale
            input.dark = next.dark
            input.filter = next.filter
            input.sort = next.sort
        }
    }

    nonisolated static func derive(_ input: MonitorInput, applied: Applied) -> (output: Output, state: Applied)? {
        var input = input
        input.now = (input.state.sample?.sampledAt ?? 0) / 1000
        var table = input.state.processes.continuing(applied.table)
        let planned = table
        let next = MonitorListItems.items(input, table: &table)
        var counter = applied.counter
        let items = CardItems.revise(next, previous: applied.items, counter: &counter)
        let order = items.map(\.id)
        let state = Applied(items: Dictionary(items.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first }), order: order, counter: counter, table: table)
        guard order != applied.order || items.contains(where: { applied.items[$0.id]?.revision != $0.revision }) else { return nil }
        let fixedInput = input
        let replan: @Sendable (CGFloat) -> [CardItem] = { width in
            var input = fixedInput
            input.width = width
            var table = planned
            return MonitorListItems.items(input, table: &table)
        }
        return (Output(items: items, width: input.width, replan: replan), state)
    }

    /// The longest a result took to apply on the main thread, in ms.
    private(set) var longestApply: Double = 0

    private func show(_ output: Output) -> Bool {
        guard output.width == list.contentWidth else { return false }
        let start = CACurrentMediaTime()
        list.apply(output.items, animated: false, replan: output.replan)
        longestApply = max(longestApply, (CACurrentMediaTime() - start) * 1000)
        return true
    }

    // MARK: Processes

    func updateSearchResults(for searchController: UISearchController) { updateInput() }

    func willPresentSearchController(_ searchController: UISearchController) {
        list.scroll(to: "monitor:processes", animated: true)
    }

    /// Sorts by `column`: the same one again turns the order round.
    func choose(_ column: ProcessTable.Column) {
        sort = sort.choosing(column)
        updateSortItem()
        updateInput()
    }

    private func updateSortItem() {
        sortItem.title = MonitorListItems.sortLabel(sort)
        sortItem.accessibilityLabel = "\(Strings.Monitor.sort): \(Strings.Monitor.column(sort.column))"
        sortItem.menu = UIMenu(title: Strings.Monitor.sort, children: ProcessTable.Column.allCases.map { column in
            let chosen = column == sort.column
            let action = UIAction(title: Strings.Monitor.column(column), image: chosen ? Glyphs.image(sort.descending ? "chevron-down" : "chevron-up", size: 16) : nil) { [weak self] _ in
                self?.choose(column)
            }
            action.state = chosen ? .on : .off
            return action
        })
    }

    // MARK: Keyboard

    @objc private func keyboardWillChange(_ notification: Notification) {
        guard let frame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
        keyboardTop = view.convert(frame, from: nil).minY
        applyInsets()
    }

    @objc private func keyboardWillHide(_ notification: Notification) {
        keyboardTop = nil
        applyInsets()
    }
}
#endif
