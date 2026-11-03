#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Desktop's Feed: what happened on the computer, newest change first, in
/// home's inset grouped cards by date (Today, Yesterday, the previous seven
/// and thirty days, then by month). An entry's row carries its subject's
/// face, its title, when it last changed and a dot while it is unread;
/// under them up to three faces of who changed it and its newest change.
/// Opening one opens its subject and counts it seen. The bar's switch
/// turns to Following: the places whose changes come in, each followed or
/// muted, and a tap peeks at one's newest entries.
///
/// The entries are the engine's (`FeedLibrary`), kept on the phone and
/// followed through its events, so the screen opens on what it last
/// showed. Following and peeking ask the computer, as on desktop.
final class FeedViewController: UIViewController {
    private let session: Session
    private let feed: FeedLibrary
    let activity = CardListView()
    let following = CardListView()
    private let tabs: UISegmentedControl
    private lazy var readAllItem: UIBarButtonItem = {
        let item = UIBarButtonItem(image: .icon(.ionicons("checkmark-done-outline"), size: 22), primaryAction: UIAction { [weak self] _ in self?.readAll() })
        item.accessibilityIdentifier = "feed-read-all"
        item.isEnabled = false
        return item
    }()
    private var pipeline: ApplyPipeline<FeedListInput, Applied, Output>?
    private var clustersPipeline: ApplyPipeline<FeedClustersInput, Applied, ClustersOutput>?
    private var homeWatch: Watch?
    /// Home's faces as the list last took them.
    private var shownHome = FeedHome()
    private var watching: Task<Void, Never>?
    private var reading: Task<Void, Never>?
    /// What the rows on screen show, by ID.
    private(set) var entries: [String: FeedItem] = [:]
    private var faces: [String: FeedFace] = [:]
    private var lastEntryId: String?
    private var hasMore = false
    private var loadingMore = false
    /// The places listed, by cluster, with the follow or mute on its way.
    private(set) var clusters: [String: FeedCluster] = [:]
    private var clusterList: [FeedCluster] = []
    private var pending: Set<String> = []
    private var clusterFaces: [String: FeedFace] = [:]
    private var clustersRead = false
    /// The pull's refresh is under way.
    private var pulled = false

    struct Applied: Sendable {
        var items: [String: CardItem] = [:]
        var order: [String] = []
        var counter: UInt64 = 0
        var refreshing = false
    }

    struct Output: Sendable {
        var items: [CardItem]
        var faces: [String: FeedFace]
        var entries: [String: FeedItem]
        var lastEntryId: String?
        var unread: Int
        var hasMore: Bool
        var loadingMore: Bool
        var width: CGFloat
        var refreshing: Bool
        var replan: @Sendable (CGFloat) -> [CardItem]
    }

    struct ClustersOutput: Sendable {
        var items: [CardItem]
        var faces: [String: FeedFace]
        var width: CGFloat
        var replan: @Sendable (CGFloat) -> [CardItem]
    }

