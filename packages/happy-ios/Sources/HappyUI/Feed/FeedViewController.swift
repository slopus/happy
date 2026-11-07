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
/// The bar's filter shows all of Activity or its Highlights, the entries
/// about artifacts and tasks, as the person last chose on this computer
/// (`FeedLibrary.setFilter`). An artifact's entry with a cover or a
/// summary is a post: its row, its summary, cut at four lines until Show
/// more opens it in place, and its cover across the card (`FeedCoverView`).
///
/// The entries are the engine's (`FeedLibrary`), kept on the phone and
/// followed through its events, so the screen opens on what it last
/// showed. They are references only: every row is joined, off the main
/// thread, with the account's directory (`SyncEngine.feedDirectories`),
/// so a task renamed or a picture changed redraws exactly the rows that
/// show it, and an entry whose subject isn't synced isn't shown.
/// Following and peeking ask the computer, as on desktop.
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
    private lazy var filterItem: UIBarButtonItem = {
        // Home's filter, its menu checking the one chosen.
        let item = UIBarButtonItem(image: .icon(.ionicons("filter"), size: 22), menu: filterMenu(.all))
        item.accessibilityIdentifier = "feed-filter"
        item.accessibilityLabel = Strings.Feed.words.filter
        item.accessibilityValue = Strings.Feed.words.name(.all)
        item.preferredMenuElementOrder = .fixed
        return item
    }()
    /// The filter the bar shows as chosen.
    private var shownFilter = FeedFilter.all
    private var pipeline: ApplyPipeline<FeedListInput, Applied, Output>?
    private var clustersPipeline: ApplyPipeline<FeedClustersInput, Applied, ClustersOutput>?
    private var watching: Task<Void, Never>?
    private var reading: Task<Void, Never>?
    /// The entries the rows on screen show, and the rows, by ID.
    private(set) var entries: [String: FeedItem] = [:]
    private(set) var rows: [String: FeedRow] = [:]
    /// The places Following names, by cluster.
    private var places: [String: FeedPlace] = [:]
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
    /// The posts whose summary is open in full, by entry.
    private(set) var expanded: Set<String> = []

    struct Applied: Sendable {
        var items: [String: CardItem] = [:]
        var order: [String] = []
        var counter: UInt64 = 0
    }

    struct Output: Sendable {
        var items: [CardItem]
        var faces: [String: FeedFace]
        var entries: [String: FeedItem]
        var rows: [String: FeedRow]
        var lastEntryId: String?
        /// Open among the entries the filter shows.
        var unread: Int
        var filter: FeedFilter
        var hasMore: Bool
        var loadingMore: Bool
        var width: CGFloat
        var replan: @Sendable (CGFloat) -> [CardItem]
    }

    struct ClustersOutput: Sendable {
        var items: [CardItem]
        var faces: [String: FeedFace]
        var places: [String: FeedPlace]
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
        activity.onSelectAt = { [weak self] id, point in
            guard let self else { return }
            if FeedListItems.toggleHit(activity.items.first { $0.id == id }, at: point) { toggleSummary(id) } else { open(id) }
        }
        activity.accessibilityActions = { [weak self] id in self?.summaryActions(id) ?? [] }
        activity.onScroll = { [weak self] in self?.loadMoreIfNeeded() }
        activity.makeOverlay = { [weak self] overlay, id in
            guard let self else { return nil }
            if overlay.kind == FeedListItems.coverKind { return makeCover(overlay, id: id) }
            return makeFace(overlay, faces: faces)
        }
        following.onSelect = { [weak self] id in self?.peek(id) }
        following.makeOverlay = { [weak self] overlay, id in self?.makeClusterOverlay(overlay, id: id) }
        following.accessibilityActions = { [weak self] id in self?.clusterActions(id) ?? [] }
        setUpBar()

        let words = Strings.Feed.words
        var input = FeedListInput(words: words, dates: .current)
        input.personSeed = session.personSeed
        let pipeline = ApplyPipeline<FeedListInput, Applied, Output>(
            input: input,
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
        watching = Task { [feed, engine = session.engine, weak pipeline, weak clustersPipeline] in
            let states = await feed.states()
            pipeline?.follow(ifChanged: states) { input, state in
                guard input.state != state else { return false }
                input.state = state
                return true
            }
            // One directory per account; each list joins its own rows with it.
            pipeline?.follow(ifChanged: await engine.feedDirectories()) { input, directory in
                guard input.directory != directory else { return false }
                input.directory = directory
                return true
            }
            clustersPipeline?.follow(ifChanged: await engine.feedDirectories()) { input, directory in
                guard input.directory != directory else { return false }
                input.directory = directory
                return true
            }
            await feed.refresh()
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
        navigationItem.rightBarButtonItems = [readAllItem, filterItem]
    }

    /// All or Highlights, the chosen one checked.
    private func filterMenu(_ chosen: FeedFilter) -> UIMenu {
        let words = Strings.Feed.words
        let actions = FeedFilter.allCases.map { filter in
            let action = UIAction(title: words.name(filter), state: filter == chosen ? .on : .off) { [weak self] _ in self?.choose(filter) }
            action.accessibilityIdentifier = "feed-filter:\(filter.rawValue)"
            return action
        }
        return UIMenu(title: words.filter, options: .singleSelection, children: actions)
    }

    func choose(_ filter: FeedFilter) {
        showFilter(filter)
        Task { [feed] in await feed.setFilter(filter) }
    }

    private func showFilter(_ filter: FeedFilter) {
        guard filter != shownFilter else { return }
        shownFilter = filter
        filterItem.menu = filterMenu(filter)
        // Lit while it hides anything, as a toggled bar button is.
        filterItem.isSelected = filter != .all
        filterItem.accessibilityValue = Strings.Feed.words.name(filter)
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
        let personSeed = session.personSeed
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
            input.personSeed = personSeed
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
        guard order != applied.order || !items.allSatisfy({ applied.items[$0.id]?.revision == $0.revision }) else { return nil }
        var entries: [String: FeedItem] = [:]
        for entry in input.state.items { entries[entry.id] = entry }
        let rows = Dictionary(next.rows.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let state = Applied(items: Dictionary(items.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first }), order: order, counter: counter)
        let replan: @Sendable (CGFloat) -> [CardItem] = { width in
            var input = input
            input.width = width
            return FeedListItems.items(input).items
        }
        let output = Output(
            items: items, faces: next.faces, entries: entries, rows: rows, lastEntryId: input.state.items.last?.id,
            unread: input.state.shownUnread, filter: input.state.filter, hasMore: input.state.hasMore, loadingMore: input.state.loadingMore,
            width: input.width, replan: replan
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
        var places: [String: FeedPlace] = [:]
        for cluster in input.clusters { places[cluster.cluster] = FeedPlace(cluster, directory: input.directory) }
        return (ClustersOutput(items: items, faces: next.faces, places: places, width: input.width, replan: replan), state)
    }

    private func show(_ output: Output) -> Bool {
        guard output.width == activity.contentWidth else { return false }
        entries = output.entries
        rows = output.rows
        faces.merge(output.faces) { _, new in new }
        lastEntryId = output.lastEntryId
        hasMore = output.hasMore
        loadingMore = output.loadingMore
        readAllItem.isEnabled = output.unread > 0
        showFilter(output.filter)
        activity.apply(output.items, animated: true, replan: output.replan)
        loadMoreIfNeeded()
        return true
    }

    private func show(_ output: ClustersOutput) -> Bool {
        guard output.width == following.contentWidth else { return false }
        places = output.places
        clusterFaces.merge(output.faces) { _, new in new }
        following.apply(output.items, animated: true, replan: output.replan)
        return true
    }

    // MARK: Activity

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
        guard let entry = entries[id], let row = rows[id] else { return }
        Task { [feed] in await feed.open(entry) }
        FeedOpening.open(row, session: session, from: self)
    }

    /// Opens a post's summary in full, or cuts it back to four lines.
    func toggleSummary(_ id: String) {
        expanded.formSymmetricDifference([id])
        let expanded = expanded
        pipeline?.update { $0.expanded = expanded }
    }

    private func summaryActions(_ id: String) -> [UIAccessibilityCustomAction] {
        guard FeedListItems.toggles(activity.items.first { $0.id == id }) else { return [] }
        let words = Strings.Feed.words
        return [UIAccessibilityCustomAction(name: expanded.contains(id) ? words.showLess : words.showMore) { [weak self] _ in
            self?.toggleSummary(id)
            return true
        }]
    }

    /// A post's cover, read at the size it is drawn.
    private func makeCover(_ overlay: CardOverlay, id: String) -> UIView? {
        guard let cover = rows[id]?.post?.cover else { return nil }
        return FeedCoverView(cover: cover, frame: overlay.frame, radius: overlay.radius, displayScale: traitCollection.displayScale, images: session.images)
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
        navigationItem.rightBarButtonItems = showsFollowing ? nil : [readAllItem, filterItem]
        if showsFollowing { readClusters() }
    }

    /// The places, read again each time Following shows: they live on the
    /// computer alone, as desktop's do.
    private func readClusters() {
        reading?.cancel()
        reading = Task { [weak self, feed] in
            let result: Result<[FeedCluster], Error>
            do { result = .success(try await feed.clusters()) } catch { result = .failure(error) }
            guard !Task.isCancelled, let self else { return }
            switch result {
            case .success(let clusters):
                clustersRead = true
                showClusters(clusters, error: nil)
                Task { [engine = session.engine] in await engine.feedPlacesShown(clusters) }
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
            toggle.accessibilityLabel = Strings.Feed.words.follow(name(id))
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
        return [UIAccessibilityCustomAction(name: follows ? words.mute(name(id)) : words.follow(name(id))) { [weak self] _ in
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

    /// What a listed place is called, as its row says it.
    private func name(_ id: String) -> String {
        places[id].map { Strings.Feed.words.name($0.name) } ?? ""
    }

    private func peek(_ id: String) {
        guard let cluster = clusters[id], let place = places[id] else { return }
        navigationController?.pushViewController(FeedPeekViewController(session: session, cluster: cluster, place: place), animated: true)
    }
}

/// A place's newest entries, as Following peeks at them: the same rows as
/// the feed's, without the dot, read from the computer each time and
/// joined with the same directory, which the place's name follows too.
final class FeedPeekViewController: UIViewController {
    private let session: Session
    private let feed: FeedLibrary
    private let cluster: FeedCluster
    let list = CardListView()
    private var pipeline: ApplyPipeline<FeedListInput, FeedViewController.Applied, FeedViewController.Output>?
    private var reading: Task<Void, Never>?
    private var naming: Task<Void, Never>?
    private var rows: [String: FeedRow] = [:]
    private var faces: [String: FeedFace] = [:]
    private var expanded: Set<String> = []

    init(session: Session, cluster: FeedCluster, place: FeedPlace) {
        self.session = session
        feed = session.engine.feed
        self.cluster = cluster
        super.init(nibName: nil, bundle: nil)
        title = Strings.Feed.words.name(place.name)
        navigationItem.largeTitleDisplayMode = .never
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    deinit {
        reading?.cancel()
        naming?.cancel()
        pipeline?.cancel()
        // Its entries no longer name anything worth looking up.
        Task { [engine = session.engine] in await engine.feedPeeking([]) }
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
        list.onSelectAt = { [weak self] id, point in
            guard let self else { return }
            if FeedListItems.toggleHit(list.items.first { $0.id == id }, at: point) { toggleSummary(id) } else { open(id) }
        }
        list.makeOverlay = { [weak self] overlay, id in
            guard let self else { return nil }
            if overlay.kind == FeedListItems.coverKind, let cover = rows[id]?.post?.cover {
                return FeedCoverView(cover: cover, frame: overlay.frame, radius: overlay.radius, displayScale: traitCollection.displayScale, images: session.images)
            }
            guard let face = faces[overlay.key] else { return nil }
            return FeedFaceView(face: face, radius: overlay.radius, ringed: overlay.kind == FeedListItems.actorKind, side: overlay.frame.width, images: session.images)
        }
        var input = FeedListInput(words: Strings.Feed.words, dates: .current)
        input.peek = true
        input.personSeed = session.personSeed
        let pipeline = ApplyPipeline<FeedListInput, FeedViewController.Applied, FeedViewController.Output>(
            input: input,
            state: FeedViewController.Applied(),
            derive: { input, applied in FeedViewController.derive(input, applied: applied) },
            apply: { [weak self] output in self?.show(output) ?? false }
        )
        self.pipeline = pipeline
        let cluster = cluster
        naming = Task { [weak self, weak pipeline, engine = session.engine] in
            let directories = await engine.feedDirectories()
            pipeline?.follow(ifChanged: directories) { input, directory in
                guard input.directory != directory else { return false }
                input.directory = directory
                return true
            }
            // The place's own name, as it is now.
            for await directory in await engine.feedDirectories() {
                guard let self, let place = FeedPlace(cluster, directory: directory) else { continue }
                let name = Strings.Feed.words.name(place.name)
                if title != name { title = name }
            }
        }
        registerForTraitChanges(UIView.textSizeTraits + [UITraitUserInterfaceStyle.self, UITraitDisplayScale.self]) { (self: Self, _) in
            self.updateInput()
        }
        read()
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

    private func read() {
        reading?.cancel()
        reading = Task { [weak self, feed, cluster] in
            let result: Result<FeedPeek, Error>
            do { result = .success(try await feed.peek(cluster.cluster)) } catch { result = .failure(error) }
            let covers = await feed.current.covers
            guard !Task.isCancelled, let self else { return }
            if case .success(let peek) = result {
                Task { [engine = session.engine] in await engine.feedPeeking(peek.entries) }
            }
            pipeline?.update { input in
                input.state.loaded = true
                input.state.available = true
                input.state.covers = covers
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
        rows = output.rows
        faces.merge(output.faces) { _, new in new }
        list.apply(output.items, animated: true, replan: output.replan)
        return true
    }

    private func open(_ id: String) {
        guard let row = rows[id] else { return }
        FeedOpening.open(row, session: session, from: self)
    }

    private func toggleSummary(_ id: String) {
        expanded.formSymmetricDifference([id])
        let expanded = expanded
        pipeline?.update { $0.expanded = expanded }
    }
}

/// Where a Feed entry goes when it is opened: a task's or a bot's chat, a
/// Surface's screen, an artifact's viewer, as its row resolved them from
/// the directory. Chats count themselves read, which counts them seen;
/// Surfaces and artifacts tell the Feed they were opened (`SurfaceScreens`,
/// `ArtifactViewController`).
@MainActor
enum FeedOpening {
    static func open(_ row: FeedRow, session: Session, from controller: UIViewController) {
        if case .artifact(let artifact) = row.target { return controller.openArtifact(artifact, session: session) }
        guard let next = screen(row, session: session) else { return }
        controller.navigationController?.pushViewController(next, animated: true)
    }

    static func screen(_ row: FeedRow, session: Session) -> UIViewController? {
        switch row.target {
        case .chat(let agentId, let title):
            let home = session.home.allRows.first { $0.agentId == agentId && $0.kind == .space }
            session.warm.tap(agentId)
            return ChatViewController(session: session, agentId: agentId, title: title, spaceId: home?.spaceId, intro: nil)
        case .surface(let surface):
            return SurfaceScreens.make(session: session, surface: surface)
        case .artifact(let artifact):
            return ArtifactViewController(session: session, artifact: artifact)
        case nil:
            return nil
        }
    }
}
#endif
