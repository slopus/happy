#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// A Happy Agent conversation's workspace changes as one scrolling diff,
/// as the session Changes screen shows a Happy CLI session's
/// (`SessionChangesViewController`): the workspace's git state against its
/// comparison base, each file read when its section comes near; more than
/// a few files start collapsed. Read over the agent API
/// (`AgentClient.workspaceGit`), afresh each time the screen comes back.
///
/// Follows the person's text size, as the list does.
final class WorkspaceChangesViewController: UIViewController {
    private let session: Session
    private let workspaceId: String
    private let list: DiffFilesListView
    private var stateView: UIView?
    private var appeared = false

    private enum GitLoad {
        case loading
        case error(String)
        case noRepository
        case ready(HappyAgentGitState, revision: Int)
    }
    private var gitLoad = GitLoad.loading
    private var gitRevision = 0
    private var gitStateTask: Task<Void, Never>?
    private var queue = HappyAgentChanges.FileQueue(files: [])
    private var expandedContext: Set<String> = []
    private static let openFiles = 5

    init(session: Session, workspaceId: String) {
        self.session = session
        self.workspaceId = workspaceId
        list = DiffFilesListView(render: RenderServices(session))
        super.init(nibName: nil, bundle: nil)
        followsTextSize()
        title = Strings.WorkspaceChanges.changes
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    deinit {
        gitStateTask?.cancel()
    }

    override func loadView() {
        view = UIView()
        view.backgroundColor = UIColor(Palette.surface)
        view.accessibilityIdentifier = "workspace-changes"
        list.isHidden = true
        view.addSubview(list)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        Analytics.shared.count(.diffsOpened)
        minimalBackButton()
        navigationItem.largeTitleDisplayMode = .never
        list.onRequestContent = { [weak self] path in self?.requestContent(path) }
        list.onExpandContext = { [weak self] path in
            guard let self, !self.expandedContext.contains(path) else { return }
            self.expandedContext.insert(path)
            self.render()
        }
        loadGitState()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // Coming back reads the workspace afresh; the first visit already
        // started its read.
        defer { appeared = true }
        if appeared { loadGitState() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        list.frame = view.bounds
        stateView?.frame = view.bounds
    }

    // MARK: Reading

    private func loadGitState() {
        gitStateTask?.cancel()
        gitRevision += 1
        let revision = gitRevision
        if case .ready = gitLoad {} else {
            gitLoad = .loading
            render()
        }
        let client = session.client
        let workspaceId = workspaceId
        gitStateTask = Task { [weak self] in
            let result: Result<HappyAgentGitState?, any Error>
            do { result = .success(try await client.workspaceGit(workspaceId)) } catch { result = .failure(error) }
            guard let self, !Task.isCancelled, revision == self.gitRevision else { return }
            switch result {
            case .success(let state?):
                self.gitLoad = .ready(state, revision: revision)
                // A new snapshot gets its own reads and context.
                self.queue = HappyAgentChanges.FileQueue(files: state.files)
                self.expandedContext = []
                self.list.reset()
            case .success(nil):
                self.gitLoad = .noRepository
            case .failure(let error):
                self.gitLoad = .error(Self.message(error, fallback: Strings.ChangesDetail.loadFailed))
                if let code = AnalyticsEvent.ErrorCode(error) { Analytics.shared.errorShown(.diffLoad, code) }
            }
            self.render()
        }
    }

    private static func message(_ error: any Error, fallback: String) -> String {
        if case SessionActionError.failed(let message) = error { return message }
        if case AgentClientError.status(_, _, let message?) = error, !message.isEmpty { return message }
        return fallback
    }

    private func render() {
        switch gitLoad {
        case .loading:
            show(state: spinner())
        case .noRepository:
            show(state: ChangesMessageView(message: Strings.WorkspaceChanges.noRepository, onRetry: nil))
        case .error(let message):
            show(state: ChangesMessageView(message: message, onRetry: { [weak self] in self?.loadGitState() }))
        case .ready(let state, _):
            guard HappyAgentChanges.base(state) != nil else {
                show(state: ChangesMessageView(message: Strings.ChangesDetail.comparisonUnavailable, onRetry: { [weak self] in self?.loadGitState() }))
                return
            }
            showList()
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
                // A few files open at once; more wait for the reader.
                defaultCollapsed: state.files.count > Self.openFiles
            )
        }
    }

    private func requestContent(_ path: String) {
        queue.request(path)
        startReads()
    }

    private func startReads() {
        guard case .ready(let state, let revision) = gitLoad, let base = HappyAgentChanges.base(state) else { return }
        let client = session.client
        let workspaceId = workspaceId
        for path in queue.start() {
            guard let file = state.files.first(where: { $0.path == path }) else { continue }
            Task { [weak self] in
                let result: HappyAgentChanges.FileResult
                do {
                    result = .content(try await client.workspaceFileContent(workspaceId, base: base, file: file))
                } catch {
                    result = .error(Self.message(error, fallback: Strings.ChangesDetail.fileLoadFailed))
                }
                // Replies for an older snapshot are dropped with it.
                guard let self, case .ready(_, let current) = self.gitLoad, current == revision else { return }
                self.queue.finish(path, result)
                self.render()
                self.startReads()
            }
        }
    }

    // MARK: States

    private func spinner() -> UIView {
        let indicator = UIActivityIndicatorView(style: .medium)
        indicator.color = UIColor(Palette.textSecondary)
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
#endif