    init(session: Session) {
        self.session = session
        feed = session.engine.feed
        let words = Strings.Feed.words
        tabs = UISegmentedControl(items: [words.activity, words.following])
        super.init(nibName: nil, bundle: nil)
        title = Strings.Feed.title
        navigationItem.largeTitleDisplayMode = .never
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    // Not `isolated deinit`: that aborts on the iOS 26.3 runtime (see
    // `Watch`). Cancelling needs no actor.
    deinit {
        watching?.cancel()
        reading?.cancel()
        pipeline?.cancel()
        clustersPipeline?.cancel()
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        followsTextSize()
        view.backgroundColor = UIColor(Palette.groupedGround)
        view.accessibilityIdentifier = "direct-feed"
        activity.accessibilityIdentifier = "feed-list"
        following.accessibilityIdentifier = "feed-following-list"
        following.isHidden = true
        view.addSubview(activity)
        view.addSubview(following)
        activity.onSelect = { [weak self] id in self?.open(id) }
        activity.onRefresh = { [weak self] in self?.refresh() }
        activity.onScroll = { [weak self] in self?.loadMoreIfNeeded() }
        activity.makeOverlay = { [weak self] overlay, _ in self?.makeFace(overlay, faces: self?.faces ?? [:]) }
        following.onSelect = { [weak self] id in self?.peek(id) }
        following.onRefresh = { [weak self] in self?.readClusters(pulled: true) }
        following.makeOverlay = { [weak self] overlay, id in self?.makeClusterOverlay(overlay, id: id) }
        following.accessibilityActions = { [weak self] id in self?.clusterActions(id) ?? [] }
        setUpBar()

        let words = Strings.Feed.words
        let pipeline = ApplyPipeline<FeedListInput, Applied, Output>(
            input: FeedListInput(words: words, dates: .current),
            state: Applied(),
            derive: { input, applied in Self.derive(input, applied: applied) },
            apply: { [weak self] output in self?.show(output) ?? false }
        )
        self.pipeline = pipeline
        clustersPipeline = ApplyPipeline<FeedClustersInput, Applied, ClustersOutput>(
            input: FeedClustersInput(words: words),
            state: Applied(),
            derive: { input, applied in Self.derive(input, applied: applied) },
            apply: { [weak self] output in self?.show(output) ?? false }
        )
        updateInput()
        watching = Task { [feed, weak pipeline] in
            let states = await feed.states()
            pipeline?.follow(ifChanged: states) { input, state in
                guard input.state != state else { return false }
                input.state = state
                return true
            }
            await feed.refresh()
        }
        homeWatch = session.watchHome { [weak self] home in
            guard let self else { return }
            let next = FeedHome(home, personSeed: session.personSeed)
            guard next != shownHome else { return }
            shownHome = next
            self.pipeline?.update { $0.home = next }
            self.clustersPipeline?.update { $0.home = next }
        }
        registerForTraitChanges(UIView.textSizeTraits + [UITraitUserInterfaceStyle.self, UITraitDisplayScale.self]) { (self: Self, _) in
            self.updateInput()
        }
        NotificationCenter.default.addObserver(self, selector: #selector(dayChanged), name: .NSCalendarDayChanged, object: nil)
    }

    /// The switch between Activity and Following in the bar's middle, and
    /// Mark All Read at its right.
    private func setUpBar() {
        HeaderBar.edge(activity.edge, in: self)
        tabs.selectedSegmentIndex = 0
        tabs.accessibilityIdentifier = "feed-tabs"
        tabs.addAction(UIAction { [weak self] _ in self?.switched() }, for: .valueChanged)
        navigationItem.titleView = tabs
        readAllItem.accessibilityLabel = Strings.Feed.words.markAllRead
        navigationItem.rightBarButtonItem = readAllItem
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // Today may be yesterday by now.
        updateInput()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let safe = view.safeAreaInsets
        for list in [activity, following] {
            list.maxWidth = ContentWidth.maxWidth
            list.frame = view.bounds
            list.setInsets(UIEdgeInsets(top: safe.top + CardListMetrics.contentTop, left: 0, bottom: safe.bottom + CardListMetrics.contentBottom, right: 0))
        }
        updateInput()
    }

    // MARK: Derivation

    private func updateInput() {
        let width = activity.contentWidth
        let maxWidth = ContentWidth.maxWidth
        let scale = traitCollection.textEnvironment?.scale.multiplier ?? 1
        let displayScale = traitCollection.displayScale > 0 ? traitCollection.displayScale : 2
        let dark = traitCollection.userInterfaceStyle == .dark
        let words = Strings.Feed.words
        let dates = Strings.Artifacts.DateWords.current
        let switchSize = UISwitch().intrinsicContentSize
        pipeline?.update { input in
            input.width = width
            input.maxWidth = maxWidth
            input.scale = scale
            input.displayScale = displayScale
            input.dark = dark
            input.words = words
            input.dates = dates
            input.now = Date()
        }
        clustersPipeline?.update { input in
            input.width = width
            input.maxWidth = maxWidth
            input.scale = scale
            input.displayScale = displayScale
            input.dark = dark
            input.words = words
            input.switchSize = switchSize
        }
    }

    @objc private func dayChanged() { updateInput() }

    nonisolated static func derive(_ input: FeedListInput, applied: Applied) -> (output: Output, state: Applied)? {
        let next = FeedListItems.items(input)
        var counter = applied.counter
        let items = CardItems.revise(next.items, previous: applied.items, counter: &counter)
        let order = items.map(\.id)
        let refreshing = input.state.refreshing
        let unchanged = order == applied.order && refreshing == applied.refreshing && items.allSatisfy { applied.items[$0.id]?.revision == $0.revision }
        guard !unchanged else { return nil }
        var entries: [String: FeedItem] = [:]
        for entry in input.state.items { entries[entry.id] = entry }
        let state = Applied(items: Dictionary(items.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first }), order: order, counter: counter, refreshing: refreshing)
        let replan: @Sendable (CGFloat) -> [CardItem] = { width in
            var input = input
            input.width = width
            return FeedListItems.items(input).items
        }
        let output = Output(
            items: items, faces: next.faces, entries: entries, lastEntryId: input.state.items.last?.id,
            unread: input.state.unread, hasMore: input.state.hasMore, loadingMore: input.state.loadingMore,
            width: input.width, refreshing: refreshing, replan: replan
        )
        return (output, state)
    }

    nonisolated static func derive(_ input: FeedClustersInput, applied: Applied) -> (output: ClustersOutput, state: Applied)? {
        let next = FeedClusterItems.items(input)
        var counter = applied.counter
        let items = CardItems.revise(next.items, previous: applied.items, counter: &counter)
        let order = items.map(\.id)
        guard order != applied.order || !items.allSatisfy({ applied.items[$0.id]?.revision == $0.revision }) else { return nil }
        let state = Applied(items: Dictionary(items.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first }), order: order, counter: counter)
        let replan: @Sendable (CGFloat) -> [CardItem] = { width in
            var input = input
            input.width = width
            return FeedClusterItems.items(input).items
        }
        return (ClustersOutput(items: items, faces: next.faces, width: input.width, replan: replan), state)
    }

