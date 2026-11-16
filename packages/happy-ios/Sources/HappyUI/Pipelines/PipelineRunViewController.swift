#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Desktop's run page on a phone, opened from a run's row: how the run
/// stands and its facts, the run that started it, its nodes in graph order,
/// the child runs they started, its input and result. A node opens its own
/// page, with its log. While the run is queued or running it can be
/// aborted, after a confirmation; it shows aborted only once the server
/// says so. Follows the run while it or a node's page shows
/// (`PipelineRunFeed`).
final class PipelineRunViewController: PipelinePageViewController<PipelineRunInput> {
    let feed: PipelineRunFeed

    init(session: Session, runId: String, pipelineName: String? = nil) {
        feed = PipelineRunFeed(runId: runId, engine: session.engine)
        super.init(session: session, input: PipelineRunInput(pipelineName: pipelineName), title: Strings.Pipelines.run)
    }

    deinit {
        Task { [feed] in await feed.finish() }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "pipeline-run"
        list.accessibilityIdentifier = "pipeline-run-list"
    }

    override func follow(_ pipeline: ApplyPipeline<PipelineRunInput, PipelineRows.Applied, Output>) {
        Self.follow(feed, engine: session.engine, into: pipeline, at: \.self, keep: keep)
    }

    /// Feeds the run's page's input, at `path` in a page's own, with the
    /// run's states and agents' names: the run's page and its nodes'.
    static func follow<Input: Sendable, Output: Sendable>(_ feed: PipelineRunFeed, engine: SyncEngine, into pipeline: ApplyPipeline<Input, PipelineRows.Applied, Output>,
                                                         at path: WritableKeyPath<Input, PipelineRunInput> & Sendable, keep: (Task<Void, Never>) -> Void) {
        keep(Task { [weak pipeline] in
            let states = await feed.states()
            pipeline?.follow(ifChanged: states) { input, state in
                guard input[keyPath: path].state != state else { return false }
                input[keyPath: path].state = state
                return true
            }
        })
        keep(Task { [weak pipeline] in
            let directories = await engine.feedDirectories()
            pipeline?.follow(ifChanged: directories) { input, directory in
                let agents = directory.agents.mapValues(\.name)
                guard input[keyPath: path].agents != agents else { return false }
                input[keyPath: path].agents = agents
                return true
            }
        })
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        Task { [feed] in await feed.start() }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        Task { [feed] in await feed.stop() }
    }

    override func open(_ target: PipelineRowTarget) {
        switch target {
        case .node(let nodeId):
            navigationController?.pushViewController(PipelineNodeViewController(session: session, run: feed, nodeId: nodeId), animated: true)
        case .abort:
            confirmAbort()
        default:
            super.open(target)
        }
    }

    private func confirmAbort() {
        typealias Text = Strings.Pipelines
        let alert = UIAlertController(title: Text.abortTitle, message: Text.abortMessage, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: Strings.Common.cancel, style: .cancel))
        alert.addAction(UIAlertAction(title: Text.abortConfirm, style: .destructive) { [feed] _ in
            Task { await feed.abort() }
        })
        present(alert, animated: true)
    }
}
#endif
