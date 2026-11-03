#if canImport(UIKit)
import Foundation
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// What the Feed's list derives from, written by the library (its state),
/// the engine (the directory every row is joined with) and the screen (its
/// width, text size, theme and words).
struct FeedListInput: Sendable {
    var state = FeedLibrary.State()
    var directory = FeedDirectory()
    /// The person's own placeholder's seed (`Session.personSeed`).
    var personSeed = ""
    /// A place's newest entries, peeked at: none carries the dot.
    var peek = false
    var width: CGFloat = 0
    var maxWidth: CGFloat = .greatestFiniteMagnitude
    /// The person's text size, where the screen follows it.
    var scale: CGFloat = 1
    var displayScale: CGFloat = 2
    var dark = false
    var words: FeedWords
    var dates: Strings.Artifacts.DateWords
    var now = Date()
    var calendar = Calendar.current
}

/// The Feed's slots, worked out off the main thread: a heading for each
/// date bucket over a card of its entries, newest change first, as
/// desktop's Feed and the artifacts list group them; or one note in their
/// place. A row's ID is its entry's. Every row is joined from its entry
/// and the account's directory (`FeedRows`); an entry the directory can't
/// show yet isn't a row.
enum FeedListItems {
    /// A face over a row's bitmap: the subject's, or an actor's, which is
    /// ringed in the card's colour where the faces overlap. Its radius
    /// says whether it is round (a person) or a rounded square.
    static let faceKind = "face"
    static let actorKind = "actor"

    /// What a row's or a place's face looks like where it is a glyph on
    /// its kind's tile, drawn into the bitmap.
    nonisolated static func tile(_ kind: FeedSubjectKind, artifactType: String?) -> (icon: Icon, ink: ColorToken, fill: ColorToken) {
        switch kind {
        case .task: return (Glyphs.icon("tasks"), Palette.tileOrange, Palette.tileOrangeFill)
        case .bot: return (Glyphs.icon("agents"), Palette.tileIndigo, Palette.tileIndigoFill)
        case .document: return (Glyphs.icon("doc"), Palette.tileBlue, Palette.tileBlueFill)
        case .todoList: return (Glyphs.icon("tasks"), Palette.tileGreen, Palette.tileGreenFill)
        case .calendar: return (Glyphs.icon("calendar"), Palette.tileRed, Palette.tileRedFill)
        case .surface: return (Glyphs.icon("layers"), Palette.tileTeal, Palette.tileTealFill)
        case .unknown: return (Glyphs.icon("feed"), Palette.tileRed, Palette.tileRedFill)
        case .artifact:
            switch artifactType {
            case "markdown": return (.ionicons("document-text-outline"), Palette.tilePurple, Palette.tilePurpleFill)
            case "html": return (.ionicons("code-slash-outline"), Palette.tileBlue, Palette.tileBlueFill)
            case "image": return (.ionicons("image-outline"), Palette.tileOrange, Palette.tileOrangeFill)
            case "image_series": return (.ionicons("albums-outline"), Palette.tileOrange, Palette.tileOrangeFill)
            case "video": return (.ionicons("film-outline"), Palette.tileRed, Palette.tileRedFill)
            default: return (.ionicons("document-outline"), Palette.tileIndigo, Palette.tileIndigoFill)
            }
        }
    }

    nonisolated static func clusterTile(_ kind: String) -> (icon: Icon, ink: ColorToken, fill: ColorToken) {
        switch kind {
        case "team": return (Glyphs.icon("users"), Palette.tileTeal, Palette.tileTealFill)
        case "task": return tile(.task, artifactType: nil)
        case "bot": return tile(.bot, artifactType: nil)
        case "surface": return (Glyphs.icon("doc"), Palette.tileBlue, Palette.tileBlueFill)
        case "project": return (.ionicons("folder-outline"), Palette.tileBlue, Palette.tileBlueFill)
        case "workspace": return (.ionicons("git-branch-outline"), Palette.tileBlue, Palette.tileBlueFill)
        default: return (Glyphs.icon("feed"), Palette.tileRed, Palette.tileRedFill)
        }
    }

