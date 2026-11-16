#if canImport(UIKit)
import Foundation
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// What the pipelines list derives from, written by the feed (its state),
/// the account's directory (agents' names) and the screen (its width,
/// text size, theme and clock).
struct PipelineListInput: Sendable {
    var state = PipelinesFeed.State()
    /// Agents' names by ID, for who started a run.
    var agents: [String: String] = [:]
    var width: CGFloat = 0
    var maxWidth: CGFloat = .greatestFiniteMagnitude
    /// What the list shows between its insets: a note in place of the
    /// whole list stands in its middle.
    var height: CGFloat = 0
    var scale: CGFloat = 1
    var displayScale: CGFloat = 2
    var dark = false
    var now = Date()
    var calendar = Calendar.current
}

/// The list's slots, worked out off the main thread (desktop's
/// HappyAgentPipelinesPage on a phone): the pipelines in one card on top,
/// each with its head version and how its newest run went; under them
/// every run of every pipeline, newest first, a running one's time
/// counting. A child run says which run it came from; an archived
/// pipeline's runs are quieter and say so.
enum PipelineListItems {
    static func pipelineId(_ id: String) -> String { "pipeline:\(id)" }
    static func runId(_ id: String) -> String { "run:\(id)" }
    /// The run a row's ID names, if it is a run's row.
    static func run(ofRow id: String) -> String? { id.hasPrefix("run:") ? String(id.dropFirst("run:".count)) : nil }
    /// The pipeline a row's ID names, if it is a pipeline's row.
    static func pipeline(ofRow id: String) -> String? { id.hasPrefix("pipeline:") ? String(id.dropFirst("pipeline:".count)) : nil }

    /// Whether anything shown counts time by the second.
    nonisolated static func ticking(_ state: PipelinesFeed.State) -> Bool {
        state.runs.entries.contains { $0.state.abortable && $0.startedAt != nil }
    }

    nonisolated static func items(_ input: PipelineListInput) -> [CardItem] {
        guard input.width > 0 else { return [] }
        typealias Text = Strings.Pipelines
        let state = input.state
        func note(_ id: String, _ text: String, centred: Bool = false) -> CardItem {
            CardItems.note("pipelines:note:\(id)", text, padding: centred ? 24 : 12, fill: centred ? input.height : nil, width: input.width, maxWidth: input.maxWidth,
                           scale: input.scale, dark: input.dark, displayScale: input.displayScale)
        }
        if state.pipelines.isEmpty {
            if state.loading { return [note("whole", Text.loading, centred: true)] }
            return [note("whole", state.failed ? Text.unavailable : Text.empty, centred: true)]
        }
        var items: [CardItem] = []
        if state.failed { items.append(note("failed", Text.outOfDate)) }
        items.append(CardItems.heading("pipelines:heading", Text.title, trailing: Text.count(state.pipelines.count), width: input.width, maxWidth: input.maxWidth,
                                       afterCard: false, dark: input.dark, displayScale: input.displayScale))
        for (pipeline, place) in zip(state.pipelines, CardPlace.run(state.pipelines.count)) {
            items.append(row(pipeline, place: place, input: input))
        }
        items.append(CardItems.heading("pipelines:runs", Text.runs, width: input.width, maxWidth: input.maxWidth, afterCard: true, dark: input.dark, displayScale: input.displayScale))
        let runs = state.runs
        if !runs.listed { items.append(note("runs", Text.runsUnlisted)); return items }
        if runs.entries.isEmpty {
            items.append(note("runs", runs.loading ? Text.runsLoading : runs.failed ? Text.runsOutOfDate : Text.runsEmpty))
            return items
        }
        let names = Dictionary(runs.entries.map { ($0.id, $0.pipelineName) }, uniquingKeysWith: { first, _ in first })
        for (run, place) in zip(runs.entries, CardPlace.run(runs.entries.count)) {
            items.append(row(run, place: place, parent: names, input: input))
        }
        if runs.loadingMore { items.append(note("more", Text.runsLoadingMore)) }
        else if runs.failed { items.append(note("runs-failed", Text.runsOutOfDate)) }
        return items
    }

    nonisolated static func row(_ pipeline: PipelineSummary, place: CardPlace, input: PipelineListInput) -> CardItem {
        typealias Text = Strings.Pipelines
        var parts = [Text.version(pipeline.headVersion)]
        if !pipeline.enabled { parts.append(Text.disabled) }
        parts.append(pipeline.lastRun.map { Text.lastRun($0.state) } ?? Text.neverRun)
        let time = pipeline.lastRun.map { Text.ago(Date(timeIntervalSince1970: ($0.endedAt ?? $0.createdAt) / 1000), now: input.now, calendar: input.calendar) }
        let tile = pipeline.enabled
            ? PipelineRows.Tile(icon: Glyphs.icon("pipeline"), ink: Palette.tileTeal, fill: Palette.tileTealFill)
            : PipelineRows.neutral(Glyphs.icon("pipeline"))
        return PipelineRows.row(pipelineId(pipeline.id), title: pipeline.name, subtitle: parts.joined(separator: " · "), trailing: time, tile: tile,
                                place: place, opens: true, environment(input))
    }

    nonisolated static func row(_ run: PipelineRunListEntry, place: CardPlace, parent: [String: String], input: PipelineListInput) -> CardItem {
        row(run, title: run.pipelineName, place: place, parent: parent, agents: input.agents, environment(input))
    }

    /// A run's row: `title`, then how it stands, its version and who started
    /// it; on one pipeline's page its title is its state.
    nonisolated static func row(_ run: PipelineRunListEntry, title: String, place: CardPlace, parent: [String: String], agents: [String: String],
                                _ env: PipelineCardEnvironment) -> CardItem {
        typealias Text = Strings.Pipelines
        var status = Text.state(run.state)
        if let started = run.startedAt {
            let end = run.endedAt ?? env.now.timeIntervalSince1970 * 1000
            status = (title == status ? "" : status + " · ") + Text.elapsed(end - started)
        } else if title == status {
            status = ""
        }
        var parts = [status, Text.version(run.version), Text.startedBy(run, agent: { agents[$0].flatMap { $0.isEmpty ? nil : $0 } }, parent: { parent[$0] })]
        if run.pipelineArchived { parts.append(Text.archived) }
        let time = Text.ago(Date(timeIntervalSince1970: run.createdAt / 1000), now: env.now, calendar: env.calendar)
        return PipelineRows.row(runId(run.id), title: title, subtitle: parts.filter { !$0.isEmpty }.joined(separator: " · "), trailing: time, tile: PipelineRows.tile(run.state),
                                place: place, opens: true, titleColor: run.pipelineArchived ? Palette.settingsSecondary : Palette.text, env)
    }

    private nonisolated static func environment(_ input: PipelineListInput) -> PipelineCardEnvironment {
        PipelineCardEnvironment(width: input.width, maxWidth: input.maxWidth, height: input.height, scale: input.scale,
                                displayScale: input.displayScale, dark: input.dark, now: input.now, calendar: input.calendar)
    }
}
#endif
