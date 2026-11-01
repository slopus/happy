#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit
import UltraView

/// Desktop's fixed Artifacts row: every artifact of the computer in home's
/// inset grouped cards, grouped by when it last changed (Today, Yesterday,
/// the previous seven and thirty days, then by month), newest first. It
/// opens on the list it last showed, kept on the phone
/// (`ArtifactCatalogFeed`), reads the whole catalog again, then follows
/// its events; a pull reads it again. The bar's search filters by title
/// and kind. A row opens the artifact viewer on the latest version.
final class ArtifactsViewController: UIViewController, UISearchResultsUpdating {
    private let session: Session
    private let feed: ArtifactCatalogFeed
    private let thumbnails: ArtifactThumbnails
    let list = CardListView()
    private lazy var searchController = UISearchController(searchResultsController: nil)
    private var pipeline: ApplyPipeline<ArtifactListInput, Applied, Output>?
    private var headerWatch: Watch?
    private var following: Task<Void, Never>?
    /// What the rows on screen show, by ID.
    private(set) var artifacts: [String: ArtifactSummary] = [:]
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
        var artifacts: [String: ArtifactSummary]
        var width: CGFloat
        var refreshing: Bool
    }

    init(session: Session) {
        self.session = session
        feed = ArtifactCatalogFeed(engine: session.engine)
        thumbnails = ArtifactThumbnails(session: session)
        super.init(nibName: nil, bundle: nil)
        title = Strings.Artifacts.title
        navigationItem.largeTitleDisplayMode = .never
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    // Not `isolated deinit`: that aborts on the iOS 26.3 runtime (see
    // `Watch`). Cancelling needs no actor.
    deinit {
        following?.cancel()
        pipeline?.cancel()
        Task { [feed] in await feed.stop() }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        followsTextSize()
        view.backgroundColor = UIColor(Palette.groupedGround)
        view.accessibilityIdentifier = "direct-artifacts"
        list.accessibilityIdentifier = "artifacts-list"
        view.addSubview(list)
        list.onSelect = { [weak self] id in self?.open(id) }
        list.onRefresh = { [weak self] in self?.refresh() }
        list.menu = { [weak self] id in self?.menu(id) }
        list.makeOverlay = { [weak self] overlay, id in self?.makeOverlay(overlay, id: id) }
        setUpBar()

        let pipeline = ApplyPipeline<ArtifactListInput, Applied, Output>(
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
            await feed.start()
        }
        registerForTraitChanges(UIView.textSizeTraits + [UITraitUserInterfaceStyle.self, UITraitDisplayScale.self]) { (self: Self, _) in
            self.updateInput()
        }
        NotificationCenter.default.addObserver(self, selector: #selector(dayChanged), name: .NSCalendarDayChanged, object: nil)
        headerWatch = session.watchHeader { [weak self] state in
            self?.navigationItem.title = Strings.HeaderStatus.title(state) ?? Strings.Artifacts.title
        }
    }

    /// The bar's own search, growing into a field in it, as Settings'.
    private func setUpBar() {
        HeaderBar.edge(list.edge, in: self)
        searchController.searchResultsUpdater = self
        searchController.obscuresBackgroundDuringPresentation = false
        searchController.searchBar.placeholder = Strings.Artifacts.search
        searchController.searchBar.searchTextField.accessibilityIdentifier = "artifacts-search-field"
        navigationItem.searchController = searchController
        navigationItem.hidesSearchBarWhenScrolling = false
        navigationItem.preferredSearchBarPlacement = .integratedButton
        if #available(iOS 26.0, *) { navigationItem.searchBarPlacementAllowsToolbarIntegration = false }
        definesPresentationContext = true
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // Today may be yesterday by now.
        updateInput()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        list.frame = view.bounds
        let safe = view.safeAreaInsets
        list.setInsets(UIEdgeInsets(top: safe.top + CardListMetrics.contentTop, left: 0, bottom: safe.bottom + CardListMetrics.contentBottom, right: 0))
        updateInput()
    }

    // MARK: Derivation

    private func currentInput() -> ArtifactListInput {
        var input = ArtifactListInput(words: .current)
        input.width = list.bounds.width
        input.maxWidth = ContentWidth.maxWidth
        input.scale = traitCollection.textEnvironment?.scale.multiplier ?? 1
        input.displayScale = traitCollection.displayScale > 0 ? traitCollection.displayScale : 2
        input.dark = traitCollection.userInterfaceStyle == .dark
        input.query = searchController.searchBar.text ?? ""
        input.now = Date()
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
            input.query = next.query
            input.now = next.now
            input.words = next.words
        }
    }

    @objc private func dayChanged() { updateInput() }

    nonisolated static func derive(_ input: ArtifactListInput, applied: Applied) -> (output: Output, state: Applied)? {
        let next = ArtifactListItems.items(input)
        var counter = applied.counter
        let items = CardItems.revise(next, previous: applied.items, counter: &counter)
        let order = items.map(\.id)
        let refreshing = input.state.refreshing
        let unchanged = order == applied.order && refreshing == applied.refreshing && items.allSatisfy { applied.items[$0.id]?.revision == $0.revision }
        guard !unchanged else { return nil }
        var artifacts: [String: ArtifactSummary] = [:]
        for artifact in input.state.items { artifacts[artifact.id] = artifact }
        let state = Applied(items: Dictionary(items.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first }), order: order, counter: counter, refreshing: refreshing)
        return (Output(items: items, artifacts: artifacts, width: input.width, refreshing: refreshing), state)
    }

    private func show(_ output: Output) -> Bool {
        guard output.width == list.bounds.width else { return false }
        artifacts = output.artifacts
        list.apply(output.items, animated: true)
        if pulled, !output.refreshing {
            pulled = false
            list.refreshing = false
        }
        return true
    }

    // MARK: Acts

    func updateSearchResults(for searchController: UISearchController) { updateInput() }

    private func refresh() {
        pulled = true
        Task { [feed] in await feed.refresh() }
    }

    private func open(_ id: String) {
        guard let artifact = artifacts[id] else { return }
        navigationController?.pushViewController(ArtifactViewController(session: session, artifact: artifact.artifact), animated: true)
    }

    private func menu(_ id: String) -> UIMenu? {
        guard let artifact = artifacts[id] else { return nil }
        let title = artifact.title.isEmpty ? Strings.untitledArtifact : artifact.title
        return UIMenu(children: [
            UIAction(title: Strings.Artifacts.open, image: Glyphs.image("chevron-forward", size: 20)) { [weak self] _ in self?.open(id) },
            UIAction(title: Strings.Artifacts.copyTitle, image: Glyphs.image("copy-outline", size: 20)) { _ in UIPasteboard.general.string = title },
        ])
    }

    private func makeOverlay(_ overlay: CardOverlay, id: String) -> UIView? {
        guard overlay.kind == "thumbnail", let artifact = artifacts[id] else { return nil }
        let view = ArtifactThumbnailView(radius: overlay.radius)
        let pixels = Int((overlay.frame.width * max(traitCollection.displayScale, 2)).rounded(.up))
        thumbnails.show(artifact, in: view, pixels: pixels)
        return view
    }
}
#endif
