#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

extension PipelineInput: PipelinePageInput {
    nonisolated static func page(_ input: Self) -> PipelinePage { PipelineItems.page(input) }
    nonisolated static func ticking(_ input: Self) -> Bool { PipelineItems.ticking(input) }
}

/// A pipeline's page, opened from its row in Pipelines or from a run's
/// page: how it stands, what its latest version defines, its history and
/// its runs (`PipelineFeed`). A version opens its own page with that
/// version's definition, a node a page of what it is; they follow the same
/// feed. Read only.
final class PipelineViewController: PipelinePageViewController<PipelineInput> {
    let feed: PipelineFeed
    private let screen: PipelineScreen
    /// The page that made the feed finishes it.
    private let owns: Bool

    /// `name` is what the row it opened from called it: an archived pipeline can't be read, its name with it.
    convenience init(session: Session, pipelineId: String, name: String? = nil) {
        self.init(session: session, feed: PipelineFeed(pipelineId: pipelineId, name: name, engine: session.engine), screen: .pipeline, owns: true)
    }

    init(session: Session, feed: PipelineFeed, screen: PipelineScreen, owns: Bool = false) {
        self.feed = feed
        self.screen = screen
        self.owns = owns
        let title: String
        switch screen {
        case .pipeline: title = Strings.Pipelines.pipeline
        case .version(let number): title = Strings.Pipelines.versionTitle(number, latest: false)
        case .node(_, let nodeId): title = nodeId
        }
        super.init(session: session, input: PipelineInput(screen: screen), title: title)
    }

    deinit {
        guard owns else { return }
        Task { [feed] in await feed.finish() }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "pipeline"
        list.accessibilityIdentifier = "pipeline-list"
    }

    override func follow(_ pipeline: ApplyPipeline<PipelineInput, PipelineRows.Applied, Output>) {
        let (feed, engine) = (feed, session.engine)
        keep(Task { [weak pipeline] in
            let states = await feed.states()
            pipeline?.follow(ifChanged: states) { input, state in
                guard input.state != state else { return false }
                input.state = state
                return true
            }
        })
        keep(Task { [weak pipeline] in
            let directories = await engine.feedDirectories()
            pipeline?.follow(ifChanged: directories) { input, directory in
                let names = PipelineNames(agents: directory.agents.mapValues(\.name), people: directory.people.mapValues(\.name),
                                          surfaces: directory.surfaces.mapValues(\.name), me: directory.userId)
                guard input.names != names else { return false }
                input.names = names
                return true
            }
        })
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        let (feed, screen) = (feed, screen)
        Task {
            await feed.start()
            switch screen {
            case .version(let number), .node(let number?, _): await feed.version(number)
            default: break
            }
        }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        Task { [feed] in await feed.stop() }
    }

    override func open(_ target: PipelineRowTarget) {
        switch target {
        case .version(let number):
            navigationController?.pushViewController(PipelineViewController(session: session, feed: feed, screen: .version(number)), animated: true)
        case .definitionNode(let number, let nodeId):
            navigationController?.pushViewController(PipelineViewController(session: session, feed: feed, screen: .node(version: number, nodeId: nodeId)), animated: true)
        case .pipeline(let id, _) where id == feed.pipelineId:
            // A node running this pipeline's own page: back to it rather than another copy.
            if let page = navigationController?.viewControllers.first(where: { ($0 as? PipelineViewController)?.feed === feed && ($0 as? PipelineViewController)?.screen == .pipeline }) {
                navigationController?.popToViewController(page, animated: true)
            } else {
                super.open(target)
            }
        default:
            super.open(target)
        }
    }

    override func readMore() {
        Task { [feed] in await feed.more() }
    }
}
#endif