    private func show(_ output: Output) -> Bool {
        guard output.width == activity.contentWidth else { return false }
        entries = output.entries
        faces.merge(output.faces) { _, new in new }
        lastEntryId = output.lastEntryId
        hasMore = output.hasMore
        loadingMore = output.loadingMore
        readAllItem.isEnabled = output.unread > 0
        activity.apply(output.items, animated: true, replan: output.replan)
        if pulled, !output.refreshing {
            pulled = false
            activity.refreshing = false
        }
        loadMoreIfNeeded()
        return true
    }

    private func show(_ output: ClustersOutput) -> Bool {
        guard output.width == following.contentWidth else { return false }
        clusterFaces.merge(output.faces) { _, new in new }
        following.apply(output.items, animated: true, replan: output.replan)
        return true
    }

    // MARK: Activity

    private func refresh() {
        pulled = true
        Task { [feed] in await feed.refresh() }
    }

    /// The next page, once the last entry held is on screen.
    private func loadMoreIfNeeded() {
        guard hasMore, !loadingMore, let lastEntryId, activity.frame(of: lastEntryId) != nil else { return }
        loadingMore = true
        Task { [feed] in await feed.loadMore() }
    }

    func readAll() {
        readAllItem.isEnabled = false
        Task { [feed] in await feed.readAll() }
    }

    private func open(_ id: String) {
        guard let entry = entries[id] else { return }
        Task { [feed] in await feed.open(entry) }
        FeedOpening.open(entry, session: session, from: self)
    }

    private func makeFace(_ overlay: CardOverlay, faces: [String: FeedFace]) -> UIView? {
        guard overlay.kind == FeedListItems.faceKind || overlay.kind == FeedListItems.actorKind, let face = faces[overlay.key] else { return nil }
        return FeedFaceView(face: face, radius: overlay.radius, ringed: overlay.kind == FeedListItems.actorKind, side: overlay.frame.width, images: session.images)
    }

    // MARK: Following

    /// Turns the bar's switch to Following, as a tap on it does.
    func showFollowing() {
        tabs.selectedSegmentIndex = 1
        switched()
    }

    private func switched() {
        let showsFollowing = tabs.selectedSegmentIndex == 1
        activity.isHidden = showsFollowing
        following.isHidden = !showsFollowing
        HeaderBar.edge(showsFollowing ? following.edge : activity.edge, in: self)
        navigationItem.rightBarButtonItem = showsFollowing ? nil : readAllItem
        if showsFollowing { readClusters(pulled: false) }
    }

    /// The places, read again each time Following shows: they live on the
    /// computer alone, as desktop's do.
    private func readClusters(pulled: Bool) {
        if pulled { following.refreshing = true }
        reading?.cancel()
        reading = Task { [weak self, feed] in
            let result: Result<[FeedCluster], Error>
            do { result = .success(try await feed.clusters()) } catch { result = .failure(error) }
            guard !Task.isCancelled, let self else { return }
            following.refreshing = false
            switch result {
            case .success(let clusters):
                clustersRead = true
                showClusters(clusters, error: nil)
            case .failure(let error):
                showClusters(clusterList, error: clustersRead && !clusterList.isEmpty ? nil : String(describing: error))
            }
        }
    }

