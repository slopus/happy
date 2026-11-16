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

    /// A state's tile: its glyph, ink and fill (desktop's state tones).
    nonisolated static func tile(_ state: PipelineRunState) -> (icon: Icon, ink: ColorToken, fill: ColorToken) {
        switch state {
        case .queued: (.ionicons("time-outline"), Palette.settingsSecondary, Palette.surfaceHighest)
        case .running: (.ionicons("play-circle-outline"), Palette.tileBlue, Palette.tileBlueFill)
        case .succeeded: (.ionicons("checkmark-circle-outline"), Palette.tileGreen, Palette.tileGreenFill)
        case .failed: (.ionicons("close-circle-outline"), Palette.tileRed, Palette.tileRedFill)
        case .aborted: (.ionicons("remove-circle-outline"), Palette.settingsSecondary, Palette.surfaceHighest)
        case .superseded: (.ionicons("play-skip-forward"), Palette.settingsSecondary, Palette.surfaceHighest)
        }
    }

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
        let look = pipeline.enabled
            ? (ink: Palette.tileTeal, fill: Palette.tileTealFill)
            : (ink: Palette.settingsSecondary, fill: Palette.surfaceHighest)
        var item = card(id: pipelineId(pipeline.id), title: pipeline.name, muted: false, subtitle: parts.joined(separator: " · "), time: time,
                        icon: Glyphs.icon("pipeline"), ink: look.ink, fill: look.fill, place: place, input: input)
        // Its page comes with the pipeline page; until then the row only reads.
        item.opens = false
        return item
    }

    nonisolated static func row(_ run: PipelineRunListEntry, place: CardPlace, parent: [String: String], input: PipelineListInput) -> CardItem {
        typealias Text = Strings.Pipelines
        var status = Text.state(run.state)
        if let started = run.startedAt {
            let end = run.endedAt ?? input.now.timeIntervalSince1970 * 1000
            status += " · " + Text.elapsed(end - started)
        }
        var parts = [status, Text.version(run.version), Text.startedBy(run, agent: { input.agents[$0].flatMap { $0.isEmpty ? nil : $0 } }, parent: { parent[$0] })]
        if run.pipelineArchived { parts.append(Text.archived) }
        let time = Text.ago(Date(timeIntervalSince1970: run.createdAt / 1000), now: input.now, calendar: input.calendar)
        let look = tile(run.state)
        var item = card(id: runId(run.id), title: run.pipelineName, muted: run.pipelineArchived, subtitle: parts.joined(separator: " · "), time: time,
                        icon: look.icon, ink: look.ink, fill: look.fill, place: place, input: input)
        // The run page comes next; until then the row only reads.
        item.opens = false
        return item
    }

    /// One row: a tile, the title with a time at its end, and a line under it.
    private nonisolated static func card(id: String, title: String, muted: Bool, subtitle: String, time: String?, icon: Icon, ink: ColorToken, fill: ColorToken,
                                         place: CardPlace, input: PipelineListInput) -> CardItem {
        typealias M = CardListMetrics
        let titleFont = CardFont(.regular, M.titleSize, scale: input.scale)
        let small = CardFont(.regular, M.subtitleSize, scale: input.scale)
        let timeSize = time.map { CardText.measure($0, font: small, width: 10_000, maxLines: 1, scale: input.displayScale) }
        let layout = CardRowLayout(
            width: input.width, maxWidth: input.maxWidth, place: place, leading: CGSize(width: M.tile, height: M.tile),
            title: CardText.measurable(title, font: titleFont, maxLines: 1, scale: input.displayScale),
            subtitle: CardText.measurable(subtitle, font: small, maxLines: 2, scale: input.displayScale),
            trailing: timeSize, titleLine: CardText.line(titleFont, scale: input.displayScale), hairline: 1 / max(1, input.displayScale), scale: input.displayScale
        )
        var drawing = CardDrawing(dark: input.dark, displayScale: input.displayScale)
        if let frame = layout.leading {
            drawing.marks.append(.tile(frame, radius: M.tileRadius, fill))
            drawing.icon(icon, size: M.tileGlyph, ink, in: frame)
        }
        drawing.text(title, titleFont, muted ? Palette.settingsSecondary : Palette.text, layout.title)
        if let frame = layout.subtitle { drawing.text(subtitle, small, Palette.settingsSecondary, frame, wraps: true) }
        if let time, let frame = layout.trailing { drawing.text(time, small, Palette.settingsSecondary, frame) }
        drawing.rule(layout.separator)
        var item = CardItem(id: id, kind: .row, size: layout.size, card: layout.card, place: place, drawing: drawing)
        item.accessibilityLabel = title
        item.accessibilityValue = ([subtitle] + (time.map { [$0] } ?? [])).joined(separator: ", ")
        return item
    }
}
#endif