    /// The key an overlay's face is made for: what it shows, so a face that
    /// changes is made again and one that doesn't is kept.
    nonisolated static func faceKey(_ slot: String, _ face: FeedFace) -> String { "\(slot)|\(face)" }

    /// The feed: its notes while it has nothing to show.
    nonisolated static func items(_ input: FeedListInput) -> (items: [CardItem], faces: [String: FeedFace], rows: [FeedRow]) {
        guard input.width > 0 else { return ([], [:], []) }
        let state = input.state
        let words = input.words
        let peek = input.peek
        let rows = FeedRows.make(state.items, unread: { !peek && state.isUnread($0) }, directory: input.directory, personSeed: input.personSeed)
        if rows.isEmpty {
            let text: String
            if input.peek { text = state.error != nil ? words.clustersUnavailable : state.loaded ? words.peekEmpty : words.loadingClusters }
            else if state.available == false { text = words.unsupported }
            else if state.error != nil { text = words.unavailable }
            else if !state.loaded || state.available == nil || state.refreshing { text = words.loading }
            // Entries whose subjects aren't read yet show once they are.
            else if !state.items.isEmpty && !input.directory.loaded { text = words.loading }
            else { text = words.empty }
            return ([note("feed:note", text, input)], [:], [])
        }
        var made = entries(rows, input: input)
        if state.loadingMore {
            made.items.append(note("feed:more", words.loadingClusters, input))
        }
        return (made.items, made.faces, rows)
    }

    /// `rows` in their date's cards.
    nonisolated static func entries(_ rows: [FeedRow], input: FeedListInput) -> (items: [CardItem], faces: [String: FeedFace]) {
        var items: [CardItem] = []
        var faces: [String: FeedFace] = [:]
        let groups = DateBucket.group(rows, now: input.now, calendar: input.calendar) { Date(timeIntervalSince1970: $0.lastAt / 1000) }
        for (index, group) in groups.enumerated() {
            let label = input.dates.bucket(group.bucket, now: input.now, calendar: input.calendar)
            items.append(CardItems.heading("feed:heading:\(group.bucket)", label, width: input.width, maxWidth: input.maxWidth, afterCard: index > 0, dark: input.dark, displayScale: input.displayScale))
            for (entry, place) in zip(group.items, CardPlace.run(group.items.count)) {
                let made = row(entry, place: place, input: input)
                items.append(made.item)
                faces.merge(made.faces) { first, _ in first }
            }
        }
        return (items, faces)
    }

    nonisolated static func note(_ id: String, _ text: String, _ input: FeedListInput) -> CardItem {
        CardItems.note(id, text, width: input.width, maxWidth: input.maxWidth, scale: input.scale, dark: input.dark, displayScale: input.displayScale)
    }

