#if canImport(UIKit)
import Foundation
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// What a node's page derives from: its run's page's input, which node,
/// its log, and the commands the reader opened or folded.
struct PipelineNodeInput: Sendable {
    var run = PipelineRunInput()
    var nodeId: String
    var log = PipelineNodeLogFeed.State()
    /// Commands, by `seq`, the reader opened or folded against how they show by default.
    var toggled: Set<Int> = []
}

/// One node of a run on its own page, worked out off the main thread
/// (desktop's PipelineRunNodePanel on a phone): how it stands and what kind
/// of step it is, how it failed, what its model spent, the computers it
/// holds, the child run it started, its input and output, and last its log,
/// whose tail the page follows while the node runs.
enum PipelineNodeItems {
    typealias Text = Strings.Pipelines
    typealias Rows = [(CardPlace) -> (CardItem, PipelineRowTarget?)]

    nonisolated static func page(_ input: PipelineNodeInput) -> PipelinePage {
        let env = input.run.env
        guard env.width > 0 else { return PipelinePage() }
        let state = input.run.state
        var page = PipelinePage()
        guard let run = state.run, let node = state.orderedNodes.first(where: { $0.nodeId == input.nodeId }) else {
            let text = state.loading ? Text.runLoading : state.missing ? Text.runMissing : state.run == nil ? Text.runUnreadable : Text.nodeMissing
            page.append(PipelineRows.note("node:note", text, whole: true, env))
            return page
        }
        if state.failed { page.append(PipelineRows.note("node:failed", Text.runOutOfDate, env)) }
        let graph = state.graphNodes[node.nodeId]
        page.title = node.nodeId
        page.live = node.state == .running

        page.append(PipelineRows.heading("node:heading", Text.node, trailing: Text.kind(node.kind, model: graph?.model, pipeline: nil), afterCard: false, env))
        var facts: Rows = [{ place in
            let status = node.status.map { $0.text + ($0.progress.map { " · " + Text.percent($0) } ?? "") }
            return (PipelineRows.row("node:state", title: Text.nodeState(node.state), subtitle: status, trailing: PipelineRunItems.duration(node.startedAt, node.endedAt, env),
                                     tile: PipelineRows.tile(node.state), place: place, subtitleLines: 3, env), nil)
        }]
        let rows: [(String, String, String?)] = [
            ("agent", Text.agent, node.agentId.map { input.run.agents[$0].flatMap { $0.isEmpty ? nil : $0 } ?? $0 }),
            ("pipeline", Text.pipeline, graph?.pipelineId.map { state.names[$0] ?? $0 }),
            ("started", Text.startedAt, node.startedAt.map { PipelineRunItems.moment($0, env) }),
            ("ended", Text.endedAt, node.endedAt.map { PipelineRunItems.moment($0, env) }),
        ]
        for (id, label, value) in rows {
            guard let value else { continue }
            facts.append { place in (PipelineRows.fact("node:\(id)", label, value, place: place, env), nil) }
        }
        page.card(facts)

        if let failure = node.failure {
            page.append(PipelineRows.heading("node:failure", Text.failure, afterCard: true, env))
            page.card([
                { place in (PipelineRows.row("node:failure-title", title: Text.failureTitle(failure.code), subtitle: failure.code, place: place,
                                             titleColor: Palette.textDestructive, env), nil) },
                { place in PipelineRunItems.block("node:failure-message", Text.failure, failure.message.isEmpty ? Text.noMessage : failure.message, place: place, env) },
            ])
        }

        if node.kind == "agent" { usage(node.usage, into: &page, env) }

        let leases = run.leases.filter { $0.holders.contains(node.nodeId) || graph?.leases.contains($0.name) == true }
        if !leases.isEmpty {
            page.append(PipelineRows.heading("node:computers", Text.computers, afterCard: true, env))
            page.card(leases.map { lease in { place in
                (PipelineRows.row("lease:\(lease.name)", title: lease.name, subtitle: Text.lease(lease, now: env.now, calendar: env.calendar),
                                  tile: PipelineRows.neutral(.ionicons("desktop-outline")), place: place, env), nil)
            } })
        }

        if let child = node.childRunId {
            page.append(PipelineRows.heading("node:child", Text.childRun, afterCard: true, env))
            page.card([{ place in PipelineRunItems.relative(child, state: state, via: Text.childVia([node.nodeId]), pipelineId: graph?.pipelineId, place: place, env) }])
        }

        if let value = node.input {
            page.append(PipelineRows.heading("node:input", Text.input, afterCard: true, env))
            page.card([{ place in PipelineRunItems.block("node:input-value", Text.input, Text.value(value), place: place, env) }])
        }
        if let value = node.output {
            page.append(PipelineRows.heading("node:output", Text.output, afterCard: true, env))
            page.card([{ place in PipelineRunItems.block("node:output-value", Text.output, Text.value(value), place: place, env) }])
        }

        log(node, input, into: &page, env)
        return page
    }

    /// What an agent node's model spent, model by model.
    nonisolated static func usage(_ usage: [PipelineModelUsage]?, into page: inout PipelinePage, _ env: PipelineCardEnvironment) {
        page.append(PipelineRows.heading("node:usage", Text.usage, trailing: usage.map(Text.costOf), afterCard: true, env))
        guard let usage else {
            page.append(PipelineRows.note("node:usage-none", Text.noInference, env))
            return
        }
        page.card(usage.map { spent in { place in
            var parts = [Text.tokensInOut(input: spent.input, output: spent.output)]
            if spent.cacheRead > 0 { parts.append("\(Text.tokens(spent.cacheRead)) \(Text.cached.lowercased())") }
            if spent.reasoning > 0 { parts.append("\(Text.tokens(spent.reasoning)) \(Text.reasoning.lowercased())") }
            return (PipelineRows.row("usage:\(spent.provider)/\(spent.model)", title: spent.model, subtitle: parts.joined(separator: " · "),
                                     trailing: spent.costUsd.map(Text.cost) ?? Text.notPriced, place: place, env), nil)
        } })
    }

