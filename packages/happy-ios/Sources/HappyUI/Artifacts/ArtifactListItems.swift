#if canImport(UIKit)
import Foundation
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// What the artifacts list derives from, written by the feed (its state)
/// and the screen (its width, search, text size, theme and words).
struct ArtifactListInput: Sendable {
    var state = ArtifactCatalogFeed.State()
    var query = ""
    var width: CGFloat = 0
    var maxWidth: CGFloat = .greatestFiniteMagnitude
    /// The person's text size, where the screen follows it.
    var scale: CGFloat = 1
    var displayScale: CGFloat = 2
    var dark = false
    var words: Strings.Artifacts.DateWords
    var now = Date()
    var calendar = Calendar.current
}

/// The list's slots, worked out off the main thread: a heading for each
/// date bucket over a card of its artifacts, newest change first, or one
/// note in their place.
enum ArtifactListItems {
    /// A row's ID is its artifact's.
    static let top = "artifacts:top"

    /// The glyph and tint a kind's tile shows when the row has no picture.
    nonisolated static func tile(_ artifact: ArtifactSummary) -> (icon: Icon, ink: ColorToken, fill: ColorToken) {
        if artifact.live { return (.ionicons("globe-outline"), Palette.tileTeal, Palette.tileTealFill) }
        switch artifact.type {
        case "markdown": return (.ionicons("document-text-outline"), Palette.tilePurple, Palette.tilePurpleFill)
        case "html": return (.ionicons("code-slash-outline"), Palette.tileBlue, Palette.tileBlueFill)
        case "image": return (.ionicons("image-outline"), Palette.tileOrange, Palette.tileOrangeFill)
        case "image_series": return (.ionicons("albums-outline"), Palette.tileOrange, Palette.tileOrangeFill)
        case "video": return (.ionicons("film-outline"), Palette.tileRed, Palette.tileRedFill)
        default: return (.ionicons("document-outline"), Palette.tileIndigo, Palette.tileIndigoFill)
        }
    }

    /// The overlay key a row's thumbnail is made for: its version's entry.
    nonisolated static func thumbnailKey(_ artifact: ArtifactSummary) -> String { "\(artifact.id)/\(artifact.latestVersion)" }

    nonisolated static func items(_ input: ArtifactListInput) -> [CardItem] {
        guard input.width > 0 else { return [] }
        let state = input.state
        // Tombstones are the Feed's, which still names them.
        let live = state.items.filter { !$0.deleted }
        let shown = ArtifactCatalog.matching(input.query, in: live) { Strings.Artifacts.kind($0) }
        func note(_ text: String) -> [CardItem] {
            [CardItems.note("artifacts:note", text, width: input.width, maxWidth: input.maxWidth, scale: input.scale, dark: input.dark, displayScale: input.displayScale)]
        }
        if shown.isEmpty {
            if state.unsupported { return note(Strings.Artifacts.unsupported) }
            if !live.isEmpty { return note(Strings.Artifacts.noMatches) }
            if state.error != nil { return note(Strings.Artifacts.unavailable) }
            if !state.loaded { return note(Strings.Artifacts.loading) }
            return note(Strings.Artifacts.empty)
        }
        var items: [CardItem] = []
        let groups = DateBucket.group(shown, now: input.now, calendar: input.calendar) { Date(timeIntervalSince1970: $0.updatedAt / 1000) }
        for (index, group) in groups.enumerated() {
            let label = input.words.bucket(group.bucket, now: input.now, calendar: input.calendar)
            items.append(CardItems.heading("artifacts:heading:\(group.bucket)", label, width: input.width, maxWidth: input.maxWidth, afterCard: index > 0, dark: input.dark, displayScale: input.displayScale))
            for (artifact, place) in zip(group.items, CardPlace.run(group.items.count)) {
                items.append(row(artifact, place: place, input: input))
            }
        }
        return items
    }

    nonisolated static func row(_ artifact: ArtifactSummary, place: CardPlace, input: ArtifactListInput) -> CardItem {
        typealias M = CardListMetrics
        let titleFont = CardFont(.regular, M.titleSize, scale: input.scale)
        let small = CardFont(.regular, M.subtitleSize, scale: input.scale)
        let title = artifact.title.isEmpty ? Strings.untitledArtifact : artifact.title
        let date = Date(timeIntervalSince1970: artifact.updatedAt / 1000)
        let time = input.words.time(date, now: input.now, calendar: input.calendar)
        var kind = Strings.Artifacts.kind(artifact.type, live: artifact.live)
        if artifact.type == "image_series", artifact.fileCount > 1 { kind += " · \(artifact.fileCount)" }
        let timeSize = CardText.measure(time, font: small, width: 10_000, maxLines: 1, scale: input.displayScale)
        let square = CGSize(width: M.tile, height: M.tile)
        let layout = CardRowLayout(
            width: input.width, maxWidth: input.maxWidth, place: place, leading: square,
            title: CardText.measurable(title, font: titleFont, maxLines: 2, scale: input.displayScale),
            subtitle: CardText.measurable(kind, font: small, maxLines: 1, scale: input.displayScale),
            trailing: timeSize, titleLine: CardText.line(titleFont, scale: input.displayScale), hairline: 1 / max(1, input.displayScale), scale: input.displayScale
        )
        var drawing = CardDrawing(dark: input.dark, displayScale: input.displayScale)
        var overlays: [CardOverlay] = []
        if let frame = layout.leading {
            let look = tile(artifact)
            drawing.marks.append(.tile(frame, radius: M.tileRadius, look.fill))
            drawing.icon(look.icon, size: M.tileGlyph, look.ink, in: frame)
            // The picture lands over its kind's tile, which stays while it loads.
            if artifact.showsPicture { overlays.append(CardOverlay(kind: "thumbnail", key: thumbnailKey(artifact), frame: frame, radius: M.tileRadius)) }
        }
        drawing.text(title, titleFont, Palette.text, layout.title, wraps: true)
        if let frame = layout.subtitle { drawing.text(kind, small, Palette.settingsSecondary, frame) }
        if let frame = layout.trailing { drawing.text(time, small, Palette.settingsSecondary, frame) }
        drawing.rule(layout.separator)
        var item = CardItem(id: artifact.id, kind: .row, size: layout.size, card: layout.card, place: place, drawing: drawing, opens: true, overlays: overlays)
        item.accessibilityLabel = title
        item.accessibilityValue = "\(kind), \(time)"
        return item
    }
}
#endif
