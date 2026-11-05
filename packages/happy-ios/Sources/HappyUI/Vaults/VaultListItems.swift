#if canImport(UIKit)
import Foundation
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// Search as a vault's browser shows it: the query asked and what came back.
struct VaultSearchState: Equatable, Sendable {
    var query = ""
    var results: [VaultSearchResult] = []
    var truncated = false
    var searching = false
}

/// What a vault folder's list derives from, written by the library (its
/// state), the search and the screen (sort, width, text size, theme, words).
struct VaultListInput: Sendable {
    var state = VaultFolderState()
    var sort = VaultSort.name
    var search: VaultSearchState?
    var width: CGFloat = 0
    var maxWidth: CGFloat = .greatestFiniteMagnitude
    var scale: CGFloat = 1
    var displayScale: CGFloat = 2
    var dark = false
    var words: Strings.Artifacts.DateWords
    var now = Date()
    var calendar = Calendar.current
}

/// A vault folder's slots, worked out off the main thread: uploads under
/// way over the folder's entries (folders first, in the chosen order), or
/// search results by names then contents, or one note in their place.
enum VaultListItems {
    static func entryID(_ id: String) -> String { "e:\(id)" }
    static func uploadID(_ id: String) -> String { "u:\(id)" }
    static func resultID(_ index: Int) -> String { "r:\(index)" }

    /// The glyph and tint an entry's tile shows.
    nonisolated static func tile(_ entry: VaultEntry) -> (icon: Icon, ink: ColorToken, fill: ColorToken) {
        switch entry.kind {
        case .folder: return (.ionicons("folder"), Palette.tileBlue, Palette.tileBlueFill)
        case .artifact: return (.ionicons("globe-outline"), Palette.tileTeal, Palette.tileTealFill)
        case .file: return tile(mediaType: entry.mediaType ?? "", name: entry.name)
        }
    }

    nonisolated static func tile(mediaType: String, name: String) -> (icon: Icon, ink: ColorToken, fill: ColorToken) {
        let ext = (name as NSString).pathExtension.lowercased()
        if mediaType.hasPrefix("image/") { return (.ionicons("image-outline"), Palette.tileOrange, Palette.tileOrangeFill) }
        if mediaType.hasPrefix("video/") { return (.ionicons("film-outline"), Palette.tileRed, Palette.tileRedFill) }
        if mediaType.hasPrefix("audio/") { return (.ionicons("musical-notes"), Palette.tilePurple, Palette.tilePurpleFill) }
        if mediaType == "application/pdf" { return (.ionicons("document-text"), Palette.tileRed, Palette.tileRedFill) }
        if mediaType == "application/zip" || ext == "zip" { return (.ionicons("archive-outline"), Palette.tileIndigo, Palette.tileIndigoFill) }
        if mediaType.hasPrefix("text/markdown") || ext == "md" { return (.ionicons("document-text-outline"), Palette.tilePurple, Palette.tilePurpleFill) }
        if VaultPreviewKind.isCode(mediaType: mediaType, name: name) { return (.ionicons("code-slash-outline"), Palette.tileBlue, Palette.tileBlueFill) }
        if mediaType.hasPrefix("text/") { return (.ionicons("document-text-outline"), Palette.tilePurple, Palette.tilePurpleFill) }
        return (.ionicons("document-outline"), Palette.tileIndigo, Palette.tileIndigoFill)
    }

    nonisolated static func size(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }

    /// What a row says under its name: when it changed, and its size or kind.
    nonisolated static func detail(_ entry: VaultEntry, input: VaultListInput) -> String {
        let time = input.words.time(Date(timeIntervalSince1970: entry.updatedAt / 1000), now: input.now, calendar: input.calendar)
        switch entry.kind {
        case .folder: return time
        case .artifact: return "\(time) · \(Strings.Vaults.app)"
        case .file: return "\(time) · \(size(entry.size ?? 0))"
        }
    }