    /// The node's log in the order it happened, the newest at the foot.
    nonisolated static func log(_ node: PipelineNodeRun, _ input: PipelineNodeInput, into page: inout PipelinePage, _ env: PipelineCardEnvironment) {
        let log = input.log
        page.append(PipelineRows.heading("log", Text.log, trailing: node.state == .running ? Text.logLive : nil, afterCard: true, env))
        switch node.state {
        case .pending where log.entries.isEmpty:
            page.append(PipelineRows.note("log:note", Text.nodePending, env))
            return
        case .skipped where log.entries.isEmpty:
            page.append(PipelineRows.note("log:note", Text.nodeSkipped, env))
            return
        default: break
        }
        if log.failed { page.append(PipelineRows.note("log:failed", Text.logOutOfDate, env)) }
        if log.dropped > 0 { page.append(PipelineRows.note("log:dropped", Text.dropped(log.dropped), env)) }
        if log.entries.isEmpty {
            page.append(PipelineRows.note("log:note", log.loading ? Text.logLoading : Text.logEmpty, env))
            return
        }
        var rows: Rows = []
        for entry in log.entries { rows += self.rows(entry, input, env) }
        page.card(rows)
    }

    /// One entry's rows: a command is its line, then its output while open.
    nonisolated static func rows(_ entry: PipelineLogEntry, _ input: PipelineNodeInput, _ env: PipelineCardEnvironment) -> Rows {
        let id = "log:\(entry.seq)"
        switch entry.kind {
        case .output(let text, let stderr):
            return [{ place in PipelineRunItems.block(id, Text.log, text, place: place, color: stderr ? Palette.textDestructive : Palette.text, end: true, env) }]
        case .message(let text):
            return [{ place in PipelineRunItems.block(id, Text.log, text, place: place, mono: false, env) }]
        case .status(let text, let progress):
            return [{ place in (PipelineRows.row(id, title: text, trailing: progress.map(Text.percent), place: place, titleColor: Palette.settingsSecondary,
                                                 titleLines: 3, env), nil) }]
        case .tool(let name, let summary, let state, let durationMs, let error):
            let tile = state == "error" ? PipelineRows.Tile(icon: .ionicons("construct-outline"), ink: Palette.tileRed, fill: Palette.tileRedFill)
                : state == "running" ? PipelineRows.Tile(icon: .ionicons("construct-outline"), ink: Palette.tileBlue, fill: Palette.tileBlueFill)
                : PipelineRows.neutral(.ionicons("construct-outline"))
            var rows: Rows = [{ place in (PipelineRows.row(id, title: name, subtitle: summary.isEmpty ? nil : summary,
                                                           trailing: [Text.toolState(state), Text.duration(durationMs)].compactMap { $0 }.joined(separator: " · "),
                                                           tile: tile, place: place, subtitleLines: 4, rule: error == nil, env), nil) }]
            if let error {
                rows.append { place in PipelineRunItems.block("\(id):error", name, error, place: place, color: Palette.textDestructive, mono: false, env) }
            }
            return rows
        case .command(let command):
            let open = open(entry.seq, command, input)
            let tile = command.failed ? PipelineRows.Tile(icon: .ionicons("terminal-outline"), ink: Palette.tileRed, fill: Palette.tileRedFill)
                : command.state == "running" ? PipelineRows.Tile(icon: .ionicons("terminal-outline"), ink: Palette.tileBlue, fill: Palette.tileBlueFill)
                : PipelineRows.neutral(.ionicons("terminal-outline"))
            let output = command.output.isEmpty ? nil : command.output
            let place = ([command.lease, command.cwd] + [output.map { _ in open ? Text.hideOutput : Text.showOutput }]).compactMap { $0 }.joined(separator: " · ")
            var rows: Rows = [{ at in
                (PipelineRows.row(id, title: "$ " + command.command, subtitle: place.isEmpty ? nil : place,
                                  trailing: [Text.commandState(command), Text.duration(command.durationMs)].compactMap { $0 }.joined(separator: " · "),
                                  tile: tile, place: at, opens: output != nil, titleColor: command.failed ? Palette.textDestructive : Palette.text,
                                  titleLines: 4, mono: true, rule: !(open && output != nil), env),
                 output == nil ? nil : .command(seq: entry.seq))
            }]
            guard open, let output else { return rows }
            if command.outputTruncated {
                rows.append { at in (PipelineRows.row("\(id):cut", title: Text.outputCut, place: at, titleColor: Palette.settingsSecondary, titleLines: 2, rule: false, env), nil) }
            }
            rows.append { at in PipelineRunItems.block("\(id):output", "$ " + command.command, output, place: at, end: true, env) }
            return rows
        }
    }

    /// A command's output shows while it runs, once it failed, and once
    /// the reader watched it run; a tap turns that around.
    nonisolated static func open(_ seq: Int, _ command: PipelineLogCommand, _ input: PipelineNodeInput) -> Bool {
        let shown = command.state == "running" || command.failed || input.log.watched.contains(seq)
        return shown != input.toggled.contains(seq)
    }

    /// Whether anything on the page counts time by the second.
    nonisolated static func ticking(_ input: PipelineNodeInput) -> Bool {
        input.run.state.run?.nodes.contains { $0.nodeId == input.nodeId && $0.state == .running } == true
    }
}
#endif
