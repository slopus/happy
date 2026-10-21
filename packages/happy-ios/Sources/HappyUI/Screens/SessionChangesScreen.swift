#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyStore
import HappyWire
import UIKit

/// app/(app)/session/[id]/changes.tsx and components/AllFilesDiffView.tsx:
/// the session's changes as one scrolling diff. A Happy Agent session
/// compares its workspace with the branch base (HappyAgentDiffView); a CLI
/// session shows its uncommitted files from git status.
///
/// Follows the person's text size: the list measures its sections at it
/// off the main thread and keeps the reader's place when it changes.
final class SessionChangesViewController: UIViewController {
    private let context: AppContext
    private let session: AccountSession
    private let sessionId: String
    private let list: DiffFilesListView
    private var stateView: UIView?
    private var observation: ApplyObservation?
    private var metadata: JSONValue?
    private var appeared = false
    private var mode: Mode?

    private enum Mode: Equatable { case legacy, happyAgent }

    // The legacy viewer.
    private var gitTask: Task<Void, Never>?
    private var gitFiles: [GitFileStatus] = []
    private var legacy = LegacyChanges.State()
    /// Files the reader asked to see in full.
    private var expandedPaths: Set<String> = []

    // The Happy Agent viewer.
    private enum GitLoad {
        case loading
        case error(String)
        case ready(HappyAgentGitState, revision: Int)
    }
    private var gitLoad = GitLoad.loading
    private var gitRevision = 0
    private var gitStateTask: Task<Void, Never>?
    private var queue = HappyAgentChanges.FileQueue(files: [])
    private var expandedContext: Set<String> = []