    nonisolated static func row(_ entry: FeedRow, place: CardPlace, input: FeedListInput) -> (item: CardItem, faces: [String: FeedFace]) {
        typealias M = FeedMetrics
        let words = input.words
        let unread = entry.unread
        let titleFont = CardFont(unread ? .semiBold : .regular, M.titleSize, scale: input.scale)
        let small = CardFont(.regular, M.summarySize, scale: input.scale)
        let title = entry.title
        let date = Date(timeIntervalSince1970: entry.lastAt / 1000)
        let time = input.dates.time(date, now: input.now, calendar: input.calendar)
        let summary = words.summary(entry)
        let actors = Array(entry.actors.prefix(M.maxFaces))
        let rest = max(entry.actorCount, entry.actors.count) - actors.count
        let more = rest > 0 ? "+\(rest)" : nil
        let layout = FeedRowLayout(
            width: input.width, maxWidth: input.maxWidth, place: place,
            title: CardText.measurable(title, font: titleFont, maxLines: 1, scale: input.displayScale),
            time: CardText.measure(time, font: small, width: 10_000, maxLines: 1, scale: input.displayScale),
            faces: actors.count,
            more: more.map { CardText.measure($0, font: small, width: 10_000, maxLines: 1, scale: input.displayScale) },
            summary: CardText.measurable(summary, font: small, maxLines: 1, scale: input.displayScale),
            hairline: 1 / max(1, input.displayScale), scale: input.displayScale
        )
        var drawing = CardDrawing(dark: input.dark, displayScale: input.displayScale)
        var overlays: [CardOverlay] = []
        var faces: [String: FeedFace] = [:]
        func overlay(_ slot: String, _ face: FeedFace, _ frame: CGRect, kind: String) {
            let key = faceKey("\(entry.id)|\(slot)", face)
            overlays.append(CardOverlay(kind: kind, key: key, frame: frame, radius: radius(face, side: frame.width)))
            faces[key] = face
        }
        let subject = entry.face
        switch subject {
        case .tile(let kind, let type):
            let look = tile(kind, artifactType: type)
            drawing.marks.append(.tile(layout.avatar, radius: CardListMetrics.tileRadius, look.fill))
            drawing.icon(look.icon, size: CardListMetrics.tileGlyph, look.ink, in: layout.avatar)
        default:
            overlay("subject", subject, layout.avatar, kind: faceKind)
        }
        drawing.text(title, titleFont, Palette.text, layout.title)
        if let frame = layout.time { drawing.text(time, small, Palette.settingsSecondary, frame) }
        if unread { drawing.marks.append(.tile(layout.dot, radius: M.dot / 2, Palette.tileBlue)) }
        for (index, (actor, frame)) in zip(actors, layout.faces).enumerated() {
            overlay("actor\(index)", actor, frame, kind: actorKind)
        }
        if let more, let frame = layout.more { drawing.text(more, small, Palette.settingsSecondary, frame) }
        if let frame = layout.summary { drawing.text(summary, small, Palette.settingsSecondary, frame) }
        drawing.rule(layout.separator)
        var item = CardItem(id: entry.id, kind: .row, size: layout.size, card: layout.card, place: place, drawing: drawing, opens: entry.target != nil, overlays: overlays)
        item.accessibilityLabel = title
        item.accessibilityValue = [unread ? words.unreadMark : nil, summary, words.actors(named: entry.actorNames, count: entry.actorCount), time]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", ")
        return (item, faces)
    }

    /// A person's face is round; anything else a rounded square, its
    /// corners as a tile's are for its size.
    nonisolated static func radius(_ face: FeedFace, side: CGFloat) -> CGFloat {
        if case .mark(_, let round) = face, round { return side / 2 }
        return (CardListMetrics.tileRadius * side / CardListMetrics.tile).rounded()
    }
}

/// What the Following list derives from.
struct FeedClustersInput: Sendable {
    var clusters: [FeedCluster] = []
    /// Places whose follow or mute is on its way.
    var pending: Set<String> = []
    var loaded = false
    var error: String?
    var directory = FeedDirectory()
    var width: CGFloat = 0
    var maxWidth: CGFloat = .greatestFiniteMagnitude
    var scale: CGFloat = 1
    var displayScale: CGFloat = 2
    var dark = false
    var words: FeedWords
    /// A switch's size, measured on the main thread.
    var switchSize = CGSize(width: 51, height: 31)
}

/// Following: everything and the team in one card, each place in another,
/// a switch on each to follow or mute it; a tap peeks in. A place is named
/// from the directory; one it doesn't hold isn't listed.
enum FeedClusterItems {
    static let toggle = "switch"

    /// Followed: subscribed by choice, or following everything without one.
    nonisolated static func following(_ cluster: FeedCluster, everything: String?) -> Bool {
        (cluster.state ?? everything ?? "subscribed") == "subscribed"
    }

