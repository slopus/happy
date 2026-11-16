#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// What a run's or node's page derives its rows from.
protocol PipelinePageInput: Sendable {
    var env: PipelineCardEnvironment { get set }
    nonisolated static func page(_ input: Self) -> PipelinePage
    /// Whether anything on the page counts time by the second.
    nonisolated static func ticking(_ input: Self) -> Bool
}

extension PipelineRunInput: PipelinePageInput {
    nonisolated static func page(_ input: Self) -> PipelinePage { PipelineRunItems.page(input) }
    nonisolated static func ticking(_ input: Self) -> Bool { PipelineRunItems.ticking(input.state) }
}

extension PipelineNodeInput: PipelinePageInput {
    var env: PipelineCardEnvironment {
        get { run.env }
        set { run.env = newValue }
    }

    nonisolated static func page(_ input: Self) -> PipelinePage { PipelineNodeItems.page(input) }
    nonisolated static func ticking(_ input: Self) -> Bool { PipelineNodeItems.ticking(input) }
}

/// A run's page and a node's page: cards derived off the main thread from
/// what the page follows, a running node's time counting by the second,
/// and rows that open another run or a block's whole text.
class PipelinePageViewController<Input: PipelinePageInput>: UIViewController {
    struct Output: Sendable {
        var items: [CardItem]
        var width: CGFloat
        var title: String?
        var live: Bool
        var more: String?
        var ticking: Bool
        var targets: [String: PipelineRowTarget]
        /// The same items at another width, for a width change.
        var replan: @Sendable (CGFloat) -> [CardItem]
    }

    let session: Session
    let list = CardListView()
    private var pipeline: ApplyPipeline<Input, PipelineRows.Applied, Output>?
    private let initial: Input
    private var headerWatch: Watch?
    private var following: [Task<Void, Never>] = []
    private var clock: Timer?
    private var ticking = false
    private var shownMinute = 0
    private var targets: [String: PipelineRowTarget] = [:]
    private final var replan: (@Sendable (CGFloat) -> [CardItem])?
    /// The row that, once on screen, asks for the next page; nil once asked.
    private final var more: String?
    /// What the page is titled when the link says nothing.
    private var pageTitle: String
    private var headerTitle: String?

