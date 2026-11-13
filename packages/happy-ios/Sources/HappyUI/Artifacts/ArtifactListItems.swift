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
    /// What the list shows between its insets: a note in place of the
    /// whole list stands in its middle.
    var height: CGFloat = 0
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
        case "gen_ui": return (.ionicons("apps-outline"), Palette.tileGreen, Palette.tileGreenFill)
        default: return (.ionicons("document-outline"), Palette.tileIndigo, Palette.tileIndigoFill)
        }
    }

    /// A picture or recording without a cover: its own file, or its first
    /// frame, filling the slot (`ArtifactThumbnails`), keyed by its version.
    static let thumbnailKind = "thumbnail"
    nonisolated static func thumbnailKey(_ artifact: ArtifactSummary) -> String { "\(artifact.id)/\(artifact.latestVersion)" }

    /// A row's cover over its slot (`FeedCoverView`), keyed by where it is
    /// served, so a new version's is made again and an unchanged one kept.
    static let coverKind = "cover"
    nonisolated static func coverKey(_ path: String) -> String { "cover|\(path)" }

    /// What a cover sits on: the artifact's background, else a neutral fill.
    nonisolated static func coverGround(_ artifact: ArtifactSummary) -> ColorToken {
        guard let hex = artifact.background, let color = RGBA(hex: FeedListItems.expanded(hex)) else { return Palette.surfaceHighest }
        return ColorToken(light: color, dark: color)
    }

    nonisolated static func items(_ input: ArtifactListInput) -> [CardItem] {
        guard input.width > 0 else { return [] }
        let state = input.state
        // Tombstones are the Feed's, which still names them.
        let live = state.items.filter { !$0.deleted }
        let shown = ArtifactCatalog.matching(input.query, in: live) { Strings.Artifacts.kind($0) }
        func note(_ text: String, scene: StateScene? = nil, centred: Bool = true) -> [CardItem] {
            [CardItems.note("artifacts:note", text, scene: scene, fill: centred ? input.height : nil, width: input.width, maxWidth: input.maxWidth, scale: input.scale, dark: input.dark, displayScale: input.displayScale)]
        }
        if shown.isEmpty {
            if state.unsupported { return note(Strings.Artifacts.unsupported) }
            // Under the search field, where the keyboard leaves it seen.
            if !live.isEmpty { return note(Strings.Artifacts.noMatches, centred: false) }
            if state.error != nil { return note(Strings.Artifacts.unavailable) }
            if !state.loaded { return note(Strings.Artifacts.loading) }
            // Nothing made yet: the tickets, waiting for something to admit.
            return note(Strings.Artifacts.empty, scene: .tickets)
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
        // One slot and one title line in every row: one height for all.
        let layout = CardRowLayout(
            width: input.width, maxWidth: input.maxWidth, place: place, leading: ArtifactListMetrics.slot,
            title: CardText.measurable(title, font: titleFont, maxLines: ArtifactListMetrics.titleLines, scale: input.displayScale),
            subtitle: CardText.measurable(kind, font: small, maxLines: 1, scale: input.displayScale),
            trailing: timeSize, titleLine: CardText.line(titleFont, scale: input.displayScale), hairline: 1 / max(1, input.displayScale), scale: input.displayScale
        )
        var drawing = CardDrawing(dark: input.dark, displayScale: input.displayScale)
        var overlays: [CardOverlay] = []
        if let frame = layout.leading {
            let radius = ArtifactListMetrics.slotRadius
            if let cover = artifact.cover, let path = artifact.coverPath {
                // The cover fades in over its ground; a square stands whole
                // in the middle of the slot.
                let ratio = CGFloat(cover.aspect.ratio)
                let fills = ArtifactCoverSlot.fills(ratio: ratio, slot: frame.size)
                drawing.marks.append(.tile(frame, radius: radius, coverGround(artifact)))
                let picture = ArtifactCoverSlot.picture(ratio: ratio, in: frame, scale: input.displayScale)
                overlays.append(CardOverlay(kind: coverKind, key: coverKey(path), frame: picture, radius: fills ? radius : 0))
            } else {
                let look = tile(artifact)
                drawing.marks.append(.tile(frame, radius: radius, look.fill))
                drawing.icon(look.icon, size: M.tileGlyph, look.ink, in: frame)
                // Media without a cover: its own picture lands over the
                // glyph, which stays while it loads.
                if artifact.showsPicture, !artifact.deleted {
                    overlays.append(CardOverlay(kind: thumbnailKind, key: thumbnailKey(artifact), frame: frame, radius: radius))
                }
            }
        }
        drawing.text(title, titleFont, Palette.text, layout.title)
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