    private func showClusters(_ list: [FeedCluster], error: String?) {
        clusterList = list
        clusters = Dictionary(list.map { ($0.cluster, $0) }, uniquingKeysWith: { first, _ in first })
        let pending = pending
        clustersPipeline?.update { input in
            input.clusters = list
            input.pending = pending
            input.loaded = true
            input.error = error
        }
    }

    private func makeClusterOverlay(_ overlay: CardOverlay, id: String) -> UIView? {
        if overlay.kind == FeedClusterItems.toggle, let cluster = clusters[id] {
            let toggle = UISwitch()
            let everything = clusters["*"]?.state
            toggle.isOn = FeedClusterItems.following(cluster, everything: everything)
            toggle.isEnabled = !pending.contains(id)
            toggle.accessibilityLabel = Strings.Feed.words.follow(cluster.name)
            toggle.accessibilityIdentifier = "feed-follow:\(id)"
            toggle.addAction(UIAction { [weak self, weak toggle] _ in
                guard let toggle else { return }
                self?.follow(id, toggle.isOn)
            }, for: .valueChanged)
            return toggle
        }
        return makeFace(overlay, faces: clusterFaces)
    }

    /// The switch, for VoiceOver, which hears the row as one element.
    private func clusterActions(_ id: String) -> [UIAccessibilityCustomAction] {
        guard let cluster = clusters[id], !pending.contains(id) else { return [] }
        let follows = FeedClusterItems.following(cluster, everything: clusters["*"]?.state)
        let words = Strings.Feed.words
        return [UIAccessibilityCustomAction(name: follows ? words.mute(cluster.name) : words.follow(cluster.name)) { [weak self] _ in
            self?.follow(id, !follows)
            return true
        }]
    }

    func follow(_ id: String, _ follows: Bool) {
        pending.insert(id)
        showClusters(clusterList, error: nil)
        Task { [weak self, feed] in
            let result: Result<FeedCluster, Error>
            do { result = .success(try await feed.follow(id, follows)) } catch { result = .failure(error) }
            guard let self else { return }
            pending.remove(id)
            switch result {
            case .success(let changed):
                var list = clusterList
                if let index = list.firstIndex(where: { $0.cluster == changed.cluster }) { list[index] = changed }
                showClusters(list, error: nil)
            case .failure(let error):
                showClusters(clusterList, error: nil)
                let words = Strings.Feed.words
                let alert = UIAlertController(title: nil, message: words.followFailed(Self.reason(error)), preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: Strings.Common.ok, style: .default))
                present(alert, animated: true)
            }
        }
    }

    private static func reason(_ error: Error) -> String {
        if let error = error as? LocalizedError, let text = error.errorDescription { return text }
        return error.localizedDescription
    }

    private func peek(_ id: String) {
        guard let cluster = clusters[id] else { return }
        navigationController?.pushViewController(FeedPeekViewController(session: session, cluster: cluster), animated: true)
    }
}

/// A place's newest entries, as Following peeks at them: the same rows as
/// the feed's, without the dot, read from the computer each time.
final class FeedPeekViewController: UIViewController {
    private let session: Session
    private let feed: FeedLibrary
    private let cluster: FeedCluster
    let list = CardListView()
    private var pipeline: ApplyPipeline<FeedListInput, FeedViewController.Applied, FeedViewController.Output>?
    private var homeWatch: Watch?
    private var shownHome = FeedHome()
    private var reading: Task<Void, Never>?
    private var entries: [String: FeedItem] = [:]
    private var faces: [String: FeedFace] = [:]

