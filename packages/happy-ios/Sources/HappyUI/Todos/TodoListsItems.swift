#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
import UIKit

/// What the list of todo lists derives from: the catalog (its state), how
/// many todos each list has left, and the screen's width, text size and
/// theme.
struct TodoListsInput: Sendable {
    var state = SurfaceCatalogFeed.State()
    var outstanding: [String: Int] = [:]
    var width: CGFloat = 0
    var maxWidth: CGFloat = .greatestFiniteMagnitude
    var scale: CGFloat = 1
    var displayScale: CGFloat = 2
    var dark = false
}

/// The todo lists in one card, by name, each with the todos it has left
/// where they are known; or one note in their place.
enum TodoListsItems {
    /// A row's ID is its Surface's.
    static let noteID = "todo-lists:note"

    nonisolated static func items(_ input: TodoListsInput) -> [CardItem] {
        guard input.width > 0 else { return [] }
        let lists = input.state.of("todo")
        func note(_ text: String) -> [CardItem] {
            [CardItems.note(noteID, text, width: input.width, maxWidth: input.maxWidth, scale: input.scale, dark: input.dark, displayScale: input.displayScale)]
        }
        if lists.isEmpty {
            if input.state.unsupported { return note(Strings.Todos.unsupported) }
            if !input.state.loaded { return note(Strings.Todos.loadingLists) }
            return note(Strings.Todos.noLists)
        }
        return zip(lists, CardPlace.run(lists.count)).map { row($0, place: $1, input: input) }
    }

    nonisolated static func row(_ surface: AgentWire.Surface, place: CardPlace, input: TodoListsInput) -> CardItem {
        typealias M = CardListMetrics
        let titleFont = CardFont(.regular, M.titleSize, scale: input.scale)
        let small = CardFont(.regular, M.subtitleSize, scale: input.scale)
        let title = surface.name.isEmpty ? Strings.Todos.title : surface.name
        let left = input.outstanding[surface.id].map(Strings.Todos.outstanding)
        let layout = CardRowLayout(
            width: input.width, maxWidth: input.maxWidth, place: place, leading: CGSize(width: M.tile, height: M.tile),
            title: CardText.measurable(title, font: titleFont, maxLines: 2, scale: input.displayScale),
            subtitle: left.map { CardText.measurable($0, font: small, maxLines: 1, scale: input.displayScale) },
            titleLine: CardText.line(titleFont, scale: input.displayScale), hairline: 1 / max(1, input.displayScale), scale: input.displayScale
        )
        var drawing = CardDrawing(dark: input.dark, displayScale: input.displayScale)
        if let frame = layout.leading {
            drawing.marks.append(.tile(frame, radius: M.tileRadius, Palette.tileGreenFill))
            drawing.icon(.ionicons("checkbox-outline"), size: M.tileGlyph, Palette.tileGreen, in: frame)
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