    init(session: Session, input: Input, title: String) {
        self.session = session
        initial = input
        pageTitle = title
        super.init(nibName: nil, bundle: nil)
        self.title = title
        navigationItem.largeTitleDisplayMode = .never
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    // Not `isolated deinit` (see `Watch`).
    deinit {
        following.forEach { $0.cancel() }
        pipeline?.cancel()
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        followsTextSize()
        view.backgroundColor = UIColor(Palette.groupedGround)
        view.addSubview(list)
        HeaderBar.edge(list.edge, in: self)
        list.onSelect = { [weak self] id in
            guard let self, let target = targets[id] else { return }
            open(target)
        }
        list.onScroll = { [weak self] in
            self?.checkMore()
            self?.scrolled()
        }

        var input = initial
        input.env = environment()
        let pipeline = ApplyPipeline<Input, PipelineRows.Applied, Output>(
            input: input,
            state: PipelineRows.Applied(),
            derive: { input, applied in Self.derive(input, applied: applied) },
            apply: { [weak self] output in self?.show(output) ?? false }
        )
        self.pipeline = pipeline
        follow(pipeline)
        registerForTraitChanges(UIView.textSizeTraits + [UITraitUserInterfaceStyle.self, UITraitDisplayScale.self]) { (self: Self, _) in
            self.updateEnvironment()
        }
        headerWatch = session.watchHeader { [weak self] state in
            guard let self else { return }
            headerTitle = Strings.HeaderStatus.title(state)
            navigationItem.title = headerTitle ?? pageTitle
        }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        clock = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        updateEnvironment()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        clock?.invalidate()
        clock = nil
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        list.maxWidth = ContentWidth.maxWidth
        list.frame = view.bounds
        let safe = view.safeAreaInsets
        list.setInsets(UIEdgeInsets(top: safe.top + CardListMetrics.contentTop, left: 0, bottom: safe.bottom + CardListMetrics.contentBottom, right: 0))
        updateEnvironment()
    }

    // MARK: For the pages

    /// Starts following what the page shows; called once, as it loads.
    func follow(_ pipeline: ApplyPipeline<Input, PipelineRows.Applied, Output>) {}

    /// Keeps a task the page follows something with, until it goes.
    func keep(_ task: Task<Void, Never>) { following.append(task) }

    func update(_ change: (inout Input) -> Void) { pipeline?.update(change) }

    /// What a tapped row does; a page handles its own targets and passes the rest here.
    func open(_ target: PipelineRowTarget) {
        switch target {
        case .run(let id, let pipelineName):
            navigationController?.pushViewController(PipelineRunViewController(session: session, runId: id, pipelineName: pipelineName), animated: true)
        case .text(let title, let text):
            let page = TextSelectionViewController(text: text)
            page.title = title
            navigationController?.pushViewController(page, animated: true)
        case .pipeline(let id, let name):
            navigationController?.pushViewController(PipelineViewController(session: session, pipelineId: id, name: name), animated: true)
        case .node, .command, .abort, .version, .definitionNode:
            break
        }
    }

    /// Shows the new rows; the node's page wraps it to follow its log's tail.
    func apply(_ items: [CardItem], live: Bool) {
        list.apply(items, animated: true, replan: replan)
    }

    func scrolled() {}

    /// The last row read shows and there is more: the page reads the next.
    func readMore() {}

    private func checkMore() {
        guard let more, list.frame(of: more) != nil else { return }
        self.more = nil
        readMore()
    }

    // MARK: Derivation

    private func environment() -> PipelineCardEnvironment {
        var env = PipelineCardEnvironment()
        env.width = list.contentWidth
        env.maxWidth = list.maxWidth
        env.height = max(0, list.bounds.height - list.contentInsets.top - list.contentInsets.bottom)
        env.scale = traitCollection.textEnvironment?.scale.multiplier ?? 1
        env.displayScale = traitCollection.displayScale > 0 ? traitCollection.displayScale : 2
        env.dark = traitCollection.userInterfaceStyle == .dark
        env.now = Date()
        return env
    }

    private func updateEnvironment() {
        let env = environment()
        shownMinute = Int(env.now.timeIntervalSince1970 / 60)
        pipeline?.update { $0.env = env }
    }

    /// A second on: a running node's time moves, and every minute the
    /// times ago. Nothing is derived for a second that changes nothing shown.
    private func tick() {
        let now = Date()
        let minute = Int(now.timeIntervalSince1970 / 60)
        guard ticking || minute != shownMinute else { return }
        shownMinute = minute
        pipeline?.update { $0.env.now = now }
    }

    nonisolated static func derive(_ input: Input, applied: PipelineRows.Applied) -> (output: Output, state: PipelineRows.Applied)? {
        let page = Input.page(input)
        let revised = PipelineRows.revise(page.items, applied: applied)
        guard revised != nil || page.title != applied.title else { return nil }
        var (items, state) = revised ?? (applied.order.compactMap { applied.items[$0] }, applied)
        state.title = page.title
        let replan: @Sendable (CGFloat) -> [CardItem] = { width in
            var input = input
            input.env.width = width
            return Input.page(input).items
        }
        return (Output(items: items, width: input.env.width, title: page.title, live: page.live, more: page.more, ticking: Input.ticking(input), targets: page.targets, replan: replan), state)
    }

    private func show(_ output: Output) -> Bool {
        guard output.width == list.contentWidth else { return false }
        ticking = output.ticking
        targets = output.targets
        if let title = output.title, title != pageTitle {
            pageTitle = title
            navigationItem.title = headerTitle ?? title
        }
        replan = output.replan
        more = output.more
        apply(output.items, live: output.live)
        checkMore()
        return true
    }
}
#endif