    init(session: Session, cluster: FeedCluster) {
        self.session = session
        feed = session.engine.feed
        self.cluster = cluster
        super.init(nibName: nil, bundle: nil)
        title = cluster.name.isEmpty ? Strings.Feed.words.untitled : cluster.name
        navigationItem.largeTitleDisplayMode = .never
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    deinit {
        reading?.cancel()
        pipeline?.cancel()
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        followsTextSize()
        view.backgroundColor = UIColor(Palette.groupedGround)
        view.accessibilityIdentifier = "direct-feed-peek"
        list.accessibilityIdentifier = "feed-peek-list"
        view.addSubview(list)
        HeaderBar.edge(list.edge, in: self)
        list.onSelect = { [weak self] id in self?.open(id) }
        list.onRefresh = { [weak self] in self?.read(pulled: true) }
        list.makeOverlay = { [weak self] overlay, _ in
            guard let self, let face = faces[overlay.key] else { return nil }
            return FeedFaceView(face: face, radius: overlay.radius, ringed: overlay.kind == FeedListItems.actorKind, side: overlay.frame.width, images: session.images)
        }
        var input = FeedListInput(words: Strings.Feed.words, dates: .current)
        input.peek = true
        pipeline = ApplyPipeline<FeedListInput, FeedViewController.Applied, FeedViewController.Output>(
            input: input,
            state: FeedViewController.Applied(),
            derive: { input, applied in FeedViewController.derive(input, applied: applied) },
            apply: { [weak self] output in self?.show(output) ?? false }
        )
        homeWatch = session.watchHome { [weak self] home in
            guard let self else { return }
            let next = FeedHome(home, personSeed: session.personSeed)
            guard next != shownHome else { return }
            shownHome = next
            pipeline?.update { $0.home = next }
        }
        registerForTraitChanges(UIView.textSizeTraits + [UITraitUserInterfaceStyle.self, UITraitDisplayScale.self]) { (self: Self, _) in
            self.updateInput()
        }
        read(pulled: false)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        list.maxWidth = ContentWidth.maxWidth
        list.frame = view.bounds
        let safe = view.safeAreaInsets
        list.setInsets(UIEdgeInsets(top: safe.top + CardListMetrics.contentTop, left: 0, bottom: safe.bottom + CardListMetrics.contentBottom, right: 0))
        updateInput()
    }

    private func updateInput() {
        let width = list.contentWidth
        let scale = traitCollection.textEnvironment?.scale.multiplier ?? 1
        let displayScale = traitCollection.displayScale > 0 ? traitCollection.displayScale : 2
        let dark = traitCollection.userInterfaceStyle == .dark
        let words = Strings.Feed.words
        let dates = Strings.Artifacts.DateWords.current
        pipeline?.update { input in
            input.width = width
            input.maxWidth = ContentWidth.maxWidth
            input.scale = scale
            input.displayScale = displayScale
            input.dark = dark
            input.words = words
            input.dates = dates
            input.now = Date()
        }
    }

    private func read(pulled: Bool) {
        if pulled { list.refreshing = true }
        reading?.cancel()
        reading = Task { [weak self, feed, cluster] in
            let result: Result<FeedPeek, Error>
            do { result = .success(try await feed.peek(cluster.cluster)) } catch { result = .failure(error) }
            guard !Task.isCancelled, let self else { return }
            list.refreshing = false
            pipeline?.update { input in
                input.state.loaded = true
                input.state.available = true
                switch result {
                case .success(let peek):
                    input.state.items = peek.entries
                    input.state.error = nil
                case .failure(let error):
                    if input.state.items.isEmpty { input.state.error = String(describing: error) }
                }
            }
        }
    }

    private func show(_ output: FeedViewController.Output) -> Bool {
        guard output.width == list.contentWidth else { return false }
        entries = output.entries
        faces.merge(output.faces) { _, new in new }
        list.apply(output.items, animated: true, replan: output.replan)
        return true
    }

    private func open(_ id: String) {
        guard let entry = entries[id] else { return }
        FeedOpening.open(entry, session: session, from: self)
    }
}

/// Where a Feed entry goes when it is opened: a task's or a bot's chat, a
/// Surface's screen, an artifact's viewer. Chats count themselves read,
/// which counts them seen; Surfaces and artifacts tell the Feed they were
/// opened (`SurfaceScreens`, `ArtifactViewController`).
@MainActor
enum FeedOpening {
    static func open(_ entry: FeedItem, session: Session, from controller: UIViewController) {
        guard let next = screen(entry, session: session) else { return }
        controller.navigationController?.pushViewController(next, animated: true)
    }

    static func screen(_ entry: FeedItem, session: Session) -> UIViewController? {
        let subject = entry.subject
        let title = entry.snapshot.title
        switch subject.type {
        case "task", "bot":
            let row = session.home.allRows.first { $0.targetKind == subject.type && $0.targetId == subject.id }
            guard let agentId = row?.agentId ?? entry.snapshot.agentId else { return nil }
            session.warm.tap(agentId)
            return ChatViewController(session: session, agentId: agentId, title: row?.label ?? title, spaceId: row?.spaceId, intro: nil)
        case "surface":
            let surface = AgentWire.Surface(id: subject.id, type: entry.snapshot.surfaceType ?? "", name: title)
            return SurfaceScreens.make(session: session, surface: surface)
        case "artifact":
            let artifact = Artifact(id: subject.id, version: entry.snapshot.artifactVersion ?? 0, type: entry.snapshot.artifactType ?? "", title: title, followsLatest: true)
            return ArtifactViewController(session: session, artifact: artifact)
        default:
            return nil
        }
    }
}
#endif
