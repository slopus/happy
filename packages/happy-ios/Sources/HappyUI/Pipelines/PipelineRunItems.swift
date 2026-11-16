#if canImport(UIKit)
import Foundation
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// What a run's page and its nodes' pages derive from: the run feed's
/// state, agents' names and the screen's environment.
struct PipelineRunInput: Sendable {
    var state = PipelineRunFeed.State()
    var agents: [String: String] = [:]
    var env = PipelineCardEnvironment()
}

/// What a page's rows do, by row ID: open another run, a node or a
/// block's whole text, open or fold a command's output, or abort the run.
enum PipelineRowTarget: Equatable, Sendable {
    case run(String)
    case node(String)
    case text(title: String, text: String)
    case command(seq: Int)
    case abort
}

/// A page's rows and what they open.
struct PipelinePage: Sendable {
    var items: [CardItem] = []
    /// What the page is titled, once known.
    var title: String?
    /// Rows still arrive at its foot, as a running node's log does.
    var live = false
    var targets: [String: PipelineRowTarget] = [:]

    mutating func append(_ item: CardItem, opens target: PipelineRowTarget? = nil) {
        items.append(item)
        if let target { targets[item.id] = target }
    }

    /// A card of rows, each made at its place in it.
    mutating func card(_ rows: [(CardPlace) -> (CardItem, PipelineRowTarget?)]) {
        for (make, place) in zip(rows, CardPlace.run(rows.count)) {
            let (item, target) = make(place)
            append(item, opens: target)
        }
    }
}

/// A run's page, worked out off the main thread (desktop's
/// HappyAgentPipelineRunPage on a phone): how the run stands and its facts,
/// the run that started it, its nodes in graph order with each one's state,
/// status line and progress, the child runs its nodes started, then its
/// input and result.
enum PipelineRunItems {
    typealias Text = Strings.Pipelines

    nonisolated static func page(_ input: PipelineRunInput) -> PipelinePage {
        let env = input.env
        guard env.width > 0 else { return PipelinePage() }
        let state = input.state
        var page = PipelinePage()
        guard let run = state.run else {
            let text = state.loading ? Text.runLoading : state.missing ? Text.runMissing : Text.runUnreadable
            page.append(PipelineRows.note("run:note", text, whole: true, env))
            return page
        }
        if case .failed(let message) = state.abort { page.append(PipelineRows.note("run:abort-failed", Text.abortFailed(message), env)) }
        if state.failed { page.append(PipelineRows.note("run:failed", Text.runOutOfDate, env)) }

        page.title = state.names[run.pipelineId]
        page.append(PipelineRows.heading("run:heading", Text.run, trailing: Text.runOf(version: run.version), afterCard: false, env))
        var facts: [(CardPlace) -> (CardItem, PipelineRowTarget?)] = []
        facts.append { place in
            (PipelineRows.row("run:state", title: Text.state(run.state), subtitle: duration(run.startedAt, run.endedAt, env),
                              trailing: ago(run.createdAt, env), tile: PipelineRows.tile(run.state), place: place, env), nil)
        }
        let rows: [(String, String, String?)] = [
            ("started-by", Text.startedByLabel, startedBy(run, input)),
            ("group", Text.group, run.group),
            ("queued", Text.queuedAt, moment(run.createdAt, env)),
            ("started", Text.startedAt, run.startedAt.map { moment($0, env) }),
            ("ended", Text.endedAt, run.endedAt.map { moment($0, env) }),
        ]
        for (id, label, value) in rows {
            guard let value else { continue }
            facts.append { place in (PipelineRows.fact("run:\(id)", label, value, place: place, env), nil) }
        }
        if run.state.abortable {
            let sending = state.abort == .sending
            facts.append { place in
                let tile = PipelineRows.Tile(icon: .ionicons("stop-circle"), ink: Palette.tileRed, fill: Palette.tileRedFill)
                return (PipelineRows.row("run:abort", title: sending ? Text.aborting : Text.abortConfirm, tile: tile, place: place,
                                         titleColor: sending ? Palette.settingsSecondary : Palette.textDestructive, env), sending ? nil : .abort)
            }
        }
        page.card(facts)

        if let parent = run.parentRunId {
            page.append(PipelineRows.heading("run:parent", Text.parentRun, afterCard: true, env))
            page.card([{ place in relative(parent, state: state, via: Text.parentVia(run.trigger), pipelineId: nil, place: place, env) }])
        }

        let nodes = state.orderedNodes
        let ended = nodes.filter(\.state.ended).count
        page.append(PipelineRows.heading("run:nodes", Text.nodes, trailing: "\(ended) of \(nodes.count) ended", afterCard: true, env))
        if state.graph == .failed { page.append(PipelineRows.note("run:graph-failed", Text.graphUnavailable, env)) }
        let graph = state.graphNodes
        page.card(nodes.map { node in { place in (nodeRow(node, graph: graph[node.nodeId], names: state.names, place: place, env), .node(node.nodeId)) } })

        let children = run.children
        if !children.isEmpty {
            page.append(PipelineRows.heading("run:children", Text.childRuns, trailing: "\(children.count)", afterCard: true, env))
            page.card(children.map { child in { place in
                let waiting = run.nodes(waitingOn: child)
                let pipelineId = waiting.first.flatMap { graph[$0]?.pipelineId }
                return relative(child, state: state, via: Text.childVia(waiting), pipelineId: pipelineId, place: place, env)
            } })
        }

        page.append(PipelineRows.heading("run:input", Text.input, afterCard: true, env))
        page.card([{ place in block("run:input-value", Text.input, Text.value(run.input), place: place, env) }])
        if let result = run.result {
            page.append(PipelineRows.heading("run:result", Text.result, afterCard: true, env))
            page.card([{ place in block("run:result-value", Text.result, Text.value(.object(result)), place: place, env) }])
        }
        return page
    }