    nonisolated static func items(_ input: VaultListInput) -> [CardItem] {
        guard input.width > 0 else { return [] }
        func note(_ id: String, _ text: String) -> CardItem {
            CardItems.note(id, text, width: input.width, maxWidth: input.maxWidth, scale: input.scale, dark: input.dark, displayScale: input.displayScale)
        }
        if let search = input.search { return results(search, input: input, note: note) }
        let state = input.state
        var items: [CardItem] = []
        if state.status == .missing { return [note("vault:note", Strings.Vaults.missing)] }
        if state.inTrash { items.append(note("vault:trash", Strings.Vaults.inTrash)) }
        if !state.uploads.isEmpty {
            items.append(CardItems.heading("vault:uploads", Strings.Vaults.uploads, width: input.width, maxWidth: input.maxWidth, afterCard: false, dark: input.dark, displayScale: input.displayScale))
            for (upload, place) in zip(state.uploads, CardPlace.run(state.uploads.count)) { items.append(uploadRow(upload, place: place, input: input)) }
        }
        let entries = input.sort.sorted(state.entries)
        if entries.isEmpty {
            if state.status == .loading { return items + [note("vault:note", Strings.Vaults.loading)] }
            if state.uploads.isEmpty { items.append(note("vault:note", state.inTrash ? Strings.Vaults.emptyInTrash : Strings.Vaults.empty)) }
            return items
        }
        if !state.uploads.isEmpty {
            items.append(CardItems.heading("vault:files", Strings.Vaults.items(entries.count), width: input.width, maxWidth: input.maxWidth, afterCard: true, dark: input.dark, displayScale: input.displayScale))
        }
        for (entry, place) in zip(entries, CardPlace.run(entries.count)) {
            items.append(row(id: entryID(entry.id), entry: entry, title: entry.shownName, subtitle: detail(entry, input: input), place: place,
                             waiting: state.waiting.contains(entry.id), input: input))
        }
        return items
    }

    private nonisolated static func results(_ search: VaultSearchState, input: VaultListInput, note: (String, String) -> CardItem) -> [CardItem] {
        if search.results.isEmpty { return [note("vault:note", search.searching ? Strings.Vaults.searching : Strings.Vaults.noResults)] }
        var items: [CardItem] = []
        let groups: [(String, [Int])] = [
            (Strings.Vaults.nameMatches, search.results.indices.filter { search.results[$0].match == .name }),
            (Strings.Vaults.contentMatches, search.results.indices.filter { search.results[$0].match == .content }),
        ].filter { !$0.1.isEmpty }
        for (group, (title, indices)) in groups.enumerated() {
            items.append(CardItems.heading("vault:results:\(group)", title, width: input.width, maxWidth: input.maxWidth, afterCard: group > 0, dark: input.dark, displayScale: input.displayScale))
            for (index, place) in zip(indices, CardPlace.run(indices.count)) {
                let result = search.results[index]
                var folder = (result.path as NSString).deletingLastPathComponent
                if let inner = result.innerPath { folder = result.path + "/" + inner }
                var subtitle = folder
                if result.match == .content {
                    let snippet = (result.snippet ?? "").replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
                    subtitle = [result.line.map(Strings.Vaults.line), snippet.isEmpty ? nil : "“\(snippet)”"].compactMap { $0 }.joined(separator: ": ") + "\n" + folder
                }
                items.append(row(id: resultID(index), entry: result.entry, title: result.entry.shownName, subtitle: subtitle, place: place, waiting: false, input: input, subtitleLines: result.match == .content ? 3 : 1))
            }
        }
        if search.truncated { items.append(note("vault:more", Strings.Vaults.moreResults)) }
        return items
    }

