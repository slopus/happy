#if canImport(UIKit)
import Foundation
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// What every pipelines page derives its rows at: the list's width, the
/// person's text size, the theme and the clock. Captured on the main thread.
struct PipelineCardEnvironment: Sendable, Equatable {
    var width: CGFloat = 0
    var maxWidth: CGFloat = .greatestFiniteMagnitude
    /// What the list shows between its insets, for a note in place of it all.
    var height: CGFloat = 0
    var scale: CGFloat = 1
    var displayScale: CGFloat = 2
    var dark = false
    var now = Date()
    var calendar = Calendar.current
}

/// The pipelines pages' rows, made off the main thread in the cards' own
/// layouts (`CardRowLayout`, `CardHeadingLayout`, `CardNoteLayout`).
enum PipelineRows {
    /// A tile's glyph and colours.
    struct Tile: Sendable {
        var icon: Icon
        var ink: ColorToken
        var fill: ColorToken
    }

    /// Text drawn in a block is cut to this many lines; the whole of it
    /// opens on its own page.
    static let blockLines = 40

    nonisolated static func neutral(_ icon: Icon) -> Tile { Tile(icon: icon, ink: Palette.settingsSecondary, fill: Palette.surfaceHighest) }

    nonisolated static func tile(_ state: PipelineRunState) -> Tile {
        switch state {
        case .queued: neutral(.ionicons("time-outline"))
        case .running: Tile(icon: .ionicons("play-circle-outline"), ink: Palette.tileBlue, fill: Palette.tileBlueFill)
        case .succeeded: Tile(icon: .ionicons("checkmark-circle-outline"), ink: Palette.tileGreen, fill: Palette.tileGreenFill)
        case .failed: Tile(icon: .ionicons("close-circle-outline"), ink: Palette.tileRed, fill: Palette.tileRedFill)
        case .aborted: neutral(.ionicons("remove-circle-outline"))
        case .superseded: neutral(.ionicons("play-skip-forward"))
        }
    }

    nonisolated static func tile(_ state: PipelineNodeRunState) -> Tile {
        switch state {
        case .pending: neutral(.ionicons("ellipse-outline"))
        case .running: tile(PipelineRunState.running)
        case .succeeded: tile(PipelineRunState.succeeded)
        case .failed: tile(PipelineRunState.failed)
        case .skipped: neutral(.ionicons("play-skip-forward"))
        case .aborted: tile(PipelineRunState.aborted)
        }
    }

    nonisolated static func heading(_ id: String, _ text: String, trailing: String? = nil, afterCard: Bool, _ env: PipelineCardEnvironment) -> CardItem {
        CardItems.heading(id, text, trailing: trailing, width: env.width, maxWidth: env.maxWidth, afterCard: afterCard, dark: env.dark, displayScale: env.displayScale)
    }

    nonisolated static func note(_ id: String, _ text: String, whole: Bool = false, _ env: PipelineCardEnvironment) -> CardItem {
        CardItems.note(id, text, padding: whole ? 24 : 12, fill: whole ? env.height : nil, width: env.width, maxWidth: env.maxWidth,
                       scale: env.scale, dark: env.dark, displayScale: env.displayScale)
    }

