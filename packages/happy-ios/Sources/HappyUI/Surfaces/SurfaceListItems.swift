#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
import UIKit

/// One of home's Surface sections, as desktop's sidebar has them: its
/// Documents or its TODOs, each a list of every Surface of its type.
enum SurfaceSection: Sendable {
    case documents
    case todos

    /// The Surface type it lists and makes.
    var type: String {
        switch self {
        case .documents: "document"
        case .todos: "todo"
        }
    }

    /// Home's row for it (`SidebarRows.make`).
    var targetKind: String {
        switch self {
        case .documents: "documents"
        case .todos: "todos"
        }
    }

    var title: String {
        switch self {
        case .documents: Strings.Documents.section
        case .todos: Strings.Todos.section
        }
    }

    var glyph: String {
        switch self {
        case .documents: "document-text-outline"
        case .todos: "checkbox-outline"
        }
    }

    var tint: (ink: ColorToken, fill: ColorToken) {
        switch self {
        case .documents: (Palette.tileBlue, Palette.tileBlueFill)
        case .todos: (Palette.tileGreen, Palette.tileGreenFill)
        }
    }

    /// The + menu's one action, and the name alert's title.
    var new: String {
        switch self {
        case .documents: Strings.Todos.newDocument
        case .todos: Strings.Todos.newList
        }
    }

    var empty: String {
        switch self {
        case .documents: Strings.Documents.none
        case .todos: Strings.Todos.noLists
        }
    }

    var loading: String {
        switch self {
        case .documents: Strings.Documents.loadingList
        case .todos: Strings.Todos.loadingLists
        }
    }

    var unsupported: String {
        switch self {
        case .documents: Strings.Documents.notKept
        case .todos: Strings.Todos.unsupported
        }
    }

    /// What an unnamed one is called.
    var untitled: String {
        switch self {
        case .documents: Strings.Documents.untitled
        case .todos: Strings.Todos.title
        }
    }
}

/// What a section's list derives from: the catalog (its state), how many
/// todos each list has left, and the screen's width, text size and theme.
struct SurfaceListInput: Sendable {
    var section = SurfaceSection.todos
    var state = SurfaceCatalogFeed.State()
    var outstanding: [String: Int] = [:]
    var width: CGFloat = 0
    var maxWidth: CGFloat = .greatestFiniteMagnitude
    var scale: CGFloat = 1
    var displayScale: CGFloat = 2
    var dark = false
}

/// A section's Surfaces in one card, by name, a todo list with the todos
/// it has left where there are some; or one note in their place.
enum SurfaceListItems {
    /// A row's ID is its Surface's.
    static let noteID = "surface-list:note"

    nonisolated static func items(_ input: SurfaceListInput) -> [CardItem] {
        guard input.width > 0 else { return [] }
        let surfaces = input.state.of(input.section.type)
        func note(_ text: String) -> [CardItem] {
            [CardItems.note(noteID, text, width: input.width, maxWidth: input.maxWidth, scale: input.scale, dark: input.dark, displayScale: input.displayScale)]
        }
        if surfaces.isEmpty {
            if input.state.unsupported { return note(input.section.unsupported) }
            if !input.state.loaded { return note(input.section.loading) }
            return note(input.section.empty)
        }
        return zip(surfaces, CardPlace.run(surfaces.count)).map { row($0, place: $1, input: input) }
    }

    nonisolated static func row(_ surface: AgentWire.Surface, place: CardPlace, input: SurfaceListInput) -> CardItem {
        typealias M = CardListMetrics
        let titleFont = CardFont(.regular, M.titleSize, scale: input.scale)
        let small = CardFont(.regular, M.subtitleSize, scale: input.scale)
        let title = surface.name.isEmpty ? input.section.untitled : surface.name
        // As desktop: a count only while something is left.
        let left = input.outstanding[surface.id].flatMap { $0 > 0 ? Strings.Todos.outstanding($0) : nil }
        let layout = CardRowLayout(
            width: input.width, maxWidth: input.maxWidth, place: place, leading: CGSize(width: M.tile, height: M.tile),
            title: CardText.measurable(title, font: titleFont, maxLines: 2, scale: input.displayScale),
            subtitle: left.map { CardText.measurable($0, font: small, maxLines: 1, scale: input.displayScale) },
            titleLine: CardText.line(titleFont, scale: input.displayScale), hairline: 1 / max(1, input.displayScale), scale: input.displayScale
        )
        var drawing = CardDrawing(dark: input.dark, displayScale: input.displayScale)
        if let frame = layout.leading {
            let tint = input.section.tint
            drawing.marks.append(.tile(frame, radius: M.tileRadius, tint.fill))
            drawing.icon(.ionicons(input.section.glyph), size: M.tileGlyph, tint.ink, in: frame)
        }
        drawing.text(title, titleFont, Palette.text, layout.title, wraps: true)
        if let frame = layout.subtitle, let left { drawing.text(left, small, Palette.settingsSecondary, frame) }
        drawing.rule(layout.separator)
        var item = CardItem(id: surface.id, kind: .row, size: layout.size, card: layout.card, place: place, drawing: drawing, opens: true)
        item.accessibilityLabel = title
        item.accessibilityValue = left
        return item
    }
}
#endif