    init(context: AppContext, session: AccountSession, sessionId: String) {
        self.context = context
        self.session = session
        self.sessionId = sessionId
        list = DiffFilesListView(render: RenderServices(session))
        super.init(nibName: nil, bundle: nil)
        followsTextSize()
        setPlainHeaderTitle(Strings.ChangesDetail.title)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    deinit {
        gitTask?.cancel()
        gitStateTask?.cancel()
    }

    override func loadView() {
        view = UIView()
        view.backgroundColor = UIColor(Palette.surface)
        list.isHidden = true
        view.addSubview(list)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        showsBackTitle()
        // The session's metadata from the account's shared feed, found and
        // compared off the main thread; a new message's activity stamp is
        // not something these viewers read.
        let sessionId = self.sessionId
        let pipeline = ApplyPipeline<HomeSnapshot?, JSONValue??, JSONValue?>(
            input: nil,
            state: nil,
            derive: { snapshot, applied in
                guard let snapshot else { return nil }
                let metadata = snapshot.sessions.first { $0.id == sessionId }.map { ChatSessionState.rendered($0).metadata } ?? nil
                return applied == .some(metadata) ? nil : (metadata, metadata)
            },
            apply: { [weak self] metadata in
                guard let self, self.context.account.session === self.session else { return false }
                ApplyPerf.measure(.screen) {
                    self.metadataChanged(metadata)
                    return 1
                }
                return true
            }
        )
        pipeline.follow(session.homeFeed.snapshots()) { $0 = $1 }
        observation = pipeline.observation
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // useFocusEffect: coming back to the screen reads the workspace (or
        // git status) afresh. The first visit already started its read.
        defer { appeared = true }
        guard appeared else { return }
        switch mode {
        case .happyAgent?: loadGitState()
        case .legacy?:
            let git = session.detailGitStatus
            let id = sessionId
            Task { await git.refresh(sessionId: id) }
        case nil: break
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        list.frame = view.bounds
        stateView?.frame = view.bounds
    }

    /// Called when the metadata changed; only what the viewers read from it
    /// counts. Streaming metadata never re-scans Git.
    private func metadataChanged(_ metadata: JSONValue?) {
        guard let metadata else {
            if mode == nil, stateView == nil { show(state: spinner(color: nil)) }
            return
        }
        let wasSupported = SessionActions.supportsHappyAgentGit(self.metadata)
        let oldPath = self.metadata?["path"]?.stringValue
        self.metadata = metadata
        let next: Mode = RigCatalog.isRig(metadata) ? .happyAgent : .legacy
        guard next == mode else {
            mode = next
            switch next {
            case .legacy: startLegacy()
            case .happyAgent: loadGitState()
            }
            return
        }
        switch next {
        case .legacy where metadata["path"]?.stringValue != oldPath:
            reconcileLegacy()
        case .happyAgent where SessionActions.supportsHappyAgentGit(metadata) != wasSupported:
            loadGitState()
        default:
            break
        }
    }

    // MARK: Legacy

    private func startLegacy() {
        let git = session.detailGitStatus
        let id = sessionId
        gitTask = Task { [weak self] in
            for await status in await git.observe(sessionId: id) {
                guard let self, !Task.isCancelled else { return }
                self.gitFiles = LegacyChanges.files(status)
                self.reconcileLegacy()
            }
        }
        Task { await git.refresh(sessionId: id) }
        list.onExpandContext = { [weak self] path in
            guard let self, !self.expandedPaths.contains(path) else { return }
            self.expandedPaths.insert(path)
            self.reconcileLegacy()
        }
        reconcileLegacy()
    }

    private func reconcileLegacy() {
        let toFetch = legacy.reconcile(gitFiles, expanded: expandedPaths, ignoreWhitespace: false)
        renderLegacy()
        guard !toFetch.isEmpty else { return }
        let path = metadata?["path"]?.stringValue
        let expanded = expandedPaths
        let transport = LegacyChanges.Transport(actions: session.actions, sessionId: sessionId)
        Task { [weak self] in
            let results = await withTaskGroup(of: (Int, LegacyChanges.Result).self) { group in
                for (index, file) in toFetch.enumerated() {
                    group.addTask {
                        (index, await LegacyChanges.fetch(file, sessionPath: path, expanded: expanded.contains(file.fullPath), ignoreWhitespace: false, transport: transport))
                    }
                }
                var results: [(Int, LegacyChanges.Result)] = []
                for await result in group { results.append(result) }
                return results.sorted { $0.0 < $1.0 }.map(\.1)
            }
            guard let self else { return }
            self.legacy.receive(results)
            // Files that changed while they were in flight fetch again now.
            self.reconcileLegacy()
        }
    }

    private func renderLegacy() {
        if legacy.isLoading(fileCount: gitFiles.count) {
            show(state: spinner(color: Palette.textSecondary))
            return
        }
        if gitFiles.isEmpty {
            show(state: ChangesMessageView(message: Strings.FilesDetail.noChanges, onRetry: nil))
            return
        }
        showList()
        list.update(items: LegacyChanges.items(gitFiles, results: legacy.results), emptyText: Strings.FilesDetail.noChanges, defaultCollapsed: true)
    }

    // MARK: Happy Agent

    private func loadGitState() {
        guard SessionActions.supportsHappyAgentGit(metadata) else {
            show(state: ChangesMessageView(message: Strings.ChangesDetail.updateHappyAgent, onRetry: nil))
            return
        }
        gitStateTask?.cancel()
        gitRevision += 1
        let revision = gitRevision
        gitLoad = .loading
        renderHappyAgent()
        let actions = session.actions
        let id = sessionId
        gitStateTask = Task { [weak self] in
            let result: Result<HappyAgentGitState, any Error>
            do { result = .success(try await actions.getHappyAgentGitState(sessionId: id)) } catch { result = .failure(error) }
            guard let self, !Task.isCancelled, revision == self.gitRevision else { return }
            switch result {
            case .success(let state):
                self.gitLoad = .ready(state, revision: revision)
                // A new snapshot gets its own reads and context.
                self.queue = HappyAgentChanges.FileQueue(files: state.files)
                self.expandedContext = []
                self.list.reset()
            case .failure(let error):
                self.gitLoad = .error(Self.message(error))
            }
            self.renderHappyAgent()
        }
    }

    private static func message(_ error: any Error) -> String {
        if case SessionActionError.failed(let message) = error { return message }
        return Strings.ChangesDetail.loadFailed
    }

    private func renderHappyAgent() {
        switch gitLoad {
        case .loading:
            show(state: spinner(color: Palette.textSecondary))
        case .error(let message):
            show(state: ChangesMessageView(message: message, onRetry: { [weak self] in self?.loadGitState() }))
        case .ready(let state, _):
            guard HappyAgentChanges.base(state) != nil else {
                show(state: ChangesMessageView(message: Strings.ChangesDetail.comparisonUnavailable, onRetry: { [weak self] in self?.loadGitState() }))
                return
            }
            showList()
            list.onRequestContent = { [weak self] path in self?.requestContent(path) }
            list.onExpandContext = { [weak self] path in
                guard let self, !self.expandedContext.contains(path) else { return }
                self.expandedContext.insert(path)
                self.renderHappyAgent()
            }
            list.update(
                items: HappyAgentChanges.items(
                    state.files,
                    results: queue.results,
                    expandedContext: expandedContext,
                    ignoreWhitespace: false,
                    matchText: Strings.ChangesDetail.contentsMatch,
                    emptyText: Strings.FilesDetail.fileEmpty
                ),
                notices: HappyAgentChanges.notices(state),
                emptyText: HappyAgentChanges.isClean(state) ? Strings.FilesDetail.noChanges : Strings.ChangesDetail.noFileDetails,
                defaultCollapsed: true
            )
        }
    }

    private func requestContent(_ path: String) {
        queue.request(path)
        startReads()
    }

    private func startReads() {
        guard case .ready(let state, let revision) = gitLoad, let base = HappyAgentChanges.base(state) else { return }
        let actions = session.actions
        let id = sessionId
        for path in queue.start() {
            guard let file = state.files.first(where: { $0.path == path }) else { continue }
            Task { [weak self] in
                let result: HappyAgentChanges.FileResult
                do {
                    result = .content(try await actions.readHappyAgentGitFile(sessionId: id, gitBase: base, file: file))
                } catch {
                    result = .error(Self.fileMessage(error))
                }
                // Replies for an older snapshot are dropped with it.
                guard let self, case .ready(_, let current) = self.gitLoad, current == revision else { return }
                self.queue.finish(path, result)
                self.renderHappyAgent()
                self.startReads()
            }
        }
    }

    private static func fileMessage(_ error: any Error) -> String {
        if case SessionActionError.failed(let message) = error { return message }
        return Strings.ChangesDetail.fileLoadFailed
    }

    // MARK: States

    private func spinner(color: ColorToken?) -> UIView {
        let indicator = UIActivityIndicatorView(style: .medium)
        if let color { indicator.color = UIColor(color) }
        indicator.startAnimating()
        return DetailMessageView(lead: indicator, lines: [], padding: 20, background: Palette.surface)
    }

    private func show(state: UIView) {
        stateView?.removeFromSuperview()
        stateView = state
        list.isHidden = true
        state.frame = view.bounds
        view.addSubview(state)
    }

    private func showList() {
        stateView?.removeFromSuperview()
        stateView = nil
        list.isHidden = false
    }
}

/// HappyAgentDiffView's ChangesMessage (and the legacy viewer's empty
/// text): a centred message, with Retry under it when there is something to
/// retry.
private final class ChangesMessageView: UIView {
    private let label = StyledLabel(style: DiffTextStyles.body, color: Palette.textSecondary, alignment: .center)
    private let retry = UIControl()
    private let retryLabel = StyledLabel(style: DiffTextStyles.retry, color: Palette.text, lines: 1)
    private let onRetry: (() -> Void)?

    /// `<Pressable style={{ padding: 12, marginTop: 8 }}>`.
    static let retryPadding: CGFloat = 12
    static let retrySpacing: CGFloat = 8
    static let padding: CGFloat = 20

    init(message: String, onRetry: (() -> Void)?) {
        self.onRetry = onRetry
        super.init(frame: .zero)
        backgroundColor = UIColor(Palette.surface)
        label.string = message
        addSubview(label)
        if onRetry != nil {
            retryLabel.string = Strings.FilesDetail.retry
            retryLabel.isUserInteractionEnabled = false
            retry.addSubview(retryLabel)
            retry.addTarget(self, action: #selector(retryTapped), for: .touchUpInside)
            retry.accessibilityLabel = Strings.FilesDetail.retry
            retry.accessibilityTraits = .button
            retry.isAccessibilityElement = true
            addSubview(retry)
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        var items = [CenteredStackLayout.Item(label.measurable)]
        let retrySize = retryLabel.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude))
        if onRetry != nil {
            let padded = CGSize(width: retrySize.width + Self.retryPadding * 2, height: retrySize.height + Self.retryPadding * 2)
            items.append(.init(.fixed(padded), spacingBefore: Self.retrySpacing))
        }
        let frames = CenteredStackLayout(.init(size: bounds.size, padding: Self.padding, items: items)).items
        label.setLayoutFrame(frames[0])
        if frames.count > 1 {
            retry.setLayoutFrame(frames[1])
            retryLabel.setLayoutFrame(CGRect(x: Self.retryPadding, y: Self.retryPadding, width: retrySize.width, height: retrySize.height))
        }
    }

    @objc private func retryTapped() {
        onRetry?()
    }
}
#endif