    /// One row: an optional tile, the title with words at its end, and
    /// quieter lines under it.
    nonisolated static func row(_ id: String, title: String, subtitle: String? = nil, trailing: String? = nil, tile: Tile? = nil, place: CardPlace,
                                opens: Bool = false, titleColor: ColorToken = Palette.text, subtitleColor: ColorToken = Palette.settingsSecondary,
                                titleLines: Int = 1, subtitleLines: Int = 2, mono: Bool = false, rule: Bool = true, _ env: PipelineCardEnvironment) -> CardItem {
        typealias M = CardListMetrics
        let titleFont = CardFont(.regular, mono ? M.subtitleSize : M.titleSize, scale: env.scale, mono: mono)
        let small = CardFont(.regular, M.subtitleSize, scale: env.scale)
        // The words at the end take at most half the row; past that they're cut.
        let trailingSize = trailing.map { CardText.measure($0, font: small, width: env.width / 2, maxLines: 1, scale: env.displayScale) }
        let layout = CardRowLayout(
            width: env.width, maxWidth: env.maxWidth, place: place, leading: tile == nil ? nil : CGSize(width: M.tile, height: M.tile),
            title: CardText.measurable(title, font: titleFont, maxLines: titleLines, scale: env.displayScale),
            subtitle: subtitle.map { CardText.measurable($0, font: small, maxLines: subtitleLines, scale: env.displayScale) },
            trailing: trailingSize, titleLine: CardText.line(titleFont, scale: env.displayScale), hairline: 1 / max(1, env.displayScale), scale: env.displayScale
        )
        var drawing = CardDrawing(dark: env.dark, displayScale: env.displayScale)
        if let tile, let frame = layout.leading {
            drawing.marks.append(.tile(frame, radius: M.tileRadius, tile.fill))
            drawing.icon(tile.icon, size: M.tileGlyph, tile.ink, in: frame)
        }
        drawing.text(title, titleFont, titleColor, layout.title, wraps: titleLines != 1)
        if let subtitle, let frame = layout.subtitle { drawing.text(subtitle, small, subtitleColor, frame, wraps: subtitleLines != 1) }
        if let trailing, let frame = layout.trailing { drawing.text(trailing, small, Palette.settingsSecondary, frame) }
        if rule { drawing.rule(layout.separator) }
        var item = CardItem(id: id, kind: .row, size: layout.size, card: layout.card, place: place, drawing: drawing, opens: opens)
        item.accessibilityLabel = title
        item.accessibilityValue = [subtitle, trailing].compactMap { $0 }.joined(separator: ", ")
        return item
    }

    /// A fact: its name, and its value at the end of the line.
    nonisolated static func fact(_ id: String, _ label: String, _ value: String, place: CardPlace, _ env: PipelineCardEnvironment) -> CardItem {
        row(id, title: label, trailing: value, place: place, env)
    }

    /// A block of text the card's width, monospace by default: a JSON
    /// value, a traceback, a command's output. Long text is cut to
    /// `blockLines`, its start or for output its `end`; `opens` says
    /// whether the whole is there to open.
    nonisolated static func block(_ id: String, _ text: String, place: CardPlace, mono: Bool = true, color: ColorToken = Palette.text, rule: Bool = true,
                                  end: Bool = false, _ env: PipelineCardEnvironment) -> CardItem {
        let shown = end ? clipped(end: text) : clipped(text)
        return row(id, title: shown.text, place: place, opens: shown.cut, titleColor: color, titleLines: 0, mono: mono, rule: rule, env)
    }

    /// At most `blockLines` lines and 6000 characters of `text`, and whether that cut it.
    nonisolated static func clipped(_ text: String) -> (text: String, cut: Bool) {
        var text = text
        while text.hasSuffix("\n") { text.removeLast() }
        var lines = 0
        var end = text.startIndex
        while end < text.endIndex, lines < blockLines, text.distance(from: text.startIndex, to: end) < 6000 {
            if text[end] == "\n" { lines += 1; if lines == blockLines { break } }
            end = text.index(after: end)
        }
        guard end < text.endIndex else { return (text.isEmpty ? " " : text, false) }
        return (String(text[..<end]) + "\n…", true)
    }

    /// The last `blockLines` lines and 6000 characters of `text`, and whether that cut it.
    nonisolated static func clipped(end text: String) -> (text: String, cut: Bool) {
        var text = text
        while text.hasSuffix("\n") { text.removeLast() }
        var lines = 0
        var start = text.endIndex
        while start > text.startIndex, text.distance(from: start, to: text.endIndex) < 6000 {
            let before = text.index(before: start)
            if text[before] == "\n" { lines += 1; if lines == blockLines { break } }
            start = before
        }
        guard start > text.startIndex else { return (text.isEmpty ? " " : text, false) }
        return ("…\n" + String(text[start...]).drop { $0 == "\n" }, true)
    }

    /// The runs' and pipelines' rows' revisions, kept where the content is
    /// the same: what every pipelines page applies.
    struct Applied: Sendable {
        var items: [String: CardItem] = [:]
        var order: [String] = []
        var counter: UInt64 = 0
        /// The page's title as applied.
        var title: String?
    }

    /// `next` against what was applied: nil when nothing shown changed.
    nonisolated static func revise(_ next: [CardItem], applied: Applied) -> (items: [CardItem], state: Applied)? {
        var counter = applied.counter
        let items = CardItems.revise(next, previous: applied.items, counter: &counter)
        let order = items.map(\.id)
        guard order != applied.order || !items.allSatisfy({ applied.items[$0.id]?.revision == $0.revision }) else { return nil }
        return (items, Applied(items: Dictionary(items.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first }), order: order, counter: counter, title: applied.title))
    }
}
#endif
