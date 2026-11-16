#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// One node of a run, opened from its row on the run's page: how it stands,
/// how it failed, what its model spent, the computers it holds, its input
/// and output, and its log at the foot (`PipelineNodeLogFeed`). A command's
/// output opens and folds with a tap. While the reader is at the foot the
/// page follows the log's tail as it grows; a running node's page opens there.
final class PipelineNodeViewController: PipelinePageViewController<PipelineNodeInput> {
    private let run: PipelineRunFeed
    private let log: PipelineNodeLogFeed
    /// Whether the page keeps the log's newest entry in view.
    private var followsTail = false
    /// The reader's finger moved the list, and it hasn't come to rest.
    private var readerScrolls = false
    private var settling: Task<Void, Never>?
    private var tail: String?

    init(session: Session, run: PipelineRunFeed, nodeId: String) {
        self.run = run
        log = PipelineNodeLogFeed(runId: run.runId, nodeId: nodeId, engine: session.engine)
        super.init(session: session, input: PipelineNodeInput(nodeId: nodeId), title: nodeId)
    }

    deinit {
        settling?.cancel()
        Task { [log] in await log.finish() }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "pipeline-node"
        list.accessibilityIdentifier = "pipeline-node-list"
    }

    override func follow(_ pipeline: ApplyPipeline<PipelineNodeInput, PipelineRows.Applied, Output>) {
        PipelineRunViewController.follow(run, engine: session.engine, into: pipeline, at: \.run, keep: keep)
        keep(Task { [weak pipeline, log] in
            let states = await log.states()
            pipeline?.follow(ifChanged: states) { input, state in
                guard input.log != state else { return false }
                input.log = state
                return true
            }
        })
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        Task { [run, log] in
            await run.start()
            await log.start()
        }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        Task { [run, log] in
            await run.stop()
            await log.stop()
        }
    }

    override func open(_ target: PipelineRowTarget) {
        guard case .command(let seq) = target else { return super.open(target) }
        // The rows under the tapped one move, not the one tapped.
        followsTail = false
        update { input in
            if input.toggled.remove(seq) == nil { input.toggled.insert(seq) }
        }
    }

    /// A running node's page opens on its log's tail; after that, new
    /// entries keep it in view while the reader is there.
    override func apply(_ items: [CardItem], live: Bool) {
        // The newest entry's last row (`log:<seq>…`), not a note about the log.
        let tail = items.last { $0.id.hasPrefix("log:") && $0.id.dropFirst(4).first?.isNumber == true }?.id
        let first = self.tail == nil
        let grew = tail != nil && tail != self.tail
        if first, grew, live { followsTail = true }
        self.tail = tail
        super.apply(items, live: live)
        guard followsTail, tail != nil else { return }
        if grew || isAway { list.list.scrollToBottom(animated: !first && grew) }
        settleTail()
    }

    private var isAway: Bool { list.list.distanceFromBottom.map { $0 > 1 } ?? true }

    /// New rows are measured after the pass that brings them, and can move
    /// the foot past where the scroll to it ended: looked at again once
    /// they have settled.
    private func settleTail() {
        settling?.cancel()
        settling = Task { [weak self] in
            for _ in 0..<3 {
                try? await Task.sleep(for: .milliseconds(350))
                guard let self, !Task.isCancelled, followsTail, !readerScrolls else { return }
                guard isAway else { return }
                list.list.scrollToBottom(animated: true)
            }
        }
    }

    /// The reader's own scroll says whether to follow: at the foot it does,
    /// anywhere else it doesn't. The page's own scrolls to the tail say nothing.
    override func scrolled() {
        let inner = list.list
        if inner.isTracking || inner.isDragging { readerScrolls = true }
        guard readerScrolls else { return }
        // Nil while the last row isn't even loaded: far from the foot.
        followsTail = (inner.distanceFromBottom ?? .infinity) < 24
        if !inner.isTracking, !inner.isDragging, !inner.isDecelerating { readerScrolls = false }
    }
}
#endif