    /// A node's row: what kind of step it is, and while it runs its status
    /// line with how far along; once ended how it failed, or its state.
    nonisolated static func nodeRow(_ node: PipelineNodeRun, graph: PipelineGraph.Node?, names: [String: String], place: CardPlace, _ env: PipelineCardEnvironment) -> CardItem {
        var parts = [Text.kind(node.kind, model: graph?.model, pipeline: graph?.pipelineId.map { names[$0] ?? $0 })]
        if let failure = node.failure {
            parts.append(Text.failureTitle(failure.code))
        } else if let status = node.status, node.state == .running {
            parts.append(status.text + (status.progress.map { " · " + Text.percent($0) } ?? ""))
        } else if node.state != .running {
            parts.append(Text.nodeState(node.state))
        }
        return PipelineRows.row("node:\(node.nodeId)", title: node.nodeId, subtitle: parts.joined(separator: " · "), trailing: duration(node.startedAt, node.endedAt, env),
                                tile: PipelineRows.tile(node.state), place: place, opens: true, env)
    }

    /// A parent or child run's row, as far as it has been read.
    nonisolated static func relative(_ id: String, state: PipelineRunFeed.State, via: String, pipelineId: String?, place: CardPlace,
                                     _ env: PipelineCardEnvironment) -> (CardItem, PipelineRowTarget?) {
        guard let relative = state.relatives[id] else {
            let name = pipelineId.flatMap { state.names[$0] } ?? Text.run
            return (PipelineRows.row("relative:\(id)", title: name, subtitle: via, tile: PipelineRows.neutral(Glyphs.icon("pipeline")), place: place, opens: true, env),
                    .run(id))
        }
        let name = state.names[relative.pipelineId] ?? Text.run
        let subtitle = [Text.progress(relative), Text.version(relative.version), via].joined(separator: " · ")
        return (PipelineRows.row("relative:\(id)", title: name, subtitle: subtitle, trailing: duration(relative.startedAt, relative.endedAt, env),
                                 tile: PipelineRows.tile(relative.state), place: place, opens: true, env),
                .run(id))
    }

    /// A block of text that opens whole when it was cut.
    nonisolated static func block(_ id: String, _ title: String, _ text: String, place: CardPlace, color: ColorToken = Palette.text, mono: Bool = true,
                                  end: Bool = false, _ env: PipelineCardEnvironment) -> (CardItem, PipelineRowTarget?) {
        let item = PipelineRows.block(id, text, place: place, mono: mono, color: color, end: end, env)
        return (item, item.opens ? .text(title: title, text: text) : nil)
    }

    nonisolated static func startedBy(_ run: PipelineRun, _ input: PipelineRunInput) -> String {
        switch run.trigger {
        case .agent(let agentId): return agentId.flatMap { input.agents[$0] }.flatMap { $0.isEmpty ? nil : $0 } ?? "An agent"
        case .pipeline(let runId, let nodeId):
            let parent = input.state.relatives[runId].flatMap { input.state.names[$0.pipelineId] }
            return parent.map { "Node \(nodeId) of \($0)" } ?? "Node \(nodeId) of its parent run"
        case nil: return "Unknown"
        }
    }

    nonisolated static func duration(_ started: Double?, _ ended: Double?, _ env: PipelineCardEnvironment) -> String? {
        guard let started else { return nil }
        return Text.elapsed((ended ?? env.now.timeIntervalSince1970 * 1000) - started)
    }

    nonisolated static func ago(_ at: Double, _ env: PipelineCardEnvironment) -> String {
        Text.ago(Date(timeIntervalSince1970: at / 1000), now: env.now, calendar: env.calendar)
    }

    nonisolated static func moment(_ at: Double, _ env: PipelineCardEnvironment) -> String {
        Text.moment(Date(timeIntervalSince1970: at / 1000), now: env.now, calendar: env.calendar)
    }

    /// Whether anything on the page counts time by the second.
    nonisolated static func ticking(_ state: PipelineRunFeed.State) -> Bool {
        guard let run = state.run else { return false }
        return run.state.abortable || run.nodes.contains { $0.state == .running } || state.relatives.values.contains { $0.state.abortable }
    }
}
#endif