    nonisolated static func items(_ input: FeedClustersInput) -> (items: [CardItem], faces: [String: FeedFace]) {
        guard input.width > 0 else { return ([], [:]) }
        let words = input.words
        func note(_ text: String) -> CardItem {
            CardItems.note("following:note", text, width: input.width, maxWidth: input.maxWidth, scale: input.scale, dark: input.dark, displayScale: input.displayScale)
        }
        let shown = input.clusters.compactMap { cluster in FeedPlace(cluster, directory: input.directory).map { (cluster, $0) } }
        if shown.isEmpty {
            if input.error != nil { return ([note(words.clustersUnavailable)], [:]) }
            return ([note(input.loaded ? words.noClusters : words.loadingClusters)], [:])
        }
        let everything = input.clusters.first { $0.cluster == "*" }?.state
        let broad = shown.filter { $0.0.kind == "everything" || $0.0.kind == "team" }
        let places = shown.filter { $0.0.kind != "everything" && $0.0.kind != "team" }
        var items: [CardItem] = []
        var faces: [String: FeedFace] = [:]
        for (id, label, rows) in [("everywhere", words.everywhere, broad), ("places", words.places, places)] where !rows.isEmpty {
            items.append(CardItems.heading("following:heading:\(id)", label, width: input.width, maxWidth: input.maxWidth, afterCard: !items.isEmpty, dark: input.dark, displayScale: input.displayScale))
            for ((cluster, named), place) in zip(rows, CardPlace.run(rows.count)) {
                let made = row(cluster, named, following: following(cluster, everything: everything), place: place, input: input)
                items.append(made.item)
                faces.merge(made.faces) { first, _ in first }
            }
        }
        return (items, faces)
    }

    nonisolated static func row(_ cluster: FeedCluster, _ named: FeedPlace, following: Bool, place: CardPlace, input: FeedClustersInput) -> (item: CardItem, faces: [String: FeedFace]) {
        typealias M = FeedMetrics
        let font = CardFont(.regular, CardListMetrics.titleSize, scale: input.scale)
        let name = input.words.name(named.name)
        let square = CGSize(width: M.clusterAvatar, height: M.clusterAvatar)
        let layout = CardRowLayout(
            width: input.width, maxWidth: input.maxWidth, place: place, leading: square,
            title: CardText.measurable(name, font: font, maxLines: 1, scale: input.displayScale),
            trailing: input.switchSize, minHeight: M.clusterRow,
            hairline: 1 / max(1, input.displayScale), scale: input.displayScale
        )
        var drawing = CardDrawing(dark: input.dark, displayScale: input.displayScale)
        var overlays: [CardOverlay] = []
        var faces: [String: FeedFace] = [:]
        let face = named.face
        if let frame = layout.leading {
            switch face {
            case .clusterTile(let kind):
                let look = FeedListItems.clusterTile(kind)
                drawing.marks.append(.tile(frame, radius: CardListMetrics.tileRadius, look.fill))
                drawing.icon(look.icon, size: CardListMetrics.tileGlyph, look.ink, in: frame)
            default:
                let key = FeedListItems.faceKey("\(cluster.cluster)|face", face)
                overlays.append(CardOverlay(kind: FeedListItems.faceKind, key: key, frame: frame, radius: FeedListItems.radius(face, side: frame.width)))
                faces[key] = face
            }
        }
        drawing.text(name, font, Palette.text, layout.title)
        if let frame = layout.trailing {
            let pending = input.pending.contains(cluster.cluster)
            overlays.append(CardOverlay(kind: toggle, key: "\(toggle)|\(cluster.cluster)|\(following)|\(pending)", frame: frame))
        }
        drawing.rule(layout.separator)
        var item = CardItem(id: cluster.cluster, kind: .row, size: layout.size, card: layout.card, place: place, drawing: drawing, opens: true, overlays: overlays)
        item.accessibilityLabel = name
        // The row is one element, so VoiceOver hears the switch's state
        // here and flips it with the row's action (`FeedViewController`).
        item.accessibilityValue = following ? input.words.following : input.words.muted
        return (item, faces)
    }
}
#endif