    /// One row: `look`'s tile (else the entry's), the title, a quieter line.
    nonisolated static func row(id: String, entry: VaultEntry, title: String, subtitle: String, place: CardPlace, waiting: Bool, input: VaultListInput, subtitleLines: Int = 1,
                                look: (icon: Icon, ink: ColorToken, fill: ColorToken)? = nil, opens: Bool = true) -> CardItem {
        typealias M = CardListMetrics
        let titleFont = CardFont(.regular, M.titleSize, scale: input.scale)
        let small = CardFont(.regular, M.subtitleSize, scale: input.scale)
        let layout = CardRowLayout(
            width: input.width, maxWidth: input.maxWidth, place: place, leading: CGSize(width: M.tile, height: M.tile),
            title: CardText.measurable(title, font: titleFont, maxLines: 2, scale: input.displayScale),
            subtitle: CardText.measurable(subtitle, font: small, maxLines: subtitleLines, scale: input.displayScale),
            titleLine: CardText.line(titleFont, scale: input.displayScale), hairline: 1 / max(1, input.displayScale), scale: input.displayScale
        )
        var drawing = CardDrawing(dark: input.dark, displayScale: input.displayScale)
        if let frame = layout.leading {
            let look = look ?? tile(entry)
            drawing.marks.append(.tile(frame, radius: M.tileRadius, look.fill))
            drawing.icon(look.icon, size: M.tileGlyph, look.ink, in: frame)
        }
        drawing.text(title, titleFont, waiting ? Palette.settingsSecondary : Palette.text, layout.title, wraps: true)
        if let frame = layout.subtitle { drawing.text(subtitle, small, Palette.settingsSecondary, frame, wraps: subtitleLines != 1) }
        drawing.rule(layout.separator)
        var item = CardItem(id: id, kind: .row, size: layout.size, card: layout.card, place: place, drawing: drawing, opens: opens)
        item.accessibilityLabel = title
        item.accessibilityValue = entry.isFolder ? "\(Strings.Vaults.folder), \(subtitle)" : subtitle
        return item
    }

    /// A failed upload's reason in words: the computer's own message, or
    /// what its code means.
    nonisolated static func failure(_ reason: String) -> String {
        switch reason {
        case "": Strings.Vaults.offline
        case "too_large": Strings.Vaults.tooLarge
        case "not_found": Strings.Vaults.gone
        case "name_taken": Strings.Vaults.nameTakenShort
        case "conflict": Strings.Vaults.changedElsewhere
        case "invalid_request": Strings.Vaults.invalidUpload
        default: reason
        }
    }

    nonisolated static func uploadRow(_ upload: VaultUploadState, place: CardPlace, input: VaultListInput) -> CardItem {
        typealias M = CardListMetrics
        let titleFont = CardFont(.regular, M.titleSize, scale: input.scale)
        let small = CardFont(.regular, M.subtitleSize, scale: input.scale)
        let status: String
        switch upload.phase {
        case .sending: status = Strings.Vaults.sending(Int((upload.fraction * 100).rounded(.down)))
        case .placing: status = Strings.Vaults.placing
        case .failed(let reason): status = Strings.Vaults.uploadFailed(failure(reason))
        }
        let failed = if case .failed = upload.phase { true } else { false }
        let layout = VaultUploadRowLayout(
            width: input.width, maxWidth: input.maxWidth, place: place, leading: CGSize(width: M.tile, height: M.tile),
            title: CardText.measurable(VaultEntry.shownName(upload.name), font: titleFont, maxLines: 1, scale: input.displayScale),
            subtitle: CardText.measurable(status, font: small, maxLines: 2, scale: input.displayScale),
            fraction: upload.fraction, titleLine: CardText.line(titleFont, scale: input.displayScale), hairline: 1 / max(1, input.displayScale), scale: input.displayScale
        )
        var drawing = CardDrawing(dark: input.dark, displayScale: input.displayScale)
        if let frame = layout.row.leading {
            let look: (icon: Icon, ink: ColorToken, fill: ColorToken) = upload.kind == .artifact
                ? (.ionicons("globe-outline"), Palette.tileTeal, Palette.tileTealFill) : tile(mediaType: "", name: upload.name)
            drawing.marks.append(.tile(frame, radius: M.tileRadius, look.fill))
            drawing.icon(look.icon, size: M.tileGlyph, look.ink, in: frame)
        }
        drawing.text(VaultEntry.shownName(upload.name), titleFont, Palette.text, layout.row.title)
        drawing.text(status, small, failed ? Palette.textDestructive : Palette.settingsSecondary, layout.subtitle, wraps: true)
        drawing.marks.append(.tile(layout.track, radius: layout.track.height / 2, Palette.groupedSeparator))
        if layout.fill.width > 0 { drawing.marks.append(.tile(layout.fill, radius: layout.fill.height / 2, failed ? Palette.textDestructive : Palette.textLink)) }
        drawing.rule(layout.row.separator)
        var item = CardItem(id: uploadID(upload.id), kind: .row, size: layout.row.size, card: layout.row.card, place: place, drawing: drawing, opens: failed)
        item.accessibilityLabel = VaultEntry.shownName(upload.name)
        item.accessibilityValue = status
        return item
    }
}
#endif
