#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit
import UltraView

/// Desktop's Pipelines page on a phone, opened from home's Pipelines row
/// under Plugins on a Happy Cloud server that runs them: the team's
/// pipelines on top, then every run of them, newest first, the next page
/// read once the last run shows; a run opens its own page. Agents create
/// and run pipelines; a person reads them and can abort a run. It follows
/// the server's pipeline events while it shows (`PipelinesFeed`), and a
/// running run's time counts by the second.
final class PipelinesViewController: UIViewController {
    private let session: Session
    private let feed: PipelinesFeed
    let list = CardListView()
    private var pipeline: ApplyPipeline<PipelineListInput, Applied, Output>?
    private var headerWatch: Watch?
    private var following: [Task<Void, Never>] = []
    private var clock: Timer?
    /// What the last result said, for the clock and the paging.
    private var ticking = false
    private var lastRunId: String?
    private var hasMore = false
    private var loadingMore = false
    private var shownMinute = 0

    struct Applied: Sendable {
        var items: [String: CardItem] = [:]
        var order: [String] = []
        var counter: UInt64 = 0
    }

    struct Output: Sendable {
        var items: [CardItem]
        var width: CGFloat
        var ticking: Bool
        var lastRunId: String?
        var hasMore: Bool
        var loadingMore: Bool
        /// The same items at another width, for a width change.
        var replan: @Sendable (CGFloat) -> [CardItem]
    }

    init(session: Session) {
        self.session = session
        feed = PipelinesFeed(engine: session.engine)
        super.init(nibName: nil, bundle: nil)
        title = Strings.Pipelines.title
        navigationItem.largeTitleDisplayMode = .never
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    // Not `isolated deinit` (see `Watch`).
    deinit {
        following.forEach { $0.cancel() }
        pipeline?.cancel()
        Task { [feed] in await feed.finish() }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        followsTextSize()
        view.backgroundColor = UIColor(Palette.groupedGround)
        view.accessibilityIdentifier = "pipelines"
        list.accessibilityIdentifier = "pipelines-list"
        view.addSubview(list)
        HeaderBar.edge(list.edge, in: self)
        list.onScroll = { [weak self] in self?.loadMoreIfNeeded() }
        list.onSelect = { [weak self] id in
            guard let self, let runId = PipelineListItems.run(ofRow: id) else { return }
            navigationController?.pushViewController(PipelineRunViewController(session: session, runId: runId), animated: true)
        }

        let pipeline = ApplyPipeline<PipelineListInput, Applied, Output>(
            input: currentInput(),
            state: Applied(),
            derive: { input, applied in Self.derive(input, applied: applied) },
            apply: { [weak self] output in self?.show(output) ?? false }
        )
        self.pipeline = pipeline
        let (feed, engine) = (feed, session.engine)
        following.append(Task { [weak pipeline] in
            let states = await feed.states()
            pipeline?.follow(ifChanged: states) { input, state in
                guard input.state != state else { return false }
                input.state = state
                return true
            }
        })
        following.append(Task { [weak pipeline] in
            let directories = await engine.feedDirectories()
            pipeline?.follow(ifChanged: directories) { input, directory in
                let agents = directory.agents.mapValues(\.name)
                guard input.agents != agents else { return false }
                input.agents = agents
                return true
            }
        })
        registerForTraitChanges(UIView.textSizeTraits + [UITraitUserInterfaceStyle.self, UITraitDisplayScale.self]) { (self: Self, _) in
            self.updateInput()
        }
        headerWatch = session.watchHeader { [weak self] state in
            self?.navigationItem.title = Strings.HeaderStatus.title(state) ?? Strings.Pipelines.title
        }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        Task { [feed] in await feed.start() }
        clock = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        updateInput()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        clock?.invalidate()
        clock = nil
        Task { [feed] in await feed.stop() }
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

    private func currentInput() -> PipelineListInput {
        var input = PipelineListInput()
        input.width = list.contentWidth
        input.height = max(0, list.bounds.height - list.contentInsets.top - list.contentInsets.bottom)
        input.scale = traitCollection.textEnvironment?.scale.multiplier ?? 1
        input.displayScale = traitCollection.displayScale > 0 ? traitCollection.displayScale : 2
        input.dark = traitCollection.userInterfaceStyle == .dark
        input.now = Date()
        return input
    }

    private func updateInput() {
        let next = currentInput()
        shownMinute = Int(next.now.timeIntervalSince1970 / 60)
        pipeline?.update { input in
            input.width = next.width
            input.maxWidth = next.maxWidth
            input.height = next.height
            input.scale = next.scale
            input.displayScale = next.displayScale
            input.dark = next.dark
            input.now = next.now
        }
    }

    /// A second on: a running run's time moves, and every minute the times
    /// ago. Nothing is derived for a second that changes nothing shown.
    private func tick() {
        let now = Date()
        let minute = Int(now.timeIntervalSince1970 / 60)
        guard ticking || minute != shownMinute else { return }
        shownMinute = minute
        pipeline?.update { $0.now = now }
    }

    nonisolated static func derive(_ input: PipelineListInput, applied: Applied) -> (output: Output, state: Applied)? {
        let next = PipelineListItems.items(input)
        var counter = applied.counter
        let items = CardItems.revise(next, previous: applied.items, counter: &counter)
        let order = items.map(\.id)
        guard order != applied.order || !items.allSatisfy({ applied.items[$0.id]?.revision == $0.revision }) else { return nil }
        let state = Applied(items: Dictionary(items.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first }), order: order, counter: counter)
        let replan: @Sendable (CGFloat) -> [CardItem] = { width in
            var input = input
            input.width = width
            return PipelineListItems.items(input)
        }
        let runs = input.state.runs
        let output = Output(items: items, width: input.width, ticking: PipelineListItems.ticking(input.state),
                            lastRunId: runs.entries.last.map { PipelineListItems.runId($0.id) },
                            hasMore: runs.listed && runs.nextCursor != nil, loadingMore: runs.loadingMore, replan: replan)
        return (output, state)
    }

    private func show(_ output: Output) -> Bool {
        guard output.width == list.contentWidth else { return false }
        ticking = output.ticking
        lastRunId = output.lastRunId
        hasMore = output.hasMore
        loadingMore = output.loadingMore
        list.apply(output.items, animated: true, replan: output.replan)
        loadMoreIfNeeded()
        return true
    }

    /// The next page of runs, once the last run held is on screen.
    private func loadMoreIfNeeded() {
        guard hasMore, !loadingMore, let lastRunId, list.frame(of: lastRunId) != nil else { return }
        loadingMore = true
        Task { [feed] in await feed.more() }
    }
}
#endif
